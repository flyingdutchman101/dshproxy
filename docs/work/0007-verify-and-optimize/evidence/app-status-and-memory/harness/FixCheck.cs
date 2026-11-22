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
    // Seam check, not part of the product. Runs the app's real main window in
    // its normal mode, as `DSHProxy.exe --hidden` starts it, in a throwaway
    // data folder with spare ports.
    //   flow    the restart after a Chat key change, Stop and Quit: against the
    //           real daemon (its backend replaced by a local stand-in server)
    //           and against a stand-in gateway whose end can be timed
    //   follow  what the window notices of a gateway it did not start
    //   count   processes and CPU over 5 minutes visible and 5 minutes hidden
    // The window is off screen and is never activated: a hook on this
    // program's own UI thread refuses every activation.
    internal static class FixCheck
    {
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
        [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int length, IntPtr returned);
        [StructLayout(LayoutKind.Sequential)]
        private struct Accounting
        {
            public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
        }
        private delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
        private static readonly HookProc NoActivation = (code, w, l) => code == 5 ? (IntPtr)1 : CallNextHookEx(IntPtr.Zero, code, w, l);

        private static int failed;
        private static int foregroundTaken;
        private static MainForm form;
        private static string rigDir, home, stubLog, modeFile, commandFile, gatewayLog, node, fakeScript;
        private static int port;
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
        private const string LateLine = "The gateway had already begun to stop; it was started again.";

        private static void Check(string what, bool ok) { Console.WriteLine((ok ? "ok   " : "FAIL ") + what); if (!ok) failed++; Console.Out.Flush(); }
        private static void Note(string text) { Console.WriteLine("     " + text); Console.Out.Flush(); }
        private static void Head(string text) { Console.WriteLine("--- " + text + " ---"); Console.Out.Flush(); }

        private const BindingFlags Any = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
        private static FieldInfo F(string name) { return typeof(MainForm).GetField(name, Any); }
        private static T Ui<T>(Func<T> read) { return (T)form.Invoke(read); }
        private static T Get<T>(string name) { return Ui(() => (T)F(name).GetValue(form)); }
        private static void Post(Action act) { form.BeginInvoke(act); }
        private static void Call(string method) { var m = typeof(MainForm).GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic); Post(() => m.Invoke(form, null)); }

        private static void Foreground()
        {
            uint pid;
            GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            if (pid == (uint)Process.GetCurrentProcess().Id) foregroundTaken++;
        }

        // Seconds until `done`, or -1 when it did not happen in `ms`.
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

        private static string Secs(double s) { return s < 0 ? "not within the wait" : s.ToString("0.0", CultureInfo.InvariantCulture) + " s"; }

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

        // The dialog that is open over the main window, if `match` fits it.
        private static Seen Dialog(Func<Form, bool> match)
        {
            return Ui(() =>
            {
                foreach (Form f in Application.OpenForms)
                {
                    if (f is MainForm || !f.Visible || !match(f)) continue;
                    var said = new List<string>();
                    Labels(f, said);
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
        private static void Click(Seen dialog, string button) { Post(() => { var b = Find<Button>(dialog.Form, x => x.Text == button); if (b != null) b.PerformClick(); }); }
        private static bool Closed(Seen dialog) { return Ui(() => dialog.Form.IsDisposed || !dialog.Form.Visible); }
        private static void Answer(Seen dialog, string button) { Click(dialog, button); Until(() => Closed(dialog), 5000); }
        private static string LabelsOf(Seen dialog) { return Ui(() => { var l = new List<string>(); Labels(dialog.Form, l); return string.Join(" | ", l.ToArray()); }); }

        // ----- the stand-in command line's log -----

        private sealed class Run { public DateTime Begin; public DateTime End = DateTime.MaxValue; public int Pid; public string Args; public string Code = ""; }

        private static string ReadShared(string file)
        {
            if (!File.Exists(file)) return "";
            using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var reader = new StreamReader(stream)) return reader.ReadToEnd();
        }

        private static List<Run> Runs(string startsWith)
        {
            var runs = new List<Run>();
            foreach (var line in ReadShared(stubLog).Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var parts = line.Trim().Split(new[] { ' ' }, 4);
                if (parts.Length < 3) continue;
                var at = DateTime.Parse(parts[0], CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
                var pid = int.Parse(parts[2], CultureInfo.InvariantCulture);
                var args = parts.Length > 3 ? parts[3] : "";
                if (parts[1] == "begin") { if (args.StartsWith(startsWith, StringComparison.Ordinal)) runs.Add(new Run { Begin = at, Pid = pid, Args = args }); }
                else foreach (var run in runs) if (run.Pid == pid && run.End == DateTime.MaxValue) { run.End = at; run.Code = parts[1]; }
            }
            return runs;
        }

        private static int Fulls() { return Runs("status --json").Count; }
        private static int Starts() { return Runs("start").Count; }
        private static int Stops() { return Runs("stop").Count; }
        private static string GatewayLog() { return ReadShared(gatewayLog); }

        private static int Count(string hay, string needle)
        {
            var n = 0;
            for (var at = hay.IndexOf(needle, StringComparison.Ordinal); at >= 0; at = hay.IndexOf(needle, at + needle.Length, StringComparison.Ordinal)) n++;
            return n;
        }

        private static bool Alive(int pid)
        {
            try { using (var p = Process.GetProcessById(pid)) return !p.HasExited; }
            catch (ArgumentException) { return false; }
            catch (InvalidOperationException) { return false; }
        }

        private static void Mode(string mode) { File.WriteAllText(modeFile, mode, Utf8); }

        // Something accepts connections at the gateway's (spare) address.
        private static bool Listening()
        {
            try
            {
                using (var client = new System.Net.Sockets.TcpClient())
                {
                    var connecting = client.BeginConnect("127.0.0.1", port, null, null);
                    if (!connecting.AsyncWaitHandle.WaitOne(500)) return false;
                    client.EndConnect(connecting);
                    return true;
                }
            }
            catch (System.Net.Sockets.SocketException) { return false; }
        }

        // One instruction for the gateway; waits until the last one was taken.
        private static void Command(string command)
        {
            Until(() => !File.Exists(commandFile), 3000);
            File.WriteAllText(commandFile, command, Utf8);
            Until(() => !File.Exists(commandFile), 3000);
        }

        private static string StateText() { return Ui(() => ((Control)F("stateLabel").GetValue(form)).Text); }
        private static string Detail() { return Ui(() => ((Control)F("detailLabel").GetValue(form)).Text); }
        private static int InFlightNow() { return Get<int>("inFlight"); }
        private static string LogText() { return Ui(() => ((TextBox)F("logBox").GetValue(form)).Text); }
        private static int LateLines() { return Count(LogText(), LateLine); }
        private static Process Gateway() { return Get<Process>("gateway"); }
        private static int GatewayPid() { var g = Gateway(); try { return g == null || g.HasExited ? 0 : g.Id; } catch (InvalidOperationException) { return 0; } }
        // False as well in a build from before the watch existed.
        private static bool Watching() { return F("lateStopWatch") != null && Get<object>("lateStopWatch") != null; }

        private static void Show() { Post(() => { SetWindowPos(form.Handle, IntPtr.Zero, -12000, 0, 1280, 880, 0x0004 | 0x0010); ShowWindow(form.Handle, 4); }); }

        // Presses "Add key" on the Chat API keys page and types a synthetic key.
        private static void AddKey()
        {
            var key = "sk-synthetic-" + Guid.NewGuid().ToString("N");
            Call("AddKey");
            var ask = WaitDialog("the key dialog", f => f.Text == "API key" && HasBox(f), 8000);
            if (ask == null) return;
            Post(() => { Find<TextBox>(ask.Form, x => true).Text = key; Find<Button>(ask.Form, x => x.Text == "Save").PerformClick(); });
            Until(() => Closed(ask), 5000);
        }

        private static Seen RestartQuestion()
        {
            return WaitDialog("the restart question", f => f.Text == "API key" && !HasBox(f) && HasButton(f, "Yes"), 20000);
        }

        // Saves a key and says Yes to the restart.
        private static void AskForRestart()
        {
            AddKey();
            var ask = RestartQuestion();
            if (ask != null) Answer(ask, "Yes");
        }

        private static Process StartFake(bool withLimits, string limits)
        {
            var arguments = "\"" + fakeScript + "\" " + port + " \"" + commandFile + "\" \"" + gatewayLog + "\"" + (withLimits ? " answering \"" + limits + "\"" : "");
            return Process.Start(new ProcessStartInfo(node, arguments) { UseShellExecute = false, CreateNoWindow = true });
        }

        private static void End(Process process)
        {
            if (process == null) return;
            try { if (!process.HasExited) process.Kill(); process.WaitForExit(5000); } catch (InvalidOperationException) { } catch (System.ComponentModel.Win32Exception) { }
            process.Dispose();
        }

        private static int Main(string[] args)
        {
            var what = args[0];
            var realRoot = args[1];
            rigDir = args[2];
            port = int.Parse(args[3], CultureInfo.InvariantCulture);
            fakeScript = args[4];
            if (port == 8417 || port == 8418) return 2;
            home = Path.Combine(rigDir, "home");
            stubLog = Path.Combine(rigDir, "stub.log");
            modeFile = Path.Combine(rigDir, "stub-mode.txt");
            commandFile = Path.Combine(rigDir, "command.txt");
            gatewayLog = Path.Combine(rigDir, "gateway.log");
            var local = Path.Combine(rigDir, "localappdata");
            Directory.CreateDirectory(local);
            var helperLog = Path.Combine(rigDir, "fake-helper.log");
            foreach (var file in new[] { stubLog, modeFile, commandFile, commandFile + ".stop", commandFile + ".choices", gatewayLog, helperLog, Path.Combine(rigDir, "quit.txt") }) File.Delete(file);
            Environment.SetEnvironmentVariable("DSHPROXY_HOME", home);
            Environment.SetEnvironmentVariable("DSH_HOME", Path.Combine(rigDir, "no-deepseek-harness"));
            Environment.SetEnvironmentVariable("LOCALAPPDATA", local);
            Environment.SetEnvironmentVariable("DSHPROXY_REAL_ROOT", realRoot);
            Environment.SetEnvironmentVariable("STUB_LOG", stubLog);
            Environment.SetEnvironmentVariable("STUB_MODE_FILE", modeFile);
            Environment.SetEnvironmentVariable("STUB_COMMAND_FILE", commandFile);
            Environment.SetEnvironmentVariable("STUB_GATEWAY_LOG", gatewayLog);
            Environment.SetEnvironmentVariable("FAKE_KREA_LOG", helperLog);
            Environment.SetEnvironmentVariable("FAKE_KREA_FLAG", Path.Combine(rigDir, "fake-signed-in"));
            Environment.SetEnvironmentVariable("FAKE_KREA_MODE", "{\"address\":\"https://krea.ai/synthetic-consent\",\"exit\":\"ok\",\"waitMs\":600000}");
            var origin = "http://127.0.0.1:" + port;
            Console.WriteLine(what + ": DSHPROXY_HOME=" + home + "  gateway address " + origin);

            var display = CultureInfo.GetCultureInfo("en-US");
            CultureInfo.DefaultThreadCurrentCulture = display;
            CultureInfo.DefaultThreadCurrentUICulture = display;
            Application.CurrentCulture = display;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            SetWindowsHookEx(5, NoActivation, IntPtr.Zero, GetCurrentThreadId());
            node = Cli.FindNode();
            if (what == "race")
            {
                Stress();
                Console.WriteLine(failed == 0 ? "ALL OK" : failed + " FAILED");
                return failed == 0 ? 0 : 1;
            }

            // A gateway this window did not start, for `follow` and `count`. It
            // is started before the job object exists, so it is not counted.
            Process outside = null;
            if (what != "flow" && what != "ticks")
            {
                outside = StartFake(what == "count" || what == "hidden", Path.Combine(realRoot, "app", "preview-limits.json"));
                Thread.Sleep(900);
            }
            var job = IntPtr.Zero;
            if (what == "count" || what == "hidden")
            {
                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero || !AssignProcessToJobObject(job, GetCurrentProcess())) { Console.WriteLine("FAIL no job object: " + Marshal.GetLastWin32Error()); return 1; }
            }

            if (what == "ticks") { Mode("fake models"); Environment.SetEnvironmentVariable("FAKE_GW_CONTROL", "1"); }
            form = new MainForm(true, null);
            // Before the first check: nothing is ever sent to the default address.
            F("lastOrigin").SetValue(form, origin);
            ((NotifyIcon)F("tray").GetValue(form)).Visible = false;
            var opened = new List<string>();
            F("openConsentPage").SetValue(form, new Func<string, bool>(address => { lock (opened) opened.Add(address); return true; }));
            Console.WriteLine("command line folder: " + ((Cli)F("cli").GetValue(form)).Root);

            var test = new Thread(() =>
            {
                try
                {
                    Thread.Sleep(300);
                    if (what == "flow") Flow(opened);
                    else if (what == "ticks") { Ticks(); Call("Quit"); }
                    else if (what == "hidden") { HiddenRun(job); Call("Quit"); }
                    else if (what == "follow") { Follow(outside); Call("Quit"); }
                    else { CountRun(job); Call("Quit"); }
                }
                catch (Exception error)
                {
                    Console.WriteLine("FAIL the check itself stopped: " + error);
                    failed++;
                    try { Application.Exit(); } catch (Exception) { }
                }
            });
            test.IsBackground = true;
            test.Start();
            Application.Run(form);
            test.Join(15000);
            End(outside);
            Console.WriteLine(foregroundTaken == 0 ? "ok   the window never became the foreground window" : "FAIL the window was the foreground window in " + foregroundTaken + " samples");
            if (foregroundTaken != 0) failed++;
            Console.WriteLine(failed == 0 ? "ALL OK" : failed + " FAILED");
            Console.Out.Flush();
            return failed == 0 ? 0 : 1;
        }

        // ---------------------------------------------------------------
        // ----- 5 minutes in the tray: nothing is started -----
        private static void HiddenRun(IntPtr job)
        {
            Head("processes and CPU, 5 minutes hidden (job object: this program and everything it starts)");
            var t = Until(() => StateText().Contains("Running"), 20000);
            Check("started hidden, it shows the running gateway (" + Secs(t) + ")", t >= 0 && !Ui(() => form.Visible));
            Thread.Sleep(3000);
            Until(() => !Get<bool>("fullRunning"), 15000);
            Func<string, Accounting> sample = label =>
            {
                Accounting info;
                QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero);
                long privateBytes;
                using (var me = Process.GetCurrentProcess()) privateBytes = me.PrivateMemorySize64;
                Console.WriteLine(string.Format(CultureInfo.InvariantCulture, "{0,-14} processes ever {1,4}   job CPU {2,7} ms   private {3:0.0} MB   {4}", label, info.TotalProcesses, (info.TotalUserTime + info.TotalKernelTime) / 10000, privateBytes / 1048576.0, StateText()));
                Console.Out.Flush();
                return info;
            };
            var from = DateTime.UtcNow;
            var first = sample("hidden 0:00");
            for (var minute = 1; minute < 5; minute++) { Thread.Sleep(60000); Foreground(); sample("hidden " + minute + ":00"); }
            Thread.Sleep(60000);
            var last = sample("hidden 5:00");
            var started = (int)(last.TotalProcesses - first.TotalProcesses);
            var cpu = ((last.TotalUserTime + last.TotalKernelTime) - (first.TotalUserTime + first.TotalKernelTime)) / 10000;
            var runs = Runs("status --json").FindAll(run => run.Begin >= from).Count;
            Check("processes started in 5 minutes hidden: " + started + " (command line runs begun in that time: " + runs + "), CPU " + cpu + " ms", started == 0 && runs == 0);
            Check("the window is still hidden and still says Running", !Ui(() => form.Visible) && StateText().Contains("Running"));
        }

        private static void CountRun(IntPtr job)
        {
            Head("processes and CPU, 5 minutes visible and 5 minutes hidden (job object: this program and everything it starts)");
            Until(() => StateText().Contains("Running"), 15000);
            Show();
            Thread.Sleep(3000);
            Until(() => !Get<bool>("fullRunning"), 10000);
            Func<string, Accounting> sample = label =>
            {
                Accounting info;
                QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero);
                long privateBytes;
                using (var me = Process.GetCurrentProcess()) privateBytes = me.PrivateMemorySize64;
                Console.WriteLine(string.Format(CultureInfo.InvariantCulture, "{0,-14} processes ever {1,4}   job CPU {2,7} ms   private {3:0.0} MB   {4}", label, info.TotalProcesses, (info.TotalUserTime + info.TotalKernelTime) / 10000, privateBytes / 1048576.0, StateText()));
                Console.Out.Flush();
                return info;
            };
            var visibleFrom = DateTime.UtcNow;
            var visible0 = sample("visible 0:00");
            var fulls0 = Get<int>("failedPolls");
            for (var minute = 1; minute <= 5; minute++)
            {
                var until = DateTime.UtcNow.AddSeconds(60);
                while (DateTime.UtcNow < until)
                {
                    // Painted every 5 seconds, as a window on screen is.
                    Post(() => { using (var bmp = new Bitmap(form.Width, form.Height)) using (var g = Graphics.FromImage(bmp)) { var dc = g.GetHdc(); PrintWindow(form.Handle, dc, 2); g.ReleaseHdc(dc); } });
                    Foreground();
                    Thread.Sleep(5000);
                }
                if (minute < 5) sample("visible " + minute + ":00");
            }
            // A full status that has just started is counted whole.
            Until(() => !Get<bool>("fullRunning"), 15000);
            var visible5 = sample("visible 5:00");
            var visibleTo = DateTime.UtcNow;
            Post(() => form.Hide());
            Thread.Sleep(2000);
            Until(() => !Get<bool>("fullRunning"), 10000);
            var hidden0 = sample("hidden 0:00");
            for (var minute = 1; minute < 5; minute++) { Thread.Sleep(60000); sample("hidden " + minute + ":00"); }
            Thread.Sleep(60000);
            var hidden5 = sample("hidden 5:00");
            var startedVisible = (int)(visible5.TotalProcesses - visible0.TotalProcesses);
            var startedHidden = (int)(hidden5.TotalProcesses - hidden0.TotalProcesses);
            var cpuVisible = ((visible5.TotalUserTime + visible5.TotalKernelTime) - (visible0.TotalUserTime + visible0.TotalKernelTime)) / 10000;
            var cpuHidden = ((hidden5.TotalUserTime + hidden5.TotalKernelTime) - (hidden0.TotalUserTime + hidden0.TotalKernelTime)) / 10000;
            Console.WriteLine("processes started in 5 minutes visible: " + startedVisible + "   CPU " + cpuVisible + " ms");
            Console.WriteLine("processes started in 5 minutes hidden:  " + startedHidden + "   CPU " + cpuHidden + " ms");
            // A full status is due 60 s after the last one and starts at the next
            // 3 s check, so 5 minutes hold four or five of them: 16 or 20 processes.
            var fullsInWindow = Runs("status --json").FindAll(run => run.Begin >= visibleFrom && run.Begin <= visibleTo);
            var closest = double.MaxValue;
            var all = Runs("status --json");
            var gaps = new List<string>();
            for (var i = 1; i < all.Count; i++)
            {
                var gap = (all[i].Begin - all[i - 1].Begin).TotalSeconds;
                // Each full status of the 5 minutes against the one before it. (The
                // two before the 5 minutes, at launch and when the window is
                // shown, are a second apart and are not part of this.)
                if (all[i].Begin >= visibleFrom && all[i].Begin <= visibleTo) { gaps.Add(gap.ToString("0.0", CultureInfo.InvariantCulture)); closest = Math.Min(closest, gap); }
            }
            Console.WriteLine("full statuses while visible: " + fullsInWindow.Count + "; seconds between one and the next: " + string.Join(", ", gaps.ToArray()));
            Check("visible: every process started belongs to a full status (" + startedVisible + " = 4 x " + fullsInWindow.Count + "), and full statuses are a minute apart (closest " + (closest == double.MaxValue ? "-" : closest.ToString("0.0", CultureInfo.InvariantCulture)) + " s): 16 or 20 processes in 5 minutes", startedVisible == 4 * fullsInWindow.Count && (startedVisible == 16 || startedVisible == 20) && closest >= 59);
            Check("5 minutes hidden start none", startedHidden == 0);
            Check("the window showed a running gateway throughout, and no status read failed", StateText().Contains("Running") && Get<int>("failedPolls") == fulls0);
        }

        // ---------------------------------------------------------------
        private static void Follow(Process outside)
        {
            Head("a gateway this window did not start (stand-in)");
            var up = Until(() => StateText().Contains("Running"), 15000);
            Check("started hidden, it shows the running gateway (" + Secs(up) + ")", up >= 0);
            Show();
            Thread.Sleep(4000);
            var fulls = Fulls();
            Command("inflight 3");
            var t = Until(() => InFlightNow() == 3, 8000);
            Check("in-flight count 3 is noticed (" + Secs(t) + ") without a command line run", t >= 0 && t <= 4 && Fulls() == fulls);
            Thread.Sleep(9000);
            Check("9 s idle: no command line run (" + (Fulls() - fulls) + ")", Fulls() == fulls);
            Command("mute");
            t = Until(() => StateText().Contains("Stopped"), 12000);
            Check("it stops answering: the window says Stopped (" + Secs(t) + ")", t >= 0 && t <= 5.5);
            Check("as before for a gateway this window did not start: Start on, Stop off, no third state: " + Header(), StateText() == Dot + "Stopped" && StartOn() && !StopOn());
            Check("it is not a gateway of this window: the count is 0 once it does not answer", InFlightNow() == 0);
            Call("StopRequested");
            Thread.Sleep(900);
            Check("Stop asks nothing about a gateway this window did not start", Dialog(f => true) == null);
            Command("unmute");
            t = Until(() => StateText().Contains("Running"), 12000);
            Check("it answers again: the window says Running (" + Secs(t) + ")", t >= 0 && t <= 5.5);
            Check("Start off, Stop on: " + Header(), !StartOn() && StopOn());
            t = Until(() => InFlightNow() == 3, 6000);
            Check("and the count is back (" + Secs(t) + ")", t >= 0);
            End(outside);
            t = Until(() => StateText().Contains("Stopped"), 12000);
            Check("the gateway is gone: the window says Stopped (" + Secs(t) + ")", t >= 0 && t <= 5.5);
            Check("Start on, Stop off: " + Header(), StartOn() && !StopOn());
            // Stop on a gateway this window did not start: what it does today.
            var other = StartFake(false, null);
            t = Until(() => StateText() == Dot + "Running", 45000);
            Call("StopRequested");
            Thread.Sleep(2500);
            Check("a gateway this window did not start answers (" + Secs(t) + "): Stop asks nothing, stops nothing, and the log says where to stop it", t >= 0 && Dialog(f => true) == null && Listening() && LogText().Contains("The running gateway was not started by this window. Stop it from the window it was started in."));
            End(other);
            Until(() => StateText() == Dot + "Stopped", 45000);
            var runs = Runs("status --json");
            var overlaps = 0;
            for (var i = 1; i < runs.Count; i++) if (runs[i].Begin < runs[i - 1].End) overlaps++;
            Check("full statuses never overlapped (" + runs.Count + " runs, " + overlaps + " overlaps), and nothing but status was run", overlaps == 0 && Runs("").Count == runs.Count);
        }

        // ---------------------------------------------------------------
        // ----- the Models page, shown for the first time after it was filled -----
        // A stand-in gateway that writes the control call for a model tick to
        // its log, and a status answer with four model rows, three of them ticked.
        private static int Times(string text, string part)
        {
            var n = 0;
            for (var at = text.IndexOf(part, StringComparison.Ordinal); at >= 0; at = text.IndexOf(part, at + part.Length, StringComparison.Ordinal)) n++;
            return n;
        }



        private static int Choices() { return Times(GatewayLog(), "control: POST models/choose"); }
        private static int TickedRows() { return Ui(() => ((ListView)F("modelsList").GetValue(form)).CheckedItems.Count); }
        private static void SetTick(string id, bool on) { Ui(() => { foreach (ListViewItem item in ((ListView)F("modelsList").GetValue(form)).Items) if ((string)item.Tag == id) item.Checked = on; return 0; }); }

        private static void Ticks()
        {
            Head("the Models page: the window sends a model choice only for a tick the user changed");
            Show();
            var t = Until(() => StateText() == "\u25CF Running" && Ui(() => ((ListView)F("modelsList").GetValue(form)).Items.Count) > 0, 90000);
            var rows = Ui(() => ((ListView)F("modelsList").GetValue(form)).Items.Count);
            Check("the gateway runs and the list of models is filled (" + Secs(t) + "): " + rows + " rows, " + TickedRows() + " ticked, and the page has not been shown yet (the list has a window: " + Ui(() => ((ListView)F("modelsList").GetValue(form)).IsHandleCreated) + ")", t >= 0 && rows == 4 && TickedRows() == 3);

            Ui(() => { ((PageHost)F("tabs").GetValue(form)).SelectedIndex = 3; return 0; });
            Thread.Sleep(6000);
            var calls = Choices();
            Check("1. the page is shown for the first time: 6 s later the gateway was sent no model choice (" + calls + " calls), and the log has no \"Offering\" line (" + Times(LogText(), "Offering ") + ")", calls == 0 && Times(LogText(), "Offering ") == 0);
            foreach (var line in GatewayLog().Replace("\r", "").Split('\n')) if (line.Contains("control: ")) Console.WriteLine("     sent without a click: " + line.Substring(line.IndexOf("control: ", StringComparison.Ordinal) + 9));
            Check("   the ticks are as they were filled (" + TickedRows() + " of " + rows + "), and no box is open", TickedRows() == 3 && Dialog(f => true) == null);

            var at = Choices();
            SetTick("synthetic-model-a", false);
            t = Until(() => Times(LogText(), "No longer offering synthetic-model-a") == 1, 20000);
            Thread.Sleep(4000);
            Check("2. one tick taken off by hand: one call (" + (Choices() - at) + "), {\"id\":\"synthetic-model-a\",\"offered\":false} (" + Secs(t) + "); the list then shows " + TickedRows() + " ticked", t >= 0 && Choices() - at == 1 && Times(GatewayLog(), "{\"id\":\"synthetic-model-a\",\"offered\":false}") == 1 && TickedRows() == 2);

            at = Choices();
            SetTick("synthetic-model-a", true);
            t = Until(() => Times(LogText(), "Offering synthetic-model-a") == 1, 20000);
            Thread.Sleep(4000);
            Check("3. the tick put back by hand: one call (" + (Choices() - at) + "), {\"id\":\"synthetic-model-a\",\"offered\":true} (" + Secs(t) + "); the list then shows " + TickedRows() + " ticked", t >= 0 && Choices() - at == 1 && GatewayLog().TrimEnd().EndsWith("control: POST models/choose {\"id\":\"synthetic-model-a\",\"offered\":true}", StringComparison.Ordinal) && TickedRows() == 3);

            at = Choices();
            var fill = typeof(MainForm).GetMethod("FillModels", BindingFlags.Instance | BindingFlags.NonPublic);
            for (var i = 0; i < 3; i++)
            {
                Ui(() => { F("modelsKey").SetValue(form, ""); fill.Invoke(form, null); return 0; });
                Thread.Sleep(400);
            }
            Ui(() => { F("modelsKey").SetValue(form, ""); return 0; });
            Call("RefreshStatus");
            Thread.Sleep(5000);
            Check("4. the list is filled again four times while the page is on screen (three times from what is known, once from a new status): no call (" + (Choices() - at) + "), " + TickedRows() + " ticked", Choices() - at == 0 && TickedRows() == 3);

            at = Choices();
            Ui(() => { ((PageHost)F("tabs").GetValue(form)).SelectedIndex = 0; return 0; });
            Thread.Sleep(600);
            Ui(() => { ((PageHost)F("tabs").GetValue(form)).SelectedIndex = 3; return 0; });
            Thread.Sleep(2500);
            Check("5. another page and back: no call (" + (Choices() - at) + ")", Choices() - at == 0);
            Check("in all, the gateway was sent " + Choices() + " model choices" + (Choices() == 2 ? ": the two made by hand" : ""), Choices() == 2);

            // The other list with ticks that send something: Video > Models. It
            // saves through the command line, so the runs of that are counted.
            Head("the Video models page: the same for the other list with ticks");
            var cli = (Cli)F("cli").GetValue(form);
            string failure;
            var models = VideoSettings.Read(cli.Run(VideoSettings.ReadCommand(), null, 30000), out failure);
            Check("the video settings of the throwaway folder are read" + (models == null ? " (" + failure + ")" : ": " + models.Count + " models, " + models.FindAll(m => m.Enabled).Count + " enabled"), models != null && models.Count > 0);
            if (models == null) return;
            var pick = models.Find(m => m.Routes.Count > 0);
            var route = pick.Routes[0];
            var saved = VideoSettings.Read(cli.Run(VideoSettings.SetCommand(pick.Id, route, true), null, 30000), out failure);
            Check("set-up, by the command line: " + pick.Id + " is enabled on the route " + route, saved != null && saved.Find(m => m.Id == pick.Id).Enabled);
            Func<int> sets = () => Runs("video settings set").Count;
            Func<int> tickedVideo = () => Ui(() => ((ListView)F("videoModelsList").GetValue(form)).CheckedItems.Count);
            Ui(() => { ((PageHost)F("tabs").GetValue(form)).SelectedIndex = 0; ((RadioButton)F("videoSwitch").GetValue(form)).Checked = true; return 0; });
            t = Until(() => tickedVideo() == 1, 30000);
            var made = Ui(() => ((ListView)F("videoModelsList").GetValue(form)).IsHandleCreated);
            Check("the Video workspace is opened on Accounts: the list of video models is filled (" + Secs(t) + "), 1 ticked, and its page has not been shown (the list has a window: " + made + ")", t >= 0 && !made);
            at = sets();
            Ui(() => { ((PageHost)F("tabs").GetValue(form)).SelectedIndex = 3; return 0; });
            Thread.Sleep(6000);
            Check("6. the Video models page is shown for the first time: 6 s later nothing was saved (" + (sets() - at) + " runs of \"video settings set\"), " + tickedVideo() + " ticked", sets() - at == 0 && tickedVideo() == 1);
            foreach (var run in Runs("video settings set")) if (Runs("video settings set").IndexOf(run) >= at) Console.WriteLine("     saved without a click: " + run.Args);
            at = sets();
            Ui(() => { foreach (ListViewItem item in ((ListView)F("videoModelsList").GetValue(form)).Items) if (item.Tag is VideoSettings.Model && ((VideoSettings.Model)item.Tag).Id == pick.Id) item.Checked = false; return 0; });
            t = Until(() => sets() - at >= 1 && tickedVideo() == 0, 30000);
            Thread.Sleep(4000);
            var all = Runs("video settings set");
            Check("7. its tick taken off by hand: one run (" + (sets() - at) + "): " + (all.Count > at ? all[all.Count - 1].Args : "none") + " (" + Secs(t) + ")", t >= 0 && sets() - at == 1 && all[all.Count - 1].Args.EndsWith(pick.Id + " " + route + " disabled", StringComparison.Ordinal));
        }

        private static void Flow(List<string> opened)
        {
            Show();
            Thread.Sleep(1500);
            Pure();
            Real();
            Late();
            Silent();
            Shown();
            NeverAnswers();
            Leave(opened);
        }

        private static Process Quick() { return Process.Start(new ProcessStartInfo("cmd.exe", "/c exit 0") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true }); }
        private static Process Slow() { return Process.Start(new ProcessStartInfo(node, "-e \"setTimeout(function(){},250)\"") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true }); }

        // Cancel from another thread while Run ends and lets go of its process.
        private static void Race(string what, int rounds, Action<Func<Process>, Action<Action>> one)
        {
            var errors = new List<string>();
            for (var i = 0; i < rounds; i++)
            {
                var round = i;
                Action cancel = null;
                var ready = new ManualResetEvent(false);
                var canceller = new Thread(() =>
                {
                    try
                    {
                        ready.WaitOne();
                        Thread.Sleep(round * 7 % 90);
                        for (var k = 0; k < 4; k++) cancel();
                    }
                    catch (Exception error) { lock (errors) errors.Add("cancel: " + error.GetType().Name + ": " + error.Message); }
                });
                canceller.Start();
                try { one(round % 2 == 0 ? (Func<Process>)Quick : Slow, c => { cancel = c; ready.Set(); }); }
                catch (Exception error) { lock (errors) errors.Add("run: " + error.GetType().Name + ": " + error.Message); }
                canceller.Join();
            }
            Check(what + ": " + rounds + " rounds of Cancel from a second thread while the run ends, no exception" + (errors.Count == 0 ? "" : " (" + errors[0] + ", " + errors.Count + " in all)"), errors.Count == 0);
        }

        // Item 2, pressed hard: two threads call Cancel without pause from the
        // moment the run has its process until after the run has let go of it
        // and disposed it. The process ends by itself within milliseconds, so
        // the cancellers are busy with it exactly while it is disposed.
        private static void Stress()
        {
            Head("item 2: Cancel from two threads, without pause, while the run ends and disposes its process");
            foreach (var kind in new[] { "the stop command", "the Krea helper" })
            {
                var rounds = 300;
                var thrown = new Dictionary<string, int>();
                var calls = 0L;
                for (var i = 0; i < rounds; i++)
                {
                    object subject;
                    Action cancel;
                    Action run;
                    if (kind == "the stop command") { var stop = new IdleStop(Quick); subject = stop; cancel = stop.Cancel; run = () => stop.Run(); }
                    else { var login = new KreaLogin(Quick, address => false); subject = login; cancel = login.Cancel; run = () => login.Run(null); }
                    var held = subject.GetType().GetField("process", BindingFlags.Instance | BindingFlags.NonPublic);
                    var over = false;
                    var cancellers = new List<Thread>();
                    for (var k = 0; k < 2; k++)
                    {
                        var canceller = new Thread(() =>
                        {
                            Process seen = null;
                            while (!Volatile.Read(ref over) && (seen = (Process)held.GetValue(subject)) == null) Thread.SpinWait(20);
                            // Not before the process has ended by itself: a Cancel then
                            // returns in microseconds, so thousands of them fall into the
                            // moment in which the run lets go of the process and disposes it.
                            // Watched through a process object of this thread's own.
                            try
                            {
                                if (seen != null)
                                    using (var own = Process.GetProcessById(seen.Id))
                                        while (!Volatile.Read(ref over) && !own.HasExited) Thread.SpinWait(50);
                            }
                            catch (Exception) { }
                            while (!Volatile.Read(ref over))
                            {
                                try { cancel(); Interlocked.Increment(ref calls); }
                                catch (Exception error) { lock (thrown) { int n; thrown.TryGetValue(error.GetType().Name, out n); thrown[error.GetType().Name] = n + 1; } }
                            }
                        });
                        canceller.Start();
                        cancellers.Add(canceller);
                    }
                    try { run(); }
                    catch (Exception error) { lock (thrown) { int n; thrown.TryGetValue("in Run: " + error.GetType().Name, out n); thrown["in Run: " + error.GetType().Name] = n + 1; } }
                    Thread.Sleep(3);
                    Volatile.Write(ref over, true);
                    foreach (var canceller in cancellers) canceller.Join();
                }
                var list = new List<string>();
                foreach (var pair in thrown) list.Add(pair.Key + " x" + pair.Value);
                Check(kind + ": " + rounds + " rounds, " + calls + " Cancel calls, exceptions that escaped: " + (list.Count == 0 ? "none" : string.Join(", ", list.ToArray())), list.Count == 0);
            }
        }

        private static void Pure()
        {
            Head("without a gateway");
            Check("exit 0 with {\"stopped\":true} is Stopped", IdleStop.Read(0, "{\"stopped\":true}\n", "").Outcome == IdleStop.Outcome.Stopped);
            var busyAnswer = IdleStop.Read(2, "{\"stopped\":false,\"inFlight\":3}\n", "");
            Check("exit 2 with {\"stopped\":false,\"inFlight\":3} is StillBusy with 3", busyAnswer.Outcome == IdleStop.Outcome.StillBusy && busyAnswer.InFlight == 3);
            var older = IdleStop.Read(1, "", "DSHProxy: The running gateway is an older DSHProxy that cannot stop when idle. Nothing was stopped.\n");
            Check("exit 1 is NotDone with the command line's sentence as given", older.Outcome == IdleStop.Outcome.NotDone && older.Message == "The running gateway is an older DSHProxy that cannot stop when idle. Nothing was stopped.");
            Check("exit 0 without an answer, exit 2 without a count and exit 0 with stopped:false are NotDone",
                IdleStop.Read(0, "", "").Outcome == IdleStop.Outcome.NotDone && IdleStop.Read(2, "{\"stopped\":false}", "").Outcome == IdleStop.Outcome.NotDone && IdleStop.Read(0, "{\"stopped\":false,\"inFlight\":1}", "").Outcome == IdleStop.Outcome.NotDone);
            Check("the command is stop --when-idle --wait 300", string.Join(" ", IdleStop.Command()) == "stop --when-idle --wait 300");
            Check("wording for 1, 2 and 0 requests", RestartWaitDialog.Waiting(1) == "Waiting for 1 request to finish before restarting" && RestartWaitDialog.Waiting(2) == "Waiting for 2 requests to finish before restarting" && RestartWaitDialog.Waiting(0).StartsWith("Nothing is in flight now", StringComparison.Ordinal));
#if !BASE
            Note("Stop, gateway silent, count 2: " + InFlight.UnansweredQuestion(2, false).Replace("\n", " / "));
            Note("Quit, gateway silent, count 0: " + InFlight.UnansweredQuestion(0, true).Replace("\n", " / "));
            Note("restart, gateway silent, count 1: " + InFlight.UnansweredRestartQuestion(1).Replace("\n", " / "));
#else
            Note("built with the source as it was before these four changes");
#endif

            // Item 2.
            var gone = Quick();
            gone.WaitForExit(5000);
            gone.Dispose();
            var threw = "";
            try { ProcessTree.Kill(gone); } catch (Exception error) { threw = error.GetType().Name; }
            Check("ending a process object that was already disposed throws nothing" + (threw.Length == 0 ? "" : " (" + threw + ")"), threw.Length == 0);
            Check("ObjectDisposedException is an InvalidOperationException", typeof(InvalidOperationException).IsAssignableFrom(typeof(ObjectDisposedException)));
            Race("the stop command", 30, (start, give) => { var stop = new IdleStop(start); give(stop.Cancel); stop.Run(); });
            Race("the Krea helper", 30, (start, give) => { var login = new KreaLogin(start, address => false); give(login.Cancel); login.Run(null); });

            // Item 3.
            var flags = BindingFlags.Instance | BindingFlags.NonPublic;
            var type = typeof(SignInDialog);
            SignInDialog dialog = null;
            Button done = null;
            var afterSuccess = Ui(() =>
            {
                dialog = new SignInDialog(new GatewayControl(() => "http://127.0.0.1:" + port), null);
                dialog.StartPosition = FormStartPosition.Manual;
                dialog.Location = new Point(-12000, 0);
                var handle = dialog.Handle;
                type.GetField("sessionLabel", flags).SetValue(dialog, "Claude");
                type.GetMethod("ShowSuccess", flags).Invoke(dialog, new object[] { "one@example.test" });
                done = dialog.AcceptButton as Button;
                return done != null && done.Text == "Done" && !done.IsDisposed;
            });
            Check("sign-in dialog, signed in: Enter is \"Done\"", afterSuccess);
            var afterAnother = Ui(() =>
            {
                type.GetMethod("ShowChoices", flags).Invoke(dialog, null);
                return dialog.AcceptButton == null && dialog.CancelButton == null;
            });
            Thread.Sleep(400);
            Check("\"Add another\": the dialog has no default button left, and the old \"Done\" is released", afterAnother && Ui(() => done.IsDisposed && dialog.AcceptButton == null));
            var again = Ui(() =>
            {
                type.GetMethod("ShowSuccess", flags).Invoke(dialog, new object[] { "two@example.test" });
                var next = dialog.AcceptButton as Button;
                var ok = next != null && next != done && next.Text == "Done" && !next.IsDisposed;
                dialog.Dispose();
                return ok;
            });
            Check("signed in a second time: Enter is the new \"Done\"", again);
        }

        // ----- the real daemon, with a stand-in backend that can hold requests -----
        private static void Real()
        {
            Head("restart after a Chat key change, Stop (real daemon, stand-in backend)");
            Mode("");
            Call("StartGateway");
            var t = Until(() => StateText().Contains("Running") && GatewayPid() != 0, 25000);
            Check("Start: the window starts its gateway and shows Running (" + Secs(t) + ")", t >= 0);
            var first = GatewayPid();
            Note("gateway process " + first + "; " + Detail());
            Check("in-flight count is 0 after the start", InFlightNow() == 0);

            Command("hold");
            t = Until(() => InFlightNow() == 1, 8000);
            Check("a held model request is counted (" + Secs(t) + ")", t >= 0 && t <= 4.5);
            Call("StopRequested");
            var ask = WaitDialog("Stop with 1 in flight", f => f.Text == "Stop gateway", 6000);
            if (ask != null)
            {
                Check("Stop asks first, No is the default: " + ask.Text, ask.Default == "No" && ask.Text.Contains("1 model request was in flight when the gateway was last checked"));
                Answer(ask, "No");
            }
            Thread.Sleep(800);
            Check("No: the same gateway keeps running and the request is still in flight", GatewayPid() == first && InFlightNow() == 1 && Count(GatewayLog(), "WAS CUT") == 0);

            // Waits, cuts nothing.
            var stops = Stops();
            var startsAtFirst = Starts();
            AddKey();
            ask = RestartQuestion();
            if (ask != null)
            {
                Check("after the key is saved the question says the restart will wait: " + ask.Text, ask.Text.Contains("Restart the gateway now so it uses the change?") && ask.Text.Contains("1 request is in flight: the restart waits for a moment with none, at most 5 minutes, and cuts nothing."));
                Answer(ask, "Yes");
            }
            var wait = WaitDialog("the waiting dialog", f => f.Text == "Restart gateway", 8000);
            if (wait != null)
            {
                Check("it shows \"Waiting for 1 request to finish before restarting\" with a Cancel: " + wait.Text, wait.Text.Contains("Waiting for 1 request to finish before restarting") && Ui(() => HasButton(wait.Form, "Cancel")) && wait.Default == "Cancel");
                t = Until(() => Stops() == stops + 1, 5000);
                var stopRun = Runs("stop");
                Check("the command line was started as: " + (stopRun.Count > 0 ? stopRun[stopRun.Count - 1].Args : "(none)"), t >= 0 && stopRun[stopRun.Count - 1].Args == "stop --when-idle --wait 300");
                Thread.Sleep(4000);
                Check("4 s later the gateway is the same process, still serving, the request still in flight and not cut", GatewayPid() == first && InFlightNow() == 1 && Count(GatewayLog(), "WAS CUT") == 0 && !Closed(wait));
                Command("hold");
                t = Until(() => LabelsOf(wait).Contains("Waiting for 2 requests to finish before restarting"), 8000);
                Check("a new request is served while it waits, and the dialog follows the count: 2 requests (" + Secs(t) + ")", t >= 0);
                var firstProcess = Gateway();
                Command("release");
                t = Until(() => Closed(wait), 20000);
                Check("the requests finished: the dialog closed by itself (" + Secs(t) + ")", t >= 0);
                t = Until(() => StateText().Contains("Running") && GatewayPid() != 0 && GatewayPid() != first, 25000);
                Check("the gateway was started again as a new process and the window shows Running (" + Secs(t) + ")", t >= 0);
                var code = -99;
                try { code = firstProcess.ExitCode; } catch (InvalidOperationException) { }
                Check("the old gateway process ended by itself with exit code 0 (a killed one ends with 1): " + code, code == 0);
                var log = GatewayLog();
                Check("both held requests finished whole and none was cut (finished " + Count(log, "finished whole with HTTP 200") + ", cut " + Count(log, "WAS CUT") + ")", Count(log, "finished whole with HTTP 200") == 2 && Count(log, "WAS CUT") == 0);
                var last = Runs("stop");
                Check("the command ended with exit code 0: " + last[last.Count - 1].Code, last[last.Count - 1].Code == "end(0)");
                Check("in-flight count is 0 after the restart, and no watch for a late stop is left", InFlightNow() == 0 && !Watching());
            }
            var second = GatewayPid();
            int startsBefore;
            Thread.Sleep(3000);
            // Counted from before the restart: the new command line writes its
            // first log line a moment after its process exists.
            Check("3 s later it is still that one new process: started once (starts +" + (Starts() - startsAtFirst) + ")", GatewayPid() == second && Starts() == startsAtFirst + 1 && LateLines() == 0);

            // Nothing in flight: as before, at once.
            stops = Stops();
            AddKey();
            ask = RestartQuestion();
            if (ask != null)
            {
                Check("with nothing in flight the question is the old one, with no word about waiting: " + ask.Text, ask.Text.Contains("Restart the gateway now so it uses the change?") && !ask.Text.Contains("in flight"));
                Answer(ask, "Yes");
            }
            t = Until(() => GatewayPid() != 0 && GatewayPid() != second && StateText().Contains("Running"), 25000);
            Check("it restarts at once, as before: new process, Running (" + Secs(t) + "), no stop command run", t >= 0 && Stops() == stops && Dialog(f => f.Text == "Restart gateway") == null);
            var third = GatewayPid();
            Thread.Sleep(1500);

            // Cancel while waiting: the gateway stays.
            Command("hold");
            Until(() => InFlightNow() == 1, 8000);
            AskForRestart();
            wait = WaitDialog("the waiting dialog (to cancel)", f => f.Text == "Restart gateway", 8000);
            if (wait != null)
            {
                Until(() => Stops() == stops + 1, 5000);
                Thread.Sleep(1200);
                var stopRuns = Runs("stop");
                var stopPid = stopRuns[stopRuns.Count - 1].Pid;
                Click(wait, "Cancel");
                t = Until(() => Closed(wait), 20000);
                Check("Cancel: the dialog closed (" + Secs(t) + ")", t >= 0);
                Thread.Sleep(1500);
                Check("the command was ended (process " + stopPid + " gone)", !Alive(stopPid));
                Check("the gateway is the same process, running, with the request still in flight and not cut", GatewayPid() == third && InFlightNow() == 1 && Count(GatewayLog(), "WAS CUT") == 0 && StateText().Contains("Running"));
                Check("the gateway logged that the caller went away and that it keeps running", GatewayLog().Contains("the caller went away; the gateway keeps running"));
                Check("the log says the restart was cancelled", LogText().Contains("Restart cancelled: the gateway keeps running. The key change is used after the next restart."));
                Check("no further dialog is left open", Dialog(f => true) == null);
            }

            // The wait runs out (exit code 2).
            Mode("short-wait");
            AskForRestart();
            wait = WaitDialog("the waiting dialog (wait runs out)", f => f.Text == "Restart gateway", 8000);
            var told = WaitDialog("the message after the wait ran out", f => f.Text == "API key" && !HasBox(f) && HasButton(f, "OK"), 20000);
            Mode("");
            if (told != null)
            {
                Check("exit code 2: it says requests are still running, nothing was restarted, and the key is used after the next restart: " + told.Text,
                    told.Text.Contains("1 request is still running") && told.Text.Contains("Nothing was restarted") && told.Text.Contains("The key change is used after the next restart of the gateway."));
                var last = Runs("stop");
                Check("the command answered with exit code 2: " + last[last.Count - 1].Code, last[last.Count - 1].Code == "end(2)");
                Check("the waiting dialog is gone", wait == null || Closed(wait));
                Answer(told, "OK");
            }
            Thread.Sleep(800);
            Check("the gateway is the same process, running, the request still in flight and not cut", GatewayPid() == third && InFlightNow() == 1 && Count(GatewayLog(), "WAS CUT") == 0 && StateText().Contains("Running"));

            // A command line that does not know the command.
            Mode("old-cli");
            AskForRestart();
            var fallback = WaitDialog("the fallback question", f => f.Text == "API key" && !HasBox(f) && HasButton(f, "No") && Dialog(x => x.Text == "Restart gateway") == null, 20000);
            if (fallback != null)
            {
                Check("exit code 1 with a usage sentence: it falls back to the yes or no question, No is the default: " + fallback.Text,
                    fallback.Default == "No" && fallback.Text.Contains("Unknown command \"stop\"") && fallback.Text.Contains("1 model request was in flight") && fallback.Text.Contains("Restart anyway?"));
                Answer(fallback, "No");
            }
            Thread.Sleep(800);
            Check("No: the gateway is the same process, running, the request not cut", GatewayPid() == third && InFlightNow() == 1 && Count(GatewayLog(), "WAS CUT") == 0);
            AskForRestart();
            fallback = WaitDialog("the fallback question (second time)", f => f.Text == "API key" && !HasBox(f) && HasButton(f, "No") && Dialog(x => x.Text == "Restart gateway") == null, 20000);
            startsBefore = Starts();
            if (fallback != null) Answer(fallback, "Yes");
            t = Until(() => GatewayPid() != 0 && GatewayPid() != third && StateText().Contains("Running"), 25000);
            Mode("");
            Check("Yes: the gateway is restarted the old way (new process, Running) (" + Secs(t) + ")", t >= 0);
            Check("in-flight count is 0 right after that restart, so nothing stale can raise a question", InFlightNow() == 0);
            var fourth = GatewayPid();
            Thread.Sleep(4000);
            Check("the gateway that was ended for it was not started a second time by the watch (starts: " + (Starts() - startsBefore) + ")", Starts() == startsBefore + 1 && GatewayPid() == fourth && LateLines() == 0 && !Watching());

            // Stop resets the count.
            Command("hold");
            Until(() => InFlightNow() == 1, 8000);
            Call("StopRequested");
            ask = WaitDialog("Stop with 1 in flight (Yes)", f => f.Text == "Stop gateway", 6000);
            if (ask != null) Answer(ask, "Yes");
            t = Until(() => Gateway() == null, 15000);
            Check("Stop, Yes: the gateway is stopped (" + Secs(t) + ") and the in-flight count is 0 at once", t >= 0 && InFlightNow() == 0 && !Alive(fourth));
            t = Until(() => StateText().Contains("Stopped"), 8000);
            Check("the window says Stopped (" + Secs(t) + " after the stop)", t >= 0 && t <= 5.5);
            Call("StopRequested");
            Thread.Sleep(700);
            Check("no question when nothing is running", Dialog(f => true) == null);
        }

        // Starts the stand-in gateway from the window and reports `count` in flight.
        private static int Fake(int count, string words)
        {
            Mode("fake " + words);
            if (GatewayPid() == 0)
            {
                Until(() => StateText().Contains("Stopped"), 8000);
                Call("StartGateway");
            }
            Until(() => StateText().Contains("Running") && GatewayPid() != 0, 20000);
            Command("inflight " + count);
            Until(() => InFlightNow() == count, 8000);
            return GatewayPid();
        }

        // ----- a gateway that stops after the window was told it had not -----
        private static void Late()
        {
            Head("item 1: a gateway that stops late is started again, once (stand-in gateway whose end is timed)");
            foreach (var delay in new[] { "2000", "5000", "never" })
            {
                var pid = Fake(1, "commit:" + delay);
                var starts = Starts();
                var late = LateLines();
                var stops = Stops();
                var cancelled = Count(LogText(), "Restart cancelled: the gateway keeps running.");
                AskForRestart();
                var wait = WaitDialog("the waiting dialog", f => f.Text == "Restart gateway", 8000);
                if (wait == null) continue;
                Until(() => Stops() == stops + 1, 5000);
                var clock = Stopwatch.StartNew();
                Click(wait, "Cancel");
                var t = Until(() => Closed(wait), 20000);
                var aliveAtClose = GatewayPid() == pid;
                Check("gateway ends " + (delay == "never" ? "never" : delay + " ms after the stop was asked") + ": Cancel closes the dialog (" + Secs(t) + ") while the gateway is still running, and the log says it keeps running", t >= 0 && aliveAtClose && Count(LogText(), "Restart cancelled: the gateway keeps running.") == cancelled + 1);
                if (delay != "never")
                {
                    HeldStart();
                    t = Until(() => GatewayPid() != 0 && GatewayPid() != pid, 15000);
                    Thread.Sleep(400);
                    var held = HeldEnd();
                    Check("from Cancel until it was started again, the window's thread was never held longer than " + held + " ms (asking whether another gateway has the address takes up to 1500 ms)", t >= 0 && held < 1000);
                    var after = clock.ElapsedMilliseconds / 1000.0;
                    Check("then the gateway ended by itself, and it was started again as a new process " + Secs(after) + " after Cancel", t >= 0 && after >= int.Parse(delay) / 1000.0 - 1.6 && after <= int.Parse(delay) / 1000.0 + 5);
                    Until(() => LateLines() == late + 1, 3000);
                    Check("the log says: " + LateLine, LateLines() == late + 1);
                    var again = GatewayPid();
                    t = Until(() => StateText().Contains("Running"), 15000);
                    Thread.Sleep(5000);
                    Check("it runs (" + Secs(t) + "), and 5 s later it is still that one new process: started exactly once (starts +" + (Starts() - starts) + ")", t >= 0 && Starts() == starts + 1 && GatewayPid() == again && LateLines() == late + 1 && !Watching());
                    Check("the count of the gateway that ended is gone", InFlightNow() == 0);
                }
                else
                {
                    Check("the watch is on", Watching());
                    Thread.Sleep(32000);
                    Check("32 s later: the same gateway process, nothing started, the watch has ended", GatewayPid() == pid && Starts() == starts && LateLines() == late && !Watching());
                    Command("exit-in 0");
                    Until(() => GatewayPid() == 0, 6000);
                    t = Until(() => StateText().Contains("Stopped"), 8000);
                    Thread.Sleep(5000);
                    Check("the gateway ends after the 30 s: nothing is started, the window says Stopped (" + Secs(t) + ")", t >= 0 && Starts() == starts && LateLines() == late && GatewayPid() == 0 && StateText().Contains("Stopped"));
                    Check("the count of the gateway that ended is gone", InFlightNow() == 0);
                }
            }

            // The answer did not arrive, and the gateway is gone 3 s later.
            {
                var pid = Fake(1, "lost:3000");
                var starts = Starts();
                var late = LateLines();
                AskForRestart();
                var fallback = WaitDialog("the question after an answer that did not arrive", f => f.Text == "API key" && !HasBox(f) && HasButton(f, "No") && Dialog(x => x.Text == "Restart gateway") == null, 20000);
                if (fallback != null)
                {
                    Check("exit code 1, \"the connection was lost\", gateway still there: the yes or no question, No is the default: " + fallback.Text, fallback.Default == "No" && fallback.Text.Contains("The gateway's answer did not arrive: the connection was lost.") && fallback.Text.Contains("Restart anyway?") && GatewayPid() == pid);
                    var t = Until(() => GatewayPid() != 0 && GatewayPid() != pid, 15000);
                    Until(() => LateLines() == late + 1, 3000);
                    Check("3 s later the gateway is gone: it is started again while the question is still open (" + Secs(t) + "), and the log says so", t >= 0 && LateLines() == late + 1 && !Closed(fallback));
                    var again = GatewayPid();
                    Answer(fallback, "Yes");
                    Thread.Sleep(5000);
                    Check("Yes to the question after that does nothing more: the new gateway is not ended, nothing else is started (starts +" + (Starts() - starts) + ")", GatewayPid() == again && Alive(again) && Starts() == starts + 1 && LateLines() == late + 1);
                }
            }

            // The same, with the gateway gone at once: no question at all.
            {
                var pid = Fake(1, "lost:300");
                var starts = Starts();
                var late = LateLines();
                var gone = Count(LogText(), "Restart: the gateway has stopped (");
                AskForRestart();
                var t = Until(() => GatewayPid() != 0 && GatewayPid() != pid, 15000);
                Thread.Sleep(4000);
                Check("\"the connection was lost\" and the gateway gone at once: started again without a question (" + Secs(t) + "), once", t >= 0 && Starts() == starts + 1 && Count(LogText(), "Restart: the gateway has stopped (") == gone + 1 && LateLines() == late && Dialog(f => true) == null);
            }

            // Exit code 2, then the user stops the gateway by hand.
            {
                var pid = Fake(1, "busy");
                var starts = Starts();
                var late = LateLines();
                AskForRestart();
                var told = WaitDialog("the message after exit code 2", f => f.Text == "API key" && !HasBox(f) && HasButton(f, "OK"), 20000);
                if (told != null) Answer(told, "OK");
                Check("exit code 2: nothing restarted, the watch is on", GatewayPid() == pid && Watching());
                Call("StopRequested");
                var ask = WaitDialog("Stop with 1 in flight", f => f.Text == "Stop gateway", 6000);
                if (ask != null) Answer(ask, "Yes");
                Until(() => Gateway() == null, 10000);
                Thread.Sleep(6000);
                Check("the user stops it by hand: 6 s later nothing was started, the window says Stopped, the watch is off", Starts() == starts && LateLines() == late && Gateway() == null && !Alive(pid) && StateText().Contains("Stopped") && !Watching());
            }

            // Exit code 2, then the user stops and starts the gateway by hand.
            {
                var pid = Fake(1, "busy");
                var starts = Starts();
                var late = LateLines();
                AskForRestart();
                var told = WaitDialog("the message after exit code 2", f => f.Text == "API key" && !HasBox(f) && HasButton(f, "OK"), 20000);
                if (told != null) Answer(told, "OK");
                Call("StopRequested");
                var ask = WaitDialog("Stop with 1 in flight", f => f.Text == "Stop gateway", 6000);
                if (ask != null) Answer(ask, "Yes");
                Until(() => Gateway() == null, 10000);
                Call("StartGateway");
                var t = Until(() => GatewayPid() != 0 && GatewayPid() != pid, 15000);
                var byHand = GatewayPid();
                Until(() => Starts() == starts + 1, 15000);
                Thread.Sleep(6000);
                Check("exit code 2, then Stop and Start by hand: 6 s later the gateway is the one the user started (" + Secs(t) + "), started once, the watch did nothing (starts +" + (Starts() - starts) + ")", t >= 0 && Starts() == starts + 1 && LateLines() == late && GatewayPid() == byHand && !Watching());
            }

            // Cancel, the gateway ends late, and another gateway has the address by then.
            {
                var pid = Fake(1, "commit:2500");
                var starts = Starts();
                var late = LateLines();
                var already = Count(LogText(), "A gateway is already running on");
                var stops = Stops();
                AskForRestart();
                var wait = WaitDialog("the waiting dialog", f => f.Text == "Restart gateway", 8000);
                Until(() => Stops() == stops + 1, 5000);
                if (wait != null) Click(wait, "Cancel");
                if (wait != null) Until(() => Closed(wait), 20000);
                Check("Cancel, and the watch is on", GatewayPid() == pid && Watching());
                // The window's thread is held until another gateway answers at the
                // address, so what the window does about the end of its own comes after.
                var free = new ManualResetEvent(false);
                Post(() => free.WaitOne(40000));
                var ended = Until(() => !Alive(pid), 10000);
                var other = StartFake(false, null);
                var listening = Until(Listening, 25000);
                free.Set();
                Thread.Sleep(5500);
                Check("the gateway ended (" + Secs(ended) + ") and another program's gateway has the address (" + Secs(listening) + ") by the time the window looks: nothing is started (starts +" + (Starts() - starts) + "), and the log says a gateway is already running",
                    ended >= 0 && listening >= 0 && Starts() == starts && LateLines() == late && Gateway() == null && Count(LogText(), "A gateway is already running on") == already + 1 && !Watching());
                var t = Until(() => StateText().Contains("Running"), 45000);
                Check("the window shows that gateway as running (" + Secs(t) + ")", t >= 0);
                End(other);
                Until(() => StateText().Contains("Stopped"), 45000);
            }

            // Exit code 2, then the gateway ends on its own.
            {
                var pid = Fake(1, "busy");
                var starts = Starts();
                var late = LateLines();
                AskForRestart();
                var told = WaitDialog("the message after exit code 2", f => f.Text == "API key" && !HasBox(f) && HasButton(f, "OK"), 20000);
                if (told != null) Answer(told, "OK");
                Command("exit-in 1500");
                var t = Until(() => GatewayPid() != 0 && GatewayPid() != pid, 15000);
                Thread.Sleep(4000);
                Check("exit code 2, then the gateway ends by itself: started again (" + Secs(t) + "), once, and the log says so", t >= 0 && Starts() == starts + 1 && LateLines() == late + 1);
            }
        }

        private static bool StartOn() { return Ui(() => ((Control)F("startButton").GetValue(form)).Enabled); }
        private static bool StopOn() { return Ui(() => ((Control)F("stopButton").GetValue(form)).Enabled); }
        private static string TrayText() { return Ui(() => ((NotifyIcon)F("tray").GetValue(form)).Text); }
        // What the accounts page says when it has no cards.
        private static string AccountsSay()
        {
            return Ui(() => { var panel = (Control)F("accountsPanel").GetValue(form); return panel.Controls.Count == 1 && panel.Controls[0] is Label ? panel.Controls[0].Text : "(" + panel.Controls.Count + " controls)"; });
        }
        private static string Header() { return StateText() + " | Start " + (StartOn() ? "on" : "off") + ", Stop " + (StopOn() ? "on" : "off") + " | tray: " + TrayText() + " | " + Detail(); }
        private const string Dot = "\u25CF ";

        // ----- a gateway of this window that stops answering but is still a process -----
        private static void Silent()
        {
            Head("item 4 and item A: a live gateway of this window that does not answer is neither idle nor stopped");
            var pid = Fake(0, "");
            Until(() => !Get<bool>("fullRunning"), 15000);
            Check("answering: " + Header(), StateText() == Dot + "Running" && !StartOn() && StopOn() && TrayText() == "DSHProxy: running");
            Command("mute");
            var t = Until(() => Get<int>("fastMisses") >= 3 && StateText() == Dot + "Not answering", 12000);
            Check("it stops answering, nothing in flight: third state after three missed checks (" + Secs(t) + "): " + Header(),
                t >= 0 && !StartOn() && StopOn() && TrayText() == "DSHProxy: not answering" && Detail() == "The gateway process is running but does not answer. Stop asks before it cuts anything.");
            Check("the accounts page says: " + AccountsSay(), AccountsSay() == "The gateway is not answering. Accounts and limits are shown again when it does.");
            var starts = Starts();
            Call("StartGateway");
            Thread.Sleep(1200);
            Check("Start, were it pressed, starts nothing: the process is alive", Starts() == starts && GatewayPid() == pid);
            Call("StopRequested");
            var ask = WaitDialog("Stop, gateway silent, count 0", f => f.Text == "Stop gateway", 6000);
            if (ask != null)
            {
                Check("Stop asks, No is the default: " + ask.Text, ask.Default == "No" && ask.Text.Contains("The gateway did not answer when it was last checked, so requests may be in flight. Stopping the gateway now cuts any that are.") && !ask.Text.Contains("when it last answered"));
                Answer(ask, "No");
            }
            Check("No: the gateway process is the same", GatewayPid() == pid);
            Thread.Sleep(13000);
            Check("13 s and a full status later it is still the third state, Start off, Stop on: " + StateText(), StateText() == Dot + "Not answering" && !StartOn() && StopOn() && GatewayPid() == pid);
            var unmuted = DateTime.UtcNow;
            Command("unmute");
            t = Until(() => StateText() == Dot + "Running", 45000);
            var finished = Runs("status --json").FindAll(run => run.Begin > unmuted && run.End != DateTime.MaxValue).Count;
            Check("it answers again: Running on the first answered check (" + Secs(t) + "; the checks are 3 s apart), before any command line run begun since has finished (" + finished + "): " + Header(),
                t >= 0 && t <= 6 && finished == 0 && !StartOn() && StopOn() && TrayText() == "DSHProxy: running");
            Command("exit-in 0");
            t = Until(() => StateText() == Dot + "Stopped" && StartOn(), 30000);
            Check("then its process ends: Stopped, Start on, Stop off (" + Secs(t) + "): " + Header(), t >= 0 && !StopOn() && GatewayPid() == 0 && TrayText() == "DSHProxy: stopped" && Detail() == "The gateway is not running. Press Start.");
            Check("the accounts page says: " + AccountsSay(), AccountsSay() == "The gateway is not running. Press Start to see accounts and limits.");
            Call("StopRequested");
            Thread.Sleep(900);
            Check("and Stop asks nothing", Dialog(f => true) == null);

            pid = Fake(2, "");
            Command("mute");
            t = Until(() => Get<int>("fastMisses") >= 3 && StateText() == Dot + "Not answering", 12000);
            Check("it stops answering with 2 in flight: Not answering (" + Secs(t) + "), and the count is still 2", t >= 0 && InFlightNow() == 2);
            Thread.Sleep(13000);
            Check("13 s and a full status later the count is still 2", InFlightNow() == 2 && GatewayPid() == pid);
            Call("StopRequested");
            ask = WaitDialog("Stop, gateway silent, count 2", f => f.Text == "Stop gateway", 6000);
            if (ask != null)
            {
                Check("Stop asks, No is the default: " + ask.Text, ask.Default == "No" && ask.Text.Contains("The gateway did not answer when it was last checked, so requests may be in flight. 2 model requests were in flight when it last answered. Stopping the gateway now cuts any that are.") && ask.Text.Contains("Stop anyway?"));
                Answer(ask, "No");
            }
            Call("Quit");
            ask = WaitDialog("Quit, gateway silent, count 2", f => f.Text == "Quit DeepSeekProxy", 6000);
            if (ask != null)
            {
                Check("Quit asks, No is the default: " + ask.Text, ask.Default == "No" && ask.Text.Contains("The gateway did not answer when it was last checked") && ask.Text.Contains("Quitting stops the gateway now and cuts any that are") && ask.Text.Contains("Quit anyway?"));
                Answer(ask, "No");
            }
            Thread.Sleep(500);
            Check("No to both: the gateway process is the same and the window is still there", GatewayPid() == pid && Ui(() => form.Visible));
            Command("exit-in 0");
            t = Until(() => GatewayPid() == 0 && InFlightNow() == 0 && StateText() == Dot + "Stopped", 8000);
            Check("its process ends while it is silent: Stopped at once (" + Secs(t) + "), Start on, Stop off, the count is 0", t >= 0 && t <= 3 && StartOn() && !StopOn());
            Call("StopRequested");
            Thread.Sleep(900);
            Check("and Stop asks nothing", Dialog(f => true) == null);

            // Started from the window: Starting until the first answer.
            Mode("fake");
            Until(() => StateText() == Dot + "Stopped", 8000);
            Call("StartGateway");
            var seen = new List<string>();
            var startOnMeanwhile = false;
            t = Until(() =>
            {
                var state = StateText();
                if (seen.Count == 0 || seen[seen.Count - 1] != state) seen.Add(state);
                if (state == Dot + "Starting" && StartOn()) startOnMeanwhile = true;
                return state == Dot + "Running";
            }, 30000);
            Check("Start: the header goes " + string.Join(" > ", seen.ToArray()) + " (" + Secs(t) + "), Start off throughout", t >= 0 && seen.Contains(Dot + "Starting") && seen[seen.Count - 1] == Dot + "Running" && !seen.Contains(Dot + "Not answering") && !startOnMeanwhile && !StartOn() && StopOn());
            pid = GatewayPid();
            Call("StopRequested");
            t = Until(() => Gateway() == null, 10000);
            Check("answering with nothing in flight: Stop asks nothing and stops it (" + Secs(t) + ")", t >= 0 && Dialog(f => true) == null && !Alive(pid));
            t = Until(() => StateText() == Dot + "Stopped" && StartOn(), 15000);
            Check("Stopped, Start on (" + Secs(t) + ")", t >= 0 && !StopOn());

            // Never answered since its start: Starting, and nothing can be in flight.
            Mode("fake born-mute");
            Call("StartGateway");
            Until(() => GatewayPid() != 0, 10000);
            pid = GatewayPid();
            Thread.Sleep(3000);
            Check("a gateway that has not answered since it was started (" + Get<int>("fastMisses") + " checks missed): " + Header(), Get<int>("fastMisses") > 0 && GatewayPid() == pid && StateText() == Dot + "Starting" && !StartOn() && StopOn() && TrayText() == "DSHProxy: starting");
            Check("the accounts page says: " + AccountsSay(), AccountsSay() == "The gateway is starting. Accounts and limits are shown when it answers.");
            Call("StopRequested");
            t = Until(() => Gateway() == null, 10000);
            Check("Stop asks nothing about it and stops it (" + Secs(t) + "): " + Header(), t >= 0 && Dialog(f => true) == null && !Alive(pid) && StateText() == Dot + "Stopped" && StartOn() && !StopOn());
        }

        // ----- how long the window's thread is held -----
        private static long heldMax;
        private static volatile bool heldOn;
        private static Thread heldThread;

        // From here on, the longest time the window's thread took to get to a call that does nothing.
        private static void HeldStart()
        {
            Interlocked.Exchange(ref heldMax, 0);
            heldOn = true;
            if (heldThread != null) return;
            heldThread = new Thread(() =>
            {
                while (true)
                {
                    if (heldOn)
                    {
                        var clock = Stopwatch.StartNew();
                        try { form.Invoke(new Action(() => { })); }
                        catch (InvalidOperationException) { return; }
                        var ms = clock.ElapsedMilliseconds;
                        if (heldOn && ms > Interlocked.Read(ref heldMax)) Interlocked.Exchange(ref heldMax, ms);
                    }
                    Thread.Sleep(15);
                }
            });
            heldThread.IsBackground = true;
            heldThread.Start();
        }

        private static long HeldEnd()
        {
            heldOn = false;
            return Interlocked.Read(ref heldMax);
        }

        // ----- what is asked follows what the header says -----
        // One fast check is missed, as the window sees it, and Stop or Quit is
        // pressed in the same turn of the window's thread: nothing can come between.
        private static string MissOnceThen(string method)
        {
            var miss = typeof(MainForm).GetMethod("ShowFastCheck", BindingFlags.Instance | BindingFlags.NonPublic);
            var press = typeof(MainForm).GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic);
            string seen = null;
            var said = new ManualResetEvent(false);
            Post(() =>
            {
                miss.Invoke(form, new object[] { F("lastOrigin").GetValue(form), null });
                seen = ((Control)F("stateLabel").GetValue(form)).Text + ", " + F("fastMisses").GetValue(form) + " missed";
                said.Set();
                press.Invoke(form, null);
            });
            said.WaitOne(8000);
            return seen;
        }

        private static void Shown()
        {
            Head("last round, item 1: what Stop and Quit ask follows what the header says");
            var pid = Fake(0, "");
            Until(() => !Get<bool>("fullRunning") && Get<int>("fastMisses") == 0 && StateText() == Dot + "Running", 15000);
            var seen = MissOnceThen("StopRequested");
            var t = Until(() => Gateway() == null || Dialog(f => f.Text == "Stop gateway") != null, 12000);
            var ask = Dialog(f => f.Text == "Stop gateway");
            Check("one missed check, nothing in flight, the header says " + seen + ": Stop asks nothing and stops the gateway (" + Secs(t) + ")" + (ask == null ? "" : "; it asked: " + ask.Text),
                seen == Dot + "Running, 1 missed" && ask == null && t >= 0 && Gateway() == null && !Alive(pid));
            if (ask != null) Answer(ask, "No");

            pid = Fake(2, "");
            Until(() => !Get<bool>("fullRunning") && Get<int>("fastMisses") == 0 && StateText() == Dot + "Running" && InFlightNow() == 2, 15000);
            seen = MissOnceThen("StopRequested");
            ask = WaitDialog("Stop, one missed check, 2 in flight", f => f.Text == "Stop gateway", 6000);
            if (ask != null)
            {
                Check("one missed check, 2 in flight, the header says " + seen + ": Stop asks with the ordinary sentence, No is the default: " + ask.Text,
                    seen == Dot + "Running, 1 missed" && ask.Default == "No" && ask.Text.Contains("2 model requests were in flight when the gateway was last checked, a few seconds ago at most. Stopping the gateway now cuts them.") && !ask.Text.Contains("did not answer"));
                Answer(ask, "No");
            }
            Until(() => Get<int>("fastMisses") == 0 && StateText() == Dot + "Running", 10000);
            seen = MissOnceThen("Quit");
            ask = WaitDialog("Quit, one missed check, 2 in flight", f => f.Text == "Quit DeepSeekProxy", 6000);
            if (ask != null)
            {
                Check("the same for Quit (" + seen + "): " + ask.Text,
                    seen == Dot + "Running, 1 missed" && ask.Default == "No" && ask.Text.Contains("2 model requests were in flight when the gateway was last checked, a few seconds ago at most. Quitting stops the gateway now and cuts them.") && !ask.Text.Contains("did not answer"));
                Answer(ask, "No");
            }
            Thread.Sleep(500);
            Check("No to both: the gateway process is the same and the window is still there", GatewayPid() == pid && Ui(() => form.Visible));
            Command("exit-in 0");
            Until(() => GatewayPid() == 0 && StateText() == Dot + "Stopped", 20000);
        }

        // ----- a gateway of this window that never answers -----
        private static void NeverAnswers()
        {
            Head("last round, item 2: a gateway of this window that never answers does not stay Starting");
            Until(() => GatewayPid() == 0 && StateText() == Dot + "Stopped", 20000);
            Mode("fake born-mute");
            var clock = Stopwatch.StartNew();
            Call("StartGateway");
            var seen = new List<string>();
            double flipped = -1, lastStarting = -1;
            var startOn = false;
            var t = Until(() =>
            {
                var state = StateText();
                var at = clock.Elapsed.TotalSeconds;
                if (seen.Count == 0 || seen[seen.Count - 1] != state) seen.Add(state);
                if (state == Dot + "Starting") { lastStarting = at; if (StartOn()) startOn = true; }
                if (state == Dot + "Not answering" && flipped < 0) flipped = at;
                return flipped >= 0;
            }, 50000);
            var pid = GatewayPid();
            Check("alive and silent from the start: the header goes " + string.Join(" > ", seen.ToArray()) + "; it still said Starting " + Secs(lastStarting) + " after Start and said Not answering at " + Secs(flipped) + " (the limit is 30 s, the checks are 3 s apart), Start off throughout: " + Header(),
                t >= 0 && seen.Contains(Dot + "Starting") && lastStarting >= 25 && flipped >= 29.9 && flipped <= 36 && !startOn && pid != 0 && Alive(pid) && !StartOn() && StopOn() && TrayText() == "DSHProxy: not answering");
            Check("the accounts page says: " + AccountsSay(), AccountsSay() == "The gateway is not answering. Accounts and limits are shown again when it does.");
            Call("StopRequested");
            var ask = WaitDialog("Stop, a gateway that never answered", f => f.Text == "Stop gateway", 6000);
            if (ask != null)
            {
                Check("Stop asks, with the sentence of a gateway that did not answer and no count, No is the default: " + ask.Text, ask.Default == "No" && ask.Text.Contains("The gateway did not answer when it was last checked, so requests may be in flight. Stopping the gateway now cuts any that are.") && !ask.Text.Contains("when it last answered"));
                Answer(ask, "No");
            }
            Check("No: the gateway process is the same", pid != 0 && GatewayPid() == pid);
            Command("unmute");
            t = Until(() => StateText() == Dot + "Running", 45000);
            Check("it answers for the first time: Running on the first answered check (" + Secs(t) + "; the checks are 3 s apart): " + Header(), t >= 0 && t <= 6 && pid != 0 && GatewayPid() == pid && !StartOn() && StopOn() && TrayText() == "DSHProxy: running");
            Call("StopRequested");
            t = Until(() => Gateway() == null, 12000);
            Until(() => StateText() == Dot + "Stopped" && StartOn(), 15000);
            Check("answering with nothing in flight: Stop asks nothing and stops it (" + Secs(t) + "): " + Header(), t >= 0 && Dialog(f => true) == null && StateText() == Dot + "Stopped" && StartOn() && !StopOn());
        }

        // ----- Quit with a sign-in waiting for the browser -----
        private static void Leave(List<string> opened)
        {
            Head("Quit with a sign-in helper waiting");
            var gatewayPid = Fake(0, "");
            Call("KreaSignIn");
            var t = Until(() => { lock (opened) return opened.Count == 1; }, 15000);
            var helperLog = Environment.GetEnvironmentVariable("FAKE_KREA_LOG");
            var helperPid = 0;
            foreach (var line in ReadShared(helperLog).Split('\n'))
                if (line.Contains("\"login\"")) helperPid = int.Parse(line.Substring(line.IndexOf("\"pid\":", StringComparison.Ordinal) + 6).Split(',')[0], CultureInfo.InvariantCulture);
            Check("a stand-in sign-in helper is waiting (process " + helperPid + ")", t >= 0 && helperPid != 0 && Alive(helperPid));
            var took = -1L;
            var done = new ManualResetEvent(false);
            var quit = typeof(MainForm).GetMethod("Quit", BindingFlags.Instance | BindingFlags.NonPublic);
            Post(() =>
            {
                var clock = Stopwatch.StartNew();
                quit.Invoke(form, null);
                took = clock.ElapsedMilliseconds;
                done.Set();
            });
            Check("Quit returned", done.WaitOne(30000));
            Note("Quit took " + took + " ms on the UI thread (that includes stopping the gateway, as before)");
            var helperGone = Until(() => !Alive(helperPid), 20000);
            Check("the helper was ended (" + Secs(helperGone) + " after Quit returned) and the gateway too", helperGone >= 0 && !Alive(gatewayPid));
            File.WriteAllText(Path.Combine(rigDir, "quit.txt"), helperPid + " " + gatewayPid, Utf8);
        }
    }
}
