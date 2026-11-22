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
    // Backdrop check, not part of the product. Opens the app's real window as
    // a preview (nothing is started, read or changed), off screen and never
    // activated, resizes it, and looks at the backdrop the app keeps for it.
    //   BackdropCheck <sizes|resizes|idle> <worktree> <throwaway folder> <spare port>
    //   sizes    after every settled resize the backdrop is the one drawn at
    //            that size, and it was drawn once; not while the window is
    //            being dragged, hidden or minimised
    //   resizes  300 resizes: objects and memory before and after
    //   idle     processor time of the window's process in the 60 s after a resize
    // A window that is never shown is not what this looks at: by the rule
    // "nothing is drawn again while the window is hidden" its backdrop stays a
    // stretched one. The window here is shown, at x = -12000. Windows sends a
    // window out there no request to paint, so the check has it painted the
    // way the captures do, with PrintWindow: once after every resize, and
    // once more when the resize has settled.
    internal static class BackdropCheck
    {
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
        [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] private static extern uint GetGuiResources(IntPtr process, uint flags);
        [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        private delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
        private static readonly HookProc NoActivation = (code, w, l) => code == 5 ? (IntPtr)1 : CallNextHookEx(IntPtr.Zero, code, w, l);

        private const BindingFlags Static = BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public;
        private const BindingFlags Any = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
        private static MainForm form;
        private static int failed, foregroundTaken;
        private static string paintLog;
        private static IDictionary cache, pending;
        private static object bridged;
        private static MethodInfo render;

        private static void Check(string what, bool ok) { Console.WriteLine((ok ? "ok   " : "FAIL ") + what); if (!ok) failed++; Console.Out.Flush(); }
        private static void Note(string text) { Console.WriteLine("     " + text); Console.Out.Flush(); }
        private static void Head(string text) { Console.WriteLine("--- " + text + " ---"); Console.Out.Flush(); }
        private static T Ui<T>(Func<T> read) { return (T)form.Invoke(read); }
        private static void Ui(Action act) { form.Invoke(act); }

        private static void Foreground()
        {
            uint pid;
            GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            if (pid == (uint)Process.GetCurrentProcess().Id) foregroundTaken++;
        }

        // The backdrop drawings the app has made so far: one line of its paint log each.
        private static int Renders()
        {
            if (!File.Exists(paintLog)) return 0;
            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    using (var stream = new FileStream(paintLog, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    using (var reader = new StreamReader(stream))
                    {
                        var n = 0;
                        string line;
                        while ((line = reader.ReadLine()) != null) if (line.EndsWith("backdrop render", StringComparison.Ordinal)) n++;
                        return n;
                    }
                }
                catch (IOException) { if (attempt > 20) throw; Thread.Sleep(20); }
            }
        }

        private static bool IsPending() { return Ui(() => pending.Contains(form)); }
        private static string Sets() { return Ui(() => "backdrops kept " + cache.Count + ", redraws waiting " + pending.Count + (bridged == null ? "" : ", stretched ones " + (int)bridged.GetType().GetProperty("Count").GetValue(bridged, null))); }

        private static Bitmap canvas;

        // On the window's thread: the window paints itself, all of it.
        private static void PaintNow()
        {
            if (canvas == null || canvas.Width < form.Width || canvas.Height < form.Height)
            {
                if (canvas != null) canvas.Dispose();
                canvas = new Bitmap(Math.Max(form.Width, 5200), Math.Max(form.Height, 1400), PixelFormat.Format32bppArgb);
            }
            using (var g = Graphics.FromImage(canvas)) { var dc = g.GetHdc(); PrintWindow(form.Handle, dc, 2); g.ReleaseHdc(dc); }
        }

        private static void Resize(Size size) { Ui(() => { SetWindowPos(form.Handle, IntPtr.Zero, -12000, 0, size.Width, size.Height, 0x0004 | 0x0010); PaintNow(); }); Foreground(); }

        // Until no redraw is waiting, and the window has painted what came of it.
        private static void Settle()
        {
            var clock = Stopwatch.StartNew();
            while (clock.ElapsedMilliseconds < 8000 && IsPending()) Thread.Sleep(20);
            Thread.Sleep(250);
            Ui(() => PaintNow());
            Foreground();
        }

        // The backdrop the window has, against one drawn at its size now: the
        // number of differing pixels, -1 when the window has none of its size.
        private static int Differs(out string facts)
        {
            var said = "";
            var n = Ui(() =>
            {
                var size = form.ClientSize;
                var kept = cache.Contains(form) ? (Bitmap)cache[form] : null;
                if (kept == null || kept.Size != size) { said = "client " + size.Width + "x" + size.Height + ", backdrop " + (kept == null ? "none" : kept.Width + "x" + kept.Height); return -1; }
                said = "client " + size.Width + "x" + size.Height;
                using (var fresh = (Bitmap)render.Invoke(null, new object[] { size })) return Count(kept, fresh);
            });
            facts = said;
            return n;
        }

        private static int Count(Bitmap a, Bitmap b)
        {
            var rect = new Rectangle(0, 0, a.Width, a.Height);
            var da = a.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            var db = b.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            var p = new byte[da.Stride * da.Height];
            var q = new byte[db.Stride * db.Height];
            Marshal.Copy(da.Scan0, p, 0, p.Length);
            Marshal.Copy(db.Scan0, q, 0, q.Length);
            a.UnlockBits(da);
            b.UnlockBits(db);
            var n = 0;
            for (var i = 0; i < p.Length; i += 4) if (p[i] != q[i] || p[i + 1] != q[i + 1] || p[i + 2] != q[i + 2] || p[i + 3] != q[i + 3]) n++;
            return n;
        }

        private static int Main(string[] args)
        {
            var mode = args[0];
            var realRoot = args[1];
            var rigDir = args[2];
            var port = int.Parse(args[3], CultureInfo.InvariantCulture);
            if (port == 8417 || port == 8418) return 2;
            var temp = Path.Combine(rigDir, "backdrop-temp");
            Directory.CreateDirectory(temp);
            Directory.CreateDirectory(Path.Combine(rigDir, "localappdata"));
            // Before anything of the app is touched: its paint log is switched
            // on once, when it is first used, and goes to the temp folder.
            Environment.SetEnvironmentVariable("TMP", temp);
            Environment.SetEnvironmentVariable("TEMP", temp);
            if (mode == "sizes") Environment.SetEnvironmentVariable("DSHProxyDebug", "1");
            paintLog = Path.Combine(temp, "dshproxy-paint.log");
            if (File.Exists(paintLog)) File.Delete(paintLog);
            Environment.SetEnvironmentVariable("DSHPROXY_HOME", Path.Combine(rigDir, "home"));
            Environment.SetEnvironmentVariable("DSH_HOME", Path.Combine(rigDir, "no-deepseek-harness"));
            Environment.SetEnvironmentVariable("LOCALAPPDATA", Path.Combine(rigDir, "localappdata"));
            var display = CultureInfo.GetCultureInfo("en-US");
            CultureInfo.DefaultThreadCurrentCulture = display;
            CultureInfo.DefaultThreadCurrentUICulture = display;
            Application.CurrentCulture = display;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            SetWindowsHookEx(5, NoActivation, IntPtr.Zero, GetCurrentThreadId());

            cache = (IDictionary)typeof(Backdrop).GetField("Cache", Static).GetValue(null);
            pending = (IDictionary)typeof(Backdrop).GetField("Pending", Static).GetValue(null);
            var stretched = typeof(Backdrop).GetField("Bridged", Static);
            bridged = stretched == null ? null : stretched.GetValue(null);
            render = typeof(Backdrop).GetMethod("Render", Static);

            form = new MainForm(false, File.ReadAllText(Path.Combine(realRoot, "app", "preview-limits.json")));
            typeof(MainForm).GetField("lastOrigin", Any).SetValue(form, "http://127.0.0.1:" + port);
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(-12000, 0);
            form.MaximumSize = new Size(6000, 3000);
            var test = new Thread(() =>
            {
                try
                {
                    Thread.Sleep(1200);
                    Ui(() => { SetWindowPos(form.Handle, IntPtr.Zero, -12000, 0, 1280, 880, 0x0004 | 0x0010); ShowWindow(form.Handle, 4); PaintNow(); });
                    Settle();
                    if (mode == "sizes") Sizes();
                    else if (mode == "resizes") Resizes();
                    else if (mode == "idle") Idle();
                    Check("the window never became the foreground window", foregroundTaken == 0);
                }
                catch (Exception error)
                {
                    Console.WriteLine("FAIL the check itself stopped: " + error);
                    failed++;
                }
                try { form.BeginInvoke(new Action(() => { typeof(MainForm).GetField("quitting", Any).SetValue(form, true); Application.Exit(); })); } catch (InvalidOperationException) { }
            });
            test.IsBackground = true;
            test.Start();
            Application.Run(form);
            test.Join(20000);
            Console.WriteLine(failed == 0 ? "ALL OK" : failed + " FAILED");
            return failed == 0 ? 0 : 1;
        }

        private static readonly Size[] Four = { new Size(860, 600), new Size(1280, 880), new Size(3440, 1392), new Size(5120, 1392) };

        private static void Sizes()
        {
            Head("after a settled resize the backdrop is the one drawn at that size, drawn once");
            string facts;
            var n = Differs(out facts);
            Check("as first shown, 1280x880 (" + facts + "): " + n + " pixels differ from a backdrop drawn at that size", n == 0);
            // Every one of the four sizes from every other, in both directions: twelve steps.
            var walk = new[] { 0, 1, 0, 2, 0, 3, 1, 2, 1, 3, 2, 3, 0 };
            Resize(Four[0]);
            Settle();
            for (var i = 1; i < walk.Length; i++)
            {
                var from = Four[walk[i - 1]];
                var to = Four[walk[i]];
                var before = Renders();
                Resize(to);
                Settle();
                var drawn = Renders() - before;
                n = Differs(out facts);
                Check(from.Width + "x" + from.Height + " to " + to.Width + "x" + to.Height + " (" + facts + "): " + n + " pixels differ from a backdrop drawn at that size; drawn " + drawn + " time" + (drawn == 1 ? "" : "s") + "; " + Sets(), n == 0 && drawn == 1);
            }

            Head("a window that is being dragged: nothing is drawn until it has come to rest");
            Resize(new Size(1280, 880));
            Settle();
            var start = Renders();
            var during = 0;
            for (var step = 1; step <= 40; step++)
            {
                Resize(new Size(1280 + step * 10, 880 + step * 5));
                Thread.Sleep(15);
                during = Math.Max(during, Renders() - start);
            }
            var atRest = Renders() - start;
            Settle();
            var after = Renders() - start;
            n = Differs(out facts);
            Check("40 steps 15 ms apart, 1280x880 to 1680x1080: drawn " + during + " times while it moved, " + atRest + " when the last step was made, " + after + " in all once it had come to rest; " + n + " pixels differ (" + facts + ")", during == 0 && atRest == 0 && after == 1 && n == 0);

            Head("a window nobody sees: nothing is drawn, and the backdrop is drawn when it is seen again");
            foreach (var how in new[] { "hidden", "minimised" })
            {
                Resize(new Size(1280, 880));
                Settle();
                start = Renders();
                // Resized, and gone before the 160 ms of the wait are over.
                Ui(() => { SetWindowPos(form.Handle, IntPtr.Zero, -12000, 0, 1500, 900, 0x0004 | 0x0010); PaintNow(); ShowWindow(form.Handle, how == "hidden" ? 0 : 7); });
                var waiting = IsPending();
                Thread.Sleep(1500);
                Foreground();
                var gone = Ui(() => how == "hidden" ? !form.Visible : form.WindowState == FormWindowState.Minimized);
                var unseen = Renders() - start;
                Check("resized to 1500x900 and " + how + " at once (a redraw was waiting: " + waiting + "): 1.5 s later it is " + (gone ? how : "NOT " + how) + ", drawn " + unseen + " times, " + Sets(), waiting && gone && unseen == 0 && !IsPending());
                Ui(() => { ShowWindow(form.Handle, 4); PaintNow(); });
                Settle();
                var seen = Renders() - start;
                n = Differs(out facts);
                Check("shown again: drawn " + seen + " time" + (seen == 1 ? "" : "s") + ", " + n + " pixels differ from a backdrop drawn at that size (" + facts + "); " + Sets(), seen == 1 && n == 0 && !IsPending());
            }
        }

        private static string Counts(out long privateBytes, out uint gdi)
        {
            using (var me = Process.GetCurrentProcess())
            {
                me.Refresh();
                privateBytes = me.PrivateMemorySize64;
                gdi = GetGuiResources(me.Handle, 0);
                var user = GetGuiResources(me.Handle, 1);
                return "GDI objects " + gdi + ", USER objects " + user + ", handles " + me.HandleCount + ", private bytes " + (privateBytes / 1048576.0).ToString("0.0", CultureInfo.InvariantCulture) + " MB, managed heap " + (GC.GetTotalMemory(false) / 1048576.0).ToString("0.0", CultureInfo.InvariantCulture) + " MB; " + Sets();
            }
        }

        private static void Collect() { Ui(() => { GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect(); }); }

        private static void Resizes()
        {
            Head("300 resizes, each left to settle: objects and memory before and after");
            var sizes = new[] { new Size(860, 600), new Size(1366, 728), new Size(1920, 1040), new Size(1536, 824), new Size(2560, 1392), new Size(1280, 880) };
            // Once round first, so what the window builds once per size is built.
            for (var round = 0; round < 2; round++) foreach (var size in sizes) { Resize(size); Settle(); }
            Collect();
            Thread.Sleep(500);
            long bytesBefore, bytesAfter, bytesCollected;
            uint gdiBefore, gdiAfter, gdiCollected;
            Note("before, at 1280x880, after a collection: " + Counts(out bytesBefore, out gdiBefore));
            var clock = Stopwatch.StartNew();
            long peak = 0;
            for (var i = 0; i < 300; i++)
            {
                Resize(sizes[i % sizes.Length]);
                Settle();
                if (i % 50 == 49)
                {
                    long b; uint g;
                    Note("after " + (i + 1) + ": " + Counts(out b, out g));
                    peak = Math.Max(peak, b);
                }
            }
            Note("300 resizes took " + (clock.ElapsedMilliseconds / 1000.0).ToString("0", CultureInfo.InvariantCulture) + " s");
            var afterText = Counts(out bytesAfter, out gdiAfter);
            Collect();
            Thread.Sleep(500);
            var collectedText = Counts(out bytesCollected, out gdiCollected);
            Note("after, at 1280x880, as it stands:        " + afterText);
            Note("after, at 1280x880, after a collection:  " + collectedText);
            string facts;
            var n = Differs(out facts);
            var grown = (bytesCollected - bytesBefore) / 1048576.0;
            Check("GDI objects " + gdiBefore + " before and " + gdiCollected + " after; private bytes " + (grown >= 0 ? "+" : "") + grown.ToString("0.0", CultureInfo.InvariantCulture) + " MB (one backdrop of 2560x1392 is about 14 MB); one backdrop kept, none waiting; " + n + " pixels differ from a backdrop drawn at that size",
                Math.Abs((int)gdiCollected - (int)gdiBefore) <= 8 && grown < 12 && Ui(() => cache.Count == 1 && pending.Count == 0) && n == 0);
        }

        private static void Idle()
        {
            Head("processor time of the window's process in the 60 s after a resize");
            Resize(new Size(1920, 1040));
            Settle();
            Thread.Sleep(2000);
            string facts;
            var n = Differs(out facts);
            TimeSpan before;
            using (var me = Process.GetCurrentProcess()) before = me.TotalProcessorTime;
            var waitingSeen = 0;
            var clock = Stopwatch.StartNew();
            while (clock.ElapsedMilliseconds < 60000)
            {
                Thread.Sleep(1000);
                if (IsPending()) waitingSeen++;
                Foreground();
            }
            TimeSpan after;
            using (var me = Process.GetCurrentProcess()) after = me.TotalProcessorTime;
            var ms = (after - before).TotalMilliseconds;
            // 60 looks of this check at the window are in the figure as well.
            Check("60 s after the resize to 1920x1040 had settled (" + n + " pixels differ from a backdrop drawn at that size): " + ms.ToString("0", CultureInfo.InvariantCulture) + " ms of processor time, " + (ms / 600.0).ToString("0.00", CultureInfo.InvariantCulture) + " % of one core; a redraw was waiting in " + waitingSeen + " of 60 looks; " + Sets(),
                ms < 1500 && waitingSeen == 0);
        }
    }
}
