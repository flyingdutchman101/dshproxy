using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace DSHProxy
{
    // Seam checks, not part of the product. Written again for this round: the
    // earlier SeamCheck, CredCheck and six-tab script were removed with the
    // temporary folders, so the lines and counts differ from those runs.
    //   seam  the video settings and video key commands of the real command
    //         line, in a throwaway data folder, read the way the app reads them
    //   cred  the Video accounts and Video API keys pages of the app's real
    //         window, with synthetic keys, a stand-in Krea helper and a
    //         recorder in place of the browser
    //   tabs  the six sections of a preview window: Chat, Video, Chat again
    // Windows are off screen and never activated.
    internal static class PagesCheck
    {
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
        [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        private delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
        private static readonly HookProc NoActivation = (code, w, l) => code == 5 ? (IntPtr)1 : CallNextHookEx(IntPtr.Zero, code, w, l);

        private static int failed;
        private static int foregroundTaken;
        private static bool left;
        private static MainForm form;
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

        private static void Check(string what, bool ok) { Console.WriteLine((ok ? "ok   " : "FAIL ") + what); if (!ok) failed++; Console.Out.Flush(); }
        private static void Note(string text) { Console.WriteLine("     " + text); Console.Out.Flush(); }
        private static void Head(string text) { Console.WriteLine("--- " + text + " ---"); Console.Out.Flush(); }

        private const BindingFlags Any = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
        private static FieldInfo F(string name) { return typeof(MainForm).GetField(name, Any); }
        private static T Ui<T>(Func<T> read) { return (T)form.Invoke(read); }
        private static void Post(Action act) { form.BeginInvoke(act); }
        private static void Call(string method) { var m = typeof(MainForm).GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic); Post(() => m.Invoke(form, null)); }

        private static void Foreground()
        {
            uint pid;
            GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            if (pid == (uint)Process.GetCurrentProcess().Id) foregroundTaken++;
        }

        private static double Until(Func<bool> done, int ms)
        {
            var clock = Stopwatch.StartNew();
            while (clock.ElapsedMilliseconds < ms)
            {
                if (done()) return clock.ElapsedMilliseconds / 1000.0;
                Foreground();
                Thread.Sleep(40);
            }
            return done() ? clock.ElapsedMilliseconds / 1000.0 : -1;
        }

        private static T Find<T>(Control root, Func<T, bool> match) where T : Control
        {
            var self = root as T;
            if (self != null && match(self)) return self;
            foreach (Control child in root.Controls)
            {
                var found = Find(child, match);
                if (found != null) return found;
            }
            return null;
        }

        // Everything a control and its children say, to the eye or to a screen reader.
        private static void Texts(Control root, List<string> into)
        {
            // What is typed into a key box is the one thing not collected: it is the input itself.
            if (!(root is TextBox && ((TextBox)root).UseSystemPasswordChar)) into.Add(root.Text ?? "");
            into.Add(root.AccessibleName ?? "");
            into.Add(root.AccessibleDescription ?? "");
            var list = root as ListView;
            if (list != null)
                foreach (ListViewItem item in list.Items)
                    foreach (ListViewItem.ListViewSubItem cell in item.SubItems) into.Add(cell.Text ?? "");
            foreach (Control child in root.Controls) Texts(child, into);
        }

        private static void Labels(Control root, List<string> into)
        {
            if (root is Label && root.Text.Length > 0) into.Add(root.Text.Replace("\r", "").Replace("\n", " / "));
            foreach (Control child in root.Controls) Labels(child, into);
        }

        private sealed class Seen
        {
            public Form Form;
            public string Text = "";
            public string Default = "";
        }

        private static readonly List<string> seenTexts = new List<string>();

        private static Seen Dialog(Func<Form, bool> match)
        {
            return Ui(() =>
            {
                foreach (Form f in Application.OpenForms)
                {
                    if (f is MainForm || !f.Visible || !match(f)) continue;
                    var said = new List<string>();
                    Labels(f, said);
                    Texts(f, seenTexts);
                    var accept = f.AcceptButton as Button;
                    return new Seen { Form = f, Text = string.Join(" | ", said.ToArray()), Default = accept == null ? "" : accept.Text };
                }
                return null;
            });
        }

        private static Seen WaitDialog(string what, Func<Form, bool> match, int ms)
        {
            Seen seen = null;
            Until(() => (seen = Dialog(match)) != null, ms);
            if (seen == null) Check(what + ": the dialog opened", false);
            return seen;
        }

        private static bool HasBox(Form f) { return Find<TextBox>(f, x => true) != null; }
        private static bool HasButton(Form f, string text) { return Find<Button>(f, x => x.Text == text) != null; }
        private static bool Closed(Seen dialog) { return Ui(() => dialog.Form.IsDisposed || !dialog.Form.Visible); }
        private static void Answer(Seen dialog, string button)
        {
            Post(() => { var b = Find<Button>(dialog.Form, x => x.Text == button); if (b != null) b.PerformClick(); });
            Until(() => Closed(dialog), 5000);
        }

        private static bool Alive(int pid)
        {
            try { using (var p = Process.GetProcessById(pid)) return !p.HasExited; }
            catch (ArgumentException) { return false; }
            catch (InvalidOperationException) { return false; }
        }

        private static string ReadShared(string file)
        {
            if (!File.Exists(file)) return "";
            using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var reader = new StreamReader(stream)) return reader.ReadToEnd();
        }

        private static int Occurrences(byte[] hay, byte[] needle)
        {
            var n = 0;
            for (var i = 0; i + needle.Length <= hay.Length; i++)
            {
                var j = 0;
                while (j < needle.Length && hay[i + j] == needle[j]) j++;
                if (j == needle.Length) n++;
            }
            return n;
        }

        // How often a secret appears, as UTF-8 or UTF-16 text, in the files of a folder.
        private static int InFiles(string folder, string secret, List<string> where)
        {
            var n = 0;
            foreach (var file in Directory.GetFiles(folder, "*", SearchOption.AllDirectories))
            {
                byte[] bytes;
                try { using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) { bytes = new byte[stream.Length]; stream.Read(bytes, 0, bytes.Length); } }
                catch (IOException) { continue; }
                var hits = Occurrences(bytes, Encoding.UTF8.GetBytes(secret)) + Occurrences(bytes, Encoding.Unicode.GetBytes(secret));
                if (hits > 0) where.Add(file);
                n += hits;
            }
            return n;
        }

        private static int Main(string[] args)
        {
            var what = args[0];
            var realRoot = args[1];
            var rigDir = args[2];
            var home = Path.Combine(rigDir, "home");
            var local = Path.Combine(rigDir, "localappdata");
            Directory.CreateDirectory(local);
            Environment.SetEnvironmentVariable("DSHPROXY_HOME", home);
            Environment.SetEnvironmentVariable("DSH_HOME", Path.Combine(rigDir, "no-deepseek-harness"));
            Environment.SetEnvironmentVariable("LOCALAPPDATA", local);
            Environment.SetEnvironmentVariable("DSHPROXY_REAL_ROOT", realRoot);
            Environment.SetEnvironmentVariable("STUB_LOG", Path.Combine(rigDir, "stub.log"));
            Environment.SetEnvironmentVariable("STUB_MODE_FILE", Path.Combine(rigDir, "stub-mode.txt"));
            Environment.SetEnvironmentVariable("STUB_COMMAND_FILE", Path.Combine(rigDir, "command.txt"));
            Environment.SetEnvironmentVariable("STUB_GATEWAY_LOG", Path.Combine(rigDir, "gateway.log"));
            foreach (var name in new[] { "VIDEOROUTER_API_KEY", "KOVAPI_API_KEY", "CALLIRRA_API_KEY" }) Environment.SetEnvironmentVariable(name, null);
            foreach (var file in new[] { "stub.log", "stub-mode.txt", "command.txt", "gateway.log" }) File.Delete(Path.Combine(rigDir, file));
            Console.WriteLine(what + ": DSHPROXY_HOME=" + home);
            var display = CultureInfo.GetCultureInfo("en-US");
            CultureInfo.DefaultThreadCurrentCulture = display;
            CultureInfo.DefaultThreadCurrentUICulture = display;

            if (what == "seam") { Seam(realRoot, home); return Finish(); }

            Application.CurrentCulture = display;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            SetWindowsHookEx(5, NoActivation, IntPtr.Zero, GetCurrentThreadId());
            var opened = new List<string>();
            if (what == "cred")
            {
                var port = int.Parse(args[3], CultureInfo.InvariantCulture);
                if (port == 8417 || port == 8418) return 2;
                Environment.SetEnvironmentVariable("FAKE_KREA_LOG", Path.Combine(rigDir, "fake-helper.log"));
                Environment.SetEnvironmentVariable("FAKE_KREA_FLAG", Path.Combine(rigDir, "fake-signed-in"));
                File.Delete(Path.Combine(rigDir, "fake-helper.log"));
                File.Delete(Path.Combine(rigDir, "fake-signed-in"));
                form = new MainForm(true, null);
                // Nothing listens there, and nothing is ever sent to the default address.
                F("lastOrigin").SetValue(form, "http://127.0.0.1:" + port);
                ((NotifyIcon)F("tray").GetValue(form)).Visible = false;
                F("openConsentPage").SetValue(form, new Func<string, bool>(address => { lock (opened) opened.Add(address); return true; }));
                Console.WriteLine("command line folder: " + ((Cli)F("cli").GetValue(form)).Root);
            }
            else form = new MainForm(false, File.ReadAllText(Path.Combine(realRoot, "app", "preview-limits.json")));

            var test = new Thread(() =>
            {
                try
                {
                    Thread.Sleep(300);
                    if (what == "cred") Cred(home, rigDir, opened);
                    else Tabs();
                }
                catch (Exception error)
                {
                    Console.WriteLine("FAIL the check itself stopped: " + error);
                    failed++;
                }
                // The preview window has no gateway; the real one left through its own Quit.
                if (!left)
                {
                    try { Post(() => { var quit = typeof(MainForm).GetMethod("Quit", BindingFlags.Instance | BindingFlags.NonPublic); quit.Invoke(form, null); }); }
                    catch (InvalidOperationException) { }
                }
            });
            test.IsBackground = true;
            test.Start();
            if (what == "tabs")
            {
                form.StartPosition = FormStartPosition.Manual;
                form.Location = new Point(-12000, 0);
                form.Size = new Size(1280, 880);
            }
            Application.Run(form);
            test.Join(15000);
            Console.WriteLine(foregroundTaken == 0 ? "ok   the window never became the foreground window" : "FAIL the window was the foreground window in " + foregroundTaken + " samples");
            if (foregroundTaken != 0) failed++;
            return Finish();
        }

        private static int Finish()
        {
            Console.WriteLine(failed == 0 ? "ALL OK" : failed + " FAILED");
            Console.Out.Flush();
            return failed == 0 ? 0 : 1;
        }

        // ---------------------------------------------------------------
        private static bool Refuses(string json) { try { VideoSettings.Parse(json); return false; } catch (FormatException) { return true; } }
        private static bool RefusesName(string model, string route) { try { VideoSettings.SetCommand(model, route, true); return false; } catch (ArgumentException) { return true; } }

        private static void Seam(string realRoot, string home)
        {
            Head("video settings and video keys through the real command line");
            var cli = new Cli(realRoot, Cli.FindNode());
            var settingsBefore = File.ReadAllText(Path.Combine(home, "settings.json"));
            string failure;
            var first = VideoSettings.Read(cli.Run(VideoSettings.ReadCommand(), null, 20000), out failure);
            Check("read on a fresh data folder answers in the agreed shape" + (failure == null ? "" : " (" + failure + ")"), first != null && first.Count > 0);
            if (first == null) return;
            Note(first.Count + " models: " + string.Join(", ", first.ConvertAll(m => m.Id).ToArray()));
            Check("every model starts off, with no route", first.TrueForAll(m => !m.Enabled && m.Route.Length == 0 && !m.HasRoute));
            Check("every model lists the routes it may use", first.TrueForAll(m => m.Routes.Count > 0));
            var model = first[0];
            var route = model.Routes[0];
            var set = VideoSettings.Read(cli.Run(VideoSettings.SetCommand(model.Id, route, true), null, 20000), out failure);
            Check("set " + model.Id + " " + route + " enabled answers with the saved state" + (failure == null ? "" : " (" + failure + ")"), set != null && set.Find(m => m.Id == model.Id).Enabled && set.Find(m => m.Id == model.Id).Route == route && set.Find(m => m.Id == model.Id).HasRoute);
            var again = VideoSettings.Read(cli.Run(VideoSettings.ReadCommand(), null, 20000), out failure);
            Check("a second process reads it back", again != null && again.Find(m => m.Id == model.Id).Enabled && again.Find(m => m.Id == model.Id).Route == route);
            Check("the other models are untouched", again != null && again.FindAll(m => m.Id != model.Id).TrueForAll(m => !m.Enabled && m.Route.Length == 0));
            var off = VideoSettings.Read(cli.Run(VideoSettings.SetCommand(model.Id, route, false), null, 20000), out failure);
            Check("set ... disabled switches it off and keeps the route", off != null && !off.Find(m => m.Id == model.Id).Enabled && off.Find(m => m.Id == model.Id).Route == route);
            var none = VideoSettings.Read(cli.Run(VideoSettings.DisableCommand(model.Id), null, 20000), out failure);
            Check("set ... none disabled leaves it off with no route" + (failure == null ? "" : " (" + failure + ")"), none != null && !none.Find(m => m.Id == model.Id).Enabled && none.Find(m => m.Id == model.Id).Route.Length == 0);
            var bad = cli.Run(new[] { "video", "settings", "set", model.Id, "no-such-route", "enabled" }, null, 20000);
            var refused = VideoSettings.Read(bad, out failure);
            Check("a route the model may not use is refused by the command, with a sentence: " + failure, bad.Code != 0 && refused == null && !string.IsNullOrEmpty(failure));
            var after = VideoSettings.Read(cli.Run(VideoSettings.ReadCommand(), null, 20000), out failure);
            Check("and nothing was saved by the refused command", after != null && after.TrueForAll(m => !m.Enabled && m.Route.Length == 0));
            Check("the app refuses to build a command from an option, a path or an empty name", RefusesName("--help", "krea") && RefusesName(model.Id, "../x") && RefusesName("", route) && RefusesName(model.Id, "a b"));
            Check("a model cannot be enabled with no route", RefusesName(model.Id, VideoSettings.NoRoute));
            Check("answers that are not the agreed shape are refused whole", Refuses("") && Refuses("[]") && Refuses("{}") && Refuses("{\"models\":[{\"id\":\"x\"}]}") && Refuses("not json"));
            Check("the app's own sample parses", VideoSettings.Parse(VideoSettings.Sample).Count > 0 && VideoKeys.Parse(VideoKeys.Sample).Count > 0);

            var keys = VideoKeys.Read(cli.Run(VideoKeys.ListCommand(), null, 20000), out failure);
            Check("video key list answers in the agreed shape" + (failure == null ? "" : " (" + failure + ")"), keys != null && keys.Count > 0);
            if (keys == null) return;
            Check("no video key is saved on a fresh data folder", keys.TrueForAll(k => !k.Saved && !k.Readable));
            var provider = keys[0];
            var secret = "sk-synthetic-SEAM-" + Guid.NewGuid().ToString("N");
            var saved = cli.Run(VideoKeys.SetCommand(provider.Id), secret + "\n", 20000);
            Check("video key set " + provider.Id + " (key on standard input) answers saved", VideoKeys.Saved(saved, provider.Id));
            Check("the answer does not repeat the key", !saved.Out.Contains(secret) && !saved.Err.Contains(secret));
            var listed = VideoKeys.Read(cli.Run(VideoKeys.ListCommand(), null, 20000), out failure);
            Check("a second process lists it as saved and readable, the others as not saved", listed != null && listed.Find(k => k.Id == provider.Id).Saved && listed.Find(k => k.Id == provider.Id).Readable && listed.FindAll(k => k.Id != provider.Id).TrueForAll(k => !k.Saved));
            var where = new List<string>();
            Check("the key is in no file of the data folder as plain text (" + InFiles(home, secret, where) + " places)", InFiles(home, secret, new List<string>()) == 0);
            var removed = VideoKeys.Removed(cli.Run(VideoKeys.RemoveCommand(provider.Id), null, 20000), provider.Id);
            Check("video key remove answers removed", removed.HasValue && removed.Value);
            var removedAgain = VideoKeys.Removed(cli.Run(VideoKeys.RemoveCommand(provider.Id), null, 20000), provider.Id);
            Check("a second remove answers that none was saved", removedAgain.HasValue && !removedAgain.Value);
            Check("key rules: empty, 513 characters, a space, a line break and a non-ASCII letter are refused before anything is sent; 512 printable characters are not",
                VideoKeys.Refusal("") != null && VideoKeys.Refusal(new string('a', 513)) != null && VideoKeys.Refusal("a b") != null && VideoKeys.Refusal("a\nb") != null && VideoKeys.Refusal("k\u017E") != null && VideoKeys.Refusal(new string('a', 512)) == null);
            Check("an error text never carries the key on", !VideoKeys.Without("refused: " + secret + " is bad", secret).Contains(secret));
            var settingsAfter = Json.Obj(Json.Serializer.DeserializeObject(File.ReadAllText(Path.Combine(home, "settings.json"))));
            var settingsWas = Json.Obj(Json.Serializer.DeserializeObject(settingsBefore));
            Check("the chat settings kept their ports and the saved Chat key", Json.Str(Json.Get(settingsAfter, "port")) == Json.Str(Json.Get(settingsWas, "port")) && Json.Str(Json.Get(settingsAfter, "backendPort")) == Json.Str(Json.Get(settingsWas, "backendPort")) && Json.Serializer.Serialize(Json.Get(settingsAfter, "providers")) == Json.Serializer.Serialize(Json.Get(settingsWas, "providers")));
        }

        // ---------------------------------------------------------------
        private static ListView List(string name) { return (ListView)F(name).GetValue(form); }
        private static string StatusOf(string name) { return Ui(() => ((Control)F(name).GetValue(form)).Text); }
        private static string LogText() { return Ui(() => ((TextBox)F("logBox").GetValue(form)).Text); }
        private static string Cell(string list, string first, int column) { return Ui(() => { foreach (ListViewItem item in List(list).Items) if (item.Text == first) return item.SubItems[column].Text; return null; }); }
        private static void Select(string list, string first) { Post(() => { foreach (ListViewItem item in List(list).Items) item.Selected = item.Text == first; }); Thread.Sleep(150); }
        private static bool Enabled(string name) { return Ui(() => ((Control)F(name).GetValue(form)).Enabled); }
        private static void Krea(string plan) { Environment.SetEnvironmentVariable("FAKE_KREA_MODE", plan); }

        private static int HelperPid(string rigDir, string command)
        {
            var pid = 0;
            foreach (var line in ReadShared(Path.Combine(rigDir, "fake-helper.log")).Split('\n'))
                if (line.Contains("[\"" + command + "\"]")) pid = int.Parse(line.Substring(line.IndexOf("\"pid\":", StringComparison.Ordinal) + 6).Split(',')[0], CultureInfo.InvariantCulture);
            return pid;
        }

        private static int HelperRuns(string rigDir, string command)
        {
            var n = 0;
            foreach (var line in ReadShared(Path.Combine(rigDir, "fake-helper.log")).Split('\n')) if (line.Contains("[\"" + command + "\"]")) n++;
            return n;
        }

        private static void Cred(string home, string rigDir, List<string> opened)
        {
            Post(() => { SetWindowPos(form.Handle, IntPtr.Zero, -12000, 0, 1280, 880, 0x0004 | 0x0010); ShowWindow(form.Handle, 4); });
            Thread.Sleep(1500);

            Head("pure: what the helper may say");
            Check("consent address: https on krea.ai, www.krea.ai, api.krea.ai is accepted as written", Krea_("https://krea.ai/a?b=c") && Krea_("https://www.krea.ai/consent") && Krea_("https://api.krea.ai/x#y"));
            Check("refused: http, another host, a look-alike host, a name before an @, a port, a backslash, a space, an escaped host, nothing",
                !Krea_("http://krea.ai/a") && !Krea_("https://evil.example/krea.ai") && !Krea_("https://krea.ai.evil.example/") && !Krea_("https://krea.ai@evil.example/") && !Krea_("https://krea.ai:8443/") && !Krea_("https://krea.ai\\@evil.example/") && !Krea_("https://krea.ai/a b") && !Krea_("https://%6Brea.ai/") && !Krea_("") && !Krea_(null) && !Krea_("https://"));
            Check("status: signed out, signed in with a future time; refused: a past time, text, two lines, no flag",
                DSHProxy.Krea.ParseStatus("{\"signedIn\":false}", DateTime.UtcNow) != null && !DSHProxy.Krea.ParseStatus("{\"signedIn\":false}", DateTime.UtcNow).SignedIn
                && DSHProxy.Krea.ParseStatus("{\"signedIn\":true,\"expiresAt\":4000000000000}", DateTime.UtcNow).SignedIn
                && DSHProxy.Krea.ParseStatus("{\"signedIn\":true,\"expiresAt\":1000}", DateTime.UtcNow) == null && DSHProxy.Krea.ParseStatus("yes", DateTime.UtcNow) == null
                && DSHProxy.Krea.ParseStatus("{\"signedIn\":false}\n{\"signedIn\":true}", DateTime.UtcNow) == null && DSHProxy.Krea.ParseStatus("{}", DateTime.UtcNow) == null);
            Check("how a sign-in ended: exit 0, the three codes, anything else",
                DSHProxy.Krea.Ended(0, "") == DSHProxy.Krea.Outcome.SignedIn && DSHProxy.Krea.Ended(1, "KREA_REFUSED\n") == DSHProxy.Krea.Outcome.Refused && DSHProxy.Krea.Ended(1, "x\nKREA_LOGIN_REQUIRED") == DSHProxy.Krea.Outcome.LoginRequired
                && DSHProxy.Krea.Ended(1, "KREA_UNCERTAIN") == DSHProxy.Krea.Outcome.Uncertain && DSHProxy.Krea.Ended(1, "secret detail") == DSHProxy.Krea.Outcome.Failed);
            var sentences = new HashSet<string>();
            foreach (DSHProxy.Krea.Outcome outcome in Enum.GetValues(typeof(DSHProxy.Krea.Outcome))) sentences.Add(DSHProxy.Krea.Message(outcome));
            Check("every way a sign-in can end has its own sentence (" + sentences.Count + ")", sentences.Count == Enum.GetValues(typeof(DSHProxy.Krea.Outcome)).Length);

            Head("Video API keys page (real window, real command line, throwaway data folder)");
            Post(() => { ((RadioButton)F("videoSwitch").GetValue(form)).Checked = true; ((PageHost)F("tabs").GetValue(form)).SelectedIndex = 1; });
            var t = Until(() => StatusOf("videoKeysStatus").StartsWith("Read from DSHProxy at", StringComparison.Ordinal), 20000);
            Check("opening the page reads what is saved: " + StatusOf("videoKeysStatus"), t >= 0);
            var rows = Ui(() => { var names = new List<string>(); foreach (ListViewItem item in List("videoKeysList").Items) names.Add(item.Text + "=" + item.SubItems[3].Text); return names; });
            Note(string.Join("; ", rows.ToArray()));
            Check("one row for each provider, none saved", rows.Count >= 2 && rows.TrueForAll(r => r.EndsWith("=Not saved", StringComparison.Ordinal)));
            Check("with no row selected, Add and Remove are off", !Enabled("videoKeyAdd") && !Enabled("videoKeyRemove"));
            var provider = rows[0].Split('=')[0];
            var other = rows[1].Split('=')[0];
            Select("videoKeysList", provider);
            Check("with a row selected they are on", Enabled("videoKeyAdd") && Enabled("videoKeyRemove"));

            var key = "sk-synthetic-ONE-" + Guid.NewGuid().ToString("N");
            Call("AddVideoKey");
            var ask = WaitDialog("the key dialog", f => HasBox(f), 8000);
            if (ask != null)
            {
                Check("the key box hides what is typed, and the dialog names the provider: " + ask.Text, Ui(() => Find<TextBox>(ask.Form, x => true).UseSystemPasswordChar) && ask.Text.Contains(provider));
                Post(() => { Find<TextBox>(ask.Form, x => true).Text = key; Find<Button>(ask.Form, x => x.Text == "Save").PerformClick(); });
                Until(() => Closed(ask), 5000);
            }
            t = Until(() => StatusOf("videoKeysStatus").StartsWith("Saved the " + provider + " key. It was not checked against " + provider + ". The list shows what is saved", StringComparison.Ordinal), 20000);
            Check("saved: " + StatusOf("videoKeysStatus"), t >= 0);
            Check("the row says Saved, the other row still Not saved", Cell("videoKeysList", provider, 3) == "Saved" && Cell("videoKeysList", other, 3) == "Not saved");
            var where = new List<string>();
            var inFiles = InFiles(home, key, where) + InFiles(Path.Combine(rigDir, "localappdata"), key, where);
            Check("the key is in no file of the data folder or the app's local folder as plain text (" + inFiles + ")", inFiles == 0);
            Check("a file for video keys exists in the data folder", File.Exists(Path.Combine(home, "video-keys.json")));
            var all = new List<string>();
            Ui(() => { Texts(form, all); return 0; });
            all.AddRange(seenTexts);
            Check("the key is nowhere in the window, its accessible texts, the dialogs seen or the log", all.TrueForAll(text => !text.Contains(key)) && !LogText().Contains(key));
            Check("the log says a key was saved, without the key", LogText().Contains("Video: saved the " + provider + " key."));
            Check("the stand-in command line's log has the command without the key", ReadShared(Path.Combine(rigDir, "stub.log")).Contains("video key set") && !ReadShared(Path.Combine(rigDir, "stub.log")).Contains(key));

            // A key the rule refuses is never sent.
            var sets = Count(ReadShared(Path.Combine(rigDir, "stub.log")), " video key ");
            Select("videoKeysList", other);
            Call("AddVideoKey");
            ask = WaitDialog("the key dialog (bad key)", f => HasBox(f), 8000);
            if (ask != null)
            {
                Post(() => { Find<TextBox>(ask.Form, x => true).Text = "sk synthetic with spaces"; Find<Button>(ask.Form, x => x.Text == "Save").PerformClick(); });
                Until(() => Closed(ask), 5000);
            }
            var told = WaitDialog("the refusal", f => f.Text == "Video API key" && HasButton(f, "OK"), 8000);
            if (told != null)
            {
                Check("a key with spaces is refused before anything is sent: " + told.Text, told.Text.Contains("was not saved") && told.Text.Contains("cannot contain spaces"));
                Answer(told, "OK");
            }
            Thread.Sleep(1500);
            Check("no video key command was run for it, and the row still says Not saved", Count(ReadShared(Path.Combine(rigDir, "stub.log")), " video key ") == sets && Cell("videoKeysList", other, 3) == "Not saved");

            // Remove.
            Select("videoKeysList", provider);
            Call("RemoveVideoKey");
            var sure = WaitDialog("the removal question", f => f.Text == "Video API key" && HasButton(f, "Yes"), 8000);
            if (sure != null)
            {
                Check("Remove asks first, No is the default: " + sure.Text, sure.Default == "No" && sure.Text.Contains("Remove the saved " + provider + " video key?"));
                Answer(sure, "No");
            }
            Thread.Sleep(600);
            Check("No: still saved", Cell("videoKeysList", provider, 3) == "Saved");
            Call("RemoveVideoKey");
            sure = WaitDialog("the removal question (second time)", f => f.Text == "Video API key" && HasButton(f, "Yes"), 8000);
            if (sure != null) Answer(sure, "Yes");
            t = Until(() => StatusOf("videoKeysStatus").StartsWith("Removed the saved " + provider + " key.", StringComparison.Ordinal) && Cell("videoKeysList", provider, 3) == "Not saved", 20000);
            Check("Yes: removed, and the row says Not saved: " + StatusOf("videoKeysStatus"), t >= 0);

            Head("Video accounts page (stand-in Krea helper, recorder in place of the browser)");
            Krea("");
            Post(() => { ((PageHost)F("tabs").GetValue(form)).SelectedIndex = 0; });
            t = Until(() => StatusOf("videoAccountsStatus").StartsWith("State read from the Krea helper at", StringComparison.Ordinal), 20000);
            Check("opening the page asks the helper for the state: " + StatusOf("videoAccountsStatus"), t >= 0);
            Func<string> kreaState = () => Ui(() => List("videoAccountsList").Items[0].SubItems[3].Text);
            Check("the row says Not signed in; Sign in and Sign out are on, Cancel is off", kreaState() == "Not signed in" && Enabled("kreaSignIn") && Enabled("kreaSignOut") && !Enabled("kreaCancel"));

            // Sign-in that completes.
            Krea("{\"address\":\"https://krea.ai/synthetic-consent?code=RECORDED\",\"exit\":\"ok\",\"waitMs\":2500}");
            Call("KreaSignIn");
            t = Until(() => { lock (opened) return opened.Count == 1; }, 15000);
            Check("the consent address the helper printed is handed to the browser opener, once, as printed", t >= 0 && opened[0] == "https://krea.ai/synthetic-consent?code=RECORDED");
            Check("while it waits: Cancel is on, Sign in and Sign out are off: " + StatusOf("videoAccountsStatus"), Enabled("kreaCancel") && !Enabled("kreaSignIn") && !Enabled("kreaSignOut") && StatusOf("videoAccountsStatus").StartsWith("Waiting for you to finish in the browser", StringComparison.Ordinal));
            t = Until(() => StatusOf("videoAccountsStatus").StartsWith("Signed in to Krea. State read from the Krea helper", StringComparison.Ordinal), 20000);
            Check("signed in: " + StatusOf("videoAccountsStatus"), t >= 0);
            Check("the row says: " + kreaState(), kreaState().StartsWith("Signed in \u00B7 until ", StringComparison.Ordinal));
            Check("the consent address is not in the log or the window", !LogText().Contains("synthetic-consent") && Ui(() => { var texts = new List<string>(); Texts(form, texts); return texts.TrueForAll(text => !text.Contains("synthetic-consent")); }));

            // Sign out.
            Call("KreaSignOut");
            sure = WaitDialog("the sign-out question", f => f.Text == "Krea" && HasButton(f, "Yes"), 8000);
            if (sure != null)
            {
                Check("Sign out asks first, No is the default: " + sure.Text, sure.Default == "No" && sure.Text.Contains("Sign out of Krea?"));
                Answer(sure, "No");
            }
            Thread.Sleep(500);
            Check("No: the helper's logout was not run", HelperRuns(rigDir, "logout") == 0 && kreaState().StartsWith("Signed in", StringComparison.Ordinal));
            Call("KreaSignOut");
            sure = WaitDialog("the sign-out question (second time)", f => f.Text == "Krea" && HasButton(f, "Yes"), 8000);
            if (sure != null) Answer(sure, "Yes");
            t = Until(() => StatusOf("videoAccountsStatus").StartsWith("Signed out of Krea. State read", StringComparison.Ordinal) && kreaState() == "Not signed in", 20000);
            Check("Yes: signed out, the row says Not signed in", t >= 0 && HelperRuns(rigDir, "logout") == 1);

            // Cancel while waiting for the browser.
            Krea("{\"address\":\"https://www.krea.ai/synthetic-consent\",\"exit\":\"ok\",\"waitMs\":600000}");
            Call("KreaSignIn");
            t = Until(() => { lock (opened) return opened.Count == 2; }, 15000);
            var helper = HelperPid(rigDir, "login");
            Check("a second sign-in waits for the browser (helper process " + helper + ")", t >= 0 && helper != 0 && Alive(helper));
            Call("KreaCancelSignIn");
            t = Until(() => StatusOf("videoAccountsStatus").StartsWith("Sign-in cancelled: the Krea helper was stopped.", StringComparison.Ordinal), 25000);
            Check("Cancel: " + StatusOf("videoAccountsStatus"), t >= 0);
            // The state is asked for again after every sign-in that ended.
            t = Until(() => StatusOf("videoAccountsStatus").StartsWith("Sign-in cancelled: the Krea helper was stopped. State read", StringComparison.Ordinal), 20000);
            Check("the helper process is gone, the state was read again, the row says Not signed in, the buttons are back", t >= 0 && !Alive(helper) && kreaState() == "Not signed in" && Enabled("kreaSignIn") && !Enabled("kreaCancel"));

            // An address that is not Krea's.
            Krea("{\"address\":\"https://krea.ai.evil.example/consent\",\"exit\":\"ok\",\"waitMs\":600000}");
            Call("KreaSignIn");
            t = Until(() => StatusOf("videoAccountsStatus").StartsWith("Refused: the Krea helper gave a consent address that is not", StringComparison.Ordinal), 25000);
            helper = HelperPid(rigDir, "login");
            Check("an address on another host is refused and never opened: " + StatusOf("videoAccountsStatus").Substring(0, Math.Min(110, StatusOf("videoAccountsStatus").Length)), t >= 0 && opened.Count == 2 && !Alive(helper));
            Check("that address is not in the log or the window", !LogText().Contains("evil.example") && Ui(() => { var texts = new List<string>(); Texts(form, texts); return texts.TrueForAll(text => !text.Contains("evil.example")); }));
            Until(() => Enabled("kreaSignIn"), 20000);

            // The helper refuses.
            Krea("{\"address\":\"https://api.krea.ai/consent\",\"exit\":\"KREA_REFUSED\",\"waitMs\":800}");
            Call("KreaSignIn");
            t = Until(() => StatusOf("videoAccountsStatus").StartsWith("Krea sign-in did not complete (KREA_REFUSED)", StringComparison.Ordinal), 25000);
            Check("the helper ends with KREA_REFUSED: the page says so and the row says Not signed in", t >= 0 && Until(() => kreaState() == "Not signed in", 8000) >= 0);
            Until(() => Enabled("kreaSignIn"), 20000);

            // A state the helper does not report.
            Krea("status:not json at all");
            Post(() => { ((PageHost)F("tabs").GetValue(form)).SelectedIndex = 1; });
            Thread.Sleep(400);
            Post(() => { ((PageHost)F("tabs").GetValue(form)).SelectedIndex = 0; });
            t = Until(() => kreaState() == "Not known", 20000);
            Check("a state the helper does not report is shown as Not known, not as either one: " + StatusOf("videoAccountsStatus"), t >= 0 && StatusOf("videoAccountsStatus").Contains("did not report the sign-in state"));
            Check("only status, login and logout were ever asked of the helper", ReadShared(Path.Combine(rigDir, "fake-helper.log")).Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries).Length == HelperRuns(rigDir, "status") + HelperRuns(rigDir, "login") + HelperRuns(rigDir, "logout"));
            // The app starts its gateway when it opens, as it always does: here the
            // stand-in one of the throwaway data folder. Nothing on these pages
            // starts another or asks one to stop.
            var log = ReadShared(Path.Combine(rigDir, "stub.log"));
            Check("the gateway was started once, when the app opened; nothing on these pages started another or asked one to stop (" + Count(log, " begin ") + " command line runs in all: start x" + CountRuns(log, "start") + ", stop x" + CountRuns(log, "stop") + ")", CountRuns(log, "start") == 1 && CountRuns(log, "stop") == 0);
            var gateway = Ui(() => { var g = (Process)F("gateway").GetValue(form); return g == null ? 0 : g.Id; });
            left = true;
            Call("Quit");
            Check("Quit ends the app's gateway (process " + gateway + ")", gateway != 0 && Until(() => !Alive(gateway), 15000) >= 0);
        }

        private static bool Krea_(string address) { return DSHProxy.Krea.ConsentAddress(address) == address && address != null; }

        // Runs of one command in the stand-in command line's log.
        private static int CountRuns(string log, string command)
        {
            var n = 0;
            foreach (var line in log.Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var parts = line.Trim().Split(new[] { ' ' }, 4);
                if (parts.Length == 4 && parts[1] == "begin" && (parts[3] == command || parts[3].StartsWith(command + " ", StringComparison.Ordinal))) n++;
            }
            return n;
        }

        private static int Count(string hay, string needle)
        {
            var n = 0;
            for (var at = hay.IndexOf(needle, StringComparison.Ordinal); at >= 0; at = hay.IndexOf(needle, at + needle.Length, StringComparison.Ordinal)) n++;
            return n;
        }

        // ---------------------------------------------------------------
        private static Bitmap Shot()
        {
            return Ui(() =>
            {
                form.Refresh();
                var bmp = new Bitmap(form.Width, form.Height);
                using (var g = Graphics.FromImage(bmp)) { var dc = g.GetHdc(); PrintWindow(form.Handle, dc, 2); g.ReleaseHdc(dc); }
                return bmp;
            });
        }

        private static int Differing(Bitmap a, Bitmap b)
        {
            if (a.Width != b.Width || a.Height != b.Height) return -1;
            var n = 0;
            for (var x = 0; x < a.Width; x++) for (var y = 0; y < a.Height; y++) if (a.GetPixel(x, y).ToArgb() != b.GetPixel(x, y).ToArgb()) n++;
            return n;
        }

        // Where two captures differ: the smallest rectangle that holds every differing pixel.
        private static string Where(Bitmap a, Bitmap b)
        {
            if (a.Width != b.Width || a.Height != b.Height) return "different sizes";
            int left = int.MaxValue, top = int.MaxValue, right = -1, bottom = -1;
            for (var x = 0; x < a.Width; x++) for (var y = 0; y < a.Height; y++) if (a.GetPixel(x, y).ToArgb() != b.GetPixel(x, y).ToArgb()) { left = Math.Min(left, x); top = Math.Min(top, y); right = Math.Max(right, x); bottom = Math.Max(bottom, y); }
            return right < 0 ? "nowhere" : "x " + left + ".." + right + ", y " + top + ".." + bottom;
        }

        private static List<string> VisibleLabels()
        {
            return Ui(() =>
            {
                var all = new List<string>();
                Action<Control> walk = null;
                walk = c => { if (!c.Visible) return; if (c is Label && c.Text.Length > 0) all.Add(c.Text.Replace('\u00A0', ' ')); foreach (Control child in c.Controls) walk(child); };
                walk(form);
                return all;
            });
        }

        private static void Tabs()
        {
            Head("six sections of a preview window: Chat, then Video, then Chat again");
            Thread.Sleep(1500);
            var headings = new[] { "Video accounts", "Video API keys", "Video lanes", "Video models", "Video in DeepSeek Harness", null };
            var chat = (RadioButton)F("chatSwitch").GetValue(form);
            var video = (RadioButton)F("videoSwitch").GetValue(form);
            var tabs = (PageHost)F("tabs").GetValue(form);
            var before = new Stopwatch();
            for (var tab = 0; tab < 6; tab++)
            {
                var index = tab;
                Post(() => { chat.Checked = true; tabs.SelectedIndex = index; });
                Thread.Sleep(900);
                using (var first = Shot())
                {
                    Post(() => video.PerformClick());
                    Thread.Sleep(900);
                    var labels = VisibleLabels();
                    var inVideo = Ui(() => video.Checked && !chat.Checked && tabs.SelectedIndex == index);
                    var heading = headings[tab] == null ? labels.Exists(l => l.StartsWith("The log is shared by the Chat and Video workspaces.", StringComparison.Ordinal)) : labels.Contains(headings[tab]);
                    var hint = headings[tab] == null || labels.Exists(l => l.StartsWith("Video routing setup. Nothing is generated or charged from this window.", StringComparison.Ordinal));
                    using (var middle = Shot())
                    {
                        var changed = Differing(first, middle);
                        Post(() => chat.PerformClick());
                        Thread.Sleep(900);
                        using (var last = Shot())
                        {
                            var back = Ui(() => chat.Checked && !video.Checked && tabs.SelectedIndex == index);
                            var differing = Differing(first, last);
                            if (differing != 0) Console.WriteLine("     section " + tab + " differs at " + Where(first, last) + "; heading " + heading + ", hint " + hint + ", in video " + inVideo + ", back " + back);
                            else if (!(inVideo && heading && hint && back)) Console.WriteLine("     section " + tab + ": heading " + heading + ", hint " + hint + ", in video " + inVideo + ", back " + back);
                            Check("section " + tab + ": Video shows " + (headings[tab] ?? "the shared log") + " on the same section, and Chat comes back identical (" + differing + " differing pixels of " + first.Width * first.Height + "; the Video view differed in " + changed + ")",
                                inVideo && heading && hint && back && differing == 0 && (headings[tab] == null || changed > 0));
                        }
                    }
                }
            }
            var children = 0;
            using (var me = Process.GetCurrentProcess())
            {
                foreach (var p in Process.GetProcessesByName("node")) { p.Dispose(); }
                children = Ui(() => ((System.Windows.Forms.Timer)F("timer").GetValue(form)).Enabled ? 1 : 0);
            }
            Check("the preview window's status timer is off: it polls nothing", children == 0);
        }
    }
}
