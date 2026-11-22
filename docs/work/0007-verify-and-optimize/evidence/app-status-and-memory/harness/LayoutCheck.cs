using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace DSHProxy
{
    // Layout check, not part of the product. Opens the app's real window as a
    // preview (nothing is started, read or changed), fills its pages with
    // sample and synthetic rows, and at each window size captures every page
    // and state and checks the layout by program:
    //   margins   the column's left and right margins in the window are equal
    //             within 1 px, and so are the insets of what is in the column
    //   inside    every visible control lies inside its parent's client area
    //   text      no text is wider or taller than the control that shows it
    //   hscroll   no control has a horizontal scroll bar
    //   overlap   no two sibling controls overlap
    //   columns   the columns of every list add up to the list's client width
    //   setup     Video > DeepSeek Harness says the state of the video tools
    //             that was read, and the dialogs of Apply to DeepSeek Harness
    //             say what they have to and can always be left
    // The window is off screen and is never activated.
    //   LayoutCheck <worktree> <throwaway folder> <output folder> <spare port> [only: text in a capture name]
    internal static class LayoutCheck
    {
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
        [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
        [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr window, int index);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        private delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
        private static readonly HookProc NoActivation = (code, w, l) => code == 5 ? (IntPtr)1 : CallNextHookEx(IntPtr.Zero, code, w, l);

        private static readonly string[] CheckNames = { "margins", "inside", "text", "hscroll", "overlap", "columns", "scroll", "apply", "setup" };
        private static MainForm form;
        private static string outDir;
        private static string only;
        private static StreamWriter results;
        private static int captures, checksRun, checksPassed, capturesClean, foregroundTaken, warnings;
        private static readonly SortedDictionary<string, int> failureKinds = new SortedDictionary<string, int>();
        private static string origin;
        // What the capture being taken has to say about the first-time setup; null for a capture that shows none of it.
        private static Action<Form, List<string>> setupCheck;

        private const BindingFlags Any = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
        private static FieldInfo F(string name) { var f = typeof(MainForm).GetField(name, Any); if (f == null) throw new MissingFieldException(name); return f; }
        private static T G<T>(string name) { return (T)F(name).GetValue(form); }
        private static object Do(string method, params object[] args)
        {
            foreach (var m in typeof(MainForm).GetMethods(Any)) if (m.Name == method && m.GetParameters().Length == args.Length) return m.Invoke(form, args);
            throw new MissingMethodException(method);
        }
        private static T Ui<T>(Func<T> read) { return (T)form.Invoke(read); }
        private static void Ui(Action act) { form.Invoke(act); }

        private static void Foreground()
        {
            uint pid;
            GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            if (pid == (uint)Process.GetCurrentProcess().Id) foregroundTaken++;
        }

        // Lets the window finish what it posted to itself (the lists fit their
        // columns a moment after they are resized).
        private static void Settle()
        {
            for (var i = 0; i < 3; i++) { Thread.Sleep(90); Ui(() => { }); Foreground(); }
        }

        private static int Main(string[] args)
        {
            var realRoot = args[0];
            var rigDir = args[1];
            outDir = args[2];
            var port = int.Parse(args[3], CultureInfo.InvariantCulture);
            only = args.Length > 4 ? args[4] : null;
            if (port == 8417 || port == 8418) return 2;
            origin = "http://127.0.0.1:" + port;
            var home = Path.Combine(rigDir, "home");
            Directory.CreateDirectory(Path.Combine(rigDir, "localappdata"));
            Directory.CreateDirectory(outDir);
            Environment.SetEnvironmentVariable("DSHPROXY_HOME", home);
            Environment.SetEnvironmentVariable("DSH_HOME", Path.Combine(rigDir, "no-deepseek-harness"));
            Environment.SetEnvironmentVariable("LOCALAPPDATA", Path.Combine(rigDir, "localappdata"));
            var display = CultureInfo.GetCultureInfo("en-US");
            CultureInfo.DefaultThreadCurrentCulture = display;
            CultureInfo.DefaultThreadCurrentUICulture = display;
            Application.CurrentCulture = display;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            SetWindowsHookEx(5, NoActivation, IntPtr.Zero, GetCurrentThreadId());

            // What the command line reports for a throwaway data folder (no
            // gateway is running there): the real shape, to be filled with rows.
            var cli = new Cli(realRoot, Cli.FindNode());
            var read = cli.Run(new[] { "status", "--json" }, null, 60000);
            if (read.Code != 0) { Console.WriteLine("FAIL status --json: " + read.Err); return 1; }
            var status = Json.Obj(Json.Serializer.DeserializeObject(read.Out));
            var limits = Json.Obj(Json.Serializer.DeserializeObject(File.ReadAllText(Path.Combine(realRoot, "app", "preview-limits.json"))));

            form = new MainForm(false, Json.Serializer.Serialize(limits));
            F("lastOrigin").SetValue(form, origin);
            // No limits are read from anywhere: the window believes a read is under way.
            F("loadingLimits").SetValue(form, true);
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(-12000, 0);
            form.MaximumSize = new Size(6000, 3000);
            results = new StreamWriter(Path.Combine(outDir, only == null ? "results.txt" : "results-" + only + ".txt"), false, new UTF8Encoding(false));
            var failed = false;
            var test = new Thread(() =>
            {
                try
                {
                    Thread.Sleep(1200);
                    Run(status, limits);
                }
                catch (Exception error)
                {
                    Console.WriteLine("FAIL the check itself stopped: " + error);
                    failed = true;
                }
                try { form.BeginInvoke(new Action(() => { F("quitting").SetValue(form, true); Application.Exit(); })); } catch (InvalidOperationException) { }
            });
            test.IsBackground = true;
            test.Start();
            Application.Run(form);
            test.Join(20000);
            var summary = new List<string>();
            summary.Add("");
            summary.Add("captures: " + captures + "; with every program check passed: " + capturesClean);
            summary.Add("program checks: " + checksPassed + " of " + checksRun + " passed");
            foreach (var pair in failureKinds) summary.Add("  failing lines of kind " + pair.Key + ": " + pair.Value);
            summary.Add("pictures that changed while they were taken: " + retaken);
            summary.Add("notes for the eye (not counted as failures): " + warnings);
            summary.Add(foregroundTaken == 0 ? "the window never became the foreground window" : "FAIL the window was the foreground window in " + foregroundTaken + " samples");
            foreach (var line in summary) { results.WriteLine(line); Console.WriteLine(line); }
            results.Dispose();
            return failed || foregroundTaken != 0 ? 1 : 0;
        }

        // ---------------------------------------------------------------
        private static Dictionary<string, object> Map(params object[] pairs)
        {
            var map = new Dictionary<string, object>();
            for (var i = 0; i < pairs.Length; i += 2) map[(string)pairs[i]] = pairs[i + 1];
            return map;
        }

        // The status with rows on every page: a key saved and one that cannot
        // be read, lanes with a model that serves, one sitting out and ones
        // that cannot, a model with a long name, profiles, and a newer backend.
        private static string Filled(Dictionary<string, object> status, bool update)
        {
            var s = new Dictionary<string, object>(status);
            s["running"] = true;
            s["origin"] = origin;
            s["backend"] = Map("name", "CLIProxyAPI", "version", "8.0.72", "running", true, "pid", 4242);
            s["update"] = update ? Map("available", true, "latest", "8.0.73", "publishedAt", "2026-11-20T10:00:00.000Z") : Map("available", false);
            s["backendLock"] = Map("version", "8.0.72", "publishedAt", "2026-11-02T10:00:00.000Z", "previous", update ? "8.0.71" : "");
            var providers = Json.Arr(Json.Get(s, "providers"));
            var keys = new Dictionary<string, object>(Json.Obj(Json.Get(s, "apiKeys")));
            var unreadable = new ArrayList();
            if (providers.Count > 1)
            {
                var readable = new List<string>();
                foreach (var item in Json.Arr(Json.Get(keys, "readable"))) readable.Add(Json.Str(Json.Get(Json.Obj(item), "provider")));
                foreach (var item in providers)
                {
                    var key = Json.Str(Json.Get(Json.Obj(item), "key"));
                    if (!readable.Contains(key)) { unreadable.Add(key); break; }
                }
            }
            keys["unreadable"] = unreadable.ToArray();
            s["apiKeys"] = keys;
            var lanes = new ArrayList();
            foreach (var item in Json.Arr(Json.Get(s, "lanes")))
            {
                var lane = new Dictionary<string, object>(Json.Obj(item));
                var ladder = new ArrayList();
                var index = 0;
                foreach (var rungItem in Json.Arr(Json.Get(lane, "ladder")))
                {
                    var rung = new Dictionary<string, object>(Json.Obj(rungItem));
                    if (index == 0) rung["available"] = true;
                    if (index == 1) { rung["available"] = true; rung["coolingUntil"] = "2026-11-22T23:00:00.000Z"; }
                    ladder.Add(rung);
                    index++;
                }
                lane["ladder"] = ladder.ToArray();
                lanes.Add(lane);
            }
            s["lanes"] = lanes.ToArray();
            // Without a gateway the command line lists no models: rows in the
            // shape it reports, named after the models of the lanes. The
            // longest name among them is deepseek/deepseek-v4-pro.
            var three = new object[] { "low", "medium", "high" };
            s["modelList"] = new object[]
            {
                Model("claude-haiku-5-5", "claude", 200000, 64000, three, true, "new", true),
                Model("claude-fable-5-2", "claude", 1000000, 128000, new object[] { "low", "medium", "high", "xhigh" }, true, "known", false),
                Model("claude-opus-5-5", "claude", 1000000, 128000, new object[] { "low", "medium", "high", "xhigh" }, true, "known", false),
                Model("gpt-6-astra", "codex", 400000, 128000, new object[] { "minimal", "low", "medium", "high" }, true, "known", false),
                Model("gpt-6-luna", "codex", 400000, 128000, three, true, "switched on", false),
                Model("gemini-4-carbon-high", "antigravity", 1048576, 65536, new object[0], true, "known", false),
                Model("gemini-3.8-flash-high", "antigravity", 1048576, 65536, new object[0], false, "switched off", false),
                Model("kimi-k3-thinking", "kimi", 262144, 32768, new object[0], true, "known", false),
                Model("deepseek/deepseek-v4-pro", "deepseek", 131072, 65536, three, true, "known", false),
                Model("deepseek/deepseek-flash", "deepseek", 131072, 8192, new object[0], true, "known", false)
            };
            s["suggestions"] = new object[] { Map("from", "gpt-6-astra", "to", "gpt-6-astra-pro-extended", "lanes", new object[] { "main", "architect" }) };
            var harness = new Dictionary<string, object>(Json.Obj(Json.Get(s, "deepseekHarness")));
            harness["profiles"] = new object[]
            {
                Map("profile", "default", "routes", new object[] { Map("models", 7), Map("models", 3) }, "current", true, "error", ""),
                Map("profile", "work-profile-with-a-long-name", "routes", new object[] { Map("models", 12) }, "current", false, "error", ""),
                Map("profile", "empty", "routes", new object[0], "current", false, "error", ""),
                Map("profile", "broken", "routes", new object[0], "current", false, "error", "settings.json could not be read: unexpected end of input")
            };
            s["deepseekHarness"] = harness;
            return Json.Serializer.Serialize(s);
        }

        private static Dictionary<string, object> Model(string id, string account, int context, int output, object[] efforts, bool offered, string reason, bool isNew)
        {
            return Map("id", id, "name", id, "account", account, "contextWindow", context, "maxTokens", output, "efforts", efforts, "offered", offered, "reason", reason, "isNew", isNew);
        }

        private static void ShowChat(Dictionary<string, object> status, Dictionary<string, object> limits, bool update)
        {
            Do("ShowStatus", new Cli.Result { Code = 0, Out = Filled(status, update), Err = "" });
            // The account cards, one of them with a 60 character e-mail.
            var accounts = new ArrayList();
            var first = true;
            foreach (var item in Json.Arr(Json.Get(limits, "accounts")))
            {
                var account = new Dictionary<string, object>(Json.Obj(item));
                if (first) account["account"] = "firstname.middlename.lastname@a-long-subdomain.example.test".PadLeft(60, 'x');
                // The second card has everything a card can have: the Primary chip, a third button, and the strip for limit resets.
                if (accounts.Count == 1) { account["primary"] = true; account["siblings"] = 2; account["resets"] = Map("available", 2); }
                first = false;
                accounts.Add(account);
            }
            F("limitsAt").SetValue(form, (DateTime?)DateTime.Now);
            F("accountsKey").SetValue(form, "");
            Do("ShowLimits", accounts);
        }

        private sealed class Page
        {
            public string Name;
            public Action Enter;
            // Run at each size, after the window has been laid out at it.
            public Action After;
            // The check "setup" of this page; null for a page that shows nothing of the first-time setup.
            public Action<List<string>> Setup;
        }

        private static void Tab(int index) { G<PageHost>("tabs").SelectedIndex = index; }
        private static void Workspace(bool video) { G<SegmentRadio>("videoSwitch").Checked = video; G<SegmentRadio>("chatSwitch").Checked = !video; }

        private static void KreaState(string row, Color rowColor, string line, Color lineColor, bool busy, bool cancellable)
        {
            Do("ShowKreaState", row, rowColor);
            Do("SetPageStatus", G<Label>("videoAccountsStatus"), line, lineColor);
            Do("SetKreaBusy", busy, cancellable);
        }

        private static void VideoKeysState(bool[] saved, bool[] readable, bool[] environment, string line, Color color)
        {
            var list = VideoKeys.Parse(VideoKeys.Sample);
            for (var i = 0; i < list.Count && i < saved.Length; i++)
            {
                list[i].Saved = saved[i];
                list[i].Readable = saved[i] && readable[i];
                list[i].InEnvironment = environment[i];
            }
            F("videoKeys").SetValue(form, list);
            Do("FillVideoKeys");
            Do("SetPageStatus", G<Label>("videoKeysStatus"), line, color);
            var rows = G<ListView>("videoKeysList");
            if (rows.Items.Count > 0) rows.Items[0].Selected = true;
        }

        // ---------------------------------------------------------------
        // The first-time setup. What the command line says about DeepSeek
        // Harness and the video tools is one JSON line (the contract in
        // docs/work/0013-first-time-setup/spec.md). The lines here are
        // written from that contract, not taken from the app, and are put
        // into the window as if the command line had printed them: no
        // command is run, and no profile and no process list is looked at.

        // A folder name of exactly 120 characters, the longest the dialogs and the page are checked with.
        private static string Folder120(bool spaces)
        {
            var start = spaces ? "C:\\Users\\Firstname Lastname\\My Documents\\Tools and experiments\\" : "C:\\Users\\firstname.lastname\\Documents\\tools-and-experiments\\";
            var end = spaces ? " DSHProxy\\integrations\\dsh-video" : "-DSHProxy\\integrations\\dsh-video";
            var middle = spaces ? "an older copy of the gateway kept from last year for comparison and never opened again since" : "an-older-copy-of-the-gateway-kept-from-last-year-for-comparison-and-never-opened-again-since";
            var folder = start + middle.Substring(0, 120 - start.Length - end.Length) + end;
            if (folder.Length != 120) throw new InvalidOperationException("the sample folder is " + folder.Length + " characters long");
            return folder;
        }

        private const string ThisFolder = "C:\\Tools\\DSHProxy\\integrations\\dsh-video";

        private static string StatusLine(string harness, bool running, bool profileExists, string bundle, string linkedTo, bool canInstall, string reason)
        {
            return StatusLine(harness, running, profileExists, bundle, linkedTo, canInstall, reason, ThisFolder);
        }

        private static string StatusLine(string harness, bool running, bool profileExists, string bundle, string linkedTo, bool canInstall, string reason, string folder)
        {
            var linked = linkedTo ?? (bundle == "installed" || bundle == "switched-off" ? folder : null);
            // As the command line answers: quitting is enough only when
            // Harness being open is the one thing in the way.
            var afterQuit = !canInstall && running && reason == "DeepSeek Harness is running.";
            return Json.Serializer.Serialize(Map("harness", harness, "harnessRunning", running, "profile", "desktop", "profileExists", profileExists, "bundle", bundle,
                "folder", folder, "linkedTo", linked, "version", bundle == "not-installed" ? null : "0.1.0", "canInstall", canInstall, "canInstallAfterQuit", afterQuit, "reason", reason));
        }

        private const string NeverOpenedReason = "DeepSeek Harness has not been opened yet: open it once, then quit it.";
        private const string NotFoundReason = "DeepSeek Harness was not found in its usual folder or where dsh: links are registered.";

        // The states of the video tools the page has to tell apart: a name, and the line that reports it.
        private static readonly string[][] ToolsStates =
        {
            new[] { "installed", StatusLine("found", false, true, "installed", null, false, "") },
            new[] { "switched-off", StatusLine("found", true, true, "switched-off", null, false, "") },
            new[] { "other-folder", StatusLine("found", false, true, "other-folder", Folder120(false), true, "") },
            new[] { "folder-missing", StatusLine("found", true, true, "folder-missing", Folder120(true), false, "DeepSeek Harness is running.") },
            new[] { "not-installed", StatusLine("found", false, true, "not-installed", null, true, "") },
            new[] { "never-opened", StatusLine("found", false, false, "not-installed", null, false, NeverOpenedReason) },
            new[] { "not-found", StatusLine("not-found", false, false, "not-installed", null, false, NotFoundReason) },
            new[] { "could-not-be-read", "Usage: dshproxy dsh apply|verify|status|remove [--dry-run]" }
        };

        // Puts a status line into the window as if the command line had just printed it.
        private static void PutSetup(string line)
        {
            Do("ShowHarnessSetup", HarnessSetup.Parse(line), "08:41:07");
        }

        private static readonly Dictionary<string, string> toolsRows = new Dictionary<string, string>();

        // Video > DeepSeek Harness after a state was read: the row that asks
        // whether the video tools are installed says that state, no two
        // states read the same, nothing on the page still says the app
        // cannot tell, and a folder the profile points at is named in full
        // together with what puts it right.
        private static void ToolsRow(string state, string line, List<string> fails)
        {
            ListViewItem row = null;
            foreach (ListViewItem item in G<ListView>("videoHarnessList").Items) if (item.Text.EndsWith("installed in DeepSeek Harness?", StringComparison.Ordinal)) row = item;
            if (row == null) { fails.Add("the page has no row that asks whether the video tools are installed in DeepSeek Harness"); return; }
            var cell = row.SubItems.Count > 1 ? row.SubItems[1].Text : "";
            if (cell.StartsWith("Not known", StringComparison.Ordinal) || cell.IndexOf("cannot tell", StringComparison.Ordinal) >= 0)
                fails.Add("the row \"" + row.Text + "\" still says \"" + cell + "\" for the state \"" + state + "\", which was read");
            else if (cell.Length == 0 || cell.StartsWith("Not read", StringComparison.Ordinal) || cell.StartsWith("Reading", StringComparison.Ordinal) || cell.StartsWith("Sample", StringComparison.Ordinal))
                fails.Add("the row \"" + row.Text + "\" says \"" + cell + "\", not the state \"" + state + "\" that was read");
            else
            {
                var yes = cell.StartsWith("Yes", StringComparison.Ordinal);
                var no = cell.StartsWith("No ", StringComparison.Ordinal);
                if ((state == "installed" || state == "switched-off" || state == "other-folder") && !yes) fails.Add("the row says \"" + cell + "\" for the state \"" + state + "\": it does not begin with Yes");
                if ((state == "not-installed" || state == "never-opened" || state == "not-found") && !no) fails.Add("the row says \"" + cell + "\" for the state \"" + state + "\": it does not begin with No");
                if ((state == "could-not-be-read" || state == "folder-missing") && (yes || no)) fails.Add("the row says \"" + cell + "\" for the state \"" + state + "\", which is neither a plain yes nor a no");
                foreach (var pair in toolsRows) if (pair.Key != state && pair.Value == cell) fails.Add("the row says \"" + cell + "\" for the state \"" + state + "\" and for the state \"" + pair.Key + "\"");
                if (row.ForeColor == Theme.Muted) fails.Add("the row for the state \"" + state + "\" is in the colour of a row that says nothing");
            }
            toolsRows[state] = cell;
            // Everything the page says in words, the lines above and below the list.
            var said = new StringBuilder();
            Action<Control> walk = null;
            walk = c =>
            {
                if (c is Label && c.Visible) said.Append(c.Text.Replace('\u00A0', ' ')).Append('\n');
                foreach (Control child in c.Controls) walk(child);
            };
            walk(G<List<Panel>>("videoPages")[4]);
            var words = said.ToString();
            foreach (var old in new[] { "cannot tell", "does not install", "Chat routes only", "installed in DeepSeek Harness separately" })
                if (words.IndexOf(old, StringComparison.Ordinal) >= 0) fails.Add("the page still says \"" + old + "\", which is no longer true");
            if (state == "other-folder" || state == "folder-missing")
            {
                var folder = Json.Str(Json.Get(Json.Obj(Json.Serializer.DeserializeObject(line)), "linkedTo"));
                if (words.IndexOf(folder, StringComparison.Ordinal) < 0) fails.Add("the page does not name the folder the profile points at, " + folder);
                if (words.IndexOf("Apply to DeepSeek Harness", StringComparison.Ordinal) < 0 || words.IndexOf("this DSHProxy folder", StringComparison.Ordinal) < 0) fails.Add("the page does not say that Apply to DeepSeek Harness points the video tools at this DSHProxy folder");
            }
        }

        private static void Run(Dictionary<string, object> status, Dictionary<string, object> limits)
        {
            Ui(() => { SetWindowPos(form.Handle, IntPtr.Zero, -12000, 0, 1280, 880, 0x0004 | 0x0010); ShowWindow(form.Handle, 4); });
            Settle();
            if (only == "probe")
            {
                // Does showing the Models page for the first time, after it was filled, tick anything by itself?
                var said = new List<string>();
                Ui(() => { ShowChat(status, limits, false); said.Add("filled while hidden: list handle created " + G<ListView>("modelsList").IsHandleCreated + ", rows " + G<ListView>("modelsList").Items.Count); });
                Ui(() => Tab(3));
                Thread.Sleep(1500);
                Ui(() =>
                {
                    said.Add("shown: list handle created " + G<ListView>("modelsList").IsHandleCreated);
                    foreach (Form f in Application.OpenForms) if (!(f is MainForm) && f.Visible) { var label = Find<Label>(f, l => l.Text.Length > 0); said.Add("a box opened by itself: \"" + f.Text + "\": " + (label == null ? "" : label.Text)); var ok = Find<Button>(f, b => true); if (ok != null) ok.PerformClick(); }
                });
                Thread.Sleep(500);
                foreach (var line in said) { Console.WriteLine(line); results.WriteLine(line); }
                return;
            }
            var chat = new[] { "accounts", "api-keys", "lanes", "models", "harness", "log" };
            var pages = new List<Page>();
            for (var i = 0; i < chat.Length; i++)
            {
                var index = i;
                pages.Add(new Page { Name = "chat-" + chat[i], Enter = () => { ShowChat(status, limits, false); Workspace(false); Tab(index); } });
            }
            pages.Add(new Page { Name = "chat-accounts-update-bar", Enter = () => { ShowChat(status, limits, true); Workspace(false); Tab(0); } });
            pages.Add(new Page { Name = "chat-models-update-bar", Enter = () => { ShowChat(status, limits, true); Workspace(false); Tab(3); } });
            // The header of a gateway of this window that is alive and silent.
            pages.Add(new Page
            {
                Name = "chat-accounts-not-answering",
                Enter = () =>
                {
                    ShowChat(status, limits, false); Workspace(false); Tab(0);
                    Do("ShowState", "\u25CF Not answering", Theme.Warn);
                    G<Label>("detailLabel").Text = "The gateway process is running but does not answer. Stop asks before it cuts anything.";
                    Do("ShowAccountsMessage", "The gateway is not answering. Accounts and limits are shown again when it does.", Theme.Muted);
                }
            });
            // The limits arrive after the window was laid out, as they do when the
            // app starts: the header was laid out with no "Lowest limit" line, the
            // line comes, and nobody resizes the window.
            pages.Add(new Page
            {
                Name = "chat-accounts-limits-arrive",
                Enter = () => { ShowChat(status, limits, false); Workspace(false); Tab(0); },
                After = () =>
                {
                    G<Label>("lowestLabel").Text = "";
                    F("headerState").SetValue(form, -1);
                    Do("LayoutColumn");
                    ShowChat(status, limits, false);
                }
            });
            var stamp = "State read from the Krea helper at 08:41:07; it is read when this page opens, not kept up to date.";
            pages.Add(new Page { Name = "video-accounts-signed-out", Enter = () => { ShowChat(status, limits, false); Workspace(true); Tab(0); KreaState("Not signed in", Theme.Muted, stamp, Theme.Muted, false, false); } });
            pages.Add(new Page { Name = "video-accounts-waiting", Enter = () => { Workspace(true); Tab(0); KreaState("Signing in...", Theme.Muted, "Waiting for you to finish in the browser. Cancel stops the sign-in.", Theme.Accent, true, true); } });
            pages.Add(new Page { Name = "video-accounts-signed-in", Enter = () => { Workspace(true); Tab(0); KreaState("Signed in \u00B7 until Wed 30 Dec 2026, 23:59", Theme.Ok, "Signed in to Krea. " + stamp, Theme.Ok, false, false); } });
            pages.Add(new Page { Name = "video-accounts-error", Enter = () => { Workspace(true); Tab(0); KreaState("Not known", Theme.Warn, Krea.Message(Krea.Outcome.Refused) + " The Krea helper did not report the sign-in state. Open this page again to ask once more.", Theme.Bad, false, false); } });
            var readAt = "Read from DSHProxy at 08:41:07. A saved key is not checked against its provider.";
            var no = new[] { false, false, false };
            pages.Add(new Page { Name = "video-api-keys-none-saved", Enter = () => { Workspace(true); Tab(1); VideoKeysState(no, no, no, readAt, Theme.Muted); } });
            pages.Add(new Page { Name = "video-api-keys-some-saved", Enter = () => { Workspace(true); Tab(1); VideoKeysState(new[] { true, false, true }, new[] { true, false, true }, no, "Saved the VideoRouter key. It was not checked against VideoRouter. The list shows what is saved (read at 08:41:07).", Theme.Ok); } });
            pages.Add(new Page { Name = "video-api-keys-one-from-environment", Enter = () => { Workspace(true); Tab(1); VideoKeysState(new[] { true, false, false }, new[] { true, false, false }, new[] { false, true, false }, readAt, Theme.Muted); } });
            pages.Add(new Page { Name = "video-api-keys-one-unreadable", Enter = () => { Workspace(true); Tab(1); VideoKeysState(new[] { true, true, false }, new[] { true, false, false }, new[] { false, true, false }, "Not saved: A video API key cannot contain spaces, line breaks or anything else outside printable ASCII. Nothing was saved. The list shows what is saved (read at 08:41:07).", Theme.Bad); } });
            pages.Add(new Page { Name = "video-lanes", Enter = () => { Workspace(true); Tab(2); } });
            pages.Add(new Page { Name = "video-models", Enter = () => { Workspace(true); Tab(3); } });
            pages.Add(new Page { Name = "video-harness", Enter = () => { Workspace(true); Tab(4); } });
            // The same page for each state of the video tools the command line can report.
            foreach (var state in ToolsStates)
            {
                var name = state[0];
                var line = state[1];
                pages.Add(new Page { Name = "video-harness-tools-" + name, Enter = () => { Workspace(true); Tab(4); PutSetup(line); }, Setup = fails => ToolsRow(name, line, fails) });
            }
            pages.Add(new Page { Name = "video-log", Enter = () => { Workspace(true); Tab(5); } });

            Size smallest;
            var onFullHd = MainForm.StartBounds(new Rectangle(0, 0, 1920, 1080), out smallest).Size;
            var onSmall = MainForm.StartBounds(new Rectangle(0, 0, 1280, 672), out smallest).Size;
            var sizes = new List<Size>();
            foreach (var size in new[] { new Size(860, 600), onSmall, new Size(1280, 672), onFullHd, new Size(1366, 728), new Size(1536, 824), new Size(1920, 1040), new Size(2560, 1392), new Size(3440, 1392), new Size(5120, 1392) })
                if (!sizes.Contains(size)) sizes.Add(size);
            results.WriteLine("start size on a 1920x1080 working area: " + onFullHd.Width + "x" + onFullHd.Height + "; on a 1280x672 working area: " + onSmall.Width + "x" + onSmall.Height);
            results.WriteLine("each capture: the six program checks, then what failed, then notes for the eye");
            results.WriteLine("");
            Ui(() => { for (var i = 0; i < 40; i++) Do("AppendLog", "08:41:" + i.ToString("00", CultureInfo.InvariantCulture) + " [gateway] sample log line " + i + ": POST /v1/messages lane-main -> claude-opus-4-1-20250805 200 in 1234 ms"); });

            foreach (var page in pages)
            {
                var entered = false;
                foreach (var size in sizes)
                {
                    var name = page.Name + "-" + size.Width + "x" + size.Height;
                    if (only != null && name.IndexOf(only, StringComparison.Ordinal) < 0) continue;
                    if (!entered) { Ui(page.Enter); entered = true; Settle(); }
                    Ui(() => SetWindowPos(form.Handle, IntPtr.Zero, -12000, 0, size.Width, size.Height, 0x0004 | 0x0010));
                    Settle();
                    if (page.After != null) { Ui(page.After); Settle(); }
                    var pageSetup = page.Setup;
                    setupCheck = pageSetup == null ? (Action<Form, List<string>>)null : (top, fails) => pageSetup(fails);
                    Capture(name, form, size);
                    setupCheck = null;
                }
            }
            if (only == null || only.StartsWith("dialog", StringComparison.Ordinal)) Dialogs(status);
        }

        // ---------------------------------------------------------------
        private static void Dialogs(Dictionary<string, object> status)
        {
            Ui(() => { Workspace(false); Tab(0); SetWindowPos(form.Handle, IntPtr.Zero, -12000, 0, 1280, 880, 0x0004 | 0x0010); });
            Settle();
            // The key dialog names the provider: the longest label the command line reports.
            var longest = "";
            foreach (var item in Json.Arr(Json.Get(status, "providers")))
            {
                var label = Json.Str(Json.Get(Json.Obj(item), "label"));
                if (label.Length > longest.Length) longest = label;
            }
            results.WriteLine("longest provider label: " + longest);
            Modal("dialog-key-entry", () => KeyDialog.Ask(form, longest), null);
            RestartWaitDialog wait = null;
            Modal("dialog-restart-wait", () => { using (wait = new RestartWaitDialog(12, () => { })) wait.ShowDialog(form); }, dialog => ((RestartWaitDialog)dialog).Finish());
            Modal("dialog-stop-question", () => Msg.Show(form, InFlight.Question(12, false), "Stop gateway", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2), null);
            Modal("dialog-stop-question-not-answering", () => Msg.Show(form, InFlight.UnansweredQuestion(12, false), "Stop gateway", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2), null);
            Modal("dialog-quit-question-not-answering", () => Msg.Show(form, InFlight.UnansweredQuestion(12, true), "Quit DeepSeekProxy", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2), null);
            Modal("dialog-restart-question", () => Msg.Show(form, "The gateway could not be asked to wait for an idle moment:\nThe gateway's answer did not arrive: the connection was lost. It may or may not have stopped; check with `dshproxy status`.\n\n" + InFlight.RestartQuestion(12), "API key", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2), null);

            var type = typeof(SignInDialog);
            var providers = Json.Arr(Json.Get(status, "loginProviders"));
            Action<string, Action<SignInDialog>> signIn = (name, prepare) =>
            {
                Modal(name, () =>
                {
                    using (var dialog = new SignInDialog(new GatewayControl(() => origin), providers))
                    {
                        prepare(dialog);
                        dialog.ShowDialog(form);
                    }
                }, null);
            };
            signIn("dialog-sign-in-choices", dialog => { });
            // The address is not an https one, so no browser is opened.
            signIn("dialog-sign-in-waiting", dialog => type.GetMethod("ShowWaiting", Any).Invoke(dialog, new object[] { Map("id", "", "url", "about:blank", "flow", "browser"), "antigravity", "Gemini (Antigravity)" }));
            signIn("dialog-sign-in-code", dialog => type.GetMethod("ShowWaiting", Any).Invoke(dialog, new object[] { Map("id", "", "url", "about:blank", "flow", "device", "userCode", "WDJB-MJHT"), "kimi", "Kimi" }));
            signIn("dialog-sign-in-done", dialog =>
            {
                type.GetField("sessionLabel", Any).SetValue(dialog, "Gemini (Antigravity)");
                type.GetField("sessionKey", Any).SetValue(dialog, "antigravity");
                type.GetMethod("ShowSuccess", Any).Invoke(dialog, new object[] { "firstname.middlename.lastname@a-long-subdomain.example.test".PadLeft(60, 'x') });
            });
            signIn("dialog-sign-in-failed", dialog =>
            {
                type.GetField("sessionKey", Any).SetValue(dialog, "antigravity");
                type.GetMethod("ShowFailure", Any).Invoke(dialog, new object[] { "The provider did not finish the sign-in within 5 minutes. Nothing was saved. Try again, and approve access on the page that opens.", "antigravity", "Gemini (Antigravity)" });
            });
            SetupDialogs();
        }

        // ---------------------------------------------------------------
        // Apply to DeepSeek Harness, from the press of the button to what
        // it says at the end. The command line is stood in for: each of its
        // three commands gets an answer written here, in the shape the
        // contract gives it, and whether DeepSeek Harness is running is a
        // switch of this check. Nothing is run, written or installed, and
        // no process list is read. The Copy button is never pressed: the
        // clipboard belongs to the person at the machine.
        private const string StatusCommand = "dsh bundle status --json";
        private const string ApplyCommand = "dsh apply";
        private const string InstallCommand = "dsh bundle install --json";
        private static readonly List<string> ran = new List<string>();
        private static volatile bool harnessOpen;

        private static Cli.Result Said(string line) { return new Cli.Result { Code = 0, Out = line + "\n", Err = "" }; }
        private static Cli.Result Failed(string output, string errors) { return new Cli.Result { Code = 1, Out = output, Err = errors }; }

        private static void Answers(Cli.Result status, Cli.Result applied, Cli.Result installed, Cli.Result after)
        {
            lock (ran) ran.Clear();
            var reads = 0;
            var none = Failed("", "The layout check gave this command no answer.");
            form.UseSetupCommands(args =>
            {
                var command = string.Join(" ", args);
                lock (ran) ran.Add(command);
                if (command == StatusCommand) return (reads++ == 0 ? status : after) ?? none;
                if (command == ApplyCommand) return applied ?? none;
                if (command == InstallCommand) return installed ?? none;
                return none;
            });
        }

        private static string Ran() { lock (ran) return string.Join("; ", ran.ToArray()); }

        // The dialogs that are open, without those that were open before the setup dialogs began.
        private static List<Form> earlier = new List<Form>();

        private static List<Form> Shown()
        {
            return Ui(() => { var open = new List<Form>(); foreach (Form f in Application.OpenForms) if (!(f is MainForm) && f.Visible && !earlier.Contains(f)) open.Add(f); return open; });
        }

        private static Form NextDialog(List<Form> before)
        {
            var clock = Stopwatch.StartNew();
            while (clock.ElapsedMilliseconds < 8000)
            {
                Thread.Sleep(60);
                foreach (var f in Shown()) if (!before.Contains(f)) return f;
            }
            return null;
        }

        private static bool Gone(Form dialog, int ms)
        {
            var clock = Stopwatch.StartNew();
            while (clock.ElapsedMilliseconds < ms)
            {
                if (Ui(() => dialog.IsDisposed || !dialog.Visible)) return true;
                Thread.Sleep(60);
            }
            return false;
        }

        private static bool Press(Form dialog, string text)
        {
            return Ui(() =>
            {
                var button = Find<Button>(dialog, b => b.Text == text && b.Visible && b.Enabled);
                if (button == null) return false;
                button.PerformClick();
                return true;
            });
        }

        private static void Shot(string name, Form dialog, Action<Form, List<string>> check)
        {
            if (only != null && name.IndexOf(only, StringComparison.Ordinal) < 0) return;
            Settle();
            Thread.Sleep(250);
            setupCheck = check;
            Capture(name + "-" + Ui(() => dialog.Width) + "x" + Ui(() => dialog.Height), dialog, Size.Empty);
            setupCheck = null;
        }

        // Something the first-time setup has to do that no picture shows: counted with the program checks.
        private static void SetupFact(string name, List<string> problems)
        {
            checksRun++;
            if (problems.Count == 0) checksPassed++;
            results.WriteLine(name + "  | setup " + (problems.Count == 0 ? "ok;" : "FAIL;"));
            foreach (var problem in problems)
            {
                results.WriteLine("    FAIL setup: " + problem);
                int n;
                failureKinds.TryGetValue("setup", out n);
                failureKinds["setup"] = n + 1;
            }
            results.Flush();
            Console.WriteLine((problems.Count == 0 ? "ok   " : "FAIL ") + name);
        }

        // Everything a dialog says in words: its lines and its buttons.
        private static string Words(Control top)
        {
            var said = new StringBuilder();
            Action<Control> walk = null;
            walk = c =>
            {
                if ((c is Label || c is ButtonBase) && c.Visible) said.Append(c.Text.Replace('\u00A0', ' ')).Append('\n');
                foreach (Control child in c.Controls) walk(child);
            };
            walk(top);
            return said.ToString();
        }

        private static Button Has(Form top, List<string> fails, string text)
        {
            var button = Find<Button>(top, b => b.Text == text);
            if (button == null) fails.Add("the dialog has no button \"" + text + "\"");
            else if (!button.Visible || !button.Enabled) fails.Add("the button \"" + text + "\" cannot be pressed");
            return button;
        }

        // Plain words, and the words this state calls for. The answers the
        // command line is given here use the app's own words, so that what
        // is looked for is what the app itself says.
        private static void Says(Form top, List<string> fails, string[] wanted)
        {
            var words = Words(top);
            if (words.IndexOf('!') >= 0) fails.Add("the dialog has an exclamation mark");
            if (words.IndexOf("bundle", StringComparison.OrdinalIgnoreCase) >= 0) fails.Add("the dialog says \"bundle\" for the video tools");
            foreach (var want in wanted ?? new string[0])
                if (words.IndexOf(want, StringComparison.Ordinal) < 0) fails.Add("the dialog does not say \"" + want + "\"");
        }

        private static int Marks(Control top)
        {
            var n = top is MarkGlyph ? 1 : 0;
            foreach (Control child in top.Controls) n += Marks(child);
            return n;
        }

        // The question before anything is written: four marked lines, a way on and a way back.
        private static void Checklist(Form top, List<string> fails, string[] wanted)
        {
            Has(top, fails, "Apply");
            var cancel = Has(top, fails, "Cancel");
            if (cancel != null && top.CancelButton != cancel) fails.Add("Esc does not cancel");
            if (Marks(top) != 4) fails.Add("the checklist has " + Marks(top) + " marked lines, not the four it has to have");
            var all = new List<string> { "chat routes", "backed up first", "video tools", "afterwards. DSHProxy does not do that for you." };
            if (wanted != null) all.AddRange(wanted);
            Says(top, fails, all.ToArray());
        }

        // The wait for DeepSeek Harness to quit: it can always be left.
        private static void WaitCheck(Form top, List<string> fails)
        {
            var skip = Has(top, fails, "Skip the video tools");
            if (skip == null) fails.Add("the waiting dialog has no way out");
            else if (top.CancelButton != skip) fails.Add("Esc and the close box do not skip the video tools");
            if (!top.ControlBox) fails.Add("the waiting dialog has no close box");
            Says(top, fails, new[] { "Quit DeepSeek Harness to install the video tools", "tray", "closes by itself", "does not close DeepSeek Harness" });
        }

        private sealed class Flow
        {
            public string Name;
            // What the command line answers: the first look, the routes, the install, the look after it.
            public Cli.Result Status, Applied, Installed, After;
            // DeepSeek Harness is running when the routes have been written.
            public bool Open;
            // Capture names; null for a dialog that is passed without a picture.
            public string Confirm, Wait, End;
            public string[] ConfirmSays, EndSays;
            public string EndButton;
            public bool Cancel, PressAgain, Skip;
            // The commands that have to have been run, in order.
            public string Ran;
            // How the row of Video > DeepSeek Harness has to begin afterwards; null when nothing was read again.
            public string RowAfter;
        }

        private static void RunFlow(Flow flow)
        {
            var name = "dialog-setup-flow-" + flow.Name;
            var problems = new List<string>();
            harnessOpen = flow.Open;
            Answers(flow.Status, flow.Applied, flow.Installed, flow.After);
            var before = Shown();
            form.BeginInvoke(new Action(() => Do("ApplyToHarness")));
            var confirm = NextDialog(before);
            if (confirm == null)
            {
                problems.Add("the checklist did not open");
                SetupFact(name, problems);
                return;
            }
            if (flow.PressAgain)
            {
                // A second press while the first is still going.
                Ui(() => Do("ApplyToHarness"));
                Thread.Sleep(500);
                if (Ran() != StatusCommand) problems.Add("after a second press the commands run were \"" + Ran() + "\"");
                if (Shown().Count != 1) problems.Add("after a second press " + Shown().Count + " dialogs are open");
            }
            if (flow.Confirm != null) Shot(flow.Confirm, confirm, (top, fails) => Checklist(top, fails, flow.ConfirmSays));
            before = Shown();
            if (!Press(confirm, flow.Cancel ? "Cancel" : "Apply")) problems.Add("the checklist has no button \"" + (flow.Cancel ? "Cancel" : "Apply") + "\" to press");
            if (!Gone(confirm, 5000)) problems.Add("the checklist did not close");
            if (!flow.Cancel)
            {
                var next = NextDialog(before);
                if (next is HarnessWaitDialog)
                {
                    if (!flow.Open) problems.Add("the person was asked to quit a DeepSeek Harness that is not running");
                    if (flow.Wait != null) Shot(flow.Wait, next, WaitCheck);
                    before = Shown();
                    if (flow.Skip)
                    {
                        if (!Press(next, "Skip the video tools")) problems.Add("the waiting dialog has no button to skip with");
                        if (!Gone(next, 5000)) problems.Add("the waiting dialog did not close when the video tools were skipped");
                    }
                    else
                    {
                        // The person quits DeepSeek Harness.
                        Thread.Sleep(1300);
                        if (Gone(next, 100)) problems.Add("the waiting dialog closed while DeepSeek Harness was still running");
                        harnessOpen = false;
                        if (!Gone(next, 5000)) problems.Add("the waiting dialog did not close by itself within 5 s of DeepSeek Harness quitting");
                    }
                    next = NextDialog(before);
                }
                else if (flow.Open && flow.Wait != null) problems.Add("DeepSeek Harness is running and the person was not asked to quit it");
                if (next == null) problems.Add("nothing was shown at the end");
                else
                {
                    if (flow.End != null) Shot(flow.End, next, (top, fails) => { Says(top, fails, flow.EndSays); if (flow.EndButton != null) Has(top, fails, flow.EndButton); Has(top, fails, "OK"); });
                    var last = next;
                    Ui(() => last.Close());
                    if (!Gone(last, 5000)) problems.Add("the last dialog did not close");
                }
            }
            Thread.Sleep(400);
            Ui(() => { });
            foreach (var left in Shown())
            {
                problems.Add("a dialog was still open at the end: " + Ui(() => left.Text));
                Ui(() => left.Close());
            }
            if (Ran() != flow.Ran) problems.Add("the commands run were \"" + Ran() + "\", not \"" + flow.Ran + "\"");
            if (Ui(() => (bool)F("applying").GetValue(form))) problems.Add("the Apply did not end: another press would do nothing");
            if (flow.RowAfter != null)
            {
                var cell = Ui(() => G<ListView>("videoHarnessList").Items[0].SubItems[1].Text);
                if (!cell.StartsWith(flow.RowAfter, StringComparison.Ordinal)) problems.Add("after the Apply the page says \"" + cell + "\" about the video tools, not \"" + flow.RowAfter + "...\"");
            }
            SetupFact(name, problems);
        }

        private static void SetupDialogs()
        {
            // Run for the whole check, for the dialogs, and for anything that names the setup dialogs.
            if (only != null && "dialog-setup".IndexOf(only, StringComparison.Ordinal) < 0 && only.IndexOf("dialog-setup", StringComparison.Ordinal) < 0) return;
            HarnessSetup.Running = () => harnessOpen;
            // A dialog of an earlier capture that is still closing is given time to, and is not counted here.
            for (var i = 0; i < 50 && Shown().Count > 0; i++) Thread.Sleep(100);
            earlier = Shown();
            var noSpaces = Folder120(false);
            var spaces = Folder120(true);
            var firstTime = StatusLine("found", false, true, "not-installed", null, true, "");
            var firstTimeOpen = StatusLine("found", true, true, "not-installed", null, false, "DeepSeek Harness is running.");
            var installed = StatusLine("found", false, true, "installed", null, false, "");
            var installedOpen = StatusLine("found", true, true, "installed", null, false, "");
            var neverOpened = StatusLine("found", false, false, "not-installed", null, false, NeverOpenedReason);
            var routes = "default: updated (dshproxy-claude 7, dshproxy-openai 3)\nwork-profile-with-a-long-name: already up to date (dshproxy-claude 7, dshproxy-openai 3, dshproxy-compat 12)\nAdded the DSHPROXY_API_KEY credential reference.\nRestart DeepSeek Harness to load the new routes.\n";
            var written = new Cli.Result { Code = 0, Out = routes, Err = "" };
            var unchanged = new Cli.Result { Code = 0, Out = "default: already up to date (dshproxy-claude 7, dshproxy-openai 3)\nwork-profile-with-a-long-name: already up to date (dshproxy-claude 7, dshproxy-openai 3, dshproxy-compat 12)\n", Err = "" };
            var done = Said(Json.Serializer.Serialize(Map("ok", true, "bundle", "installed", "message", "Installed the video tools in the desktop profile of DeepSeek Harness.", "log", null)));
            var lastLine = "ERR_PNPM_LINKING_FAILED  EPERM: operation not permitted, symlink '" + noSpaces + "' -> 'C:\\Users\\firstname.lastname\\.dsh\\profiles\\desktop\\node_modules\\@local\\dshproxy-video'";
            var log = "C:\\Users\\firstname.lastname\\AppData\\Local\\DSHProxy\\logs\\video-tools-install-2026-11-22T22-41-07.log";
            var notDone = Failed(Json.Serializer.Serialize(Map("ok", false, "bundle", "not-installed", "message", lastLine, "log", log)) + "\n", "");

            RunFlow(new Flow
            {
                Name = "first-time-harness-closed", Status = Said(firstTime), Applied = written, Installed = done, After = Said(installed), PressAgain = true,
                Confirm = "dialog-setup-confirm-first-time-closed", ConfirmSays = new[] { "is installed and has been opened once", "The video tools will be installed in DeepSeek Harness." },
                End = "dialog-setup-result-installed", EndSays = new[] { "default: updated", "The video tools are installed in DeepSeek Harness.", "Installed the video tools in the desktop profile", "Start DeepSeek Harness again." },
                Ran = StatusCommand + "; " + ApplyCommand + "; " + InstallCommand + "; " + StatusCommand, RowAfter = "Yes"
            });
            RunFlow(new Flow
            {
                Name = "first-time-harness-open-then-quit", Status = Said(firstTimeOpen), Applied = written, Installed = done, After = Said(installed), Open = true,
                Confirm = "dialog-setup-confirm-first-time-open", ConfirmSays = new[] { "The video tools will be installed after you quit DeepSeek Harness.", "DeepSeek Harness is open now.", "you can skip that step" },
                Wait = "dialog-setup-wait",
                End = "dialog-setup-result-installed-after-quit", EndSays = new[] { "The video tools are installed in DeepSeek Harness.", "Start DeepSeek Harness again." },
                Ran = StatusCommand + "; " + ApplyCommand + "; " + InstallCommand + "; " + StatusCommand, RowAfter = "Yes"
            });
            RunFlow(new Flow
            {
                Name = "harness-open-and-skipped", Status = Said(StatusLine("found", true, true, "other-folder", noSpaces, false, "DeepSeek Harness is running.")), Applied = written, After = Said(StatusLine("found", true, true, "other-folder", noSpaces, false, "DeepSeek Harness is running.")), Open = true, Skip = true,
                Confirm = "dialog-setup-confirm-other-folder-open", ConfirmSays = new[] { "The video tools will be pointed at this DSHProxy folder after you quit DeepSeek Harness.", "from another folder", noSpaces },
                Wait = "dialog-setup-wait-skipped",
                End = "dialog-setup-result-skipped", EndSays = new[] { "The video tools were not installed, because you skipped that step.", "quit DeepSeek Harness and press Apply to DeepSeek Harness again" },
                Ran = StatusCommand + "; " + ApplyCommand + "; " + StatusCommand, RowAfter = "Yes \u00B7 from another folder"
            });
            RunFlow(new Flow
            {
                Name = "second-apply-changes-nothing", Status = Said(installedOpen), Applied = unchanged, After = Said(installedOpen), Open = true,
                Confirm = "dialog-setup-confirm-installed", ConfirmSays = new[] { "The video tools are already installed." },
                End = "dialog-setup-result-already-installed", EndSays = new[] { "default: already up to date", "The video tools were already installed. Nothing was changed for them." },
                Ran = StatusCommand + "; " + ApplyCommand + "; " + StatusCommand, RowAfter = "Yes"
            });
            RunFlow(new Flow
            {
                Name = "cancel-changes-nothing", Status = Said(neverOpened), Cancel = true,
                Confirm = "dialog-setup-confirm-never-opened", ConfirmSays = new[] { "has not been opened yet", "The video tools cannot be installed.", NeverOpenedReason, "Open DeepSeek Harness once, quit it, then press Apply to DeepSeek Harness again." },
                Ran = StatusCommand
            });
            RunFlow(new Flow
            {
                Name = "install-fails", Status = Said(StatusLine("found", false, true, "not-installed", null, true, "", noSpaces)), Applied = written, Installed = notDone, After = Said(StatusLine("found", false, true, "not-installed", null, true, "", noSpaces)),
                End = "dialog-setup-result-install-failed", EndButton = "Copy folder path", EndSays = new[] { "The video tools were not installed.", lastLine, log, "Plugins > Add plugin", noSpaces },
                Ran = StatusCommand + "; " + ApplyCommand + "; " + InstallCommand + "; " + StatusCommand, RowAfter = "No"
            });
            RunFlow(new Flow
            {
                Name = "routes-fail-and-nothing-is-installed", Status = Said(firstTime), Applied = Failed("", "DSHProxy: The profile default could not be backed up: access to C:\\Users\\firstname.lastname\\.dsh\\profiles\\default\\settings.json is denied.\n"),
                End = "dialog-setup-routes-failed", EndSays = new[] { "could not be backed up" },
                Ran = StatusCommand + "; " + ApplyCommand
            });
            RunFlow(new Flow
            {
                Name = "could-not-be-read", Status = Failed("", "Usage: dshproxy dsh apply|verify|status|remove [--dry-run]\n"), Applied = written, After = Failed("", "Usage: dshproxy dsh apply|verify|status|remove [--dry-run]\n"),
                Confirm = "dialog-setup-confirm-could-not-be-read", ConfirmSays = new[] { "DeepSeek Harness could not be checked.", "The video tools could not be checked, so they are left as they are." },
                End = "dialog-setup-result-not-checked", EndSays = new[] { "default: updated", "The video tools could not be checked. Nothing was installed." },
                Ran = StatusCommand + "; " + ApplyCommand + "; " + StatusCommand, RowAfter = "Could not be read"
            });
            // Nothing stands in for the command line from here on.
            Ui(() => form.UseSetupCommands(null));
            lock (ran) ran.Clear();

            // The button in a preview window, which this window is: the
            // checklist with a sample, and no command behind it.
            Modal("dialog-setup-confirm-preview-window", () => Do("ApplyToHarness"), null, (top, fails) => Checklist(top, fails, new[] { "The video tools will be installed in DeepSeek Harness." }));

            // The states the flows above did not pass through, shown as the app shows them.
            Action<string, string, string[]> confirm = (name, line, says) =>
                Modal("dialog-setup-confirm-" + name, () => SetupDialog.Confirm(form, HarnessSetup.Parse(line)), null, (top, fails) => Checklist(top, fails, says));
            confirm("switched-off", StatusLine("found", true, true, "switched-off", null, false, ""), new[] { "switched off in DeepSeek Harness", "They are left off." });
            confirm("folder-missing", StatusLine("found", false, true, "folder-missing", spaces, true, ""), new[] { "The video tools will be pointed at this DSHProxy folder.", "from a folder that is gone", spaces });
            confirm("not-found", StatusLine("not-found", false, false, "not-installed", null, false, NotFoundReason), new[] { "DeepSeek Harness was not found on this computer.", "The video tools cannot be installed.", NotFoundReason });
            var unsafePath = "The folder of the video tools has a character in its name that cannot be passed to DeepSeek Harness.";
            confirm("cannot-other-reason", StatusLine("found", false, true, "not-installed", null, false, unsafePath, spaces), new[] { "The video tools cannot be installed.", unsafePath });
            // Harness is open, but something else is in the way too: the
            // person is not asked to quit Harness for an install that would be refused.
            confirm("cannot-other-reason-open", StatusLine("found", true, true, "not-installed", null, false, unsafePath, spaces), new[] { "The video tools cannot be installed.", unsafePath });
            Action<string, string, HarnessSetup.Outcome, string[], string> result = (name, line, outcome, says, button) =>
                Modal("dialog-setup-result-" + name, () => { var state = HarnessSetup.Parse(line); SetupDialog.Show(form, state.Summary(routes, outcome, null, state.Folder)); }, null,
                    (top, fails) => { Says(top, fails, says); if (button != null) Has(top, fails, button); Has(top, fails, "OK"); });
            result("switched-off", StatusLine("found", true, true, "switched-off", null, false, ""), HarnessSetup.Outcome.NothingToInstall, new[] { "They were left off." }, null);
            result("never-opened", neverOpened, HarnessSetup.Outcome.NothingToInstall, new[] { "The video tools were not installed.", NeverOpenedReason, "Open DeepSeek Harness once, quit it, then press Apply to DeepSeek Harness again." }, null);
            result("cannot-other-reason", StatusLine("found", false, true, "not-installed", null, false, unsafePath, spaces), HarnessSetup.Outcome.NothingToInstall, new[] { unsafePath, "Plugins > Add plugin", spaces }, "Copy folder path");
        }

        private static void Modal(string name, Action show, Action<Form> close, Action<Form, List<string>> check = null)
        {
            if (only != null && name.IndexOf(only, StringComparison.Ordinal) < 0) return;
            var before = Ui(() => { var open = new List<Form>(); foreach (Form f in Application.OpenForms) open.Add(f); return open; });
            form.BeginInvoke(show);
            Form dialog = null;
            var clock = Stopwatch.StartNew();
            while (dialog == null && clock.ElapsedMilliseconds < 8000)
            {
                Thread.Sleep(60);
                dialog = Ui(() => { foreach (Form f in Application.OpenForms) if (!(f is MainForm) && f.Visible && !before.Contains(f)) return f; return null; });
            }
            if (dialog == null) { results.WriteLine(name + ": FAIL the dialog did not open"); return; }
            Settle();
            Thread.Sleep(250);
            setupCheck = check;
            Capture(name + "-" + Ui(() => dialog.Width) + "x" + Ui(() => dialog.Height), dialog, Size.Empty);
            setupCheck = null;
            Ui(() =>
            {
                if (close != null) { close(dialog); return; }
                var cancel = Find<Button>(dialog, b => b.Text == "Cancel" || b.Text == "No" || b.Text == "Close");
                if (cancel != null) cancel.PerformClick(); else dialog.Close();
            });
            clock.Restart();
            while (clock.ElapsedMilliseconds < 5000 && Ui(() => !dialog.IsDisposed && dialog.Visible)) Thread.Sleep(60);
            Settle();
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

        // ---------------------------------------------------------------
        private static void Capture(string name, Form top, Size wanted)
        {
            var fails = new Dictionary<string, List<string>>();
            foreach (var check in CheckNames) fails[check] = new List<string>();
            var notes = new List<string>();
            var facts = "";
            // After a resize the window shows its old backdrop stretched until a
            // timer of the app has drawn it at the new size, 160 ms after it was
            // last painted at another size: the picture waits for that. Windows
            // asks a window this far off screen for no painting, so it is painted
            // here once first, the way the picture is taken, to start that wait.
            Ui(() => Pixels(top));
            var pending = (System.Collections.IDictionary)typeof(Backdrop).GetField("Pending", BindingFlags.Static | BindingFlags.NonPublic).GetValue(null);
            for (var wait = 0; wait < 100 && Ui(() => pending.Contains(top)); wait++) Thread.Sleep(50);
            Ui(() =>
            {
                top.Refresh();
                facts = "window " + top.Width + "x" + top.Height + ", client " + top.ClientSize.Width + "x" + top.ClientSize.Height;
                if (!wanted.IsEmpty && top.Size != wanted) fails["margins"].Add("the window is " + top.Width + "x" + top.Height + ", not the " + wanted.Width + "x" + wanted.Height + " asked for");
                if (top == form) facts += Margins(fails["margins"]);
                if (top == form) HeaderApply(fails["apply"]);
                if (setupCheck != null) setupCheck(top, fails["setup"]);
                Walk(top, top, fails, notes);
            });
            // The picture is what the desktop compositor holds of the window,
            // which can be a frame behind what the window has just painted. It
            // is taken until two in a row are the same; a picture that had to
            // be taken again is said in the results.
            var shot = Ui(() => Pixels(top));
            var retakes = 0;
            var where = new List<string>();
            var width = Ui(() => top.Width);
            for (var i = 0; i < 6; i++)
            {
                Thread.Sleep(i == 0 ? 120 : 400);
                var next = Ui(() => Pixels(top));
                var differs = Differs(shot, next, width);
                shot = next;
                if (differs == null) break;
                where.Add(differs);
                retakes++;
            }
            if (retakes > 0) { notes.Add("the picture changed while it was taken, " + retakes + " times: " + string.Join("; then ", where.ToArray())); retaken++; }
            using (var bmp = new Bitmap(top.Width, top.Height, PixelFormat.Format32bppArgb))
            {
                var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                System.Runtime.InteropServices.Marshal.Copy(shot, 0, data.Scan0, shot.Length);
                bmp.UnlockBits(data);
                bmp.Save(Path.Combine(outDir, name + ".png"), ImageFormat.Png);
            }
            Foreground();
            captures++;
            var line = new StringBuilder(name + ".png  " + facts + "  |");
            var clean = true;
            foreach (var check in CheckNames)
            {
                var ok = fails[check].Count == 0;
                checksRun++;
                if (ok) checksPassed++; else clean = false;
                line.Append(" " + check + (ok ? " ok" : " FAIL") + ";");
            }
            if (clean) capturesClean++;
            results.WriteLine(line.ToString());
            foreach (var check in CheckNames)
                foreach (var fail in fails[check])
                {
                    results.WriteLine("    FAIL " + check + ": " + fail);
                    int n;
                    failureKinds.TryGetValue(check, out n);
                    failureKinds[check] = n + 1;
                }
            foreach (var note in notes) { results.WriteLine("    look: " + note); warnings++; }
            results.Flush();
            Console.WriteLine((clean ? "ok   " : "FAIL ") + name);
        }

        private static int retaken;

        private static byte[] Pixels(Form top)
        {
            using (var bmp = new Bitmap(top.Width, top.Height, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bmp)) { var dc = g.GetHdc(); PrintWindow(top.Handle, dc, 2); g.ReleaseHdc(dc); }
                var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                var bytes = new byte[data.Stride * data.Height];
                System.Runtime.InteropServices.Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
                bmp.UnlockBits(data);
                return bytes;
            }
        }

        // Null when two pictures are the same; otherwise the rectangle that holds every differing pixel.
        private static string Differs(byte[] a, byte[] b, int width)
        {
            if (a.Length != b.Length) return "another size";
            int left = int.MaxValue, top = int.MaxValue, right = -1, bottom = -1, n = 0;
            for (var i = 0; i < a.Length; i += 4)
            {
                if (a[i] == b[i] && a[i + 1] == b[i + 1] && a[i + 2] == b[i + 2]) continue;
                var x = (i / 4) % width;
                var y = (i / 4) / width;
                if (x < left) left = x;
                if (x > right) right = x;
                if (y < top) top = y;
                if (y > bottom) bottom = y;
                n++;
            }
            return n == 0 ? null : n + " pixels in x " + left + ".." + right + ", y " + top + ".." + bottom;
        }

        private static string Where(Control c, Control top)
        {
            var parts = new List<string>();
            for (var at = c; at != null && at != top; at = at.Parent)
            {
                var text = at.Text ?? "";
                text = text.Replace("\r", "").Replace("\n", " / ");
                if (text.Length > 34) text = text.Substring(0, 34) + "...";
                parts.Insert(0, at.GetType().Name + (text.Length > 0 && !(at is TextBox) ? " \"" + text + "\"" : ""));
            }
            if (parts.Count > 3) parts.RemoveRange(0, parts.Count - 3);
            return string.Join(" > ", parts.ToArray());
        }

        private static Rectangle In(Control c, Control ancestor)
        {
            return ancestor.RectangleToClient(c.Parent.RectangleToScreen(c.Bounds));
        }

        // The column in the window, and what is in the column.
        private static string Margins(List<string> fails)
        {
            var column = G<Panel>("column");
            var left = column.Left;
            var right = form.ClientSize.Width - column.Right;
            if (Math.Abs(left - right) > 1) fails.Add("the column has " + left + " px to its left and " + right + " px to its right");
            var min = int.MaxValue;
            var max = int.MinValue;
            Control leftmost = null, rightmost = null;
            Action<Control> walk = null;
            walk = c =>
            {
                var hasVisibleChild = false;
                foreach (Control child in c.Controls) if (child.Visible && child.Width > 0 && child.Height > 0) { hasVisibleChild = true; walk(child); }
                if (hasVisibleChild && !(c is ListView) || c == column) return;
                // The section strip is as wide as the column; what it shows is the capsule in its middle.
                var strip = c as NavStrip;
                if (strip != null)
                {
                    var at = In(strip, column);
                    var capsule = Math.Min(strip.CapsuleWidth, strip.Width);
                    var from = at.Left + Math.Max(0, (strip.Width - capsule) / 2);
                    if (from < min) { min = from; leftmost = c; }
                    if (from + capsule > max) { max = from + capsule; rightmost = c; }
                    return;
                }
                // An empty panel is a spacer, not content.
                if (c is Panel && !(c is PageHost) && c.Controls.Count == 0 && c.GetType() == typeof(Panel)) return;
                var r = In(c, column);
                if (r.Left < min) { min = r.Left; leftmost = c; }
                if (r.Right > max) { max = r.Right; rightmost = c; }
            };
            walk(column);
            var insetLeft = min;
            var insetRight = column.Width - max;
            if (Math.Abs(insetLeft - insetRight) > 1) fails.Add("what is in the column starts " + insetLeft + " px from its left edge (" + Where(leftmost, form) + ") and ends " + insetRight + " px from its right edge (" + Where(rightmost, form) + ")");
            return ", column " + column.Width + " wide with " + left + " and " + right + " px beside it, content inset " + insetLeft + " and " + insetRight;
        }

        // The button that writes the routes into DeepSeek Harness: one, in the
        // header at the top of the window, whole, readable and able to be
        // pressed, on every page of both workspaces; and no second one on a page.
        private static void HeaderApply(List<string> fails)
        {
            var header = G<TableLayoutPanel>("headerPanel");
            var found = new List<Button>();
            Action<Control> walk = null;
            walk = c =>
            {
                var button = c as Button;
                if (button != null && (button.Text ?? "").StartsWith("Apply to", StringComparison.Ordinal)) found.Add(button);
                foreach (Control child in c.Controls) walk(child);
            };
            walk(form);
            Button apply = null;
            foreach (var button in found)
            {
                var inHeader = false;
                for (Control at = button; at != null; at = at.Parent) if (at == header) inHeader = true;
                if (!inHeader) { fails.Add(Where(button, form) + " is on a page, not in the header"); continue; }
                if (apply != null) fails.Add("the header has more than one button that applies to DeepSeek Harness");
                apply = button;
            }
            if (apply == null) { fails.Add("the header has no button that applies to DeepSeek Harness"); return; }
            for (Control at = apply; at != null && at != form; at = at.Parent)
                if (!at.Visible) { fails.Add("\"" + apply.Text + "\" is not shown: " + Where(at, form) + " is hidden"); return; }
            if (!apply.Enabled) fails.Add("\"" + apply.Text + "\" cannot be pressed");
            if (apply.Text != "Apply to DeepSeek Harness" && apply.Text != "Apply to Harness") fails.Add("the button says \"" + apply.Text + "\", which does not say what it applies to");
            var place = In(apply, form);
            var room = In(header, form);
            if (!room.Contains(place)) fails.Add("\"" + apply.Text + "\" at " + place.X + "," + place.Y + " " + place.Width + "x" + place.Height + " is not inside the header at " + room.X + "," + room.Y + " " + room.Width + "x" + room.Height);
            if (!form.ClientRectangle.Contains(place)) fails.Add("\"" + apply.Text + "\" is not inside the window");
            if (room.Top != 0) fails.Add("the header starts " + room.Top + " px down the window, not at its top");
            var start = G<Button>("startButton");
            if (start.Parent != apply.Parent) fails.Add("\"" + apply.Text + "\" does not stand in the row of Start and Stop");
            else if (Math.Abs((apply.Top + apply.Bottom) - (start.Top + start.Bottom)) > 2) fails.Add("\"" + apply.Text + "\" stands " + Math.Abs((apply.Top + apply.Bottom) - (start.Top + start.Bottom)) / 2.0 + " px off the middle of Start beside it");
            if (Skin.KindOf(apply) != ButtonKind.Primary) fails.Add("\"" + apply.Text + "\" is not drawn as the main button");
        }
        private static void Walk(Control c, Control top, Dictionary<string, List<string>> fails, List<string> notes)
        {
            if (c.IsHandleCreated && (GetWindowLong(c.Handle, -16) & 0x00100000) != 0) fails["hscroll"].Add(Where(c, top) + " has a horizontal scroll bar");
            Text(c, top, fails["text"], notes);
            var list = c as ListView;
            if (list != null && list.View == View.Details && list.Columns.Count > 0)
            {
                var sum = 0;
                foreach (ColumnHeader column in list.Columns) sum += column.Width;
                if (sum != list.ClientSize.Width) fails["columns"].Add(Where(c, top) + ": the columns add up to " + sum + ", the list is " + list.ClientSize.Width + " wide inside");
            }
            var shown = new List<Control>();
            foreach (Control child in c.Controls) if (child.Visible && child.Width > 0 && child.Height > 0) shown.Add(child);
            var scrolls = c is ScrollableControl && ((ScrollableControl)c).AutoScroll;
            // A panel that scrolls: the range it scrolls over ends where what is in it ends.
            if (scrolls && shown.Count > 0)
            {
                var panel = (ScrollableControl)c;
                var bottom = 0;
                foreach (var child in shown) bottom = Math.Max(bottom, child.Bottom - panel.AutoScrollPosition.Y);
                // The display rectangle is the scrolled range without the padding.
                var range = panel.DisplayRectangle.Height + panel.Padding.Vertical;
                var needsBar = bottom > panel.ClientSize.Height;
                if (needsBar && Math.Abs(range - bottom) > 1) fails["scroll"].Add(Where(c, top) + " scrolls over " + range + " px, what is in it ends at " + bottom);
                if (needsBar != panel.VerticalScroll.Visible) fails["scroll"].Add(Where(c, top) + (needsBar ? " needs a scroll bar and has none" : " has a scroll bar it does not need") + " (content " + bottom + ", room " + panel.ClientSize.Height + ")");
            }
            foreach (var child in shown)
            {
                var b = child.Bounds;
                var client = c.ClientRectangle;
                // A panel that scrolls up and down may hold more than it shows; nothing may stick out sideways.
                var inside = scrolls ? b.Left >= 0 && b.Right <= client.Right : client.Contains(b);
                if (!inside) fails["inside"].Add(Where(child, top) + " at " + b.X + "," + b.Y + " " + b.Width + "x" + b.Height + " is not inside its parent's " + client.Width + "x" + client.Height);
            }
            for (var i = 0; i < shown.Count; i++)
                for (var j = i + 1; j < shown.Count; j++)
                {
                    var both = Rectangle.Intersect(shown[i].Bounds, shown[j].Bounds);
                    if (both.Width > 0 && both.Height > 0) fails["overlap"].Add(Where(shown[i], top) + " and " + Where(shown[j], top) + " overlap by " + both.Width + "x" + both.Height);
                }
            Rows(shown, top, notes);
            foreach (var child in shown) Walk(child, top, fails, notes);
        }

        // Buttons that stand side by side should stand on one line.
        private static void Rows(List<Control> shown, Control top, List<string> notes)
        {
            for (var i = 0; i < shown.Count; i++)
                for (var j = i + 1; j < shown.Count; j++)
                {
                    var a = shown[i];
                    var b = shown[j];
                    // A line of text beside a button: the middle of the text against the middle of the button.
                    if (a.Parent is FlowLayoutPanel && (a is Label && b is ButtonBase || a is ButtonBase && b is Label) && !(a is Chip) && !(b is Chip))
                    {
                        var label = a as Label ?? (Label)b;
                        var button = a is Label ? b : a;
                        var oneLine = label.GetPreferredSize(Size.Empty).Height - label.Padding.Vertical;
                        if (label.Text.Length == 0 || label.Height - label.Padding.Vertical > oneLine + 4 || label.Bottom <= button.Top || button.Bottom <= label.Top) continue;
                        var textMiddle = label.Top * 2 + label.Padding.Top * 2 + (label.Height - label.Padding.Vertical);
                        var apart = Math.Abs(textMiddle - (button.Top + button.Bottom)) / 2.0;
                        if (apart > 2) notes.Add("the text \"" + (label.Text.Length > 40 ? label.Text.Substring(0, 40) + "..." : label.Text) + "\" stands " + apart + " px off the middle of the button \"" + button.Text + "\" beside it");
                        continue;
                    }
                    // A drop-down beside a button counts as one of the row.
                    if (!(a is ButtonBase || a is ComboBox) || !(b is ButtonBase || b is ComboBox) || a is RadioButton != b is RadioButton || (a is ComboBox && b is ComboBox)) continue;
                    if (a.Bottom <= b.Top || b.Bottom <= a.Top) continue;
                    var centre = Math.Abs((a.Top + a.Bottom) - (b.Top + b.Bottom));
                    if (centre > 2) notes.Add("\"" + a.Text + "\" and \"" + b.Text + "\" stand side by side, centres " + centre / 2.0 + " px apart");
                }
        }

        private static int LineWidth(string text, Font font)
        {
            var widest = 0;
            foreach (var line in text.Replace("\r", "").Split('\n')) widest = Math.Max(widest, TextRenderer.MeasureText(line, font, Size.Empty, TextFormatFlags.NoPrefix).Width);
            return widest;
        }

        private static void Text(Control c, Control top, List<string> fails, List<string> notes)
        {
            var text = c.Text ?? "";
            var label = c as Label;
            if (label != null && text.Length > 0)
            {
                var one = label.GetPreferredSize(Size.Empty);
                if (one.Width > label.Width || one.Height > label.Height)
                {
                    var wrapped = label.GetPreferredSize(new Size(label.Width, 0));
                    if (wrapped.Width > label.Width || wrapped.Height > label.Height)
                        fails.Add(Where(c, top) + " is " + label.Width + "x" + label.Height + "; its text needs " + one.Width + "x" + one.Height + " on one line, " + wrapped.Width + "x" + wrapped.Height + " wrapped");
                    else Orphan(label, top, notes);
                }
                return;
            }
            var button = c as ButtonBase;
            if (button != null && text.Length > 0)
            {
                var need = button.GetPreferredSize(Size.Empty).Width;
                var plain = LineWidth(text, button.Font) + (button.Image != null ? button.Image.Width + 8 : 0) + button.Padding.Horizontal;
                // The button's own measure when it has one, and never less than the bare text.
                if (button.AutoSize ? need > button.Width : plain > button.Width)
                    fails.Add(Where(c, top) + " is " + button.Width + " wide; its text needs " + (button.AutoSize ? need : plain));
                return;
            }
            var combo = c as ComboBox;
            if (combo != null && combo.Text.Length > 0)
            {
                var need = LineWidth(combo.Text, combo.Font) + 26;
                if (need > combo.Width) fails.Add(Where(c, top) + " is " + combo.Width + " wide; its text needs " + need);
                return;
            }
            var nav = c as NavStrip;
            if (nav != null)
            {
                if (nav.CapsuleWidth > nav.Width) fails.Add("the section strip is " + nav.Width + " wide; its sections need " + nav.CapsuleWidth);
                return;
            }
            var list = c as ListView;
            if (list == null || list.View != View.Details) return;
            using (var headerFont = Theme.Ui(8.5f, FontStyle.Bold))
                foreach (ColumnHeader column in list.Columns)
                {
                    // A column that is left out; its cells are looked at below.
                    if (column.Width == 0 && column.Index > 0) continue;
                    var need = LineWidth(column.Text, headerFont);
                    if (need > column.Width - 12) fails.Add(Where(c, top) + ": the heading \"" + column.Text + "\" needs " + need + ", its column leaves " + (column.Width - 12));
                }
            var images = list.SmallImageList;
            foreach (ListViewItem item in list.Items)
                for (var i = 0; i < item.SubItems.Count && i < list.Columns.Count; i++)
                {
                    var cell = item.SubItems[i].Text ?? "";
                    if (cell.Length == 0) continue;
                    var x = 10;
                    if (i == 0)
                    {
                        if (list.CheckBoxes) x = 8 + 18 + 10;
                        if (images != null && images.ImageSize.Width > 1) x += images.ImageSize.Width + 10;
                    }
                    var width = list.Columns[i].Width;
                    if (width == 0 && i > 0)
                    {
                        // A column that is left out: the row has to say the same in its tip.
                        if (!list.ShowItemToolTips || (item.ToolTipText ?? "").IndexOf(cell, StringComparison.Ordinal) < 0)
                            fails.Add(Where(c, top) + ": the column \"" + list.Columns[i].Text + "\" is left out, and the tip of the row \"" + item.Text + "\" (\"" + item.ToolTipText + "\") does not say \"" + cell + "\"");
                        else if (item.Index == 0)
                            notes.Add(Where(c, top) + ": the column \"" + list.Columns[i].Text + "\" is left out (the list is " + list.ClientSize.Width + " wide inside); every row is checked to say it in its tip, the first: \"" + item.ToolTipText + "\"");
                        continue;
                    }
                    var font = item.Font ?? list.Font;
                    if (Skin.IsLadder(list, i, cell))
                    {
                        // A ladder of chips, on as many lines as the row holds.
                        int lines;
                        var room = width - x - Skin.CellRight;
                        var chips = Skin.LadderChips(list.Font, cell.Split('\u0001'), room, out lines);
                        var holds = Math.Max(1, item.Bounds.Height / Skin.LadderLine);
                        if (lines > holds) fails.Add(Where(c, top) + ": the ladder of \"" + item.Text + "\" (" + chips.Count + " models) needs " + lines + " lines of " + room + " px, its row holds " + holds);
                        foreach (var chip in chips) if (chip.Right > room) fails.Add(Where(c, top) + ": a model of the ladder of \"" + item.Text + "\" needs " + chip.Right + ", its column leaves " + room);
                        continue;
                    }
                    var needed = TextRenderer.MeasureText(cell, font, Size.Empty, TextFormatFlags.NoPrefix).Width;
                    if (needed > width - x - 6) fails.Add(Where(c, top) + ": \"" + (cell.Length > 60 ? cell.Substring(0, 60) + "..." : cell) + "\" in column " + (i + 1) + " needs " + needed + ", the column leaves " + (width - x - 6));
                }
        }

        // A wrapped note whose last line is a single word.
        private static void Orphan(Label label, Control top, List<string> notes)
        {
            var words = label.Text.Replace("\r", "").Replace("\n", " ").Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries); // a no-break space keeps two words in one piece
            if (words.Length < 4) return;
            var room = label.Width - label.Padding.Horizontal;
            var lines = 1;
            var onLine = 0;
            var line = "";
            foreach (var word in words)
            {
                var tried = line.Length == 0 ? word : line + " " + word;
                if (line.Length > 0 && TextRenderer.MeasureText(tried, label.Font, Size.Empty, TextFormatFlags.NoPrefix).Width > room)
                {
                    lines++;
                    line = word;
                    onLine = 1;
                }
                else { line = tried; onLine++; }
            }
            if (lines > 1 && onLine == 1 && line.IndexOf('\u00A0') < 0) notes.Add("the wrapped note \"" + (label.Text.Length > 50 ? label.Text.Substring(0, 50) + "..." : label.Text) + "\" ends in a line with the single word \"" + line + "\"");
        }
    }
}
