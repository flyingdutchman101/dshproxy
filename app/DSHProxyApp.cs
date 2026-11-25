// DeepSeekProxy (DSHProxy) for Windows: a window and tray icon that run and control the gateway.
//
// The app owns no gateway logic. It starts `node bin/dshproxy.js start` as a
// hidden child process, reads `dshproxy status --json`, and talks to the
// running gateway's local control API for sign-in, accounts and limits. The
// Video workspace reads and writes its models and billing routes only through
// `dshproxy video settings` (see VideoSettings). Built with the C# compiler
// that ships with Windows (see app/build.ps1), so the code stays within C# 5.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace DSHProxy
{
    internal static class Dbg
    {
        private static readonly bool On = Environment.GetEnvironmentVariable("DSHProxyDebug") == "1";
        private static readonly object Gate = new object();

        public static void Write(string what)
        {
            if (!On) return;
            try
            {
                lock (Gate)
                    File.AppendAllText(Path.Combine(Path.GetTempPath(), "dshproxy-paint.log"),
                        DateTime.Now.ToString("HH:mm:ss.fff") + " " + what + Environment.NewLine);
            }
            catch (Exception) { }
        }
    }

    internal static class Program
    {
        // A second launch signals this event, so the instance already in the tray
        // brings its window up instead of showing an "already running" box.
        private const string ShowEvent = "dshproxy-windows-app-show";

        [STAThread]
        private static void Main(string[] args)
        {
            // The interface is in English, so dates and numbers are formatted in
            // English too. Without this they follow the Windows regional setting
            // and come out mixed (English weekday names beside local ones), which
            // reads like a bug. Times are still converted to the machine's own
            // time zone.
            var display = CultureInfo.GetCultureInfo("en-US");
            CultureInfo.DefaultThreadCurrentCulture = display;
            CultureInfo.DefaultThreadCurrentUICulture = display;
            Application.CurrentCulture = display;

            bool created;
            // --preview: a second window that only reads the status of the
            // running gateway; it starts, stops and changes nothing, and has
            // no tray icon. Used to check the layout.
            var previewing = Array.IndexOf(args, "--preview-limits") >= 0 || Array.IndexOf(args, "--preview") >= 0;
            MainForm.ReadOnly = Array.IndexOf(args, "--preview") >= 0;
            using (var mutex = new Mutex(true, previewing ? "dshproxy-windows-app-preview-" + Guid.NewGuid().ToString("N") : "dshproxy-windows-app", out created))
            {
                if (!created)
                {
                    // A second launch (desktop shortcut, Start menu) should bring
                    // up the window that is already running in the tray rather
                    // than complain about it.
                    try
                    {
                        using (var show = EventWaitHandle.OpenExisting(ShowEvent))
                        {
                            show.Set();
                            return;
                        }
                    }
                    catch (Exception)
                    {
                        Msg.Show("DeepSeekProxy is already running. Open it from the tray icon.", "DeepSeekProxy", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                    return;
                }
                // Created before the window so a concurrent second launch can
                // always find it.
                var showEventHandle = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEvent);
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                // --preview-limits <file.json>: shows the Accounts tab with
                // sample limits and starts nothing. Used to check the layout.
                var preview = Array.IndexOf(args, "--preview-limits");
                if (preview >= 0 && preview + 1 < args.Length)
                {
                    Application.Run(new MainForm(false, File.ReadAllText(args[preview + 1])));
                    return;
                }
                Application.Run(new MainForm(Array.IndexOf(args, "--hidden") >= 0, null, ShowEvent));
            }
        }
    }

    // The app icon embedded in the program (app/icon/DSHProxy.ico). Loading it
    // at the size wanted picks the matching frame, so the tray and title bar
    // icons are sharp instead of a scaled 32 px frame.
    internal static class AppIcon
    {
        public static Icon Load(Size size)
        {
            using (var stream = typeof(AppIcon).Assembly.GetManifestResourceStream("app.ico"))
            {
                if (stream == null) return null;
                try { return new Icon(stream, size); }
                catch (ArgumentException) { return null; }
            }
        }
    }

    // Controls.Clear only takes the children off a panel: their windows, and the
    // glass and bitmaps kept for them, would stay until the program ends. This
    // takes them off and releases them. The release happens a moment later, on
    // the same thread, because the caller may be inside a click on one of them.
    internal static class Children
    {
        public static void Release(Control parent)
        {
            if (parent.Controls.Count == 0) return;
            var old = new Control[parent.Controls.Count];
            parent.Controls.CopyTo(old, 0);
            parent.Controls.Clear();
            var context = SynchronizationContext.Current;
            if (context is WindowsFormsSynchronizationContext) context.Post(_ => Dispose(old), null);
            else Dispose(old);
        }

        private static void Dispose(Control[] controls)
        {
            foreach (var control in controls) control.Dispose();
        }
    }

    // Provider logos embedded in the program (see app/logos). Unknown names
    // get null, and callers leave the space empty.
    internal static class Logos
    {
        private static readonly Dictionary<string, Image> Cache = new Dictionary<string, Image>();

        public static Image Get(string provider)
        {
            if (string.IsNullOrEmpty(provider)) return null;
            Image image;
            if (Cache.TryGetValue(provider, out image)) return image;
            using (var stream = typeof(Logos).Assembly.GetManifestResourceStream("logo." + provider + ".png"))
            {
                image = stream == null ? null : new Bitmap(Image.FromStream(stream));
            }
            Cache[provider] = image;
            return image;
        }

        // A logo for a list row: `size` pixels, centred in a slot as tall as
        // the row, so a list with logos keeps the row height it had without.
        // Null when there is no logo of that name.
        public static Image Slot(string provider, int size, int rowHeight)
        {
            using (var logo = Sized(provider, size))
            {
                if (logo == null) return null;
                var slot = new Bitmap(size, rowHeight);
                using (var g = Graphics.FromImage(slot)) g.DrawImage(logo, 0, (rowHeight - size) / 2, size, size);
                return slot;
            }
        }

        // A copy drawn at `size` pixels, for list views and buttons.
        public static Image Sized(string provider, int size)
        {
            var source = Get(provider);
            if (source == null) return null;
            var bitmap = new Bitmap(size, size);
            using (var g = Graphics.FromImage(bitmap))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(source, 0, 0, size, size);
            }
            return bitmap;
        }
    }

    internal static class Json
    {
        public static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        public static string Str(object value)
        {
            return value == null ? "" : Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        public static Dictionary<string, object> Obj(object value)
        {
            return value as Dictionary<string, object> ?? new Dictionary<string, object>();
        }

        // DeserializeObject returns lists as object[]; Deserialize<T> returns
        // ArrayList. Both are accepted.
        public static ArrayList Arr(object value)
        {
            var list = value as ArrayList;
            if (list != null) return list;
            var array = value as object[];
            return array != null ? new ArrayList(array) : new ArrayList();
        }

        public static object Get(Dictionary<string, object> map, string key)
        {
            object value;
            return map != null && map.TryGetValue(key, out value) ? value : null;
        }

        public static bool Bool(Dictionary<string, object> map, string key)
        {
            var value = Get(map, key);
            return value is bool && (bool)value;
        }

        public static double Num(Dictionary<string, object> map, string key, double fallback)
        {
            var value = Get(map, key);
            if (value == null) return fallback;
            try { return Convert.ToDouble(value, CultureInfo.InvariantCulture); }
            catch (FormatException) { return fallback; }
            catch (InvalidCastException) { return fallback; }
        }
    }

    internal static class Format
    {
        public static DateTime? ParseTime(string iso)
        {
            if (string.IsNullOrEmpty(iso)) return null;
            DateTime parsed;
            if (DateTime.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out parsed)) return parsed.ToLocalTime();
            return null;
        }

        public static string Until(DateTime when)
        {
            var span = when - DateTime.Now;
            if (span.TotalSeconds <= 0) return "now";
            if (span.TotalMinutes < 60) return string.Format("{0} min", Math.Max(1, (int)Math.Ceiling(span.TotalMinutes)));
            if (span.TotalHours < 24) return string.Format("{0} h {1} min", (int)span.TotalHours, span.Minutes);
            return string.Format("{0} d {1} h", (int)span.TotalDays, span.Hours);
        }

        public static string Reset(string iso)
        {
            var when = ParseTime(iso);
            if (!when.HasValue) return "reset time not reported";
            var day = when.Value.Date == DateTime.Today ? "today" : when.Value.Date == DateTime.Today.AddDays(1) ? "tomorrow" : when.Value.ToString("ddd d MMM", CultureInfo.CurrentCulture);
            return string.Format("resets in {0} ({1} {2})", Until(when.Value), day, when.Value.ToString("HH:mm", CultureInfo.CurrentCulture));
        }

        public static string Ago(DateTime when)
        {
            var span = DateTime.Now - when;
            if (span.TotalSeconds < 45) return "just now";
            if (span.TotalMinutes < 60) return string.Format("{0} min ago", (int)Math.Round(span.TotalMinutes));
            return when.ToString("HH:mm", CultureInfo.CurrentCulture);
        }
    }

    // Runs the DSHProxy command line.
    internal sealed class Cli
    {
        public readonly string Root;
        public readonly string Node;

        public Cli(string root, string node)
        {
            Root = root;
            Node = node;
        }

        public static string FindRoot()
        {
            var dir = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
            while (dir != null)
            {
                if (File.Exists(Path.Combine(dir.FullName, "bin", "dshproxy.js"))) return dir.FullName;
                dir = dir.Parent;
            }
            return null;
        }

        public static string FindNode()
        {
            var candidates = new List<string>();
            var path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var part in path.Split(';'))
            {
                if (part.Trim().Length > 0) candidates.Add(Path.Combine(part.Trim(), "node.exe"));
            }
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
            foreach (var candidate in candidates)
            {
                try { if (File.Exists(candidate)) return candidate; } catch (ArgumentException) { }
            }
            return null;
        }

        private static string Quote(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
            return "\"" + arg.Replace("\"", "\\\"") + "\"";
        }

        private ProcessStartInfo Info(string[] args)
        {
            return Info(Path.Combine(Root, "bin", "dshproxy.js"), args);
        }

        // Node running one script of the DSHProxy folder, hidden, with its
        // standard streams in this program's hands.
        private ProcessStartInfo Info(string script, string[] args)
        {
            var parts = new List<string> { Quote(script) };
            foreach (var arg in args) parts.Add(Quote(arg));
            return new ProcessStartInfo(Node, string.Join(" ", parts.ToArray()))
            {
                WorkingDirectory = Root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
        }

        public sealed class Result
        {
            public int Code;
            public string Out;
            public string Err;
        }

        // Runs a command to completion. `input` is written to standard input,
        // which is how API keys are passed: never on the command line.
        public Result Run(string[] args, string input, int timeoutMs)
        {
            return Run(Info(args), input, timeoutMs);
        }

        private static Result Run(ProcessStartInfo info, string input, int timeoutMs)
        {
            using (var process = Process.Start(info))
            {
                var output = process.StandardOutput.ReadToEndAsync();
                var errors = process.StandardError.ReadToEndAsync();
                if (input != null) process.StandardInput.Write(input);
                process.StandardInput.Close();
                if (!process.WaitForExit(timeoutMs))
                {
                    try { process.Kill(); } catch (InvalidOperationException) { }
                    return new Result { Code = -1, Out = "", Err = "The command did not finish in time." };
                }
                return new Result { Code = process.ExitCode, Out = output.Result, Err = errors.Result };
            }
        }

        // Starts a command and hands its process over, for one that waits and
        // can be cancelled.
        public Process Start(string[] args)
        {
            return Process.Start(Info(args));
        }

        // Starts the long-running gateway, hidden.
        public Process StartHidden(string[] args)
        {
            var info = Info(args);
            info.RedirectStandardInput = false;
            return Process.Start(info);
        }

        // The separate Krea helper. It is started directly, never through
        // dshproxy.js: the sign-in it keeps stays out of the routing command
        // line, and out of this program.
        private string KreaScript
        {
            get { return Path.Combine(Root, "bin", "dshproxy-krea.js"); }
        }

        // Runs a short helper command (status, logout) to its end.
        public Result RunKrea(string[] args, int timeoutMs)
        {
            return Run(Info(KreaScript, args), null, timeoutMs);
        }

        // Starts a helper command that waits (login) and hands the process over.
        public Process StartKrea(string[] args)
        {
            return Process.Start(Info(KreaScript, args));
        }
    }

    internal sealed class ControlException : Exception
    {
        public ControlException(string message) : base(message) { }
    }

    // Calls the running gateway's local control API. The token is read from
    // the data folder on every call, because the gateway makes a new one each
    // time it starts.
    internal sealed class GatewayControl
    {
        private readonly Func<string> origin;

        public GatewayControl(Func<string> origin)
        {
            this.origin = origin;
        }

        public static string Home()
        {
            var home = Environment.GetEnvironmentVariable("DSHPROXY_HOME");
            return string.IsNullOrEmpty(home) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dshproxy") : home;
        }

        private static string Token()
        {
            var file = Path.Combine(Home(), "control.token");
            if (!File.Exists(file)) throw new ControlException("The gateway is not running. Press Start first.");
            return File.ReadAllText(file).Trim();
        }

        public Dictionary<string, object> Call(string method, string path, object body, int timeoutMs)
        {
            var request = (HttpWebRequest)WebRequest.Create(origin() + "/dshproxy/control/" + path);
            request.Method = method;
            request.Timeout = timeoutMs;
            request.ReadWriteTimeout = timeoutMs;
            request.Headers["x-dshproxy-token"] = Token();
            request.Accept = "application/json";
            if (body != null)
            {
                var bytes = Encoding.UTF8.GetBytes(Json.Serializer.Serialize(body));
                request.ContentType = "application/json";
                request.ContentLength = bytes.Length;
                using (var stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
            }
            try
            {
                using (var response = (HttpWebResponse)request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    return Json.Obj(Json.Serializer.DeserializeObject(reader.ReadToEnd()));
                }
            }
            catch (WebException error)
            {
                var response = error.Response as HttpWebResponse;
                if (response == null) throw new ControlException("The gateway did not answer. Is it running?");
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    var text = reader.ReadToEnd();
                    try { throw new ControlException(Json.Str(Json.Get(Json.Obj(Json.Serializer.DeserializeObject(text)), "error"))); }
                    catch (ArgumentException) { throw new ControlException(text.Length > 0 ? text : error.Message); }
                }
            }
        }
    }

    // A horizontal bar showing how much of a limit is left.
    internal sealed class Meter : System.Windows.Forms.Control
    {
        private double left;

        public Meter()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            Height = 8;
            Margin = new Padding(8, 9, 16, 9);
        }

        public double LeftPercent
        {
            get { return left; }
            set { left = Math.Max(0, Math.Min(100, value)); Invalidate(); }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
            var bounds = new RectangleF(0, 0, Width - 1, Height - 1);
            using (var track = new SolidBrush(Theme.Track)) FillRounded(e.Graphics, track, bounds);
            var width = (float)((Width - 1) * left / 100.0);
            if (width >= 2)
            {
                var color = Theme.ForLeft(left);
                using (var fill = new LinearGradientBrush(new RectangleF(0, 0, Math.Max(width, 2), Height), ControlPaint.Dark(color, 0.25f), color, LinearGradientMode.Horizontal)) FillRounded(e.Graphics, fill, new RectangleF(0, 0, width, Height - 1));
            }
        }

        private static void FillRounded(Graphics g, Brush brush, RectangleF r)
        {
            var radius = Math.Min(r.Height, r.Width);
            using (var path = new GraphicsPath())
            {
                path.AddArc(r.X, r.Y, radius, r.Height, 90, 180);
                path.AddArc(r.Right - radius, r.Y, radius, r.Height, 270, 180);
                path.CloseFigure();
                g.FillPath(brush, path);
            }
        }
    }

    // Guides the user through one sign-in and confirms the result.
    internal sealed class SignInDialog : Form
    {
        private readonly GatewayControl control;
        private readonly ArrayList providers;
        private readonly Panel body = Glass.Make(new Panel { Dock = DockStyle.Fill, Padding = new Padding(22, 18, 22, 14) }, 24, true);
        private readonly Panel holder = new Panel { Dock = DockStyle.Fill, Padding = new Padding(14, 14, 14, 0) };
        private readonly FlowLayoutPanel buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Height = 62, Padding = new Padding(14, 12, 14, 10) };
        private readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer { Interval = 1500 };
        private string sessionId;
        private string sessionLabel;
        private bool busy;

        public string SignedInAs;

        // The services the gateway can sign in to, used when the status has not
        // been read yet.
        private static ArrayList DefaultProviders()
        {
            var list = new ArrayList();
            foreach (var pair in new[] { new[] { "claude", "Claude" }, new[] { "codex", "ChatGPT (Codex)" }, new[] { "antigravity", "Gemini (Antigravity)" }, new[] { "kimi", "Kimi" } })
            {
                list.Add(new Dictionary<string, object> { { "key", pair[0] }, { "label", pair[1] } });
            }
            return list;
        }

        public SignInDialog(GatewayControl control, ArrayList providers)
        {
            this.control = control;
            this.providers = providers != null && providers.Count > 0 ? providers : DefaultProviders();
            Text = "Add an account";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MinimizeBox = false;
            MaximizeBox = false;
            ShowInTaskbar = false;
            ClientSize = new Size(548, 520);
            Font = Theme.Ui(9.5f);
            holder.Controls.Add(body);
            Controls.Add(holder);
            Controls.Add(buttons);
            Skin.Apply(this);
            poll.Tick += (s, e) => Poll();
            FormClosing += (s, e) =>
            {
                poll.Stop();
                if (sessionId != null) CancelSession();
            };
            ShowChoices();
        }

        private void Reset(params Button[] actions)
        {
            // The default buttons belong to the contents that go now. The next
            // contents name their own, where they have one.
            AcceptButton = null;
            CancelButton = null;
            Children.Release(body);
            Children.Release(buttons);
            foreach (var action in actions) buttons.Controls.Add(action);
        }

        private static Label Heading(string text)
        {
            return new GlassLabel { Text = text, Dock = DockStyle.Top, Height = 38, Font = Theme.Ui(15f, FontStyle.Bold), ForeColor = Theme.Text };
        }

        private static Label Text2(string text, Color color)
        {
            return new GlassLabel { Text = text, Dock = DockStyle.Top, AutoSize = false, Height = 44, ForeColor = color };
        }

        private Button Close2(string text)
        {
            var button = new PillButton { Text = text, Width = 96, Height = 32 };
            button.Click += (s, e) => Close();
            return button;
        }

        private static readonly Dictionary<string, string> Descriptions = new Dictionary<string, string>
        {
            { "claude", "Claude Pro or Max. Opens claude.ai." },
            { "codex", "ChatGPT Plus or Pro. Opens chatgpt.com." },
            { "antigravity", "Google AI Pro or Ultra. Opens accounts.google.com." },
            { "kimi", "Kimi Code. You type a short code on kimi.com." }
        };

        private void ShowChoices()
        {
            sessionId = null;
            Reset(Close2("Cancel"));
            var list = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(0, 6, 0, 0) };
            foreach (var item in providers)
            {
                var provider = Json.Obj(item);
                var key = Json.Str(Json.Get(provider, "key"));
                var label = Json.Str(Json.Get(provider, "label"));
                string description;
                Descriptions.TryGetValue(key, out description);
                var choice = new PillButton
                {
                    Text = label + Environment.NewLine + (description ?? ""),
                    TextAlign = ContentAlignment.MiddleLeft,
                    Width = 470,
                    Height = 64,
                    Margin = new Padding(0, 0, 0, 8),
                    Padding = new Padding(12, 0, 0, 0),
                    Image = Logos.Sized(key, 30),
                    ImageAlign = ContentAlignment.MiddleLeft,
                    TextImageRelation = TextImageRelation.ImageBeforeText
                };
                choice.Click += (s, e) => Begin(key, label);
                list.Controls.Add(choice);
            }
            body.Controls.Add(list);
            body.Controls.Add(Text2("Pick the subscription to sign in to. Your browser opens to the provider's own sign-in page; DSHProxy never sees your password.", Theme.Muted));
            body.Controls.Add(Heading("Add an account"));
        }

        private string sessionKey;

        // The service's logo, shown above the heading while signing in.
        private System.Windows.Forms.Control LogoBox(string key)
        {
            var image = Logos.Sized(key, 44);
            var row = new Panel { Dock = DockStyle.Top, Height = image == null ? 0 : 52 };
            if (image != null) row.Controls.Add(new GlassPicture { Image = image, Size = new Size(44, 44), Location = new Point(0, 0) });
            return row;
        }

        private void Begin(string key, string label)
        {
            if (busy) return;
            busy = true;
            sessionLabel = label;
            sessionKey = key;
            Reset(Close2("Cancel"));
            body.Controls.Add(Text2("Asking the provider for a sign-in link...", Theme.Muted));
            body.Controls.Add(Heading("Signing in to " + label));
            body.Controls.Add(LogoBox(key));
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Dictionary<string, object> started = null;
                string failure = null;
                try { started = control.Call("POST", "login/start", new Dictionary<string, object> { { "provider", key } }, 30000); }
                catch (ControlException error) { failure = error.Message; }
                catch (WebException error) { failure = error.Message; }
                BeginInvoke(new Action(() =>
                {
                    busy = false;
                    if (failure != null) { ShowFailure(failure, key, label); return; }
                    ShowWaiting(started, key, label);
                }));
            });
        }

        private void ShowWaiting(Dictionary<string, object> started, string key, string label)
        {
            sessionId = Json.Str(Json.Get(started, "id"));
            var url = Json.Str(Json.Get(started, "url"));
            var device = Json.Str(Json.Get(started, "flow")) == "device";
            var code = Json.Str(Json.Get(started, "userCode"));

            var cancel = new PillButton { Text = "Cancel", Width = 96, Height = 32 };
            cancel.Click += (s, e) => { CancelSession(); ShowChoices(); };
            var reopen = Skin.Primary(new PillButton { Text = "Open page again", Width = 140, Height = 32 });
            reopen.Click += (s, e) => OpenBrowser(url);
            var copy = new PillButton { Text = "Copy link", Width = 96, Height = 32 };
            copy.Click += (s, e) => Clipboard.SetText(url);
            Reset(cancel, reopen, copy);

            var progress = new Marquee { Dock = DockStyle.Top };
            var waiting = Text2("Waiting for you to finish in your browser. This window updates by itself; the sign-in expires after 5 minutes.", Theme.Muted);
            body.Controls.Add(waiting);
            body.Controls.Add(new Panel { Dock = DockStyle.Top, Height = 14 });
            body.Controls.Add(progress);
            body.Controls.Add(new Panel { Dock = DockStyle.Top, Height = 14 });
            if (device && code.Length > 0)
            {
                var codeRow = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 56, FlowDirection = FlowDirection.LeftToRight };
                var codeLabel = new GlassLabel { Text = code, AutoSize = true, Font = Theme.Mono(22f, FontStyle.Bold), ForeColor = Theme.Accent, Margin = new Padding(0, 10, 16, 0) };
                var copyCode = Skin.Outline(new PillButton { Text = "Copy code", Width = 104, Height = 32, Margin = new Padding(0, 12, 0, 0) });
                copyCode.Click += (s, e) => Clipboard.SetText(code);
                codeRow.Controls.Add(codeLabel);
                codeRow.Controls.Add(copyCode);
                body.Controls.Add(codeRow);
                body.Controls.Add(Text2("Enter this code on the " + label + " page that opened:", Theme.Text));
            }
            else
            {
                body.Controls.Add(Text2("Sign in on the " + label + " page that opened and approve access. When it says you are signed in, come back here.", Theme.Text));
            }
            body.Controls.Add(Heading("Signing in to " + label));
            body.Controls.Add(LogoBox(key));
            OpenBrowser(url);
            poll.Start();
        }

        private static void OpenBrowser(string url)
        {
            // Only web addresses are opened; anything else is ignored.
            Uri parsed;
            if (!Uri.TryCreate(url, UriKind.Absolute, out parsed) || parsed.Scheme != Uri.UriSchemeHttps) return;
            try { Process.Start(new ProcessStartInfo(parsed.AbsoluteUri) { UseShellExecute = true }); }
            catch (System.ComponentModel.Win32Exception) { }
        }

        private void Poll()
        {
            if (sessionId == null || busy) return;
            busy = true;
            var id = sessionId;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Dictionary<string, object> status = null;
                string failure = null;
                try { status = control.Call("GET", "login/status?id=" + Uri.EscapeDataString(id), null, 15000); }
                catch (ControlException error) { failure = error.Message; }
                catch (WebException error) { failure = error.Message; }
                BeginInvoke(new Action(() =>
                {
                    busy = false;
                    if (id != sessionId) return;
                    if (failure != null) return;
                    var state = Json.Str(Json.Get(status, "status"));
                    if (state == "ok")
                    {
                        poll.Stop();
                        sessionId = null;
                        ShowSuccess(Json.Str(Json.Get(status, "account")));
                    }
                    else if (state == "error")
                    {
                        poll.Stop();
                        sessionId = null;
                        ShowFailure(Json.Str(Json.Get(status, "error")), null, sessionLabel);
                    }
                }));
            });
        }

        private void CancelSession()
        {
            var id = sessionId;
            sessionId = null;
            poll.Stop();
            if (id == null) return;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try { control.Call("POST", "login/cancel", new Dictionary<string, object> { { "id", id } }, 10000); }
                catch (ControlException) { }
                catch (WebException) { }
            });
        }

        private void ShowSuccess(string account)
        {
            SignedInAs = account.Length > 0 ? account : sessionLabel;
            var done = Skin.Primary(new PillButton { Text = "Done", Width = 96, Height = 32, DialogResult = DialogResult.OK });
            var another = new PillButton { Text = "Add another", Width = 116, Height = 32 };
            another.Click += (s, e) => ShowChoices();
            Reset(done, another);
            AcceptButton = done;
            body.Controls.Add(Text2("DSHProxy can now use this subscription. Its limits appear on the Accounts tab within a minute.", Theme.Muted));
            body.Controls.Add(new GlassLabel { Text = account.Length > 0 ? account : "", Dock = DockStyle.Top, Height = 28, Font = Theme.Ui(11f) });
            body.Controls.Add(new GlassLabel { Text = "\u2713  Signed in to " + sessionLabel, Dock = DockStyle.Top, Height = 40, Font = Theme.Ui(14f, FontStyle.Bold), ForeColor = Theme.Ok });
            body.Controls.Add(LogoBox(sessionKey));
        }

        private void ShowFailure(string message, string key, string label)
        {
            var back = new PillButton { Text = "Back", Width = 96, Height = 32 };
            back.Click += (s, e) => ShowChoices();
            Reset(Close2("Close"), back);
            if (key != null)
            {
                var retry = Skin.Primary(new PillButton { Text = "Try again", Width = 104, Height = 32 });
                retry.Click += (s, e) => Begin(key, label);
                buttons.Controls.Add(retry);
            }
            body.Controls.Add(Text2(message, Theme.Text));
            body.Controls.Add(new GlassLabel { Text = "Sign-in to " + label + " did not finish", Dock = DockStyle.Top, Height = 40, Font = Theme.Ui(13f, FontStyle.Bold), ForeColor = Theme.Bad });
            body.Controls.Add(LogoBox(key ?? sessionKey));
        }
    }

    internal sealed class MainForm : Form
    {
        private readonly Cli cli;
        private readonly GatewayControl control;
        private readonly bool startHidden;
        private readonly NotifyIcon tray = new NotifyIcon();
        private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer limitsTimer = new System.Windows.Forms.Timer();
        private Process gateway;
        private bool quitting;
        private bool loadingLimits;
        private bool balloonShown;
        private bool running;
        private bool shownOnce;
        private string lastOrigin = "http://127.0.0.1:8417";
        private ArrayList loginProviders = new ArrayList();
        private ArrayList providers = new ArrayList();
        private DateTime? limitsAt;
        private readonly HashSet<string> warned = new HashSet<string>();

        private readonly Chip stateLabel = new Chip { Font = Theme.Ui(9f, FontStyle.Bold), Margin = new Padding(14, 12, 0, 0) };
        private readonly Label detailLabel = new GlassLabel { AutoSize = true, ForeColor = Theme.Muted, Margin = new Padding(0, 2, 0, 0) };
        private readonly Label lowestLabel = new GlassLabel { AutoSize = true, Margin = new Padding(0, 2, 0, 0) };
        private readonly Button startButton = Skin.Primary(new PillButton { Text = "Start", Width = 104, Height = 40 });
        private readonly Button stopButton = Skin.Danger(new PillButton { Text = "Stop", Width = 104, Height = 40, Margin = new Padding(8, 3, 0, 3) });
        // In the header, so it is in sight on every page of both workspaces.
        private readonly Button applyButton = Skin.Primary(new PillButton { Text = "Apply to DeepSeek Harness", AutoSize = true, MinimumSize = new Size(0, 40), Margin = new Padding(0, 3, 8, 3), AccessibleDescription = "Writes the DSHProxy chat routes into every DeepSeek Harness profile and installs the video tools, after asking." });
        private readonly Panel accountsPanel = new Panel { Dock = DockStyle.Fill, AutoScroll = true, Padding = new Padding(0, 4, 0, 4) };
        private readonly Label limitsNote = new GlassLabel { AutoSize = true, ForeColor = Theme.Muted, Padding = new Padding(0, 12, 0, 0) };
        private readonly ListView keysList = new DarkList();
        private readonly ComboBox keyProviderCombo = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200, Margin = new Padding(0, 6, 3, 3) };
        private readonly ComboBox keyRegionCombo = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 220, Margin = new Padding(3, 6, 3, 3) };
        private readonly ListView lanesList = new DarkList();
        private readonly ListView modelsList = new DarkList();
        private readonly Label modelsNote = new GlassLabel { AutoSize = true, ForeColor = Theme.Muted, Padding = new Padding(0, 12, 0, 0) };
        private readonly FlowLayoutPanel suggestionsPanel = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(0, 8, 0, 8), Margin = new Padding(0, 0, 0, 8), Visible = false };
        private readonly FlowLayoutPanel updateBar = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Padding = new Padding(22, 8, 19, 8), Visible = false };
        private readonly Label updateLabel = new GlassLabel { AutoSize = false, Margin = new Padding(0, 8, 12, 0) };
        private readonly Button updateButton = Skin.Primary(new PillButton { Text = "Update...", AutoSize = true });
        private readonly Button rollbackButton = new PillButton { Text = "Roll back...", AutoSize = true };
        private ArrayList modelRows = new ArrayList();
        private bool showHiddenModels;
        private bool fillingModels;
        private int failedPolls;
        private string accountsKey = "";
        private string modelsKey = "";
        private string keysKey = "";
        private string lanesKey = "";
        private string profilesKey = "";
        private string routingKey = "";
        private string suggestionsKey = "";
        private Dictionary<string, object> lastUpdate;
        private string previousBackend = "";
        private readonly ListView profilesList = new DarkList();
        private readonly TextBox logBox = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, WordWrap = false, Dock = DockStyle.Fill, Font = Theme.Mono(9f), BackColor = Theme.Input };
        private readonly CheckBox autostartBox = new GlassCheck { Text = "Start with Windows", AutoSize = true };
        private readonly Label footer = new GlassLabel { AutoSize = true, ForeColor = Theme.Muted };
        private readonly PageHost tabs = new PageHost { Dock = DockStyle.Fill };
        private NavStrip navStrip;

        private readonly string previewLimits;
        public static bool ReadOnly;

        public MainForm(bool hidden, string previewLimits, string showEvent = null)
        {
            startHidden = hidden;
            this.previewLimits = previewLimits;
            if (showEvent != null)
            {
                // Listen for a second launch wanting this window on screen.
                var handle = new EventWaitHandle(false, EventResetMode.AutoReset, showEvent);
                var watcher = new Thread(() =>
                {
                    while (true)
                    {
                        handle.WaitOne();
                        if (IsDisposed) return;
                        try { BeginInvoke(new Action(ShowRequested)); }
                        catch (Exception) { return; }
                    }
                });
                watcher.IsBackground = true;
                watcher.Start();
            }
            var root = Cli.FindRoot();
            var node = Cli.FindNode();
            if (root == null || node == null)
            {
                Msg.Show(root == null ? "DSHProxy.exe must stay in the DSHProxy folder (next to bin\\dshproxy.js)." : "Node.js was not found. Install Node.js 22 or later.", "DSHProxy", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Environment.Exit(1);
            }
            cli = new Cli(root, node);
            control = new GatewayControl(() => lastOrigin);

            Text = "DeepSeekProxy";
            // Sized and placed for the screen the window opens on, which is
            // the one the pointer is on.
            Size smallest;
            var start = StartBounds(Screen.FromPoint(Cursor.Position).WorkingArea, out smallest);
            MinimumSize = smallest;
            StartPosition = FormStartPosition.Manual;
            Bounds = start;
            Font = Theme.Ui(9.5f);
            Icon = AppIcon.Load(SystemInformation.IconSize);

            BuildLayout();
            BuildTray();
            Skin.Apply(this);
            LayoutColumn();
            ClientSizeChanged += (s, e) => LayoutColumn();
            // The header is lower in a short window when its two status lines
            // fit side by side, which depends on what they say.
            // Whether the status lines fit beside the buttons depends on it too.
            detailLabel.TextChanged += (s, e) => LayoutHeader(shortWindow, column.Width);
            lowestLabel.TextChanged += (s, e) => LayoutHeader(shortWindow, column.Width);

            // Dragging the window edge to a new size: show a stretched snapshot
            // of the window and lay out again when the drag ends. Rebuilding the
            // glass for every dragged pixel is what tore the window apart.
            ResizeBegin += (s, e) => BeginResizePreview();
            ResizeEnd += (s, e) => EndResizePreview();
            // Also raised when the window has been dragged to another screen.
            ResizeEnd += (s, e) => FitMinimumSize();
            Resize += (s, e) => { if (resizePreview != null) { resizeWatchdog.Stop(); resizeWatchdog.Start(); } };

            startButton.Click += (s, e) => StartGateway();
            stopButton.Click += (s, e) => StopRequested();
            applyButton.Click += (s, e) => ApplyToHarness();
            autostartBox.Checked = Autostart.IsOn();
            autostartBox.CheckedChanged += (s, e) => Autostart.Set(autostartBox.Checked);

            timer.Interval = WatchedCheckMs;
            timer.Tick += (s, e) => StatusTick();
            // Shown, hidden, minimised or restored: the checks keep pace with it.
            VisibleChanged += (s, e) => WatchChanged();
            Resize += (s, e) => WatchChanged();
            limitsTimer.Interval = 60000;
            limitsTimer.Tick += (s, e) => LoadLimits(false);
            Shown += (s, e) => OnShownOnce();
            // --tab <n>: open on that tab (used to check the layout).
            var args = Environment.GetCommandLineArgs();
            var tabArg = Array.IndexOf(args, "--tab");
            int tabIndex;
            if (tabArg >= 0 && tabArg + 1 < args.Length && int.TryParse(args[tabArg + 1], out tabIndex) && tabIndex >= 0 && tabIndex < tabs.TabPages.Count) tabs.SelectedIndex = tabIndex;
            // --workspace video: open in the Video workspace (used to check the layout).
            var workspaceArg = Array.IndexOf(args, "--workspace");
            if (workspaceArg >= 0 && workspaceArg + 1 < args.Length && args[workspaceArg + 1] == "video") videoSwitch.Checked = true;
            FormClosing += OnClosing;
        }

        // The window's first size and place: up to 1280x880, never more than
        // 92% of the working area of its screen, and in the middle of it. The
        // smallest size it can be dragged to is 860x600, or 92% of the working
        // area where that is less, so it always fits the screen it opens on.
        internal static Rectangle StartBounds(Rectangle area, out Size smallest)
        {
            var mostWide = Math.Max(1, area.Width * 92 / 100);
            var mostHigh = Math.Max(1, area.Height * 92 / 100);
            smallest = new Size(Math.Min(860, mostWide), Math.Min(600, mostHigh));
            var width = Math.Max(smallest.Width, Math.Min(1280, mostWide));
            var height = Math.Max(smallest.Height, Math.Min(880, mostHigh));
            return new Rectangle(area.X + (area.Width - width) / 2, area.Y + (area.Height - height) / 2, width, height);
        }

        // The smallest size follows the working area of the screen the window
        // is on now, so it can always be made to fit that screen.
        private void FitMinimumSize()
        {
            Size smallest;
            StartBounds(Screen.FromControl(this).WorkingArea, out smallest);
            if (MinimumSize != smallest) MinimumSize = smallest;
        }

        // ---------- the column ----------
        //
        // Everything in the window sits in one column in the middle of it, at
        // most MaxColumnWidth wide; the backdrop fills the rest. A narrower
        // window is all column, with the side padding each row already has.
        // In a short window (client height under ShortBelow) the header and
        // the rows around the pages are lower and, when the column is wide
        // enough, the workspace switch moves onto the row of the section strip.

        private const int MaxColumnWidth = 1240;
        private const int ShortBelow = 760;
        private readonly Panel column = new Panel();
        private readonly Panel switchRow = new Panel { Dock = DockStyle.Top, Height = 108 };
        private readonly Font nameFont = Theme.Light(22f);
        private readonly Font nameFontShort = Theme.Light(17f);
        private TableLayoutPanel headerPanel;
        private AppMark headerMark;
        private Label nameLabel;
        private FlowLayoutPanel nameRow;
        private FlowLayoutPanel detailRow;
        private FlowLayoutPanel headerButtons;
        private TableLayoutPanel bottomRow;
        private Label workspaceLabel;
        private System.Windows.Forms.Control workspaceCapsule;
        private bool shortWindow;
        private int headerState = -1;

        private void LayoutColumn()
        {
            // While the window edge is dragged the column is hidden behind a
            // snapshot; it is laid out once, when the drag ends.
            if (resizePreview != null || navStrip == null) return;
            var client = ClientSize;
            if (client.Width < 2 || client.Height < 2) return; // minimised
            var width = Math.Min(client.Width, MaxColumnWidth);
            var bounds = new Rectangle((client.Width - width) / 2, 0, width, client.Height);
            shortWindow = client.Height < ShortBelow;
            column.SuspendLayout();
            if (column.Bounds != bounds) column.Bounds = bounds;
            LayoutHeader(shortWindow, width);
            LayoutSwitchRow(shortWindow, width);
            // The bottom row is as tall as its line of text at the width it
            // has: one line in a wide window, more in a narrow one or with
            // long folder names.
            var bottomPadding = shortWindow ? new Padding(22, 1, 22, 1) : new Padding(22, 8, 22, 8);
            var footerRoom = width - bottomPadding.Horizontal - autostartBox.Width - autostartBox.Margin.Horizontal - footer.Margin.Horizontal;
            var footerHeight = footer.Text.Length == 0 || footerRoom <= 0 ? 0 : footer.GetPreferredSize(new Size(footerRoom, 0)).Height;
            // Two lines in a short window: a little air under the second one.
            if (shortWindow && footerHeight > footer.Font.Height + 6) bottomPadding.Bottom = 5;
            var bottomHeight = Math.Max(shortWindow ? 36 : 42, footerHeight + footer.Margin.Vertical + bottomPadding.Vertical);
            if (bottomRow.Height != bottomHeight || bottomRow.Padding != bottomPadding)
            {
                bottomRow.Padding = bottomPadding;
                bottomRow.Height = bottomHeight;
            }
            column.ResumeLayout(true);
        }

        private void LayoutHeader(bool compact, int width)
        {
            // What the name and the status lines have beside the mark, and
            // what is left of it beside the buttons.
            var beside = width - 44 - (compact ? 58 : 76);
            var room = beside - headerButtons.PreferredSize.Width - 12;
            var lowest = lowestLabel.Text.Length == 0 ? 0 : lowestLabel.PreferredSize.Width;
            // Status lines too long to stand beside the buttons go under them,
            // where they have the whole width: the buttons then stand on the
            // line of the name.
            var under = Math.Max(detailLabel.PreferredSize.Width, lowest) > room;
            // In a short window the two status lines share one line when they fit.
            var inline = compact && (lowest == 0 || detailLabel.PreferredSize.Width + 18 + lowest <= (under ? beside : room));
            var state = (!compact ? 0 : inline ? 2 : 1) + (under ? 3 : 0);
            if (state != headerState)
            {
                headerState = state;
                headerPanel.SuspendLayout();
                headerPanel.Padding = compact ? new Padding(22, 8, 22, 4) : new Padding(22, 18, 22, 8);
                headerMark.Size = compact ? new Size(44, 44) : new Size(60, 60);
                headerMark.Margin = compact ? new Padding(0, 2, 14, 0) : new Padding(0, 0, 16, 0);
                nameLabel.Font = compact ? nameFontShort : nameFont;
                stateLabel.Margin = compact ? new Padding(12, 6, 0, 0) : new Padding(14, 12, 0, 0);
                detailRow.FlowDirection = inline ? FlowDirection.LeftToRight : FlowDirection.TopDown;
                detailLabel.Margin = new Padding(0, 2, inline ? 18 : 0, 0);
                headerButtons.Margin = new Padding(0, under ? 0 : compact ? 4 : 8, 0, 0);
                headerPanel.SetRowSpan(headerButtons, under ? 1 : 2);
                headerPanel.SetColumnSpan(detailRow, under ? 2 : 1);
                headerPanel.ResumeLayout(true);
            }
            // Under the buttons the header is as tall as the line of the name
            // and the buttons, and the status lines it has, need.
            var height = !compact ? 104 : inline ? 62 : 84;
            if (under) height = headerPanel.Padding.Vertical + Math.Max(nameRow.PreferredSize.Height, headerButtons.PreferredSize.Height) + detailRow.PreferredSize.Height;
            if (headerPanel.Height != height) headerPanel.Height = height;
        }

        // The workspace switch and the section strip, each in the middle of
        // the column: on two rows, or side by side in a short window that is
        // wide enough for both. Side by side there is no room for the line
        // that describes the workspace, so it is not shown.
        private void LayoutSwitchRow(bool compact, int width)
        {
            var label = workspaceLabel.PreferredSize;
            var capsule = workspaceCapsule.PreferredSize;
            var strip = navStrip.CapsuleWidth;
            var both = label.Width + 12 + capsule.Width + 18 + strip;
            var sideBySide = compact && both <= width - 44;
            switchRow.SuspendLayout();
            if (sideBySide)
            {
                var x = (width - both) / 2;
                workspaceLabel.SetBounds(x, (50 - label.Height) / 2, label.Width, label.Height);
                x += label.Width + 12;
                workspaceCapsule.SetBounds(x, (50 - capsule.Height) / 2, capsule.Width, capsule.Height);
                x += capsule.Width + 18;
                navStrip.SetBounds(x, 0, strip, 50);
                // Set outright: while the column is hidden for the resize preview,
                // reading Visible says false for everything in it.
                workspaceHint.Visible = false;
                if (switchRow.Height != 50) switchRow.Height = 50;
            }
            else
            {
                // The switch itself is centred, so it does not move when the
                // line beside it changes with the workspace.
                var top = compact ? 4 : 6;
                var stripHeight = compact ? 50 : 58;
                var x = (width - capsule.Width) / 2;
                workspaceCapsule.SetBounds(x, top, capsule.Width, capsule.Height);
                workspaceLabel.SetBounds(x - 12 - label.Width, top + (capsule.Height - label.Height) / 2, label.Width, label.Height);
                var hintLeft = x + capsule.Width + 14;
                workspaceHint.SetBounds(hintLeft, top, Math.Max(0, width - 22 - hintLeft), capsule.Height);
                workspaceHint.Visible = true;
                var stripTop = top + capsule.Height + (compact ? 0 : 2);
                navStrip.SetBounds(0, stripTop, width, stripHeight);
                if (switchRow.Height != stripTop + stripHeight) switchRow.Height = stripTop + stripHeight;
            }
            switchRow.ResumeLayout(false);
            navStrip.Invalidate();
        }

        protected override void SetVisibleCore(bool value)
        {
            // Started with --hidden: stay in the tray until opened.
            if (startHidden && !IsHandleCreated)
            {
                CreateHandle();
                value = false;
                OnShownOnce();
            }
            base.SetVisibleCore(value);
        }

        private void OnShownOnce()
        {
            if (shownOnce) return;
            shownOnce = true;
            // Opened straight in the Video workspace: its settings are read
            // now that the window exists to show them.
            if (videoPending)
            {
                videoPending = false;
                LoadVideoSettings();
                EnterVideoPage();
            }
            if (previewLimits != null)
            {
                Text = "DeepSeekProxy (preview)";
                tray.Visible = false;
                ShowState("Preview", Theme.Accent);
                detailLabel.Text = "Sample limits. Nothing is running.";
                limitsAt = DateTime.Now;
                ShowLimits(Json.Arr(Json.Get(Json.Obj(Json.Serializer.DeserializeObject(previewLimits)), "accounts")));
                return;
            }
            if (ReadOnly)
            {
                tray.Visible = false;
                BeginInvoke(new Action(StartStatusChecks));
                return;
            }
            BeginInvoke(new Action(() =>
            {
                // Restore the gateway under the desktop's ownership before the worker verifies it.
                if (Environment.GetEnvironmentVariable("DSHPROXY_UPDATE_SESSION") == null || Environment.GetEnvironmentVariable("DSHPROXY_UPDATE_RESUME") == "1") StartGateway();
                SelfUpdateCommand(new[] { "self-update", "result" }, result =>
                {
                    var state = Json.Str(Json.Get(result, "status"));
                    StartStatusChecks();
                    limitsTimer.Start();
                    if (state != "none")
                        Msg.Show(this, "DSHProxy update: " + state + "\n\n" + Json.Str(Json.Get(result, "message")), "DSHProxy update", MessageBoxButtons.OK, state == "success" ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
                });
            }));
        }

        // ---------- layout ----------

        private static FlowLayoutPanel Row(params System.Windows.Forms.Control[] controls)
        {
            var row = new FlowLayoutPanel { Dock = DockStyle.Bottom, AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = true, Padding = new Padding(0, 10, 0, 0) };
            foreach (var item in controls) row.Controls.Add(item);
            return row;
        }

        // A note above a page. As tall as its text at the width it has: one
        // line in a wide window, two in a narrow one.
        private static Label Note(string text)
        {
            var note = new GlassLabel { Text = Tied(text), Dock = DockStyle.Top, AutoSize = false, Height = 40, ForeColor = Theme.Muted, Padding = new Padding(0, 2, 0, 0) };
            EventHandler fit = (s, e) =>
            {
                if (note.Width <= 0) return;
                var height = note.GetPreferredSize(new Size(note.Width, 0)).Height + 4;
                if (note.Height != height) note.Height = height;
            };
            note.Resize += fit;
            note.FontChanged += fit;
            return note;
        }

        // Lists sit in a bordered panel so they read as one surface.
        private static System.Windows.Forms.Control Framed(System.Windows.Forms.Control body)
        {
            if (!(body is ListView) && !(body is TextBox)) return body;
            var frame = Glass.Make(new Panel { Dock = DockStyle.Fill, Padding = new Padding(10, 6, 10, 10) }, 20);
            body.Dock = DockStyle.Fill;
            frame.Controls.Add(body);
            return frame;
        }

        private static Panel Page(string title, System.Windows.Forms.Control body, System.Windows.Forms.Control top, System.Windows.Forms.Control bottom)
        {
            var page = new Panel { Text = title, Padding = new Padding(22, 8, 22, 14) };
            page.Controls.Add(Framed(body));
            if (bottom != null) page.Controls.Add(bottom);
            if (top != null) page.Controls.Add(top);
            return page;
        }

        // The header: app icon and name, a status pill, and what is running.
        private System.Windows.Forms.Control BuildHeader()
        {
            var header = new TableLayoutPanel { Dock = DockStyle.Top, Height = 104, ColumnCount = 3, Padding = new Padding(22, 18, 22, 8) };
            headerPanel = header;
            header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

            var mark = new AppMark { Size = new Size(60, 60), Margin = new Padding(0, 0, 16, 0) };
            headerMark = mark;
            var big = AppIcon.Load(new Size(64, 64));
            if (big != null) mark.Picture = big.ToBitmapExact(64, Color.Black);
            header.Controls.Add(mark, 0, 0);

            // Two rows beside the mark: the name, and the status lines under
            // it. The buttons stand beside both, or beside the name alone
            // when the status lines need the whole width (see LayoutHeader).
            header.RowCount = 2;
            header.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            header.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            header.SetRowSpan(mark, 2);
            nameRow = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, WrapContents = false, Anchor = AnchorStyles.Left, Margin = new Padding(0) };
            nameLabel = new GlassLabel { Text = "DeepSeekProxy", AutoSize = true, Font = nameFont, ForeColor = Theme.Text, Margin = new Padding(0, 0, 0, 0) };
            nameRow.Controls.Add(nameLabel);
            nameRow.Controls.Add(stateLabel);
            header.Controls.Add(nameRow, 1, 0);
            // The two status lines: one under the other, or side by side in a
            // short window (see LayoutHeader).
            detailRow = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = false, Anchor = AnchorStyles.Left | AnchorStyles.Top, Margin = new Padding(0) };
            detailRow.Controls.Add(detailLabel);
            detailRow.Controls.Add(lowestLabel);
            header.Controls.Add(detailRow, 1, 1);

            var buttons = new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Anchor = AnchorStyles.Right | AnchorStyles.Top, Margin = new Padding(0, 8, 0, 0) };
            headerButtons = buttons;
            buttons.Controls.Add(applyButton);
            buttons.Controls.Add(startButton);
            buttons.Controls.Add(stopButton);
            header.Controls.Add(buttons, 2, 0);
            header.SetRowSpan(buttons, 2);
            return header;
        }

        // The status pill next to the app name.
        private void ShowState(string text, Color color)
        {
            SetText(stateLabel, text);
            if (stateLabel.Tint != color) stateLabel.Tint = color;
        }

        // The bottom line. When it wraps, a name stays with what it names,
        // and the build is not left with one word on a line of its own. A
        // folder name with spaces in it can still be broken at them, so a
        // long one does not run out of the window.
        private static string FooterText(string home, string root, string stamp)
        {
            return "Data:\u00A0" + home + "    Program:\u00A0" + root + "    " + ("Build: " + stamp).Replace(' ', '\u00A0');
        }

        // A note that wraps does not end in a line with a single word on it:
        // its last two words stay together.
        private static string Tied(string text)
        {
            var at = text.LastIndexOf(' ');
            return at <= 0 ? text : text.Substring(0, at) + "\u00A0" + text.Substring(at + 1);
        }

        // Assigning the same string still invalidates the control, so a status
        // refresh every three seconds repainted the whole window for nothing.
        private static void SetText(Control control, string text)
        {
            if (control.Text != text) control.Text = text;
        }

        private void BuildLayout()
        {
            var header = BuildHeader();

            // Shown when a newer CLIProxyAPI is available or a rollback is possible.
            updateBar.Controls.Add(updateLabel);
            updateBar.Controls.Add(updateButton);
            updateBar.Controls.Add(rollbackButton);
            updateButton.Click += (s, e) => ApplyUpdate();
            rollbackButton.Click += (s, e) => Rollback();
            updateBar.Resize += (s, e) => FitUpdateBar();

            // Accounts and limits
            var addAccount = Skin.Primary(new PillButton { Text = "+ Add account", AutoSize = true });
            addAccount.Click += (s, e) => AddAccount();
            var refreshLimits = new PillButton { Text = "Refresh limits", AutoSize = true };
            refreshLimits.Click += (s, e) => LoadLimits(true);
            var authFolder = new PillButton { Text = "Open credentials folder", AutoSize = true };
            authFolder.Click += (s, e) => OpenFolder("auth");
            tabs.TabPages.Add(Page("Accounts", accountsPanel,
                Note("Subscription accounts and how much of each limit is left. Bars turn amber below 30% and red below 10%."),
                Row(addAccount, refreshLimits, authFolder, limitsNote)));

            // API keys
            keysList.View = View.Details;
            foreach (var c in new[] { "Provider", "Region", "State" }) keysList.Columns.Add(c, 220);
            keysList.FullRowSelect = true;
            keysList.Dock = DockStyle.Fill;
            // Logos for the API-key rows, at a height that also spaces the rows out.
            var keyLogos = new ImageList { ImageSize = new Size(22, 22), ColorDepth = ColorDepth.Depth32Bit };
            foreach (var name in new[] { "deepseek", "moonshot", "zai", "qwen", "minimax", "mistral", "openrouter" })
            {
                var image = Logos.Sized(name, 22);
                if (image != null) keyLogos.Images.Add(name, image);
            }
            keysList.SmallImageList = keyLogos;
            var addKey = Skin.Primary(new PillButton { Text = "Add or replace key", AutoSize = true });
            addKey.Click += (s, e) => AddKey();
            var removeKey = Skin.Danger(new PillButton { Text = "Remove selected", AutoSize = true });
            removeKey.Click += (s, e) => RemoveKey();
            keyProviderCombo.SelectedIndexChanged += (s, e) => FillRegions();
            tabs.TabPages.Add(Page("API keys", keysList,
                Note("Pay-per-use API keys. Keys are stored encrypted for your Windows account. Restart the gateway after a change."),
                Row(keyProviderCombo, keyRegionCombo, addKey, removeKey)));

            // Lanes, with the routing presets above them
            lanesList.View = View.Details;
            lanesList.Columns.Add("Lane", 110);
            lanesList.Columns.Add("Ladder (first to last)", 780);
            lanesList.FullRowSelect = true;
            lanesList.Dock = DockStyle.Fill;
            lanesList.Font = Theme.Ui(9.5f);
            lanesList.SmallImageList = new ImageList { ImageSize = new Size(1, 34) };
            var editLanes = new PillButton { Text = "Edit lanes (settings.json)", AutoSize = true };
            editLanes.Click += (s, e) => EditSettings();
            var presetRow = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = true, Dock = DockStyle.Top, Margin = new Padding(0), Padding = new Padding(0, 2, 0, 2) };
            presetRow.Controls.Add(new GlassLabel { Text = "Routing:", AutoSize = true, ForeColor = Theme.Muted, Margin = new Padding(0, 11, 10, 0) });
            presetTips = new ToolTip { AutoPopDelay = 12000, InitialDelay = 400 };
            foreach (var preset in new[] { new[] { "performance", "Max performance" }, new[] { "balanced", "Balanced" }, new[] { "cheap", "Cheap production" } })
            {
                var button = new PillButton { Text = preset[1], AutoSize = true, Margin = new Padding(0, 2, 8, 2) };
                var key = preset[0];
                button.Click += (s, e) => UsePreset(key, button.Text);
                presetButtons[key] = button;
                presetRow.Controls.Add(button);
            }
            var lanesTop = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 1, RowCount = 3, Margin = new Padding(0) };
            lanesTop.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            // In a table the row follows a label that sizes itself, which a
            // Note (it sets its own height) does not get; the spacing is the same.
            lanesTop.Controls.Add(new GlassLabel { Text = Tied("A lane tries each model in order until one answers. Green: can serve. Amber: sitting out after running out of quota. Red: no account or key."), AutoSize = true, Dock = DockStyle.Fill, ForeColor = Theme.Muted, Margin = new Padding(0, 2, 0, 4) }, 0, 0);
            lanesTop.Controls.Add(presetRow, 0, 1);
            lanesTop.Controls.Add(presetNote, 0, 2);
            tabs.TabPages.Add(Page("Lanes", lanesList, lanesTop, Row(editLanes)));


            // Models
            modelsList.View = View.Details;
            modelsList.CheckBoxes = true;
            foreach (var c in new[] { new object[] { "Model", 210 }, new object[] { "Service", 140 }, new object[] { "Context", 80 }, new object[] { "Output", 75 }, new object[] { "Reasoning", 165 }, new object[] { "Status", 200 } }) modelsList.Columns.Add((string)c[0], (int)c[1]);
            modelsList.FullRowSelect = true;
            modelsList.Dock = DockStyle.Fill;
            // Where the six columns cannot all show their text, Service is the
            // one left out: the logo before the name says it, and so does the
            // tip of the row.
            ((DarkList)modelsList).OptionalColumn = 1;
            modelsList.ShowItemToolTips = true;
            var modelLogos = new ImageList { ImageSize = new Size(18, 18), ColorDepth = ColorDepth.Depth32Bit };
            foreach (var name in new[] { "claude", "codex", "antigravity", "kimi" })
            {
                var image = Logos.Sized(name, 18);
                if (image != null) modelLogos.Images.Add(name, image);
            }
            modelsList.SmallImageList = modelLogos;
            modelsList.ItemCheck += (s, e) => OnModelChecked(e);
            var checkModels = Skin.Primary(new PillButton { Text = "Check for new models", AutoSize = true });
            checkModels.Click += (s, e) => RefreshModels();
            var showAll = new GlassCheck { Text = "Show hidden models", AutoSize = true, Margin = new Padding(12, 7, 0, 0) };
            showAll.CheckedChanged += (s, e) => { showHiddenModels = showAll.Checked; FillModels(); };
            var modelsPage = Page("Models", modelsList,
                Note("Ticked models are offered to DeepSeek Harness. New models are found automatically every 3 hours; when the list changes, the DSHProxy routes in DeepSeek Harness are updated (restart DeepSeek Harness to see them)."),
                Row(checkModels, showAll, modelsNote));
            modelsPage.Controls.Add(suggestionsPanel);
            suggestionsPanel.BringToFront();
            // The list sits in a frame; the frame is what fills the page.
            modelsList.Parent.BringToFront();
            tabs.TabPages.Add(modelsPage);

            // DeepSeek Harness
            profilesList.View = View.Details;
            foreach (var c in new[] { new object[] { "Profile", 220 }, new object[] { "Routes", 90 }, new object[] { "Models", 90 }, new object[] { "Points at this gateway", 400 } }) profilesList.Columns.Add((string)c[0], (int)c[1]);
            profilesList.FullRowSelect = true;
            profilesList.Dock = DockStyle.Fill;
            var preview = new PillButton { Text = "Preview changes", AutoSize = true };
            preview.Click += (s, e) => RunAndShow(new[] { "dsh", "apply", "--dry-run" }, "Preview", false);
            var verify = Skin.Outline(new PillButton { Text = "Verify", AutoSize = true });
            verify.Click += (s, e) => VerifyHarness();
            var remove = Skin.Danger(new PillButton { Text = "Remove from DeepSeek Harness", AutoSize = true });
            remove.Click += (s, e) => RemoveFromHarness();
            tabs.TabPages.Add(Page("DeepSeek Harness", profilesList,
                Note("Apply to DeepSeek Harness, at the top of the window, writes the DSHProxy routes into every DeepSeek Harness profile and keeps everything else. Preview shows what it would change. Verify checks the profiles back: routes, models, default model and credential. Restart DeepSeek Harness after a change."),
                Row(preview, verify, remove)));

            // Log
            var logPage = new Panel { Text = "Log", Padding = new Padding(22, 8, 22, 14) };
            logPage.Controls.Add(Framed(logBox));
            logBox.BorderStyle = BorderStyle.None;
            var openLogFolder = new PillButton { Text = "Open data folder", AutoSize = true };
            openLogFolder.Click += (s, e) => OpenFolder("");
            logPage.Controls.Add(Row(openLogFolder));
            tabs.TabPages.Add(logPage);

            // The Video workspace: one page for each section above except the
            // log, which both workspaces share.
            BuildVideoPages();

            tabs.SelectedIndexChanged += (s, e) =>
            {
                // A control on a hidden page must not keep the focus: WinForms
                // then scrolls its AutoScroll panel on the way back, which looks
                // like the page jumping.
                if (navStrip != null) navStrip.Focus();
                ShowWorkspace();
                EnterVideoPage();
                // In the Video workspace the first section is the video
                // accounts page, which reads its own state (EnterVideoPage).
                if (tabs.SelectedIndex == 0 && !videoMode)
                {
                    accountsPanel.AutoScrollPosition = Point.Empty;
                    LoadLimits(false);
                }
            };

            var bottom = new TableLayoutPanel { Dock = DockStyle.Bottom, Height = 42, ColumnCount = 3, Padding = new Padding(22, 8, 22, 8) };
            bottomRow = bottom;
            bottom.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            bottom.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            footer.Margin = new Padding(0, 5, 0, 0);
            bottom.Controls.Add(footer, 0, 0);
            bottom.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            var checkApp = new Button { Text = "Check for app updates…", AutoSize = true, Margin = Padding.Empty, Enabled = !ReadOnly && previewLimits == null };
            checkApp.Click += (s, e) => CheckSelfUpdate();
            bottom.Controls.Add(checkApp, 1, 0);
            bottom.Controls.Add(autostartBox, 2, 0);
            footer.TextChanged += (s, e) => LayoutColumn();
            
            var nav = new NavStrip(tabs);
            navStrip = nav;
            // The chat pages and the video pages share one area; ShowWorkspace
            // decides which of the two is on screen.
            content.Controls.Add(tabs);
            content.Controls.Add(videoHost);
            // The column is the window's only child, so the resize preview,
            // which hides and shows the window's direct children, leaves what
            // is hidden inside it (the update bar, the other workspace) alone.
            // The rows are added in the order the Tab key visits them.
            column.Controls.Add(content);
            column.Controls.Add(BuildSwitchRow(nav));
            column.Controls.Add(updateBar);
            column.Controls.Add(bottom);
            column.Controls.Add(header);
            Controls.Add(column);
            ShowAccountsMessage("Starting...", Theme.Muted);
        }

        private void BuildTray()
        {
            tray.Icon = AppIcon.Load(SystemInformation.SmallIconSize) ?? SystemIcons.Application;
            tray.Text = "DeepSeekProxy";
            tray.Visible = true;
            var menu = new ContextMenuStrip();
            Skin.Menu(menu);
            menu.Items.Add("Open DeepSeekProxy", null, (s, e) => ShowWindow());
            menu.Items.Add("Add account...", null, (s, e) => { ShowWindow(); AddAccount(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Start gateway", null, (s, e) => StartGateway());
            menu.Items.Add("Stop gateway", null, (s, e) => StopRequested());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Check for DSHProxy updates…", null, (s, e) => CheckSelfUpdate());
            menu.Items.Add("Quit", null, (s, e) => Quit());
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += (s, e) => ShowWindow();
            tray.BalloonTipClicked += (s, e) => { ShowWindow(); tabs.SelectedIndex = 0; };
        }

        private bool selfUpdateBusy;

        private void SelfUpdateCommand(string[] args, Action<Dictionary<string, object>> done)
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Dictionary<string, object> reply;
                try
                {
                    var result = cli.Run(args, null, args.Length > 1 && args[1] == "install" ? 1500000 : 120000);
                    reply = Json.Obj(Json.Serializer.DeserializeObject(result.Out));
                    if (reply == null || !reply.ContainsKey("status")) throw new InvalidOperationException("The updater returned an invalid response.");
                }
                catch (Exception error)
                {
                    reply = new Dictionary<string, object> { { "status", "unavailable" }, { "message", error.Message } };
                }
                if (IsDisposed || !IsHandleCreated || quitting) return;
                try { BeginInvoke(new Action(() => { if (!quitting) done(reply); })); }
                catch (InvalidOperationException) { }
            });
        }

        private void CheckSelfUpdate()
        {
            if (ReadOnly || previewLimits != null || selfUpdateBusy) return;
            selfUpdateBusy = true;
            ShowWindow();
            SelfUpdateCommand(new[] { "self-update", "check" }, reply =>
            {
                var status = Json.Str(Json.Get(reply, "status"));
                var message = Json.Str(Json.Get(reply, "message"));
                var sha = Json.Str(Json.Get(reply, "candidate"));
                var installed = Json.Str(Json.Get(reply, "installed"));
                var valid = System.Text.RegularExpressions.Regex.IsMatch(sha, "\\A[0-9a-fA-F]{40}\\z");
                if (status != "available" || !valid)
                {
                    selfUpdateBusy = false;
                    Msg.Show(this, (status == "current" ? "DSHProxy is up to date." : "DSHProxy update unavailable.") + "\n\n" + message + "\n\nInstalled: " + installed,
                        "DSHProxy update", MessageBoxButtons.OK, status == "current" ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
                    return;
                }
                using (var dialog = new Form { Text = "DSHProxy update", StartPosition = FormStartPosition.CenterParent, ClientSize = new Size(540, 280), FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false })
                {
                    var body = new Label { Left = 20, Top = 20, Width = 500, Height = 160, Text = "Installed: " + (installed.Length > 12 ? installed.Substring(0, 12) : installed) + "\nCandidate: " + sha.Substring(0, 12) + "\n" + Json.Str(Json.Get(reply, "subject")) + "\n\n" + message + "\n\nInstall this revision? DSHProxy will close and relaunch. Active requests must finish first." };
                    var link = new LinkLabel { Left = 20, Top = 185, Width = 500, Text = "View official commit" };
                    var url = Json.Str(Json.Get(reply, "url"));
                    Uri uri;
                    link.Enabled = Uri.TryCreate(url, UriKind.Absolute, out uri) && uri.Scheme == "https" && uri.Host == "github.com";
                    link.LinkClicked += (s, e) => { try { Process.Start(url); } catch (Exception error) { Msg.Show(dialog, error.Message, "Open commit", MessageBoxButtons.OK, MessageBoxIcon.Warning); } };
                    var install = new Button { Text = "Install", Left = 330, Top = 230, DialogResult = DialogResult.OK };
                    var cancel = new Button { Text = "Cancel", Left = 425, Top = 230, DialogResult = DialogResult.Cancel };
                    dialog.Controls.AddRange(new Control[] { body, link, install, cancel });
                    dialog.CancelButton = cancel;
                    dialog.AcceptButton = cancel;
                    if (dialog.ShowDialog(this) != DialogResult.OK) { selfUpdateBusy = false; return; }
                }
                SelfUpdateCommand(new[] { "self-update", "install", "--sha", sha, OwnGatewayAlive ? "--owns-gateway" : "--no-gateway" }, result =>
                {
                    selfUpdateBusy = false;
                    if (Json.Str(Json.Get(result, "status")) == "started")
                    {
                        // The detached helper owns draining, replacement and relaunch.
                        // Normal Quit stops the gateway and would interrupt requests.
                        quitting = true;
                        timer.Stop();
                        limitsTimer.Stop();
                        tray.Visible = false;
                        Application.Exit();
                        return;
                    }
                    Msg.Show(this, "DSHProxy update did not start.\n\n" + Json.Str(Json.Get(result, "message")), "DSHProxy update", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                });
            });
        }

        private void ShowWindow()
        {
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }

        // ---------- resize preview ----------

        private PictureBox resizePreview;
        private readonly System.Windows.Forms.Timer resizeWatchdog = new System.Windows.Forms.Timer { Interval = 220 };

        private void BeginResizePreview()
        {
            Dbg.Write("preview begin");
            if (resizePreview != null || IsDisposed || !IsHandleCreated) return;
            var size = ClientSize;
            if (size.Width < 2 || size.Height < 2) return;
            Bitmap shot;
            try
            {
                shot = new Bitmap(size.Width, size.Height);
                using (var g = Graphics.FromImage(shot)) g.CopyFromScreen(PointToScreen(Point.Empty), Point.Empty, size);
            }
            catch (Exception) { return; }
            Skin.SuppressBackdrop = true;
            resizePreview = new PictureBox { Image = shot, SizeMode = PictureBoxSizeMode.StretchImage, Dock = DockStyle.Fill };
            foreach (Control child in Controls) child.Visible = false;
            Controls.Add(resizePreview);
            resizePreview.BringToFront();
            // If ResizeEnd never arrives (a sizing loop that ends oddly, a
            // programmatic resize), the snapshot must still go away.
            if (!resizeWatchdog.Enabled)
            {
                resizeWatchdog.Tick += (s, e) => { resizeWatchdog.Stop(); EndResizePreview(); };
                resizeWatchdog.Start();
            }
            else resizeWatchdog.Stop();
            resizeWatchdog.Start();
        }

        private void EndResizePreview()
        {
            Dbg.Write("preview end");
            resizeWatchdog.Stop();
            if (resizePreview == null) return;
            Controls.Remove(resizePreview);
            var image = resizePreview.Image;
            resizePreview.Dispose();
            resizePreview = null;
            if (image != null) image.Dispose();
            LayoutColumn();
            foreach (Control child in Controls) child.Visible = true;
            Skin.SuppressBackdrop = false;
            Invalidate(true);
        }

        // Called when a second launch asks for the window.
        internal void ShowRequested()
        {
            ShowWindow();
            TopMost = true;
            TopMost = false;
            BringToFront();
        }

        private void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (quitting || previewLimits != null || ReadOnly || e.CloseReason == CloseReason.WindowsShutDown) return;
            // Closing the window keeps the gateway running in the tray.
            e.Cancel = true;
            Hide();
            if (!balloonShown)
            {
                balloonShown = true;
                tray.ShowBalloonTip(4000, "DeepSeekProxy is still running", "The gateway keeps serving DeepSeek Harness. Right-click the tray icon to quit.", ToolTipIcon.Info);
            }
        }

        private void Quit()
        {
            if (!ConfirmCut(true)) return;
            // A sign-in left waiting for the browser, and a restart left waiting
            // for an idle moment, end with the app. Stopping their helper can
            // take seconds, so it is not done here: the window goes at once, and
            // a thread the process waits for stops them before the process ends.
            var login = kreaLogin;
            var waiting = idleStop;
            if (login != null || waiting != null)
            {
                var ending = new Thread(() =>
                {
                    if (waiting != null) waiting.Cancel();
                    if (login != null) login.Cancel();
                });
                ending.IsBackground = false;
                ending.Start();
            }
            quitting = true;
            timer.Stop();
            limitsTimer.Stop();
            StopGateway();
            tray.Visible = false;
            Application.Exit();
        }

        // ---------- gateway process ----------

        private void AppendLog(string line)
        {
            if (line == null) return;
            if (InvokeRequired)
            {
                BeginInvoke(new Action<string>(AppendLog), line);
                return;
            }
            if (logBox.TextLength > 400000) logBox.Text = logBox.Text.Substring(200000);
            logBox.AppendText(line + Environment.NewLine);
        }

        private bool GatewayAnswers()
        {
            return GatewayAnswers(lastOrigin);
        }

        // Takes up to a second and a half. It touches nothing of the window,
        // so a thread other than the window's can ask it.
        private static bool GatewayAnswers(string origin)
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(origin + "/dshproxy/status");
                request.Timeout = 1500;
                using (var response = (HttpWebResponse)request.GetResponse()) return (int)response.StatusCode == 200;
            }
            catch (WebException) { return false; }
        }

        // True when a gateway process was started here.
        private bool StartGateway()
        {
            return StartGatewayKnowing(null);
        }

        // `answers`: whether a gateway answers at the address already, when
        // the caller has asked that on another thread; null to ask it here.
        private bool StartGatewayKnowing(bool? answers)
        {
            if (ReadOnly) return false;
            if (gateway != null && !gateway.HasExited) return false;
            // A start from here ends the watch for a gateway that stops late.
            lateStopWatch = null;
            // A count from before this start says nothing about what is in flight now.
            ForgetInFlight();
            if (answers ?? GatewayAnswers())
            {
                AppendLog("A gateway is already running on " + lastOrigin + "; showing its status.");
                return false;
            }
            try
            {
                var started = cli.StartHidden(new[] { "start" });
                gateway = started;
                gatewayStartedAt = DateTime.UtcNow;
                started.EnableRaisingEvents = true;
                started.OutputDataReceived += (s, e) => AppendLog(e.Data);
                started.ErrorDataReceived += (s, e) => AppendLog(e.Data);
                started.Exited += (s, e) =>
                {
                    AppendLog("Gateway stopped.");
                    GatewayExited(started);
                };
                started.BeginOutputReadLine();
                started.BeginErrorReadLine();
                AppendLog("Starting the gateway...");
                // A live process that has not answered yet: Starting, Stop on, Start off.
                ShowGateway(false);
                CheckQuickly();
                return true;
            }
            catch (System.ComponentModel.Win32Exception error)
            {
                AppendLog("Could not start the gateway: " + error.Message);
                return false;
            }
        }

        // The process of a gateway started here has ended: nothing is in flight in it.
        private void GatewayExited(Process ended)
        {
            if (InvokeRequired)
            {
                try { BeginInvoke(new Action<Process>(GatewayExited), ended); }
                catch (InvalidOperationException) { }
                return;
            }
            if (gateway != ended || quitting) return;
            ForgetInFlight();
            // It was starting or not answering: now there is no process. A
            // gateway that was answering is seen to be gone by the checks.
            if (shownAs != GatewayShown.Running) ShowGateway(false);
        }

        // The gateway this window started is still a live process.
        private bool OwnGatewayAlive
        {
            get
            {
                var mine = gateway;
                try { return mine != null && !mine.HasExited; }
                catch (InvalidOperationException) { return false; }
                catch (System.ComponentModel.Win32Exception) { return false; }
            }
        }

        // The header says Not answering: the gateway this window started is a
        // live process that does not answer. It may be busy, not gone. One
        // missed check is not that: the header still says Running then, and
        // Stop, Quit and a restart ask what they ask of a gateway that answers.
        private bool Unanswered
        {
            get { return shownAs == GatewayShown.NotAnswering && OwnGatewayAlive; }
        }

        private void StopGateway()
        {
            if (ReadOnly) return;
            // Stopped from here: a gateway that then ends is not started again.
            lateStopWatch = null;
            if (gateway == null || gateway.HasExited)
            {
                if (GatewayAnswers()) AppendLog("The running gateway was not started by this window. Stop it from the window it was started in.");
                return;
            }
            // Stops the gateway and the backend it started.
            try
            {
                using (var kill = Process.Start(new ProcessStartInfo("taskkill.exe", "/PID " + gateway.Id + " /T /F") { CreateNoWindow = true, UseShellExecute = false })) kill.WaitForExit(10000);
            }
            catch (System.ComponentModel.Win32Exception error)
            {
                AppendLog("Could not stop the gateway: " + error.Message);
            }
            gateway = null;
            ForgetInFlight();
            // Stopped while it was starting or not answering: the header says Stopped now.
            if (shownAs != GatewayShown.Running && !quitting) ShowGateway(false);
            CheckQuickly();
            try { File.Delete(Path.Combine(GatewayControl.Home(), "control.token")); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }

        // The count of requests in flight is no longer known: it is 0 until the
        // gateway reports one again.
        private void ForgetInFlight()
        {
            inFlight = 0;
            fastInFlight = 0;
            gatewayAnswered = false;
            // The next answer is read afresh, even if it is the same text.
            fastBody = null;
        }

        // ---------- status ----------
        //
        // Two readings. The fast check asks the gateway itself over HTTP (GET
        // <origin>/dshproxy/status): it starts no process, and says whether
        // the gateway answers and how many requests are in flight. The full
        // status is the command line's `status --json`. That one starts four
        // processes and uses half a second of CPU, so it runs only when there
        // is something to learn: at start, when the fast answer changes in
        // anything but the in-flight count, after an action of this window,
        // when the window comes back on screen, and now and then to notice
        // what was changed outside the app. Neither waits for the other, and
        // there is never more than one of each.

        private const int WatchedCheckMs = 3000;
        private const int UnwatchedCheckMs = 15000;
        // After a missed check, and for a moment after Start or Stop.
        private const int QuickCheckMs = 250;
        private const int WatchedFullSeconds = 60;
        private const int UnwatchedFullSeconds = 600;

        private bool fullRunning;
        private bool fullWanted;
        // A full status failed: it is tried again at the next check.
        private bool fullRetry;
        private DateTime fullAt = DateTime.MinValue;
        // A wanted full status that is not urgent waits until then.
        private DateTime fullNotBefore = DateTime.MinValue;
        // The address of the gateway has been read from the settings, by a full status.
        private bool originKnown;
        private bool fastRunning;
        private bool fastUp;
        private int fastMisses;
        private string fastBody;
        // The last fast answer without its in-flight count, and that count.
        private string fastPrint;
        private int fastInFlight;
        private DateTime quickUntil = DateTime.MinValue;
        private bool watched;
        // The gateway this window started has answered a fast check since its start.
        private bool gatewayAnswered;
        // When it was started, and how long the header says Starting while it has not answered.
        private DateTime gatewayStartedAt = DateTime.MinValue;
        private const int StartingSeconds = 30;

        // On screen: visible and not minimised.
        private bool Watched
        {
            get { return Visible && WindowState != FormWindowState.Minimized; }
        }

        private void StartStatusChecks()
        {
            watched = Watched;
            RefreshStatus();
            PaceStatusChecks();
            timer.Start();
        }

        // The window was shown, hidden, minimised or restored.
        private void WatchChanged()
        {
            var now = Watched;
            if (now == watched) return;
            watched = now;
            if (!timer.Enabled) return;
            PaceStatusChecks();
            if (!now) return;
            // Back on screen: it shows what is true now, not what was true when it went.
            RefreshStatus();
            FastCheck();
        }

        private void PaceStatusChecks()
        {
            var quick = (fastMisses > 0 && fastMisses < 3) || DateTime.UtcNow < quickUntil;
            var ms = quick ? QuickCheckMs : watched ? WatchedCheckMs : UnwatchedCheckMs;
            if (timer.Interval != ms) timer.Interval = ms;
        }

        // The gateway was just started or stopped from here: look sooner for a while.
        private void CheckQuickly()
        {
            quickUntil = DateTime.UtcNow.AddSeconds(10);
            if (timer.Enabled) PaceStatusChecks();
        }

        private void StatusTick()
        {
            Dbg.Write("tick start");
            var now = DateTime.UtcNow;
            var age = (now - fullAt).TotalSeconds;
            // A command line that keeps failing is not started every few seconds.
            var retry = fullRetry && (failedPolls < 3 || age >= 15);
            if ((fullWanted && now >= fullNotBefore) || retry || age >= (watched ? WatchedFullSeconds : UnwatchedFullSeconds)) FullStatus();
            FastCheck();
            PaceStatusChecks();
            Dbg.Write("tick end");
        }

        // Asks for a full status: now, or straight after the one that is running.
        private void RefreshStatus()
        {
            fullWanted = true;
            fullNotBefore = DateTime.MinValue;
            FullStatus();
        }

        // Asks for one too, but no sooner than ten seconds after the last one
        // started. For a disagreement between the two readings, which must not
        // start a process on every check if it does not go away. One that is
        // running now will settle it.
        private void RefreshStatusSoon()
        {
            if (fullRunning || fullWanted) return;
            var earliest = fullAt.AddSeconds(10);
            if (DateTime.UtcNow >= earliest)
            {
                RefreshStatus();
                return;
            }
            fullWanted = true;
            fullNotBefore = earliest;
        }

        private void FullStatus()
        {
            // One at a time; a request made meanwhile stays wanted.
            if (fullRunning) return;
            fullRunning = true;
            fullWanted = false;
            fullRetry = false;
            fullAt = DateTime.UtcNow;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Cli.Result result;
                try { result = cli.Run(new[] { "status", "--json" }, null, 20000); }
                catch (Exception error) { result = new Cli.Result { Code = -1, Out = "", Err = error.Message }; }
                try
                {
                    BeginInvoke(new Action(() =>
                    {
                        fullRunning = false;
                        ShowStatus(result);
                        if (fullWanted && !quitting && DateTime.UtcNow >= fullNotBefore) FullStatus();
                    }));
                }
                catch (InvalidOperationException) { fullRunning = false; }
            });
        }

        private void FastCheck()
        {
            // Not before the settings have said where the gateway is.
            if (fastRunning || !originKnown) return;
            fastRunning = true;
            var origin = lastOrigin;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                var body = GatewayStatus.Read(origin, 2000);
                try
                {
                    BeginInvoke(new Action(() =>
                    {
                        fastRunning = false;
                        if (!quitting) ShowFastCheck(origin, body);
                    }));
                }
                catch (InvalidOperationException) { fastRunning = false; }
            });
        }

        // `body` is what the gateway at `origin` answered, or null when it did not.
        private void ShowFastCheck(string origin, string body)
        {
            // The address changed while the question was out.
            if (origin != lastOrigin) return;
            int count = 0;
            string print = null;
            // An answer already seen needs no reading again.
            var same = body != null && body == fastBody;
            if (body != null && !same && !GatewayStatus.Parse(body, out count, out print)) body = null;
            if (body == null)
            {
                // One slow answer does not flip the display: three in a row do.
                if (fastMisses < 3) fastMisses++;
                if (fastMisses >= 3)
                {
                    fastUp = false;
                    fastBody = null;
                    fastPrint = null;
                    // A gateway started here that is still a live process may only
                    // be slow to answer: its last count stands, and Stop and Quit
                    // ask before they cut. The count goes when the process does.
                    if (!OwnGatewayAlive)
                    {
                        fastInFlight = 0;
                        inFlight = 0;
                    }
                    if (running || shownAs == GatewayShown.Running)
                    {
                        ShowGatewayDown();
                        RefreshStatusSoon();
                    }
                }
                // Still no first answer from a gateway started here: the header
                // says Starting for half a minute, not for as long as it is silent.
                if (shownAs == GatewayShown.Starting) ShowGateway(false);
                PaceStatusChecks();
                return;
            }
            var wasUp = fastUp;
            fastUp = true;
            fastMisses = 0;
            if (OwnGatewayAlive) gatewayAnswered = true;
            if (!same)
            {
                fastBody = body;
                fastInFlight = count;
                // The first answer is what later ones are compared with. The
                // full status that gave the address is as new as it is.
                if (fastPrint == null) fastPrint = print;
                else if (print != fastPrint)
                {
                    fastPrint = print;
                    RefreshStatus();
                }
            }
            inFlight = fastInFlight;
            if (restartDialog != null) restartDialog.SetCount(inFlight);
            // A gateway this window started answers, and the header said
            // Starting or Not answering: it says Running at once. The pages
            // follow: the limits are read, and a full status is asked for now.
            if (shownAs != GatewayShown.Running && OwnGatewayAlive)
            {
                ShowGateway(true);
                running = true;
                LoadLimits(false);
                RefreshStatus();
            }
            // It answers, and the window says it is stopped.
            if (!running)
            {
                if (!wasUp) RefreshStatus();
                else RefreshStatusSoon();
            }
            PaceStatusChecks();
        }

        // The gateway stopped answering. Said at once; the full status follows.
        private void ShowGatewayDown()
        {
            ShowGateway(false);
        }

        // What the header says about the gateway.
        private enum GatewayShown { Nothing, Running, Starting, NotAnswering, Stopped }
        private GatewayShown shownAs = GatewayShown.Nothing;
        // The second header line of a gateway that answers, from the last full status.
        private string runningDetail;

        // Four states. Running: the gateway answers. Starting and Not
        // answering: a gateway this window started is a live process that
        // has not answered yet, or has stopped answering; Stop stays on
        // (it asks before it cuts) and Start stays off. Stopped, with Start
        // on: no gateway process of this window is alive and nothing answers.
        private void ShowGateway(bool answers)
        {
            var before = shownAs;
            var alive = !answers && OwnGatewayAlive;
            // Half a minute without a first answer is not starting any more:
            // the process hangs, or another program has the address.
            var late = alive && !gatewayAnswered && (DateTime.UtcNow - gatewayStartedAt).TotalSeconds >= StartingSeconds;
            shownAs = answers ? GatewayShown.Running : !alive ? GatewayShown.Stopped : gatewayAnswered || late ? GatewayShown.NotAnswering : GatewayShown.Starting;
            if (!answers) running = false;
            switch (shownAs)
            {
                case GatewayShown.Running:
                    ShowState("\u25CF Running", Theme.Ok);
                    SetText(detailLabel, runningDetail ?? lastOrigin);
                    tray.Text = "DSHProxy: running";
                    break;
                case GatewayShown.Starting:
                    ShowState("\u25CF Starting", Theme.Warn);
                    SetText(detailLabel, "The gateway is starting.");
                    tray.Text = "DSHProxy: starting";
                    break;
                case GatewayShown.NotAnswering:
                    ShowState("\u25CF Not answering", Theme.Warn);
                    SetText(detailLabel, "The gateway process is running but does not answer. Stop asks before it cuts anything.");
                    tray.Text = "DSHProxy: not answering";
                    break;
                default:
                    ShowState("\u25CF Stopped", Theme.Bad);
                    SetText(detailLabel, "The gateway is not running. Press Start.");
                    tray.Text = "DSHProxy: stopped";
                    break;
            }
            var startOn = shownAs == GatewayShown.Stopped;
            if (startButton.Enabled != startOn) startButton.Enabled = startOn;
            if (stopButton.Enabled == startOn) stopButton.Enabled = !startOn;
            if (shownAs == before) return;
            // In a short window the two status lines share one line only
            // while they fit: a longer sentence is given its own.
            headerState = -1;
            LayoutColumn();
            // The accounts page says why it has nothing to show. Not on every
            // reading: replacing the cards each time was a flash. And not
            // while a gateway that was running is being started again: its
            // cards stay until the new ones are read.
            var says = shownAs == GatewayShown.Stopped && before != GatewayShown.Nothing ? "The gateway is not running. Press Start to see accounts and limits."
                : shownAs == GatewayShown.NotAnswering ? "The gateway is not answering. Accounts and limits are shown again when it does."
                : shownAs == GatewayShown.Starting && before == GatewayShown.Stopped ? "The gateway is starting. Accounts and limits are shown when it answers."
                : null;
            if (says == null) return;
            // The cards are built again from the next limits, also when those
            // are the same as the last ones.
            accountsKey = "";
            ShowAccountsMessage(says, Theme.Muted);
        }

        private void ShowStatus(Cli.Result result)
        {
            if (result.Code != 0)
            {
                // A single slow or failed read must not wipe the window: doing so
                // made the cards and lists flash every few seconds.
                failedPolls++;
                fullRetry = true;
                if (failedPolls < 3) return;
                ShowState("Status unavailable", Theme.Bad);
                SetText(detailLabel, result.Err.Trim());
                return;
            }
            failedPolls = 0;
            Dictionary<string, object> status;
            try { status = Json.Obj(Json.Serializer.DeserializeObject(result.Out)); }
            catch (ArgumentException) { return; }

            var origin = Json.Str(Json.Get(status, "origin"));
            // The command line gives the gateway two seconds, once. When the
            // gateway has just answered this window, one slow answer there
            // does not flip the display: the checks decide, three misses in a
            // row, and a full status is read again.
            if (!Json.Bool(status, "running") && fastUp && origin == lastOrigin)
            {
                RefreshStatusSoon();
                return;
            }
            var wasRunning = running;
            running = Json.Bool(status, "running");
            if (origin != lastOrigin)
            {
                // Another address: what the fast check knew was about the old one.
                fastUp = false;
                fastMisses = 0;
                fastBody = null;
                fastPrint = null;
                fastInFlight = 0;
                inFlight = 0;
            }
            lastOrigin = origin;
            originKnown = origin.Length > 0;
            // The fast check has the newer count once the gateway answers it. A
            // status that found no gateway says nothing about the count of one
            // started here that is still a live process.
            if (!fastUp && (running || !OwnGatewayAlive)) inFlight = InFlight.Count(status);
            var backend = Json.Obj(Json.Get(status, "backend"));
            var models = Json.Arr(Json.Get(status, "models"));
            var accountCount = Json.Arr(Json.Get(status, "accounts")).Count;

            if (running) runningDetail = string.Format("{0}  \u00B7  {1} {2}  \u00B7  {3} account{4}  \u00B7  {5} models offered", lastOrigin, Json.Str(Json.Get(backend, "name")), Json.Str(Json.Get(backend, "version")), accountCount, accountCount == 1 ? "" : "s", models.Count);
            ShowGateway(running);
            SetText(footer, FooterText(Json.Str(Json.Get(status, "home")), cli.Root, BuildInfo.Stamp));
            loginProviders = Json.Arr(Json.Get(status, "loginProviders"));

            if (running && !wasRunning) LoadLimits(false);
            // That the gateway went down is said on the accounts page by
            // ShowGateway, once, when the header changes.

            // API keys
            var keys = Json.Obj(Json.Get(status, "apiKeys"));
            var readable = new Dictionary<string, string>();
            foreach (var item in Json.Arr(Json.Get(keys, "readable"))) readable[Json.Str(Json.Get(Json.Obj(item), "provider"))] = Json.Str(Json.Get(Json.Obj(item), "region"));
            var unreadable = new HashSet<string>();
            foreach (var item in Json.Arr(Json.Get(keys, "unreadable"))) unreadable.Add(Json.Str(item));
            providers = Json.Arr(Json.Get(status, "providers"));
            // Rebuilt only when something actually changed: rebuilding every few
            // seconds wiped the hover highlight and read as a glitch.
            var keysPrint = Json.Serializer.Serialize(new object[] { Json.Get(status, "providers"), Json.Get(keys, "readable"), Json.Get(keys, "unreadable") });
            if (keysPrint != keysKey)
            {
                keysKey = keysPrint;
                keysList.BeginUpdate();
                keysList.Items.Clear();
                foreach (var item in providers)
                {
                    var provider = Json.Obj(item);
                    var key = Json.Str(Json.Get(provider, "key"));
                    string state;
                    Color color;
                    if (readable.ContainsKey(key)) { state = "Saved"; color = Theme.Ok; }
                    else if (unreadable.Contains(key)) { state = "Saved, cannot be read: add it again"; color = Theme.Bad; }
                    else { state = "Not set"; color = Theme.Muted; }
                    var region = readable.ContainsKey(key) ? RegionLabel(provider, readable[key]) : "";
                    keysList.Items.Add(new ListViewItem(new[] { Json.Str(Json.Get(provider, "label")), region, state }) { ForeColor = color, Tag = key, ImageKey = key });
                }
                keysList.EndUpdate();
            }
            if (keyProviderCombo.Items.Count == 0)
            {
                foreach (var item in providers) keyProviderCombo.Items.Add(new Choice(Json.Str(Json.Get(Json.Obj(item), "key")), Json.Str(Json.Get(Json.Obj(item), "label"))));
                if (keyProviderCombo.Items.Count > 0) keyProviderCombo.SelectedIndex = 0;
            }

            // Lanes
            var lanesPrint = Json.Serializer.Serialize(Json.Get(status, "lanes"));
            if (lanesPrint != lanesKey)
            {
                lanesKey = lanesPrint;
                lanesList.BeginUpdate();
                lanesList.Items.Clear();
                foreach (var item in Json.Arr(Json.Get(status, "lanes")))
                {
                    var lane = Json.Obj(item);
                    var parts = new List<string>();
                    foreach (var rungItem in Json.Arr(Json.Get(lane, "ladder")))
                    {
                        var rung = Json.Obj(rungItem);
                        var available = Json.Bool(rung, "available");
                        var cooling = Json.Str(Json.Get(rung, "coolingUntil"));
                        var mark = !available ? "\u2717" : cooling.Length > 0 ? "\u23F8" : "\u2713";
                        parts.Add(mark + " " + Json.Str(Json.Get(rung, "model")));
                    }
                    lanesList.Items.Add(new ListViewItem(new[] { "lane-" + Json.Str(Json.Get(lane, "name")), string.Join("\u0001", parts.ToArray()) }));
                }
                lanesList.EndUpdate();
            }
            ShowRouting(Json.Obj(Json.Get(status, "routing")));

            // Models and backend updates
            modelRows = Json.Arr(Json.Get(status, "modelList"));
            var discovery = Json.Obj(Json.Get(status, "discovery"));
            var fetchedAt = Format.ParseTime(Json.Str(Json.Get(discovery, "fetchedAt")));
            var catalogError = Json.Str(Json.Get(discovery, "catalogError"));
            SetText(modelsNote, catalogError.Length > 0 ? "Model catalog not reachable: " + catalogError
                : fetchedAt.HasValue ? "Last checked " + Format.Ago(fetchedAt.Value) + "." : "Not checked yet.");
            FillModels();
            FillSuggestions(Json.Arr(Json.Get(status, "suggestions")));
            ShowUpdate(Json.Obj(Json.Get(status, "update")), Json.Obj(Json.Get(status, "backendLock")));

            // DeepSeek Harness
            var harness = Json.Obj(Json.Get(status, "deepseekHarness"));
            var profilesPrint = Json.Serializer.Serialize(Json.Get(harness, "profiles"));
            if (profilesPrint != profilesKey)
            {
            profilesKey = profilesPrint;
            profilesList.BeginUpdate();
            profilesList.Items.Clear();
            foreach (var item in Json.Arr(Json.Get(harness, "profiles")))
            {
                var p = Json.Obj(item);
                var routes = Json.Arr(Json.Get(p, "routes"));
                var count = 0;
                foreach (var route in routes) count += (int)Json.Num(Json.Obj(route), "models", 0);
                var error = Json.Str(Json.Get(p, "error"));
                var current = Json.Bool(p, "current");
                var pointing = error.Length > 0 ? error : routes.Count == 0 ? "Not applied" : current ? "Yes" : "No: apply again";
                profilesList.Items.Add(new ListViewItem(new[] { Json.Str(Json.Get(p, "profile")), routes.Count.ToString(), count.ToString(), pointing }) { ForeColor = routes.Count > 0 && current ? Theme.Ok : Theme.Muted });
            }
            profilesList.EndUpdate();
            }
        }

        private static string RegionLabel(Dictionary<string, object> provider, string regionKey)
        {
            foreach (var item in Json.Arr(Json.Get(provider, "regions")))
            {
                if (Json.Str(Json.Get(Json.Obj(item), "key")) == regionKey) return Json.Str(Json.Get(Json.Obj(item), "label"));
            }
            return regionKey;
        }

        private void FillRegions()
        {
            keyRegionCombo.Items.Clear();
            var choice = keyProviderCombo.SelectedItem as Choice;
            if (choice == null) return;
            foreach (var item in providers)
            {
                var provider = Json.Obj(item);
                if (Json.Str(Json.Get(provider, "key")) != choice.Key) continue;
                foreach (var region in Json.Arr(Json.Get(provider, "regions"))) keyRegionCombo.Items.Add(new Choice(Json.Str(Json.Get(Json.Obj(region), "key")), Json.Str(Json.Get(Json.Obj(region), "label"))));
            }
            if (keyRegionCombo.Items.Count > 0) keyRegionCombo.SelectedIndex = 0;
        }

        // ---------- accounts and limits ----------

        private void ShowAccountsMessage(string text, Color color)
        {
            Children.Release(accountsPanel);
            var message = new GlassLabel { Text = text, Dock = DockStyle.Top, Height = 60, ForeColor = color, TextAlign = ContentAlignment.MiddleCenter, Font = Theme.Ui(10f) };
            message.Disposed += (s, e) => message.Font.Dispose();
            accountsPanel.Controls.Add(message);
        }

        private void LoadLimits(bool force)
        {
            if (!running || loadingLimits) return;
            if (!force && !Visible && limitsAt.HasValue && (DateTime.Now - limitsAt.Value).TotalMinutes < 10) return;
            loadingLimits = true;
            limitsNote.Text = "Reading limits...";
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Dictionary<string, object> result = null;
                string failure = null;
                try { result = control.Call("GET", "limits" + (force ? "?refresh=1" : ""), null, 60000); }
                catch (ControlException error) { failure = error.Message; }
                catch (WebException error) { failure = error.Message; }
                try
                {
                    BeginInvoke(new Action(() =>
                    {
                        loadingLimits = false;
                        if (failure != null)
                        {
                            limitsNote.Text = "Could not read limits: " + failure;
                            return;
                        }
                        limitsAt = DateTime.Now;
                        ShowLimits(Json.Arr(Json.Get(result, "accounts")));
                    }));
                }
                catch (InvalidOperationException) { loadingLimits = false; }
            });
        }

        private void ShowLimits(ArrayList accounts)
        {
            SetText(limitsNote, "Limits updated " + Format.Ago(limitsAt.Value) + ". They refresh every minute.");
            // Rebuilt only when the data changed: rebuilding on a timer threw the
            // cards away and repainted the panel flat for a frame.
            var print = Json.Serializer.Serialize(accounts);
            if (print == accountsKey && accountsPanel.Controls.Count > 0) return;
            accountsKey = print;
            accountsPanel.SuspendLayout();
            Children.Release(accountsPanel);
            if (accounts.Count == 0)
            {
                ShowAccountsMessage("No accounts yet. Press \"+ Add account\" to sign in to Claude, ChatGPT, Gemini or Kimi.", Theme.Muted);
                SetLowest("", Theme.Muted);
                accountsPanel.ResumeLayout();
                return;
            }
            string lowestText = null;
            double lowest = 101;
            var cards = new List<TableLayoutPanel>();
            var widestThird = 0;
            // Docked to the top, so they are added last-first.
            for (var index = accounts.Count - 1; index >= 0; index -= 1)
            {
                var account = Json.Obj(accounts[index]);
                accountsPanel.Controls.Add(new Panel { Dock = DockStyle.Top, Height = 14 });
                int third;
                var built = BuildCard(account, out third);
                cards.Add(built);
                widestThird = Math.Max(widestThird, third);
                accountsPanel.Controls.Add(built);
                foreach (var item in Json.Arr(Json.Get(account, "windows")))
                {
                    var w = Json.Obj(item);
                    var left = Json.Num(w, "leftPercent", 100);
                    if (left < lowest)
                    {
                        lowest = left;
                        lowestText = string.Format("Lowest limit: {0} {1}, {2:0}% left", Json.Str(Json.Get(account, "label")), Json.Str(Json.Get(w, "title")), left);
                    }
                }
            }
            // The third column is the same width in every card, so the bars
            // end at one line down the page whatever buttons a card has.
            foreach (var built in cards) built.ColumnStyles[2] = new ColumnStyle(SizeType.Absolute, widestThird);
            SetLowest(lowestText ?? "", lowestText == null ? Theme.Muted : Theme.ForLeft(lowest));
            // The cards are docked, so they are as wide as the page: the
            // column keeps them from stretching across a wide monitor.
            accountsPanel.ResumeLayout();
        }

        // The second status line of the header. In a short window it shares a
        // line with the first one only while both fit, so the header is laid
        // out again when the text changes, not only when the window is resized.
        private void SetLowest(string text, Color color)
        {
            if (lowestLabel.ForeColor != color) lowestLabel.ForeColor = color;
            if (lowestLabel.Text == text) return;
            lowestLabel.Text = text;
            headerState = -1;
            LayoutColumn();
        }

        // thirdNeed: the width the card's third column needs, for its buttons and its widest line.
        private TableLayoutPanel BuildCard(Dictionary<string, object> account, out int thirdNeed)
        {
            var file = Json.Str(Json.Get(account, "file"));
            var label = Json.Str(Json.Get(account, "label"));
            var email = Json.Str(Json.Get(account, "account"));
            var plan = Json.Str(Json.Get(account, "plan"));
            var disabled = Json.Bool(account, "disabled");
            var error = Json.Str(Json.Get(account, "error"));
            var supported = Json.Bool(account, "supported");
            var windows = Json.Arr(Json.Get(account, "windows"));

            var card = new TableLayoutPanel
            {
                Dock = DockStyle.Top,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                ColumnCount = 3,
                Padding = new Padding(20, 16, 20, 16)
            };
            Skin.Border(card);
            card.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 190));
            card.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            card.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            // The cards are rebuilt whenever a limit moves: the logo copy and the
            // fonts a card made for itself are released with it.
            var labelFont = Theme.Ui(11f, FontStyle.Bold);
            var emailFont = Theme.Ui(10f);
            var windowFont = Theme.Ui(9.5f);

            var title = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Margin = new Padding(0, 0, 0, 6) };
            var logo = Logos.Sized(Json.Str(Json.Get(account, "provider")), 24);
            card.Disposed += (s, e) =>
            {
                if (logo != null) logo.Dispose();
                labelFont.Dispose();
                emailFont.Dispose();
                windowFont.Dispose();
            };
            if (logo != null) title.Controls.Add(new GlassPicture { Image = logo, Size = new Size(24, 24), Margin = new Padding(0, 1, 8, 0) });
            title.Controls.Add(new GlassLabel { Text = label, AutoSize = true, Font = labelFont, Margin = new Padding(0, 2, 8, 0) });
            var emailBeside = new GlassLabel { Text = email, AutoSize = true, Font = emailFont, ForeColor = Theme.Muted, Margin = new Padding(0, 4, 10, 0) };
            title.Controls.Add(emailBeside);
            // The same e-mail on the line below, for a card too narrow to hold it beside the name.
            var emailBelow = new GlassLabel { Text = email, AutoSize = true, Font = emailFont, ForeColor = Theme.Muted, Margin = new Padding(logo != null ? 32 : 0, 0, 0, 6), Visible = false };
            // Plan names such as "self_serve_business_prolite" are made readable and kept short.
            var planText = plan.Replace("_", " ");
            if (planText.Length > 16) planText = planText.Substring(0, 15) + "\u2026";
            if (plan.Length > 0) title.Controls.Add(new Chip { Text = planText, Tint = Theme.Teal, Margin = new Padding(0, 3, 8, 0) });
            // With two accounts at one provider, the primary one serves until it
            // is out of quota; only then does the other take over.
            var primary = Json.Bool(account, "primary");
            var siblings = (int)Json.Num(account, "siblings", 1);
            if (primary && siblings > 1) title.Controls.Add(new Chip { Text = "Primary", Tint = Theme.Ok, Margin = new Padding(0, 3, 8, 0) });
            title.Controls.Add(new GlassLabel { Text = disabled ? "\u25CF Paused" : "\u25CF Active", AutoSize = true, ForeColor = disabled ? Theme.Muted : Theme.Ok, Margin = new Padding(0, 5, 0, 0) });
            card.Controls.Add(title, 0, 0);
            card.SetColumnSpan(title, 2);
            card.Controls.Add(emailBelow, 0, 1);
            card.SetColumnSpan(emailBelow, 3);

            var actions = new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, FlowDirection = FlowDirection.RightToLeft, WrapContents = false, Anchor = AnchorStyles.Top | AnchorStyles.Right, Margin = new Padding(0) };
            var signOut = Skin.Danger(new PillButton { Text = "Sign out...", AutoSize = true, Margin = new Padding(6, 0, 0, 0) });
            signOut.Click += (s, e) => SignOut(file, label, email);
            var pause = new PillButton { Text = disabled ? "Resume" : "Pause", AutoSize = true, Margin = new Padding(6, 0, 0, 0) };
            pause.Click += (s, e) => SetPaused(file, label, email, !disabled);
            actions.Controls.Add(signOut);
            actions.Controls.Add(pause);
            if (siblings > 1 && !primary && !disabled)
            {
                var makePrimary = new PillButton { Text = "Make primary", AutoSize = true, Margin = new Padding(6, 0, 0, 0) };
                makePrimary.Click += (s, e) => AccountCall("accounts/primary", new Dictionary<string, object> { { "file", file } }, label + " (" + email + ") is now the primary account: it is used until it runs out, then the other one takes over.");
                actions.Controls.Add(makePrimary);
            }
            else if (siblings > 1 && primary)
            {
                var noPrimary = new PillButton { Text = "Not primary", AutoSize = true, Margin = new Padding(6, 0, 0, 0) };
                noPrimary.Click += (s, e) => AccountCall("accounts/primary", new Dictionary<string, object> { { "file", file }, { "primary", false } }, label + " has no primary account now: its accounts take turns.");
                actions.Controls.Add(noPrimary);
            }
            var resets = Json.Obj(Json.Get(account, "resets"));
            var resetCount = (int)Json.Num(resets, "available", 0);
            card.Controls.Add(actions, 2, 0);

            // The third column is as wide as its widest line, or as the buttons above.
            var third = actions.PreferredSize.Width + actions.Margin.Horizontal;
            var row = 2;
            foreach (var item in windows)
            {
                var w = Json.Obj(item);
                var reported = !(Json.Get(w, "reported") is bool) || Json.Bool(w, "reported");
                var left = Json.Num(w, "leftPercent", 0);
                card.Controls.Add(new GlassLabel { Text = Json.Str(Json.Get(w, "title")), AutoSize = true, Margin = new Padding(0, 4, 0, 4), Font = windowFont, ForeColor = reported ? Theme.Text : Theme.Muted }, 0, row);
                if (reported)
                {
                    card.Controls.Add(new Meter { LeftPercent = left, Dock = DockStyle.Fill }, 1, row);
                    var resetLine = new GlassLabel { Text = string.Format("{0:0}% left \u00B7 {1}", left, Format.Reset(Json.Str(Json.Get(w, "resetsAt")))), AutoSize = true, MinimumSize = new Size(330, 0), ForeColor = Theme.ForLeft(left), Margin = new Padding(0, 4, 0, 4) };
                    third = Math.Max(third, Math.Max(resetLine.MinimumSize.Width, resetLine.PreferredSize.Width) + resetLine.Margin.Horizontal);
                    card.Controls.Add(resetLine, 2, row);
                }
                else
                {
                    var none = new GlassLabel { Text = "Not reported for this plan", AutoSize = true, ForeColor = Theme.Muted, Margin = new Padding(0, 4, 0, 4) };
                    card.Controls.Add(none, 1, row);
                    card.SetColumnSpan(none, 2);
                }
                row += 1;
            }
            // The resets get their own warning strip: the count, the risk, and
            // the only way in, which is the danger-zone dialog.
            if (resetCount > 0 && !disabled)
            {
                var strip = Glass.Make(new FlowLayoutPanel { AutoSize = false, Height = 56, Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Margin = new Padding(0, 12, 0, 0), Padding = new Padding(14, 10, 14, 10) }, 14, false, Theme.Bad);
                strip.Controls.Add(new Chip { Text = resetCount == 1 ? "\u26A0 1 limit reset" : string.Format("\u26A0 {0} limit resets", resetCount), Tint = Theme.Warn, Margin = new Padding(0, 5, 12, 0) });
                strip.Controls.Add(new GlassLabel { Text = "Danger zone: spending one cannot be undone.", AutoSize = true, ForeColor = Theme.Bad, Margin = new Padding(0, 9, 14, 0) });
                var useReset = Skin.DangerStrong(new PillButton { Text = "Use a reset\u2026", AutoSize = true, Margin = new Padding(3, 0, 3, 0) });
                useReset.Click += (s, e) => UseReset(file, label, email, windows, resetCount);
                strip.Controls.Add(useReset);
                card.Controls.Add(strip, 0, row);
                card.SetColumnSpan(strip, 3);
                row += 1;
            }
            string note = null;
            if (disabled) note = "Paused: DSHProxy does not use this account until you resume it.";
            else if (!supported) note = label + " does not report its limits.";
            else if (error.Length > 0) note = error;
            if (note != null)
            {
                var noteLabel = new GlassLabel { Text = note, AutoSize = true, ForeColor = error.Length > 0 && !disabled && supported ? Theme.Bad : Theme.Muted, Margin = new Padding(0, 4, 0, 0) };
                card.Controls.Add(noteLabel, 0, row);
                card.SetColumnSpan(noteLabel, 3);
            }
            // The e-mail stands beside the name while the title line has the
            // room for all of it; in a narrower card it gets the line below.
            // The card is measured only at the width its list gives it, and it
            // is changed after the list has finished laying out: a card that
            // changes its height while the list is being laid out leaves the
            // list scrolling over the height the card had before.
            var beside = true;
            var queued = false;
            Func<bool> measured = () => !card.IsDisposed && card.Parent != null && card.Width + SystemInformation.VerticalScrollBarWidth >= card.Parent.ClientSize.Width;
            Func<bool> fitsNow = () =>
            {
                var column = card.ColumnStyles[2];
                var room = card.ClientSize.Width - card.Padding.Horizontal - (column.SizeType == SizeType.Absolute ? (int)column.Width : third);
                var need = 0;
                foreach (Control part in title.Controls) need += part.PreferredSize.Width + part.Margin.Horizontal;
                return email.Length == 0 || need <= room;
            };
            Action move = () =>
            {
                queued = false;
                if (!measured()) return;
                var fits = fitsNow();
                if (fits == beside) return;
                beside = fits;
                card.SuspendLayout();
                emailBeside.Visible = fits;
                emailBelow.Visible = !fits;
                title.Margin = new Padding(0, 0, 0, fits ? 6 : 0);
                card.ResumeLayout(true);
            };
            card.SizeChanged += (s, e) =>
            {
                if (queued || !measured() || fitsNow() == beside) return;
                var poster = card.IsHandleCreated ? (System.Windows.Forms.Control)card : this;
                if (!poster.IsHandleCreated)
                {
                    move();
                    return;
                }
                queued = true;
                poster.BeginInvoke(move);
            };
            thirdNeed = third;
            return card;
        }

        // Low limits are shown in the window (amber and red bars); a tray balloon
        // for them only interrupted whatever you were doing, so there is none.

        private void AddAccount()
        {
            if (!running)
            {
                Msg.Show(this, "Start the gateway first. Sign-in runs through it.", "Add account", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            using (var dialog = new SignInDialog(control, loginProviders))
            {
                dialog.ShowDialog(this);
                if (dialog.SignedInAs != null)
                {
                    AppendLog("Signed in: " + dialog.SignedInAs);
                    // A chat account: show it in the Chat workspace (the tray
                    // menu can start a sign-in while Video is showing).
                    chatSwitch.Checked = true;
                    tabs.SelectedIndex = 0;
                    RefreshStatus();
                    LoadLimits(true);
                }
            }
        }

        // Lists the resets ChatGPT offers, then hands over to the danger-zone
        // dialog, where using one has to be typed out. Each attempt carries its
        // own request ID, so a retried request cannot use a second reset.
        private void UseReset(string file, string label, string email, ArrayList windows, int available)
        {
            UseWaitCursor = true;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Dictionary<string, object> listed = null;
                string failure = null;
                try { listed = control.Call("GET", "resets?file=" + Uri.EscapeDataString(file), null, 30000); }
                catch (ControlException error) { failure = error.Message; }
                catch (WebException error) { failure = error.Message; }
                BeginInvoke(new Action(() =>
                {
                    UseWaitCursor = false;
                    if (failure != null)
                    {
                        Msg.Show(this, "Could not list your resets: " + failure, "Limit reset", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        return;
                    }
                    var credits = Json.Arr(Json.Get(listed, "credits"));
                    var count = (int)Json.Num(listed, "available", 0);
                    if (count <= 0 && credits.Count == 0)
                    {
                        Msg.Show(this, "No limit reset is available on this account right now.", "Limit reset", MessageBoxButtons.OK, MessageBoxIcon.Information);
                        return;
                    }
                    // Every use goes through the danger zone, even when ChatGPT
                    // did not name the credit it would spend.
                    var chosen = ResetDialog.Choose(this, label, email, credits, windows, Math.Max(count, credits.Count));
                    if (chosen == null) return;
                    ConsumeReset(file, Json.Str(Json.Get(chosen, "id")), Guid.NewGuid().ToString());
                }));
            });
        }

        private void ConsumeReset(string file, string creditId, string requestId)
        {
            UseWaitCursor = true;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Dictionary<string, object> result = null;
                string failure = null;
                var body = new Dictionary<string, object> { { "file", file }, { "requestId", requestId } };
                if (!string.IsNullOrEmpty(creditId)) body["creditId"] = creditId;
                try { result = control.Call("POST", "resets/use", body, 60000); }
                catch (ControlException error) { failure = error.Message; }
                catch (WebException error) { failure = error.Message; }
                BeginInvoke(new Action(() =>
                {
                    UseWaitCursor = false;
                    if (failure != null)
                    {
                        Msg.Show(this, "The reset was not confirmed: " + failure + "\n\nRefresh the limits to see whether it was used before trying again.", "Limit reset", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        return;
                    }
                    var ok = Json.Str(Json.Get(result, "code")) == "reset";
                    AppendLog(Json.Str(Json.Get(result, "message")));
                    Msg.Show(this, Json.Str(Json.Get(result, "message")), "Limit reset", MessageBoxButtons.OK, ok ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
                    LoadLimits(true);
                }));
            });
        }

        private void SignOut(string file, string label, string email)
        {
            var answer = Msg.Show(this,
                string.Format("Sign out of {0} ({1})?\n\nDSHProxy stops using this account and deletes its saved sign-in. Lanes move to their other models. You can sign in again at any time.", label, email),
                "Sign out", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes) return;
            AccountCall("accounts/remove", new Dictionary<string, object> { { "file", file } }, "Signed out of " + label + " (" + email + ").");
        }

        private void SetPaused(string file, string label, string email, bool pause)
        {
            AccountCall("accounts/disable", new Dictionary<string, object> { { "file", file }, { "disabled", pause } }, (pause ? "Paused " : "Resumed ") + label + " (" + email + ").");
        }

        private void AccountCall(string path, Dictionary<string, object> body, string done)
        {
            UseWaitCursor = true;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                string failure = null;
                try { control.Call("POST", path, body, 30000); }
                catch (ControlException error) { failure = error.Message; }
                catch (WebException error) { failure = error.Message; }
                BeginInvoke(new Action(() =>
                {
                    UseWaitCursor = false;
                    if (failure != null)
                    {
                        Msg.Show(this, failure, "Account", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        return;
                    }
                    AppendLog(done);
                    RefreshStatus();
                    LoadLimits(true);
                }));
            });
        }

        private readonly Dictionary<string, Button> presetButtons = new Dictionary<string, Button>();
        private readonly Label presetNote = new GlassLabel { AutoSize = true, ForeColor = Theme.Muted, Margin = new Padding(0, 6, 0, 2) };
        private ToolTip presetTips;
        private string activePreset = "";
        private ArrayList routingPresets = new ArrayList();

        // Shows which routing preset the ladders are, and what it does.
        private void ShowRouting(Dictionary<string, object> routing)
        {
            var routingPrint = Json.Serializer.Serialize(routing);
            if (routingPrint == routingKey) return;
            routingKey = routingPrint;
            var active = Json.Obj(Json.Get(routing, "active"));
            activePreset = Json.Str(Json.Get(active, "name"));
            routingPresets = Json.Arr(Json.Get(routing, "presets"));
            foreach (var pair in presetButtons)
            {
                if (pair.Key == activePreset) Skin.Primary(pair.Value);
                else pair.Value.Tag = null;
                pair.Value.Invalidate();
            }
            string summary = null;
            foreach (var item in routingPresets)
            {
                var preset = Json.Obj(item);
                var name = Json.Str(Json.Get(preset, "name"));
                if (presetButtons.ContainsKey(name) && presetTips != null) presetTips.SetToolTip(presetButtons[name], Json.Str(Json.Get(preset, "summary")));
                if (name == activePreset) summary = Json.Str(Json.Get(preset, "summary"));
            }
            presetNote.Text = activePreset == "custom"
                ? "Custom ladders, edited in settings.json. Pick a preset to replace them."
                : "Active: " + Json.Str(Json.Get(active, "label")) + ". " + (summary ?? "");
        }

        private void UsePreset(string name, string label)
        {
            if (!running)
            {
                Msg.Show(this, "Start the gateway first.", "Routing preset", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            var answer = Msg.Show(this, string.Format("Use the {0} routing preset?\n\nThis replaces the ladders of all five lanes. You can switch back or edit them at any time.", label), "Routing preset", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes) return;
            ControlInBackground("lanes/preset", new Dictionary<string, object> { { "name", name } }, result =>
            {
                AppendLog("Routing preset: " + label + ".");
                if (Json.Bool(result, "harnessChanged")) AppendLog("DeepSeek Harness routes updated. Restart DeepSeek Harness to see them.");
                RefreshStatus();
            });
        }

        // ---------- models ----------

        private static readonly Dictionary<string, string> ServiceLabels = new Dictionary<string, string>
        {
            { "claude", "Claude" }, { "codex", "ChatGPT" }, { "antigravity", "Gemini (Google)" }, { "kimi", "Kimi" }
        };

        private static string Tokens(double value)
        {
            if (value >= 1000000) return (value / 1000000).ToString("0.##", CultureInfo.InvariantCulture) + "M";
            if (value >= 1000) return Math.Round(value / 1000).ToString(CultureInfo.InvariantCulture) + "K";
            return value.ToString(CultureInfo.InvariantCulture);
        }

        private void FillModels()
        {
            var visible = new List<Dictionary<string, object>>();
            foreach (var item in modelRows)
            {
                var m = Json.Obj(item);
                var reason = Json.Str(Json.Get(m, "reason"));
                var offered = Json.Bool(m, "offered");
                if (offered || showHiddenModels || reason == "switched off") visible.Add(m);
            }
            // New models first, then by service and name.
            visible.Sort((a, b) =>
            {
                var na = Json.Bool(a, "isNew") && Json.Bool(a, "offered") ? 0 : 1;
                var nb = Json.Bool(b, "isNew") && Json.Bool(b, "offered") ? 0 : 1;
                if (na != nb) return na - nb;
                var sa = string.Compare(Json.Str(Json.Get(a, "account")), Json.Str(Json.Get(b, "account")), StringComparison.Ordinal);
                return sa != 0 ? sa : string.Compare(Json.Str(Json.Get(a, "id")), Json.Str(Json.Get(b, "id")), StringComparison.Ordinal);
            });
            var key = Json.Serializer.Serialize(visible) + showHiddenModels;
            if (key == modelsKey) return;
            modelsKey = key;
            fillingModels = true;
            modelsList.BeginUpdate();
            modelsList.Items.Clear();
            modelTicks.Clear();
            foreach (var m in visible)
            {
                var reason = Json.Str(Json.Get(m, "reason"));
                var offered = Json.Bool(m, "offered");
                modelTicks[Json.Str(Json.Get(m, "id"))] = offered;
                var efforts = new List<string>();
                foreach (var e in Json.Arr(Json.Get(m, "efforts"))) efforts.Add(Json.Str(e));
                string label;
                switch (reason)
                {
                    case "new": label = "NEW \u00B7 found automatically"; break;
                    case "known": label = "Offered"; break;
                    case "switched on": label = "Offered (you switched it on)"; break;
                    case "switched off": label = "Off (you switched it off)"; break;
                    case "older generation": label = "Hidden: older generation"; break;
                    case "not a chat model": label = "Hidden: not a chat model"; break;
                    case "not in the catalog": label = "Hidden: no details known"; break;
                    default: label = reason; break;
                }
                string service;
                ServiceLabels.TryGetValue(Json.Str(Json.Get(m, "account")), out service);
                if (service == null) service = Json.Str(Json.Get(m, "account"));
                var known = Json.Str(Json.Get(m, "name"));
                var row = new ListViewItem(new[]
                {
                    Json.Str(Json.Get(m, "id")),
                    service,
                    Tokens(Json.Num(m, "contextWindow", 0)),
                    Tokens(Json.Num(m, "maxTokens", 0)),
                    efforts.Count > 0 ? string.Join(", ", efforts.ToArray()) : "none",
                    label
                })
                {
                    Checked = offered,
                    Tag = Json.Str(Json.Get(m, "id")),
                    ImageKey = Json.Str(Json.Get(m, "account")),
                    ToolTipText = (known.Length > 0 ? known + "  \u00B7  " : "") + "Service: " + service
                };
                if (reason == "new" && offered) { row.ForeColor = Theme.Accent; row.Font = new Font(modelsList.Font, FontStyle.Bold); }
                else if (!offered) row.ForeColor = Theme.Muted;
                modelsList.Items.Add(row);
            }
            modelsList.EndUpdate();
            fillingModels = false;
        }

        // What each row was filled with, or was last changed to by the user.
        private readonly Dictionary<string, bool> modelTicks = new Dictionary<string, bool>();

        private void OnModelChecked(ItemCheckEventArgs e)
        {
            if (fillingModels) return;
            var id = modelsList.Items[e.Index].Tag as string;
            if (id == null) return;
            // Windows reports every tick again when it builds the list, which
            // is when the page is first shown; only a real change is acted on.
            bool ticked;
            if (modelTicks.TryGetValue(id, out ticked) && ticked == (e.NewValue == CheckState.Checked)) return;
            if (!running)
            {
                e.NewValue = e.CurrentValue;
                Msg.Show(this, "Start the gateway first.", "Models", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            var on = e.NewValue == CheckState.Checked;
            modelTicks[id] = on;
            ControlInBackground("models/choose", new Dictionary<string, object> { { "id", id }, { "offered", on } }, result =>
            {
                AppendLog((on ? "Offering " : "No longer offering ") + id + (Json.Bool(result, "harnessChanged") ? "; DeepSeek Harness routes updated. Restart DeepSeek Harness to see it." : "."));
                modelsKey = "";
                RefreshStatus();
            });
        }

        private void RefreshModels()
        {
            if (!running)
            {
                Msg.Show(this, "Start the gateway first.", "Models", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            modelsNote.Text = "Checking for new models...";
            ControlInBackground("models/refresh", new Dictionary<string, object>(), result =>
            {
                modelsKey = "";
                var error = Json.Str(Json.Get(result, "catalogError"));
                var changed = Json.Bool(result, "harnessChanged");
                AppendLog("Checked for new models" + (error.Length > 0 ? " (catalog not reachable: " + error + ")" : "") + (changed ? "; DeepSeek Harness routes updated." : "."));
                RefreshStatus();
                // No balloon here: the log line above and the update bar already
                // say it, and popping up while you work is just noise.
            });
        }

        private void FillSuggestions(ArrayList list)
        {
            var key = Json.Serializer.Serialize(list);
            if (key == suggestionsKey) return;
            suggestionsKey = key;
            suggestionsPanel.SuspendLayout();
            Children.Release(suggestionsPanel);
            foreach (var item in list)
            {
                var s = Json.Obj(item);
                var from = Json.Str(Json.Get(s, "from"));
                var to = Json.Str(Json.Get(s, "to"));
                var lanes = new List<string>();
                foreach (var l in Json.Arr(Json.Get(s, "lanes"))) lanes.Add(Json.Str(l));
                var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Margin = new Padding(0, 2, 0, 2) };
                row.Controls.Add(new GlassLabel { Text = string.Format("Newer model: {0} could replace {1} on lane {2}.", to, from, string.Join(", ", lanes.ToArray())), AutoSize = true, Margin = new Padding(0, 12, 10, 0) });
                var use = new PillButton { Text = "Use " + to, AutoSize = true };
                var lanesCopy = lanes.ToArray();
                use.Click += (s2, e2) => ReplaceOnLanes(from, to, lanesCopy);
                row.Controls.Add(use);
                suggestionsPanel.Controls.Add(row);
            }
            suggestionsPanel.Visible = list.Count > 0;
            suggestionsPanel.ResumeLayout();
        }

        private void ReplaceOnLanes(string from, string to, string[] lanes)
        {
            var answer = Msg.Show(this, string.Format("Put {0} in place of {1} on lane {2}?\n\nThe rest of each ladder stays as it is. You can change it back in settings.json.", to, from, string.Join(", ", lanes)), "Lanes", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes) return;
            ControlInBackground("lanes/replace", new Dictionary<string, object> { { "from", from }, { "to", to }, { "lanes", lanes } }, result =>
            {
                AppendLog(string.Format("{0} now replaces {1} on lane {2}.", to, from, string.Join(", ", lanes)));
                suggestionsKey = "";
                RefreshStatus();
            });
        }

        // ---------- backend updates ----------

        private void ShowUpdate(Dictionary<string, object> update, Dictionary<string, object> lockInfo)
        {
            lastUpdate = update;
            previousBackend = Json.Str(Json.Get(lockInfo, "previous"));
            var available = Json.Bool(update, "available");
            var current = Json.Str(Json.Get(lockInfo, "version"));
            if (available)
            {
                var published = Format.ParseTime(Json.Str(Json.Get(update, "publishedAt")));
                updateLabel.Text = string.Format("CLIProxyAPI {0} is available (you run {1}){2}. Updating tries it first and keeps {1} for rollback.",
                    Json.Str(Json.Get(update, "latest")), current, published.HasValue ? ", released " + published.Value.ToString("d MMM HH:mm", CultureInfo.CurrentCulture) : "");
            }
            else if (previousBackend.Length > 0)
            {
                updateLabel.Text = string.Format("Running CLIProxyAPI {0}. The previous version {1} is kept.", current, previousBackend);
            }
            updateButton.Visible = available;
            rollbackButton.Visible = previousBackend.Length > 0;
            updateBar.Visible = running && (available || previousBackend.Length > 0);
            FitUpdateBar();
        }

        // The sentence about the backend wraps in front of its buttons, so a
        // narrow window does not push them out of sight, and it stands in
        // the middle of their height on one line or on two.
        private void FitUpdateBar()
        {
            var buttons = 0;
            var tallest = 0;
            var offered = new List<Button>();
            if (lastUpdate != null && Json.Bool(lastUpdate, "available")) offered.Add(updateButton);
            if (previousBackend.Length > 0) offered.Add(rollbackButton);
            foreach (var button in offered)
            {
                var size = button.PreferredSize;
                buttons += size.Width + button.Margin.Horizontal;
                tallest = Math.Max(tallest, size.Height);
            }
            var room = updateBar.ClientSize.Width - updateBar.Padding.Horizontal - 12 - buttons;
            if (room < 80) return;
            // The sentence takes all the room there is, so the buttons stand
            // at the right edge, under Start and Stop, at every width.
            var sentence = new Size(room, updateLabel.GetPreferredSize(new Size(room, 0)).Height);
            var margin = new Padding(0, Math.Max(0, 3 + (tallest - sentence.Height) / 2), 12, 0);
            if (updateLabel.Size == sentence && updateLabel.Margin == margin) return;
            updateBar.SuspendLayout();
            updateLabel.Size = sentence;
            updateLabel.Margin = margin;
            updateBar.ResumeLayout(true);
        }

        private void ApplyUpdate()
        {
            if (lastUpdate == null || !Json.Bool(lastUpdate, "available")) return;
            var latest = Json.Str(Json.Get(lastUpdate, "latest"));
            var answer = Msg.Show(this,
                string.Format("Update the backend to CLIProxyAPI {0}?\n\n1. Download it and check it against the release's published checksum.\n2. Start it on a spare port and send one short request through each signed-in account (uses a tiny bit of quota).\n3. Only if that passes: restart DSHProxy on {0}, about 5 seconds offline.\n\nIf anything fails, DSHProxy stays on the version you have.", latest),
                "Update CLIProxyAPI", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes) return;
            updateButton.Enabled = false;
            updateLabel.Text = "Downloading and trying CLIProxyAPI " + latest + "... this takes up to a minute.";
            ControlInBackground("update/apply", new Dictionary<string, object>(), result =>
            {
                updateButton.Enabled = true;
                var checks = new List<string>();
                foreach (var c in Json.Arr(Json.Get(result, "checks"))) checks.Add("\u2022 " + Json.Str(c));
                var ok = Json.Bool(result, "ok");
                AppendLog(Json.Str(Json.Get(result, "message")));
                Msg.Show(this, Json.Str(Json.Get(result, "message")) + (checks.Count > 0 ? "\n\nTrial run:\n" + string.Join("\n", checks.ToArray()) : "") + (ok ? "\n\nDSHProxy is restarting on the new version." : ""),
                    "Update CLIProxyAPI", MessageBoxButtons.OK, ok ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
            }, 300000, () => updateButton.Enabled = true);
        }

        private void Rollback()
        {
            if (previousBackend.Length == 0) return;
            var answer = Msg.Show(this, string.Format("Go back to CLIProxyAPI {0}?\n\nDSHProxy restarts, about 5 seconds offline.", previousBackend), "Roll back", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes) return;
            ControlInBackground("update/rollback", new Dictionary<string, object>(), result => AppendLog(Json.Str(Json.Get(result, "message"))));
        }

        // Calls the control API off the UI thread and reports a failure.
        private void ControlInBackground(string path, Dictionary<string, object> body, Action<Dictionary<string, object>> done, int timeoutMs = 60000, Action failed = null)
        {
            UseWaitCursor = true;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Dictionary<string, object> result = null;
                string failure = null;
                try { result = control.Call("POST", path, body, timeoutMs); }
                catch (ControlException error) { failure = error.Message; }
                catch (WebException error) { failure = error.Message; }
                BeginInvoke(new Action(() =>
                {
                    UseWaitCursor = false;
                    if (failure != null)
                    {
                        if (failed != null) failed();
                        modelsKey = "";
                        Msg.Show(this, failure, "DSHProxy", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        RefreshStatus();
                        return;
                    }
                    done(result);
                }));
            });
        }

        // ---------- video workspace ----------
        //
        // The Chat / Video switch changes what the sections show; the selected
        // section stays where it is, and the log is the same in both. The
        // video pages are a setup surface: nothing here asks for a price or
        // submits a job. Models and billing routes are read and written
        // through the command line only (see VideoSettings), off the UI
        // thread; saved keys and the Krea sign-in have their own section
        // further down (video credentials). A preview window shows sample
        // data and runs no command.

        private readonly Panel content = new Panel { Dock = DockStyle.Fill };
        private readonly Panel videoHost = new Panel { Dock = DockStyle.Fill, Visible = false };
        private readonly List<Panel> videoPages = new List<Panel>();
        private readonly SegmentRadio chatSwitch = new SegmentRadio { Text = "Chat", Size = new Size(96, 34), Checked = true, AccessibleName = "Chat workspace", AccessibleDescription = "Shows chat accounts, API keys, lanes and models in the sections below." };
        private readonly SegmentRadio videoSwitch = new SegmentRadio { Text = "Video", Size = new Size(96, 34), AccessibleName = "Video workspace", AccessibleDescription = "Shows video accounts, API keys, lanes and models in the sections below." };
        private readonly Label workspaceHint = new GlassLabel { AutoSize = false, ForeColor = Theme.Muted, TextAlign = ContentAlignment.MiddleLeft };
        private readonly ListView videoModelsList = new DarkList();
        private readonly ListView videoLanesList = new DarkList();
        private readonly ListView videoHarnessList = new DarkList();
        private readonly Label videoModelsStatus = new GlassLabel { ForeColor = Theme.Muted };
        private readonly Label videoLanesStatus = new GlassLabel { ForeColor = Theme.Muted };
        private ListViewItem videoHarnessSaved;
        private ListViewItem videoHarnessUnrouted;
        private ListViewItem videoHarnessFiles;
        // Where the DeepSeek Harness video bundle sits in the DSHProxy folder.
        private const string VideoBundleFolder = "integrations\\dsh-video";
        // Switched off while a video settings command is running.
        private readonly List<Button> videoButtons = new List<Button>();
        // What the command line last reported; null until it has answered.
        private List<VideoSettings.Model> videoModels;
        private string videoError;
        private bool videoMode;
        private bool videoBusy;
        private bool videoPending;
        private bool fillingVideo;

        // A preview window (--preview, --preview-limits) must not read or
        // change the real configuration, so it works on sample settings.
        private bool VideoSynthetic
        {
            get { return ReadOnly || previewLimits != null; }
        }

        // The section strip and the workspace switch. LayoutSwitchRow places
        // them; the strip comes first in the Tab order, as it always has.
        private System.Windows.Forms.Control BuildSwitchRow(NavStrip nav)
        {
            workspaceLabel = new GlassLabel { Text = "Workspace", AutoSize = true, Font = Theme.Ui(10f, FontStyle.Bold) };
            var capsule = Glass.Make(new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Padding = new Padding(4), Margin = new Padding(0), AccessibleRole = AccessibleRole.Grouping, AccessibleName = "Workspace" }, 21, true);
            workspaceCapsule = capsule;
            capsule.Controls.Add(chatSwitch);
            capsule.Controls.Add(videoSwitch);
            switchRow.Controls.Add(nav);
            switchRow.Controls.Add(workspaceLabel);
            switchRow.Controls.Add(capsule);
            switchRow.Controls.Add(workspaceHint);
            videoSwitch.CheckedChanged += (s, e) => SetWorkspace(videoSwitch.Checked);
            ShowWorkspace();
            return switchRow;
        }

        private void SetWorkspace(bool video)
        {
            if (videoMode == video) return;
            videoMode = video;
            ShowWorkspace();
            if (video)
            {
                // Before the window exists there is nowhere to report to.
                if (IsHandleCreated)
                {
                    LoadVideoSettings();
                    EnterVideoPage();
                }
                else videoPending = true;
            }
            else if (tabs.SelectedIndex == 0)
            {
                // Back on the chat accounts: the same refresh as choosing the tab.
                accountsPanel.AutoScrollPosition = Point.Empty;
                LoadLimits(false);
            }
        }

        // Puts the page for the current workspace and section on screen. The
        // section index never changes here, so a switch stays on the same tab.
        private void ShowWorkspace()
        {
            var index = tabs.SelectedIndex;
            var logSelected = index == tabs.TabPages.Count - 1 && tabs.TabPages.Count > 0;
            var showVideo = videoMode && index < videoPages.Count;
            content.SuspendLayout();
            if (showVideo)
            {
                // The new page goes up before the old one comes down, so there
                // is never a blank frame between them.
                videoPages[index].Visible = true;
                videoPages[index].BringToFront();
                for (var i = 0; i < videoPages.Count; i++) if (i != index) videoPages[i].Visible = false;
                videoHost.Visible = true;
                videoHost.BringToFront();
                tabs.Visible = false;
            }
            else
            {
                tabs.Visible = true;
                tabs.BringToFront();
                videoHost.Visible = false;
            }
            content.ResumeLayout(true);
            content.Invalidate(true);
            SetText(workspaceHint, Tied(logSelected ? "The log is shared by the Chat and Video workspaces."
                : videoMode ? "Video routing setup. Nothing is generated or charged from this window."
                : "Chat accounts, keys, lanes and models."));
        }

        private static ListView SetUpVideoList(ListView list, string name, string[] columns, int[] widths)
        {
            list.View = View.Details;
            list.FullRowSelect = true;
            list.MultiSelect = false;
            list.HideSelection = false;
            list.HeaderStyle = ColumnHeaderStyle.Nonclickable;
            list.Dock = DockStyle.Fill;
            list.AccessibleName = name;
            // The widths are the proportions: the list shares its own width
            // between its columns (see DarkList).
            for (var i = 0; i < columns.Length; i++) list.Columns.Add(columns[i], widths[i]);
            return list;
        }

        // The top of a video page: its name, so the workspace is never in
        // doubt, and what the page does and does not do.
        private static System.Windows.Forms.Control VideoTop(string title, string note)
        {
            var top = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 1, RowCount = 2, Margin = new Padding(0) };
            top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            top.Controls.Add(new GlassLabel { Text = title, AutoSize = true, Font = Theme.Ui(12f, FontStyle.Bold), ForeColor = Theme.Text, Margin = new Padding(0, 2, 0, 4) }, 0, 0);
            // Sized by its text and the width it has, so a narrow window gets
            // the lines it needs and a wide one gives the room to the list.
            top.Controls.Add(new GlassLabel { Text = Tied(note), AutoSize = true, Dock = DockStyle.Fill, ForeColor = Theme.Muted, Margin = new Padding(0, 0, 0, 8) }, 0, 1);
            return top;
        }

        // The bottom of a video page that changes settings: what happened
        // last, then the buttons.
        private static System.Windows.Forms.Control VideoBottom(Label status, params System.Windows.Forms.Control[] buttons)
        {
            var bottom = new TableLayoutPanel { Dock = DockStyle.Bottom, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 1, RowCount = 2, Margin = new Padding(0) };
            bottom.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            status.AutoSize = true;
            status.Dock = DockStyle.Fill;
            status.Margin = new Padding(0, 10, 0, 0);
            status.AccessibleRole = AccessibleRole.StatusBar;
            var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = true, Dock = DockStyle.Top, Margin = new Padding(0), Padding = new Padding(0, 4, 0, 0) };
            foreach (var button in buttons) row.Controls.Add(button);
            bottom.Controls.Add(status, 0, 0);
            bottom.Controls.Add(row, 0, 1);
            return bottom;
        }

        // The bottom of a video page that changes nothing itself: what was
        // read last, then a note. Both are as tall as their text at the width
        // they have, so a long folder name gets the lines it needs.
        private static System.Windows.Forms.Control VideoNotes(Label status, string note)
        {
            var bottom = new TableLayoutPanel { Dock = DockStyle.Bottom, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 1, RowCount = 2, Margin = new Padding(0) };
            bottom.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            status.AutoSize = true;
            status.Dock = DockStyle.Fill;
            status.Margin = new Padding(0, 10, 0, 0);
            status.AccessibleRole = AccessibleRole.StatusBar;
            bottom.Controls.Add(status, 0, 0);
            bottom.Controls.Add(new GlassLabel { Text = Tied(note), AutoSize = true, Dock = DockStyle.Fill, ForeColor = Theme.Muted, Margin = new Padding(0, 6, 0, 0) }, 0, 1);
            return bottom;
        }

        private void AddVideoPage(string section, System.Windows.Forms.Control body, System.Windows.Forms.Control top, System.Windows.Forms.Control bottom)
        {
            var page = Page(section, body, top, bottom);
            page.Dock = DockStyle.Fill;
            page.Visible = false;
            page.AccessibleName = "Video workspace: " + section;
            videoPages.Add(page);
            videoHost.Controls.Add(page);
        }

        // One video page per section, in the order of the sections. The last
        // section, the log, has none: both workspaces show the same log.
        private void BuildVideoPages()
        {
            // Accounts: the one signed-in video service. Its state comes from
            // the separate Krea helper when the page opens, never on a timer.
            SetUpVideoList(videoAccountsList, "Video accounts: Krea sign-in state", new[] { "Service", "Billed in", "Sign-in", "State" }, new[] { 200, 184, 126, 270 });
            VideoLogos(videoAccountsList, "krea");
            kreaRow = new ListViewItem(new[] { VideoSettings.RouteName("krea"), VideoSettings.Units("krea"), "In your browser", "Not read yet" }) { ForeColor = Theme.Muted, ImageKey = VideoLogoKey(videoAccountsList, "krea") };
            videoAccountsList.Items.Add(kreaRow);
            kreaSignIn = Skin.Primary(new PillButton { Text = "Sign in to Krea...", AutoSize = true });
            kreaSignIn.Click += (s, e) => KreaSignIn();
            kreaSignOut = new PillButton { Text = "Sign out", AutoSize = true, AccessibleName = "Sign out of Krea" };
            kreaSignOut.Click += (s, e) => KreaSignOut();
            kreaCancel = new PillButton { Text = "Cancel", AutoSize = true, Enabled = false, AccessibleName = "Cancel the Krea sign-in" };
            kreaCancel.Click += (s, e) => KreaCancelSignIn();
            AddVideoPage("Accounts", videoAccountsList,
                VideoTop("Video accounts", "Video has one signed-in service, a Krea workspace. Sign in to Krea starts DSHProxy's separate Krea helper and opens Krea's consent page in your browser. The helper keeps the sign-in; this app sees only whether one is present and until when. The chat accounts (Claude, ChatGPT, Gemini, Kimi) are not used for video. Sign-in with a live Krea workspace has not been verified in this build."),
                VideoBottom(videoAccountsStatus, kreaSignIn, kreaSignOut, kreaCancel));

            // API keys: one row for each pay-per-use provider. The rows say
            // whether a key is saved, never the key, and none says a key works.
            // These providers are named in text; the app has no logo for them.
            // The State column holds the longest state in the smallest window.
            SetUpVideoList(videoKeysList, "Video API keys: one row for each provider", new[] { "Provider", "Environment variable", "Billed in", "State" }, new[] { 104, 166, 98, 412 });
            videoKeysList.SelectedIndexChanged += (s, e) => UpdateVideoKeyButtons();
            videoKeysList.ItemActivate += (s, e) => AddVideoKey();
            videoKeyAdd = Skin.Primary(new PillButton { Text = "Add or replace key...", AutoSize = true, Enabled = false });
            videoKeyAdd.Click += (s, e) => AddVideoKey();
            videoKeyRemove = new PillButton { Text = "Remove key", AutoSize = true, Enabled = false };
            videoKeyRemove.Click += (s, e) => RemoveVideoKey();
            AddVideoPage("API keys", videoKeysList,
                VideoTop("Video API keys", "Save the key of a pay-per-use video provider here. It is stored encrypted in the DSHProxy data folder, like the Chat API keys, and is used by DSHProxy's video command; a key in the provider's environment variable is used instead when that is set. A saved key is not checked against the provider. Video generation from DeepSeek Harness works on the Krea route only for now."),
                VideoBottom(videoKeysStatus, videoKeyAdd, videoKeyRemove, new GlassLabel { Text = "The Krea workspace route uses a sign-in instead of a key: see Accounts.", AutoSize = true, ForeColor = Theme.Muted, Margin = new Padding(12, 11, 0, 0) }));
            SetPageStatus(videoAccountsStatus, "The Krea sign-in state has not been read yet.", Theme.Muted);
            SetPageStatus(videoKeysStatus, "The saved video keys have not been read yet.", Theme.Muted);
            FillVideoKeys();

            // Lanes: one billing route for each enabled model.
            SetUpVideoList(videoLanesList, "Video lanes: enabled models and their billing route", new[] { "Model", "Company", "Billing route", "Billed in" }, new[] { 180, 100, 250, 180 });
            VideoLogos(videoLanesList, VideoSettings.CompanyLogos);
            videoLanesList.ItemActivate += (s, e) => ChangeVideoRoute();
            var changeRoute = Skin.Primary(new PillButton { Text = "Change billing route...", AutoSize = true });
            changeRoute.Click += (s, e) => ChangeVideoRoute();
            var reloadLanes = new PillButton { Text = "Reload video settings", AutoSize = true };
            reloadLanes.Click += (s, e) => LoadVideoSettings();
            videoButtons.Add(changeRoute);
            videoButtons.Add(reloadLanes);
            AddVideoPage("Lanes", videoLanesList,
                VideoTop("Video lanes", "Each enabled model has exactly one billing route. A paid job is never retried automatically, moved to another provider or passed on to another route. A saved route is a setting: it does not prove a sign-in, a key, availability or a price."),
                VideoBottom(videoLanesStatus, changeRoute, reloadLanes, CompanyNote()));

            // Models: switch exact models on and off.
            SetUpVideoList(videoModelsList, "Video models: tick to enable", new[] { "Model", "Company", "Billing route", "Billed in", "State" }, new[] { 172, 90, 196, 176, 146 });
            VideoLogos(videoModelsList, VideoSettings.CompanyLogos);
            videoModelsList.ItemCheck += (s, e) => OnVideoModelChecked(e);
            var reloadModels = new PillButton { Text = "Reload video settings", AutoSize = true };
            reloadModels.Click += (s, e) => LoadVideoSettings();
            videoButtons.Add(reloadModels);
            AddVideoPage("Models", videoModelsList,
                VideoTop("Video models", "Ticked models with a billing route are what the separate DeepSeek Harness video bundle may offer; new models start switched off. A tick is a setting only: it checks no sign-in, key, availability or price, it is not a spending limit, and nothing is generated or charged here. Choose the billing route under Lanes."),
                VideoBottom(videoModelsStatus, reloadModels, CompanyNote()));

            // DeepSeek Harness: video gets there through the video tools, a
            // plugin that Apply to DeepSeek Harness installs. The first row is
            // what the command line read from the desktop profile (see the
            // first-time setup); this program opens no profile itself. The
            // page has no button: the one that acts is Apply, in the header.
            SetUpVideoList(videoHarnessList, "Video in DeepSeek Harness: state", new[] { "What", "State" }, new[] { 300, 470 });
            // The rows that matter most come first, so they are on screen in the smallest window.
            videoHarnessTools = new ListViewItem(new[] { "Video tools installed in DeepSeek Harness?", "Not read yet" }) { ForeColor = Theme.Muted };
            videoHarnessList.Items.Add(videoHarnessTools);
            videoHarnessSaved = new ListViewItem(new[] { "Enabled, with a billing route", "Not read yet" }) { ForeColor = Theme.Muted };
            videoHarnessList.Items.Add(videoHarnessSaved);
            videoHarnessUnrouted = new ListViewItem(new[] { "Enabled, no valid route (not offered)", "Not read yet" }) { ForeColor = Theme.Muted };
            videoHarnessList.Items.Add(videoHarnessUnrouted);
            videoHarnessFiles = new ListViewItem(new[] { "Video tools in this DSHProxy folder", "" }) { ForeColor = Theme.Muted };
            videoHarnessList.Items.Add(videoHarnessFiles);
            AddVideoPage("DeepSeek Harness", videoHarnessList,
                VideoTop("Video in DeepSeek Harness", "Video reaches DeepSeek Harness through the video tools, a plugin in " + VideoBundleFolder + " of the DSHProxy folder. Apply to DeepSeek Harness, at the top of the window, installs it in the DeepSeek Harness desktop app, together with the Chat routes."),
                VideoNotes(videoHarnessStatus, "The video tools offer the enabled models above. Their README says what they can do and how far that has been checked."));
            SetPageStatus(videoHarnessStatus, "Whether the video tools are installed in DeepSeek Harness has not been read yet.", Theme.Muted);

            SetVideoStatus("Video settings have not been read yet.", Theme.Muted);
            FillVideo();
        }

        private void SetVideoStatus(string text, Color color)
        {
            // The same line is on the Lanes page and on the Models page.
            var labels = new[] { videoModelsStatus, videoLanesStatus };
            var changed = false;
            foreach (var label in labels)
            {
                if (label.Text != text) changed = true;
                SetText(label, text);
                if (label.ForeColor != color) label.ForeColor = color;
            }
            // A screen reader hears the result of a save or a failed read
            // without having to go looking for this line. It is said once, by
            // the copy on the video page that is on screen, and not at all
            // when neither is.
            var index = tabs.SelectedIndex;
            if (!changed || !videoMode || index >= videoPages.Count) return;
            foreach (var label in labels)
            {
                if (!videoPages[index].Contains(label) || !label.IsHandleCreated) continue;
                // Saying it aloud is an extra: it must never get in the way of the setting itself.
                try { Announce(label, text); }
                catch (Exception) { }
                return;
            }
        }

        // Kept apart so a Windows without this notification only loses the announcement.
        [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
        private static void Announce(Control control, string text)
        {
            control.AccessibilityObject.RaiseAutomationNotification(System.Windows.Forms.Automation.AutomationNotificationKind.Other, System.Windows.Forms.Automation.AutomationNotificationProcessing.MostRecent, text);
        }

        // A row that says why a list of models is empty: a short title, and
        // the detail in the wide billing route column.
        private static ListViewItem VideoPlaceholder(int columns, string title, string detail, Color color)
        {
            var cells = new string[columns];
            for (var i = 0; i < columns; i++) cells[i] = i == 0 ? title : i == 2 ? detail : "";
            return new ListViewItem(cells) { ForeColor = color };
        }

        // The image of a row that has no logo: an empty slot, so its text
        // lines up with the rows that have one.
        private const string NoLogo = "none";

        // Gives a video list its logos, each in a slot as tall as a row.
        private static void VideoLogos(ListView list, params string[] names)
        {
            var images = new ImageList { ImageSize = new Size(22, 30), ColorDepth = ColorDepth.Depth32Bit };
            images.Images.Add(NoLogo, new Bitmap(22, 30));
            foreach (var name in names)
            {
                var image = Logos.Slot(name, 22, 30);
                if (image != null) images.Images.Add(name, image);
            }
            list.SmallImageList = images;
        }

        private static string VideoLogoKey(ListView list, string name)
        {
            return name.Length > 0 && list.SmallImageList.Images.ContainsKey(name) ? name : NoLogo;
        }

        // Says what the logos are, next to the buttons under a list of models.
        private static Label CompanyNote()
        {
            return new GlassLabel { Text = "Logos show the company behind each model, not a model mark.", AutoSize = true, ForeColor = Theme.Muted, Margin = new Padding(12, 11, 0, 0) };
        }

        // Redraws the video lists from what the command line last reported.
        private void FillVideo()
        {
            fillingVideo = true;
            try
            {
                // Why there is nothing to list, when there is nothing to list.
                string emptyTitle = null;
                var emptyDetail = "";
                var emptyColor = Theme.Muted;
                if (videoError != null) { emptyTitle = "Not available"; emptyDetail = videoError; emptyColor = Theme.Bad; }
                else if (videoModels == null) emptyTitle = videoBusy ? "Reading..." : "Not read yet";
                else if (videoModels.Count == 0) { emptyTitle = "No video models"; emptyDetail = "DSHProxy lists none"; }

                // Models. The tick boxes are only there when there are models.
                videoModelsList.Items.Clear();
                if (videoModelsList.CheckBoxes != (emptyTitle == null)) videoModelsList.CheckBoxes = emptyTitle == null;
                videoModelsList.BeginUpdate();
                if (emptyTitle != null) videoModelsList.Items.Add(VideoPlaceholder(5, emptyTitle, emptyDetail, emptyColor));
                else foreach (var model in videoModels)
                {
                    var state = !model.Enabled ? "Off" : model.HasRoute ? "Enabled" : "No valid route";
                    string logo;
                    var company = VideoSettings.Company(model.Id, out logo);
                    videoModelsList.Items.Add(new ListViewItem(new[] { model.Id, company, VideoRouteCell(model), model.HasRoute ? VideoSettings.Units(model.Route) : "", state })
                    {
                        Checked = model.Enabled,
                        Tag = model,
                        ImageKey = VideoLogoKey(videoModelsList, logo),
                        ForeColor = !model.Enabled ? Theme.Muted : model.HasRoute ? Theme.Text : Theme.Warn
                    });
                }
                videoModelsList.EndUpdate();

                // Lanes: the enabled models, keeping the selected row.
                var selected = videoLanesList.SelectedItems.Count > 0 ? videoLanesList.SelectedItems[0].Tag as VideoSettings.Model : null;
                var selectedId = selected == null ? null : selected.Id;
                var enabled = new List<string>();
                var unrouted = new List<string>();
                var lanes = 0;
                videoLanesList.BeginUpdate();
                videoLanesList.Items.Clear();
                if (emptyTitle != null) videoLanesList.Items.Add(VideoPlaceholder(4, emptyTitle, emptyDetail, emptyColor));
                else
                {
                    foreach (var model in videoModels)
                    {
                        if (!model.Enabled) continue;
                        lanes++;
                        if (model.HasRoute) enabled.Add(model.Id + " on " + model.Route);
                        else unrouted.Add(model.Id);
                        string logo;
                        var company = VideoSettings.Company(model.Id, out logo);
                        videoLanesList.Items.Add(new ListViewItem(new[] { model.Id, company, VideoRouteCell(model), model.HasRoute ? VideoSettings.Units(model.Route) : "Choose a billing route" })
                        {
                            Tag = model,
                            ImageKey = VideoLogoKey(videoLanesList, logo),
                            ForeColor = model.HasRoute ? Theme.Text : Theme.Warn,
                            Selected = model.Id == selectedId
                        });
                    }
                    if (lanes == 0) videoLanesList.Items.Add(VideoPlaceholder(4, "None enabled", "Tick a model on the Models tab", Theme.Muted));
                }
                videoLanesList.EndUpdate();

                // DeepSeek Harness: the settings the bundle would read, said as
                // no more than that, and whether its files are in this folder.
                // Only this program's own folder is looked at, never a profile.
                if (videoHarnessSaved != null)
                {
                    var unread = emptyTitle == null ? null : videoError != null ? "Not available" : "Not read yet";
                    var sample = VideoSynthetic ? "Sample: enabled" : "Enabled";
                    videoHarnessSaved.Text = sample + ", with a billing route";
                    videoHarnessSaved.SubItems[1].Text = unread ?? (enabled.Count == 0 ? "None" : string.Join(", ", enabled.ToArray()));
                    videoHarnessUnrouted.Text = sample + ", no valid route (not offered)";
                    videoHarnessUnrouted.SubItems[1].Text = unread ?? (unrouted.Count == 0 ? "None" : string.Join(", ", unrouted.ToArray()));
                    videoHarnessUnrouted.ForeColor = unread == null && unrouted.Count > 0 ? Theme.Warn : Theme.Muted;
                    if (VideoSynthetic)
                    {
                        // A preview window looks at nothing real, this folder included.
                        videoHarnessFiles.SubItems[1].Text = "Sample only \u00B7 not checked";
                        videoHarnessFiles.ForeColor = Theme.Muted;
                    }
                    else
                    {
                        bool found;
                        try { found = File.Exists(Path.Combine(cli.Root, VideoBundleFolder, "package.json")); }
                        catch (Exception) { found = false; }
                        videoHarnessFiles.SubItems[1].Text = (found ? "Found: " : "Not found: ") + VideoBundleFolder;
                        videoHarnessFiles.ForeColor = found ? Theme.Muted : Theme.Warn;
                    }
                }
            }
            finally { fillingVideo = false; }
        }

        // The route of a model as the lists show it. A model without a route,
        // or with one DSHProxy does not allow for it, is never shown as ready.
        private static string VideoRouteCell(VideoSettings.Model model)
        {
            if (model.Route.Length == 0) return "Not configured";
            if (!model.HasRoute) return "Not allowed: " + (model.Route.Length > 40 ? model.Route.Substring(0, 39) + "\u2026" : model.Route);
            return VideoSettings.RouteName(model.Route);
        }

        // Runs one video settings command off the UI thread. DSHProxy does not
        // lock the video settings file between processes, so the app never has
        // two of these running: every caller checks videoBusy first, a read
        // cannot start while a write is out, and a write cannot start while a
        // read is. videoBusy is only ever read and written on the UI thread.
        private void VideoCommand(string[] args, string input, Action<Cli.Result> done)
        {
            SetVideoBusy(true);
            // A chat operation may already be showing the wait cursor; it is
            // then left for that operation to clear.
            var alreadyWaiting = UseWaitCursor;
            UseWaitCursor = true;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Cli.Result result;
                try { result = cli.Run(args, input, 20000); }
                catch (Exception error) { result = new Cli.Result { Code = -1, Out = "", Err = error.Message }; }
                try
                {
                    BeginInvoke(new Action(() =>
                    {
                        SetVideoBusy(false);
                        if (!alreadyWaiting) UseWaitCursor = false;
                        done(result);
                        // The keys page was opened while this command was out.
                        if (!videoBusy && videoKeysWanted)
                        {
                            videoKeysWanted = false;
                            if (videoMode && tabs.SelectedIndex == VideoKeysPage) ReadVideoKeys(null, false);
                        }
                    }));
                }
                // The window has gone: there is nothing left to report to.
                catch (InvalidOperationException) { }
            });
        }

        // While a command is out, the buttons that would start another are
        // switched off, and a tick in the Models list is put back.
        private void SetVideoBusy(bool busy)
        {
            videoBusy = busy;
            foreach (var button in videoButtons) if (button.Enabled == busy) button.Enabled = !busy;
            UpdateVideoKeyButtons();
        }

        // Reads the video settings: `dshproxy video settings`. `notSaved` is
        // set when this read follows a save that failed: the lists then show
        // what is really saved, and the line under them still says what went wrong.
        private void LoadVideoSettings(string notSaved = null)
        {
            if (videoBusy) return;
            if (VideoSynthetic)
            {
                videoError = null;
                videoModels = VideoSettings.Parse(VideoSettings.Sample);
                SetVideoStatus("Sample video settings for this preview window. Nothing is read from, or saved to, your configuration.", Theme.Accent);
                FillVideo();
                return;
            }
            SetVideoStatus(notSaved == null ? "Reading video settings..." : notSaved + " Reading what is saved...", notSaved == null ? Theme.Muted : Theme.Bad);
            VideoCommand(VideoSettings.ReadCommand(), null, result =>
            {
                string failure;
                var models = VideoSettings.Read(result, out failure);
                if (models == null)
                {
                    // Settings that could not be read are not shown as if they
                    // were current, and cannot be changed from here.
                    videoModels = null;
                    videoError = failure;
                    SetVideoStatus((notSaved == null ? "" : notSaved + " ") + "Could not read the video settings: " + failure, Theme.Bad);
                    AppendLog("Video: could not read the video settings: " + failure);
                }
                else
                {
                    videoModels = models;
                    videoError = null;
                    var read = DateTime.Now.ToString("HH:mm:ss", CultureInfo.CurrentCulture);
                    if (notSaved == null) SetVideoStatus("Video settings read from DSHProxy at " + read + ".", Theme.Muted);
                    else SetVideoStatus(notSaved + " The lists show what is saved (read again at " + read + ").", Theme.Bad);
                }
                FillVideo();
            });
            // After VideoCommand, so an empty list says it is being read.
            if (videoModels == null) { videoError = null; FillVideo(); }
        }

        private void OnVideoModelChecked(ItemCheckEventArgs e)
        {
            if (fillingVideo) return;
            var model = videoModelsList.Items[e.Index].Tag as VideoSettings.Model;
            if (model == null)
            {
                e.NewValue = e.CurrentValue;
                return;
            }
            var on = e.NewValue == CheckState.Checked;
            // Windows reports every tick again when it builds the list; only a
            // real change is acted on.
            if (on == model.Enabled) return;
            if (videoBusy)
            {
                e.NewValue = e.CurrentValue;
                return;
            }
            // Both paths run after this event: saving redraws the list, which
            // must not happen while the list is still reporting the tick.
            if (model.HasRoute)
            {
                var route = model.Route;
                BeginInvoke(new Action(() => SaveVideoModel(model, route, on)));
                return;
            }
            // Switching off needs no route, so a model that is enabled without
            // a valid one is switched off without a question.
            if (!on)
            {
                BeginInvoke(new Action(() => SaveVideoModel(model, VideoSettings.NoRoute, false)));
                return;
            }
            // No valid billing route is saved for this model, and the app does
            // not pick one: the tick waits until the user has chosen.
            e.NewValue = e.CurrentValue;
            BeginInvoke(new Action(() => ChooseVideoRoute(model, on)));
        }

        private void ChangeVideoRoute()
        {
            if (videoBusy) return;
            VideoSettings.Model model = null;
            if (videoLanesList.SelectedItems.Count > 0) model = videoLanesList.SelectedItems[0].Tag as VideoSettings.Model;
            else if (videoLanesList.Items.Count == 1) model = videoLanesList.Items[0].Tag as VideoSettings.Model;
            if (model == null)
            {
                var any = false;
                foreach (ListViewItem item in videoLanesList.Items) if (item.Tag is VideoSettings.Model) any = true;
                Msg.Show(this, any ? "Select a model in the list first." : videoError != null ? "The video settings could not be read. Press \"Reload video settings\"." : "No video model is enabled. Tick one on the Models tab first.", "Video lanes", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            ChooseVideoRoute(model, model.Enabled);
        }

        // Asks for the one billing route of a model, then saves it together
        // with whether the model is enabled.
        private void ChooseVideoRoute(VideoSettings.Model model, bool enabled)
        {
            if (videoBusy || videoModels == null || !videoModels.Contains(model)) return;
            if (model.Routes.Count == 0)
            {
                Msg.Show(this, "DSHProxy lists no allowed billing route for " + model.Id + ", so nothing can be saved for it.", "Video", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            var route = RouteDialog.Ask(this, model.Id, model.Routes, model.HasRoute ? model.Route : "", enabled);
            if (route == null) return;
            if (model.HasRoute && route == model.Route && enabled == model.Enabled) return;
            SaveVideoModel(model, route, enabled);
        }

        // Saves one model: `dshproxy video settings set MODEL ROUTE enabled|disabled`.
        // The lists then show what the command line reports back, not what was asked for.
        private void SaveVideoModel(VideoSettings.Model model, string route, bool enabled)
        {
            // Only a model and a route the command line itself listed are sent
            // back to it. The one exception is "no route", and that only ever
            // switches a model off: nothing is enabled without a listed route.
            var clearing = route == VideoSettings.NoRoute;
            if (videoBusy || videoModels == null || !videoModels.Contains(model) || (clearing ? enabled : !model.Routes.Contains(route)))
            {
                FillVideo();
                return;
            }
            var id = model.Id;
            var what = clearing ? id + " switched off, no billing route" : string.Format("{0} {1}, billing route {2}", id, enabled ? "enabled" : "switched off", route);
            // What the command line should report back for the route.
            var expected = clearing ? "" : route;
            if (VideoSynthetic)
            {
                model.Enabled = enabled;
                model.Route = expected;
                SetVideoStatus("Sample only, nothing saved: " + what + ".", Theme.Accent);
                FillVideo();
                return;
            }
            SetVideoStatus("Saving: " + what + "...", Theme.Muted);
            VideoCommand(VideoSettings.SetCommand(id, route, enabled), null, result =>
            {
                if (result.Code != 0)
                {
                    // Refused, timed out or failed half way: what is saved is
                    // read again rather than taken from what the app last saw.
                    var refused = VideoSettings.Failure(result);
                    AppendLog("Video: not saved (" + what + "): " + refused);
                    FillVideo();
                    LoadVideoSettings("Not saved: " + refused);
                    Msg.Show(this, "The video setting was not saved.\n\n" + refused + "\n\nThe lists are being read again, so they show what is saved.", "Video", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }
                string failure;
                var models = VideoSettings.Read(result, out failure);
                if (models == null)
                {
                    // The command succeeded but its answer cannot be read, so
                    // what is saved is asked for again rather than assumed.
                    AppendLog("Video: saved (" + what + "), but the answer could not be read: " + failure);
                    LoadVideoSettings();
                    return;
                }
                videoModels = models;
                videoError = null;
                var saved = models.Find(m => m.Id == id);
                if (saved != null && saved.Enabled == enabled && saved.Route == expected)
                {
                    SetVideoStatus("Saved: " + what + ". This is a setting only; nothing was checked or charged.", Theme.Ok);
                    AppendLog("Video: " + what + ".");
                }
                else
                {
                    SetVideoStatus("DSHProxy answered, but " + id + " does not read as asked. The lists show what is saved.", Theme.Warn);
                    AppendLog("Video: asked for " + what + ", but the saved setting reads differently.");
                }
                FillVideo();
            });
        }

        // ---------- video credentials ----------
        //
        // Video > Accounts shows the Krea sign-in and starts or ends it through
        // the separate Krea helper. Video > API keys saves, replaces and
        // removes provider keys through `dshproxy video key`. Neither a key
        // nor a sign-in is kept, logged or shown by this window. Every call
        // runs off the UI thread: one command line call at a time (videoBusy,
        // shared with the video settings) and one helper at a time (kreaBusy).
        // A preview window starts no process and reads nothing.

        private const int VideoAccountsPage = 0;
        private const int VideoKeysPage = 1;
        private readonly ListView videoAccountsList = new DarkList();
        private readonly ListView videoKeysList = new DarkList();
        private readonly Label videoAccountsStatus = new GlassLabel { ForeColor = Theme.Muted };
        private readonly Label videoKeysStatus = new GlassLabel { ForeColor = Theme.Muted };
        private ListViewItem kreaRow;
        private Button kreaSignIn;
        private Button kreaSignOut;
        private Button kreaCancel;
        private Button videoKeyAdd;
        private Button videoKeyRemove;
        // What `video key list` last reported; null until it has answered.
        private List<VideoKeys.Provider> videoKeys;
        private string videoKeysNote = "Not read yet";
        // The keys page was opened while another command was out.
        private bool videoKeysWanted;
        private bool kreaBusy;
        // The sign-in that is waiting for the browser, if one is.
        private KreaLogin kreaLogin;
        private Func<string, bool> openConsentPage = Krea.Open;

        // Called when a video page comes on screen: the two credential pages
        // read their state then, and at no other time on their own.
        private void EnterVideoPage()
        {
            if (!videoMode || !IsHandleCreated) return;
            if (tabs.SelectedIndex == VideoAccountsPage) ReadKreaState(null, Theme.Muted);
            else if (tabs.SelectedIndex == VideoKeysPage) ReadVideoKeys(null, false);
            else if (tabs.SelectedIndex == VideoHarnessPage) ReadHarnessSetup();
        }

        // The line under a video list: what happened last. A screen reader
        // hears it when its page is the one on screen.
        private void SetPageStatus(Label label, string text, Color color)
        {
            var changed = label.Text != text;
            SetText(label, text);
            if (label.ForeColor != color) label.ForeColor = color;
            var index = tabs.SelectedIndex;
            if (!changed || !videoMode || index >= videoPages.Count || !videoPages[index].Contains(label) || !label.IsHandleCreated) return;
            try { Announce(label, text); }
            catch (Exception) { }
        }

        private static string ClockNow()
        {
            return DateTime.Now.ToString("HH:mm:ss", CultureInfo.CurrentCulture);
        }

        // ----- API keys -----

        private VideoKeys.Provider SelectedVideoKey()
        {
            return videoKeysList.SelectedItems.Count == 0 ? null : videoKeysList.SelectedItems[0].Tag as VideoKeys.Provider;
        }

        private void UpdateVideoKeyButtons()
        {
            if (videoKeyAdd == null) return;
            var on = !videoBusy && SelectedVideoKey() != null;
            if (videoKeyAdd.Enabled != on) videoKeyAdd.Enabled = on;
            if (videoKeyRemove.Enabled != on) videoKeyRemove.Enabled = on;
        }

        private void FillVideoKeys()
        {
            var selected = SelectedVideoKey();
            var selectedId = selected == null ? null : selected.Id;
            videoKeysList.BeginUpdate();
            videoKeysList.Items.Clear();
            if (videoKeys == null)
            {
                videoKeysList.Items.Add(new ListViewItem(new[] { "Not shown", "", "", videoKeysNote }) { ForeColor = Theme.Muted });
            }
            else
            {
                foreach (var provider in videoKeys)
                {
                    var item = new ListViewItem(new[] { provider.Label, provider.Variable, VideoKeys.Units(provider), VideoKeys.State(provider) }) { Tag = provider, ForeColor = !provider.Saved ? Theme.Muted : provider.Readable ? Theme.Text : Theme.Warn };
                    videoKeysList.Items.Add(item);
                    if (provider.Id == selectedId) item.Selected = true;
                }
            }
            videoKeysList.EndUpdate();
            UpdateVideoKeyButtons();
        }

        // Reads which keys are saved: `dshproxy video key list`. `outcome` is
        // what a save or removal just did; it stays on the line while the list
        // is read again and after, so the list always shows what is saved and
        // the line still says what happened.
        private void ReadVideoKeys(string outcome, bool failed)
        {
            if (VideoSynthetic)
            {
                if (videoKeys == null) videoKeys = VideoKeys.Parse(VideoKeys.Sample);
                SetPageStatus(videoKeysStatus, outcome ?? "Sample rows for this preview window, not your keys. No key is read, saved or removed here.", Theme.Accent);
                FillVideoKeys();
                return;
            }
            if (videoBusy)
            {
                videoKeysWanted = true;
                return;
            }
            videoKeysWanted = false;
            SetPageStatus(videoKeysStatus, outcome == null ? "Reading which video keys are saved..." : outcome + " Reading what is saved...", outcome != null && failed ? Theme.Bad : Theme.Muted);
            VideoCommand(VideoKeys.ListCommand(), null, result =>
            {
                string failure;
                var providers = VideoKeys.Read(result, out failure);
                if (providers == null)
                {
                    // What could not be read is not shown as if it were current.
                    videoKeys = null;
                    videoKeysNote = "Could not be read";
                    SetPageStatus(videoKeysStatus, (outcome == null ? "" : outcome + " ") + "Could not read which video keys are saved: " + failure, Theme.Bad);
                    AppendLog("Video: could not read which video keys are saved: " + failure);
                }
                else
                {
                    videoKeys = providers;
                    if (outcome == null) SetPageStatus(videoKeysStatus, "Read from DSHProxy at " + ClockNow() + ". A saved key is not checked against its provider.", Theme.Muted);
                    else SetPageStatus(videoKeysStatus, outcome + " The list shows what is saved (read at " + ClockNow() + ").", failed ? Theme.Bad : Theme.Ok);
                }
                FillVideoKeys();
            });
        }

        // Saves or replaces the key of the selected provider: `dshproxy video
        // key set PROVIDER`, with the key on standard input and nowhere else.
        private void AddVideoKey()
        {
            var provider = SelectedVideoKey();
            if (provider == null) return;
            if (VideoSynthetic)
            {
                SetPageStatus(videoKeysStatus, "Sample only: no key is asked for or saved in this preview window.", Theme.Accent);
                return;
            }
            if (videoBusy) return;
            var id = provider.Id;
            var label = provider.Label;
            var key = KeyDialog.Ask(this, label);
            if (key == null) return;
            var unusable = VideoKeys.Refusal(key);
            if (unusable != null)
            {
                SetPageStatus(videoKeysStatus, "Not saved: " + unusable, Theme.Bad);
                Msg.Show(this, "The " + label + " key was not saved.\n\n" + unusable, "Video API key", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            SetPageStatus(videoKeysStatus, "Saving the " + label + " key...", Theme.Muted);
            VideoCommand(VideoKeys.SetCommand(id), key + "\n", result =>
            {
                if (VideoKeys.Saved(result, id))
                {
                    AppendLog("Video: saved the " + label + " key.");
                    ReadVideoKeys("Saved the " + label + " key. It was not checked against " + label + ".", false);
                    return;
                }
                if (result.Code == 0)
                {
                    // The command succeeded but did not answer as agreed, so
                    // what is saved is asked for rather than assumed.
                    AppendLog("Video: the " + label + " key was sent, but the answer could not be read.");
                    ReadVideoKeys("DSHProxy did not answer as expected after the " + label + " key was sent.", true);
                    return;
                }
                var refused = VideoKeys.Without(VideoSettings.Failure(result), key);
                AppendLog("Video: the " + label + " key was not saved: " + refused);
                ReadVideoKeys("Not saved: " + refused, true);
                Msg.Show(this, "The " + label + " key was not saved.\n\n" + refused + "\n\nThe list is being read again, so it shows what is saved.", "Video API key", MessageBoxButtons.OK, MessageBoxIcon.Error);
            });
        }

        // Removes the saved key of the selected provider: `dshproxy video key
        // remove PROVIDER`, after asking.
        private void RemoveVideoKey()
        {
            var provider = SelectedVideoKey();
            if (provider == null) return;
            if (VideoSynthetic)
            {
                SetPageStatus(videoKeysStatus, "Sample only: no key is removed in this preview window.", Theme.Accent);
                return;
            }
            if (videoBusy) return;
            var id = provider.Id;
            var label = provider.Label;
            if (Msg.Show(this, "Remove the saved " + label + " video key?\n\nDSHProxy's video command can then use " + label + " only with a key in " + provider.Variable + ".", "Video API key", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
            SetPageStatus(videoKeysStatus, "Removing the saved " + label + " key...", Theme.Muted);
            VideoCommand(VideoKeys.RemoveCommand(id), null, result =>
            {
                if (result.Code != 0)
                {
                    var refused = VideoSettings.Failure(result);
                    AppendLog("Video: the saved " + label + " key was not removed: " + refused);
                    ReadVideoKeys("Not removed: " + refused, true);
                    Msg.Show(this, "The saved " + label + " key was not removed.\n\n" + refused + "\n\nThe list is being read again, so it shows what is saved.", "Video API key", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }
                var removed = VideoKeys.Removed(result, id);
                if (removed == null)
                {
                    AppendLog("Video: removal of the saved " + label + " key was asked for, but the answer could not be read.");
                    ReadVideoKeys("DSHProxy did not answer as expected when asked to remove the " + label + " key.", true);
                }
                else if (removed.Value)
                {
                    AppendLog("Video: removed the saved " + label + " key.");
                    ReadVideoKeys("Removed the saved " + label + " key.", false);
                }
                else ReadVideoKeys("No " + label + " key was saved, so nothing was removed.", false);
            });
        }

        // ----- Krea sign-in -----

        private void SetKreaBusy(bool busy, bool cancellable)
        {
            kreaBusy = busy;
            if (kreaSignIn.Enabled == busy) kreaSignIn.Enabled = !busy;
            if (kreaSignOut.Enabled == busy) kreaSignOut.Enabled = !busy;
            var cancel = busy && cancellable;
            if (kreaCancel.Enabled != cancel) kreaCancel.Enabled = cancel;
        }

        private void ShowKreaState(string text, Color color)
        {
            if (kreaRow.SubItems[3].Text != text) kreaRow.SubItems[3].Text = text;
            if (kreaRow.ForeColor != color) kreaRow.ForeColor = color;
        }

        // Runs a short helper command off the UI thread and hands back its result.
        private void KreaCommand(string[] args, Action<Cli.Result> done)
        {
            SetKreaBusy(true, false);
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Cli.Result result;
                try { result = cli.RunKrea(args, 20000); }
                catch (Exception) { result = new Cli.Result { Code = -1, Out = "", Err = "" }; }
                try
                {
                    BeginInvoke(new Action(() =>
                    {
                        SetKreaBusy(false, false);
                        done(result);
                    }));
                }
                // The window has gone: there is nothing left to report to.
                catch (InvalidOperationException) { }
            });
        }

        // Asks the helper whether a sign-in is present: `status`. `outcome` is
        // what a sign-in or sign-out just did; it stays on the line.
        private void ReadKreaState(string outcome, Color color)
        {
            if (VideoSynthetic)
            {
                ShowKreaState("Sample: not signed in", Theme.Muted);
                SetPageStatus(videoAccountsStatus, outcome ?? "Sample row for this preview window. The Krea helper is not started and no sign-in is read.", Theme.Accent);
                return;
            }
            if (kreaBusy) return;
            SetPageStatus(videoAccountsStatus, (outcome == null ? "" : outcome + " ") + "Reading the Krea sign-in state...", outcome == null ? Theme.Muted : color);
            KreaCommand(Krea.StatusCommand(), result =>
            {
                var state = result.Code == 0 ? Krea.ParseStatus(result.Out, DateTime.UtcNow) : null;
                if (state == null)
                {
                    // A state that could not be read is not shown as either one.
                    ShowKreaState("Not known", Theme.Warn);
                    SetPageStatus(videoAccountsStatus, (outcome == null ? "" : outcome + " ") + "The Krea helper did not report the sign-in state. Open this page again to ask once more.", Theme.Bad);
                    AppendLog("Video: the Krea helper did not report the sign-in state.");
                    return;
                }
                ShowKreaState(Krea.Describe(state), state.SignedIn ? Theme.Ok : Theme.Muted);
                var read = "State read from the Krea helper at " + ClockNow() + "; it is read when this page opens, not kept up to date.";
                SetPageStatus(videoAccountsStatus, outcome == null ? read : outcome + " " + read, outcome == null ? Theme.Muted : color);
            });
        }

        // Starts the helper's `login`, opens the consent page it names in the
        // browser, and waits for it to end. The address is checked before it
        // is opened and is never written anywhere.
        private void KreaSignIn()
        {
            if (VideoSynthetic)
            {
                SetPageStatus(videoAccountsStatus, "Sample only: no sign-in is started in this preview window.", Theme.Accent);
                return;
            }
            if (kreaBusy) return;
            var open = openConsentPage;
            var login = new KreaLogin(() => cli.StartKrea(Krea.LoginCommand()), open);
            kreaLogin = login;
            SetKreaBusy(true, true);
            ShowKreaState("Signing in...", Theme.Muted);
            SetPageStatus(videoAccountsStatus, "Starting the Krea sign-in: the helper is asking Krea for the consent page. Cancel stops it.", Theme.Muted);
            AppendLog("Video: Krea sign-in started.");
            ThreadPool.QueueUserWorkItem(_ =>
            {
                var outcome = login.Run(() =>
                {
                    try { BeginInvoke(new Action(() => { if (kreaLogin == login) SetPageStatus(videoAccountsStatus, "Waiting for you to finish in the browser. Cancel stops the sign-in.", Theme.Accent); })); }
                    catch (InvalidOperationException) { }
                });
                try
                {
                    BeginInvoke(new Action(() =>
                    {
                        kreaLogin = null;
                        SetKreaBusy(false, false);
                        var message = Krea.Message(outcome);
                        AppendLog("Video: " + message);
                        ReadKreaState(message, outcome == Krea.Outcome.SignedIn ? Theme.Ok : outcome == Krea.Outcome.Cancelled ? Theme.Muted : Theme.Bad);
                    }));
                }
                catch (InvalidOperationException) { }
            });
        }

        // Stops the helper that is waiting for the browser.
        private void KreaCancelSignIn()
        {
            var login = kreaLogin;
            if (login == null) return;
            kreaCancel.Enabled = false;
            SetPageStatus(videoAccountsStatus, "Stopping the Krea helper...", Theme.Muted);
            ThreadPool.QueueUserWorkItem(_ => login.Cancel());
        }

        // Removes the stored sign-in: the helper's `logout`, after asking.
        private void KreaSignOut()
        {
            if (VideoSynthetic)
            {
                SetPageStatus(videoAccountsStatus, "Sample only: nothing is signed out in this preview window.", Theme.Accent);
                return;
            }
            if (kreaBusy) return;
            if (Msg.Show(this, "Sign out of Krea?\n\nThe Krea sign-in stored on this computer is removed. Video on the Krea workspace route then needs a new sign-in.", "Krea", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
            SetPageStatus(videoAccountsStatus, "Signing out of Krea...", Theme.Muted);
            KreaCommand(Krea.LogoutCommand(), result =>
            {
                if (result.Code == 0)
                {
                    AppendLog("Video: signed out of Krea.");
                    ReadKreaState("Signed out of Krea.", Theme.Muted);
                }
                else
                {
                    AppendLog("Video: Krea sign-out did not complete.");
                    ReadKreaState("Sign-out did not complete: the Krea helper ended with an error.", Theme.Bad);
                }
            });
        }

        // ---------- restart for a key change ----------

        // The wait for an idle moment that is in progress, if one is.
        private IdleStop idleStop;
        private RestartWaitDialog restartDialog;

        // Restarts the gateway this window started so it uses a changed key.
        // With nothing in flight it is stopped and started as it always was.
        // With requests in flight nothing is cut: the gateway is asked to stop
        // at a moment with none, and started again when it has.
        private void RestartForChange(string title)
        {
            if (gateway == null || gateway.HasExited || idleStop != null) return;
            if (inFlight <= 0 && !Unanswered)
            {
                StopGateway();
                StartGateway();
                return;
            }
            var asked = gateway;
            var stop = new IdleStop(() => cli.Start(IdleStop.Command()));
            IdleStop.Result result = null;
            using (var dialog = new RestartWaitDialog(inFlight, () => ThreadPool.QueueUserWorkItem(_ => stop.Cancel())))
            {
                idleStop = stop;
                restartDialog = dialog;
                AppendLog("Restart: waiting for the requests in flight to finish, at most 5 minutes.");
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    var ended = stop.Run();
                    // A gateway that stopped ends its own process a moment later.
                    // After an answer that did not arrive it may have, too. In
                    // every other case nothing is waited for here: should the
                    // gateway stop after all, the watch below starts it again.
                    if (ended.Outcome == IdleStop.Outcome.Stopped || ended.Outcome == IdleStop.Outcome.NotDone)
                    {
                        try { asked.WaitForExit(ended.Outcome == IdleStop.Outcome.Stopped ? 15000 : 1500); }
                        catch (InvalidOperationException) { }
                        catch (System.ComponentModel.Win32Exception) { }
                    }
                    try
                    {
                        BeginInvoke(new Action(() =>
                        {
                            result = ended;
                            dialog.Finish();
                        }));
                    }
                    catch (InvalidOperationException) { }
                });
                dialog.ShowDialog(this);
                idleStop = null;
                restartDialog = null;
            }
            if (result == null || quitting) return;

            // Stop or Quit was used from the tray while this waited.
            if (gateway != asked) return;
            var gone = asked.HasExited;
            switch (result.Outcome)
            {
                case IdleStop.Outcome.Stopped:
                    // Stopped with nothing in flight. Should its process still be
                    // there, ending it cuts nothing: its port is closed.
                    if (gone) gateway = null;
                    else StopGateway();
                    inFlight = 0;
                    AppendLog("Restart: the gateway stopped at a moment with nothing in flight. Starting it again.");
                    StartGateway();
                    return;
                case IdleStop.Outcome.StillBusy:
                    StartAgainIfItStops(asked);
                    AppendLog("Restart: requests were still running after 5 minutes. Nothing was restarted.");
                    Msg.Show(this, (result.InFlight == 1 ? "1 request is" : result.InFlight.ToString(CultureInfo.InvariantCulture) + " requests are") + " still running after 5 minutes of waiting.\n\nNothing was restarted: the gateway keeps running as it was. The key change is used after the next restart of the gateway.", title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                case IdleStop.Outcome.Cancelled:
                    if (gone)
                    {
                        // It stopped in the very moment Cancel was pressed.
                        gateway = null;
                        inFlight = 0;
                        AppendLog("Restart: the gateway had already stopped when the wait was cancelled. Starting it again.");
                        StartGateway();
                        return;
                    }
                    StartAgainIfItStops(asked);
                    AppendLog("Restart cancelled: the gateway keeps running. The key change is used after the next restart.");
                    return;
                default:
                    if (gone)
                    {
                        gateway = null;
                        inFlight = 0;
                        AppendLog("Restart: the gateway has stopped (" + result.Message + "). Starting it again.");
                        StartGateway();
                        return;
                    }
                    // The gateway could not be asked to wait (an older gateway, for
                    // one). What is left is the restart that cuts, and that is asked for.
                    StartAgainIfItStops(asked);
                    AppendLog("Restart: the gateway could not be asked to stop at an idle moment: " + result.Message);
                    var unanswered = Unanswered;
                    var cut = (inFlight <= 0 && !unanswered) || Msg.Show(this, "The gateway could not be asked to wait for an idle moment:\n" + result.Message + "\n\n" + (unanswered ? InFlight.UnansweredRestartQuestion(inFlight) : InFlight.RestartQuestion(inFlight)), title, MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.Yes;
                    // While the question was open the gateway was stopped from the
                    // tray, or ended and was started again: there is nothing to do.
                    if (quitting || gateway != asked) return;
                    if (!cut)
                    {
                        AppendLog("Restart: not restarted. The key change is used after the next restart.");
                        return;
                    }
                    StopGateway();
                    StartGateway();
                    return;
            }
        }

        // The watch for a gateway that was asked to stop when idle, was left
        // running, and may stop after all. Each watch has its own token; Stop,
        // Quit and a start from here end the watch by taking the token away.
        private object lateStopWatch;
        private const int LateStopSeconds = 30;

        // A gateway asked to stop at an idle moment can have begun to stop when
        // the answer here was "not stopped": the wait was cancelled in that very
        // moment, the answer did not arrive, or the command was ended. If its
        // process ends within half a minute it is started again, once.
        private void StartAgainIfItStops(Process asked)
        {
            if (quitting || gateway != asked) return;
            var token = new object();
            lateStopWatch = token;
            var origin = lastOrigin;
            // The watch waits on a process object of its own, so the one this
            // window uses is touched by this thread only.
            Process watched = null;
            try { watched = Process.GetProcessById(asked.Id); }
            // Already gone: the watch reports at once.
            catch (ArgumentException) { }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
            var watch = new Thread(() =>
            {
                // No process to wait for: it was gone already.
                var ended = watched == null;
                try
                {
                    if (watched != null) ended = watched.WaitForExit(LateStopSeconds * 1000);
                }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception) { }
                finally { if (watched != null) watched.Dispose(); }
                // Whether another gateway has the address by now is asked
                // here, when a start may follow: the question takes up to a
                // second and a half, in which the window would not answer.
                bool? answers = null;
                if (ended)
                {
                    try { answers = GatewayAnswers(origin); }
                    // Not an address: left to the start, which asks on the window's thread as before.
                    catch (UriFormatException) { }
                    catch (NotSupportedException) { }
                }
                try { BeginInvoke(new Action(() => LateStopSeen(token, asked, origin, answers))); }
                catch (InvalidOperationException) { }
            });
            watch.IsBackground = true;
            watch.Start();
        }

        // On the window's thread, when the gateway's process ended or the half
        // minute is over.
        // `answers`: what the watch was answered at `origin`, null when it did not ask.
        private void LateStopSeen(object token, Process asked, string origin, bool? answers)
        {
            // Stop, Quit, a start from here or a newer watch came first.
            if (lateStopWatch != token) return;
            lateStopWatch = null;
            if (quitting || gateway != asked) return;
            bool ended;
            try { ended = asked.HasExited; }
            catch (InvalidOperationException) { ended = false; }
            catch (System.ComponentModel.Win32Exception) { ended = false; }
            if (!ended) return;
            gateway = null;
            // Not when another gateway answers at the address by now: the start
            // says so. What the watch was answered counts only for the address
            // the gateway still has; otherwise the start asks here.
            if (StartGatewayKnowing(origin == lastOrigin ? answers : null)) AppendLog("The gateway had already begun to stop; it was started again.");
        }

        // ---------- stopping with requests in flight ----------

        // The model requests in flight when the status was last read; 0 when
        // the gateway did not say (not running, or an older gateway).
        private int inFlight;
        private bool confirmingCut;

        // Stop and Quit ask first when the gateway this window started was
        // serving requests at the last status read. No is the default.
        private bool ConfirmCut(bool quitting)
        {
            if (ReadOnly || gateway == null || gateway.HasExited) return true;
            // A gateway that did not answer the last check may be serving
            // requests all the same: that is asked about too.
            var unanswered = Unanswered;
            if (inFlight <= 0 && !unanswered) return true;
            // The tray menu still works while the question is open: a second
            // Stop or Quit then does nothing rather than ask again on top.
            if (confirmingCut) return false;
            confirmingCut = true;
            try { return Msg.Show(Visible ? this : null, unanswered ? InFlight.UnansweredQuestion(inFlight, quitting) : InFlight.Question(inFlight, quitting), quitting ? "Quit DeepSeekProxy" : "Stop gateway", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.Yes; }
            finally { confirmingCut = false; }
        }

        private void StopRequested()
        {
            if (ConfirmCut(false)) StopGateway();
        }

        // ---------- other actions ----------

        private void AddKey()
        {
            var provider = keyProviderCombo.SelectedItem as Choice;
            var region = keyRegionCombo.SelectedItem as Choice;
            if (provider == null) return;
            var key = KeyDialog.Ask(this, provider.Label);
            if (string.IsNullOrEmpty(key)) return;
            var args = region == null ? new[] { "key", "set", provider.Key } : new[] { "key", "set", provider.Key, region.Key };
            RunInBackground(args, key + "\n", "API key", true);
        }

        private void RemoveKey()
        {
            if (keysList.SelectedItems.Count == 0) return;
            var key = keysList.SelectedItems[0].Tag as string;
            if (key == null) return;
            if (Msg.Show(this, "Remove the saved " + keysList.SelectedItems[0].Text + " key?", "API key", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
            RunInBackground(new[] { "key", "remove", key }, null, "API key", true);
        }

        // ---------- first-time setup ----------
        //
        // Apply to DeepSeek Harness reads what is in place (`dshproxy dsh
        // bundle status --json`), says so in a checklist, writes the chat
        // routes (`dsh apply`, as it always did) and then has the command
        // line install the video tools (`dsh bundle install --json`), once
        // the person has quit DeepSeek Harness when it is open. This program
        // never closes, ends or starts DeepSeek Harness, and never writes into
        // one of its profiles itself. Every command runs off the UI thread.

        private const int VideoHarnessPage = 4;
        private readonly Label videoHarnessStatus = new GlassLabel { ForeColor = Theme.Muted, UseMnemonic = false };
        private ListViewItem videoHarnessTools;
        // What the command line last said about DeepSeek Harness and the
        // video tools; null until it has answered.
        private HarnessSetup harnessSetup;
        private bool readingSetup;
        // Apply finished while a read was out: what is true now is read after it.
        private bool setupWanted;
        // An Apply is under way: a second press does nothing.
        private bool applying;
        // Stands in for the command line in the layout check, which runs no
        // command and touches no profile. Null everywhere else.
        private Func<string[], Cli.Result> setupRun;

        internal void UseSetupCommands(Func<string[], Cli.Result> run)
        {
            setupRun = run;
        }

        // A preview window runs none of the setup commands.
        private bool SetupSynthetic
        {
            get { return VideoSynthetic && setupRun == null; }
        }

        // Runs one command of the setup off the UI thread and reports back on it.
        private void SetupCommand(string[] args, int timeoutMs, Action<Cli.Result> done)
        {
            var alreadyWaiting = UseWaitCursor;
            UseWaitCursor = true;
            var run = setupRun;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Cli.Result result;
                try { result = run != null ? run(args) : cli.Run(args, null, timeoutMs); }
                catch (Exception error) { result = new Cli.Result { Code = -1, Out = "", Err = error.Message }; }
                try
                {
                    BeginInvoke(new Action(() =>
                    {
                        if (!alreadyWaiting) UseWaitCursor = false;
                        done(result);
                    }));
                }
                // The window has gone: there is nothing left to report to.
                catch (InvalidOperationException) { }
            });
        }

        // Reads whether the video tools are installed in DeepSeek Harness:
        // when the DeepSeek Harness page of the Video workspace comes on
        // screen, and after an Apply.
        private void ReadHarnessSetup()
        {
            if (SetupSynthetic)
            {
                // A preview window looks at nothing real.
                if (harnessSetup == null && videoHarnessTools != null)
                {
                    videoHarnessTools.SubItems[1].Text = "Sample only \u00B7 not checked";
                    videoHarnessTools.ForeColor = Theme.Muted;
                    SetPageStatus(videoHarnessStatus, "This preview window does not look at DeepSeek Harness.", Theme.Accent);
                }
                return;
            }
            if (readingSetup)
            {
                setupWanted = true;
                return;
            }
            readingSetup = true;
            setupWanted = false;
            if (harnessSetup == null && videoHarnessTools != null)
            {
                videoHarnessTools.SubItems[1].Text = "Reading...";
                SetPageStatus(videoHarnessStatus, "Reading whether the video tools are installed in DeepSeek Harness...", Theme.Muted);
            }
            SetupCommand(HarnessSetup.StatusCommand(), 30000, result =>
            {
                readingSetup = false;
                ShowHarnessSetup(HarnessSetup.Read(result), ClockNow());
                if (setupWanted) ReadHarnessSetup();
            });
        }

        // Puts what was read on the DeepSeek Harness page of the Video workspace.
        private void ShowHarnessSetup(HarnessSetup state, string readAt)
        {
            var unreadBefore = harnessSetup != null && harnessSetup.State == HarnessSetup.Kind.Unreadable;
            harnessSetup = state;
            if (videoHarnessTools == null) return;
            var cell = state.RowText();
            if (videoHarnessTools.SubItems[1].Text != cell) videoHarnessTools.SubItems[1].Text = cell;
            if (videoHarnessTools.ForeColor != state.RowColor()) videoHarnessTools.ForeColor = state.RowColor();
            // A folder name at the end of the line is left as it is; any other line keeps its last two words together.
            var line = "Checked at " + readAt + ". " + state.PageLine();
            SetPageStatus(videoHarnessStatus, line.EndsWith(".", StringComparison.Ordinal) ? Tied(line) : line, state.RowColor());
            // Said in the log once, not every time the page is opened.
            if (state.State == HarnessSetup.Kind.Unreadable && !unreadBefore) AppendLog("Video: could not read whether the video tools are installed in DeepSeek Harness: " + state.Reason);
        }

        private void ApplyToHarness()
        {
            if (applying) return;
            applying = true;
            if (SetupSynthetic)
            {
                // A preview window shows the question with a sample and does nothing.
                ApplyStep(() =>
                {
                    if (SetupDialog.Confirm(this, HarnessSetup.Parse(HarnessSetup.Sample))) Msg.Show(this, "Sample only: this is a preview window. Nothing was read, written or installed.", SetupDialog.Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return false;
                });
                return;
            }
            SetupCommand(HarnessSetup.StatusCommand(), 30000, read => ApplyStep(() => ApplyConfirmed(HarnessSetup.Read(read))));
        }

        // One step of an Apply, on the window's thread. A step that has
        // handed over to a command returns true: the Apply is still under way.
        private void ApplyStep(Func<bool> step)
        {
            var goesOn = false;
            try { goesOn = step(); }
            finally { if (!goesOn) applying = false; }
        }

        // The checklist. Cancel changes nothing: no command has written anything yet.
        private bool ApplyConfirmed(HarnessSetup state)
        {
            ShowHarnessSetup(state, ClockNow());
            if (!SetupDialog.Confirm(this, state) || quitting) return false;
            SetupCommand(new[] { "dsh", "apply" }, 120000, applied => ApplyStep(() => ApplyWritten(state, applied)));
            return true;
        }

        // The chat routes are written, or were not. Then the video tools,
        // when the checklist said they would be installed.
        private bool ApplyWritten(HarnessSetup state, Cli.Result applied)
        {
            var text = (applied.Out + Environment.NewLine + applied.Err).Trim();
            AppendLog(text);
            if (setupRun == null) RefreshStatus();
            if (applied.Code != 0)
            {
                Msg.Show(this, text.Length > 0 ? text : "The chat routes were not written: the DSHProxy command ended with code " + applied.Code.ToString(CultureInfo.InvariantCulture) + ".", SetupDialog.Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }
            if (!state.WillInstall)
            {
                ShowApplyResult(state.Summary(text, HarnessSetup.Outcome.NothingToInstall, null, VideoToolsFolder(state)));
                return false;
            }
            if (HarnessSetup.Running())
            {
                bool gone;
                using (var wait = new HarnessWaitDialog(HarnessSetup.Running))
                {
                    wait.ShowDialog(this);
                    gone = wait.HarnessGone;
                }
                if (quitting) return false;
                if (!gone)
                {
                    AppendLog("Video tools: not installed. The step was skipped while DeepSeek Harness was open.");
                    ShowApplyResult(state.Summary(text, HarnessSetup.Outcome.Skipped, null, VideoToolsFolder(state)));
                    return false;
                }
            }
            SetupCommand(HarnessSetup.InstallCommand(), 180000, installed => ApplyStep(() =>
            {
                var answer = HarnessSetup.ReadInstall(installed);
                AppendLog("Video tools: " + (answer.Ok ? "installed in DeepSeek Harness." : "not installed.") + (answer.Message.Length > 0 ? " " + answer.Message : ""));
                ShowApplyResult(state.Summary(text, answer.Ok ? HarnessSetup.Outcome.Installed : HarnessSetup.Outcome.Failed, answer, VideoToolsFolder(state)));
                return false;
            }));
            return true;
        }

        // The folder to choose in DeepSeek Harness when the video tools are
        // installed by hand: the one the command line named, else this program's own.
        private string VideoToolsFolder(HarnessSetup state)
        {
            return state.Folder.Length > 0 ? state.Folder : Path.Combine(cli.Root, VideoBundleFolder);
        }

        private void ShowApplyResult(HarnessSetup.Result result)
        {
            // The page shows what is true now, not what was true before.
            ReadHarnessSetup();
            SetupDialog.Show(this, result);
        }

        // Reads the profiles back and shows whether DeepSeek Harness has every
        // route it needs: routes, models, image caps, default model, credential.
        private void VerifyHarness()
        {
            UseWaitCursor = true;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Cli.Result result;
                try { result = cli.Run(new[] { "dsh", "verify" }, null, 120000); }
                catch (Exception error) { result = new Cli.Result { Code = -1, Out = "", Err = error.Message }; }
                BeginInvoke(new Action(() =>
                {
                    UseWaitCursor = false;
                    var text = (result.Out + Environment.NewLine + result.Err).Trim();
                    AppendLog(text);
                    RefreshStatus();
                    Msg.Show(this, text, "Verify DeepSeek Harness", MessageBoxButtons.OK, result.Code == 0 ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
                }));
            });
        }

        private void RemoveFromHarness()
        {
            if (Msg.Show(this, "Remove the DSHProxy routes from every DeepSeek Harness profile?", "DeepSeek Harness", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
            RunAndShow(new[] { "dsh", "remove" }, "DeepSeek Harness", false);
        }

        private void RunAndShow(string[] args, string title, bool restartHint)
        {
            RunInBackground(args, null, title, restartHint);
        }

        private void RunInBackground(string[] args, string input, string title, bool restartHint)
        {
            UseWaitCursor = true;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Cli.Result result;
                try { result = cli.Run(args, input, 120000); }
                catch (Exception error) { result = new Cli.Result { Code = -1, Out = "", Err = error.Message }; }
                BeginInvoke(new Action(() =>
                {
                    UseWaitCursor = false;
                    var text = (result.Out + Environment.NewLine + result.Err).Trim();
                    AppendLog(text);
                    if (result.Code == 0 && restartHint && gateway != null && !gateway.HasExited)
                    {
                        var busy = inFlight <= 0 ? "" : "\n\n" + (inFlight == 1 ? "1 request is" : inFlight.ToString(CultureInfo.InvariantCulture) + " requests are") + " in flight: the restart waits for a moment with none, at most 5 minutes, and cuts nothing.";
                        if (Msg.Show(this, text + "\n\nRestart the gateway now so it uses the change?" + busy, title, MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes) RestartForChange(title);
                    }
                    else
                    {
                        Msg.Show(this, text.Length > 0 ? text : "Done.", title, MessageBoxButtons.OK, result.Code == 0 ? MessageBoxIcon.Information : MessageBoxIcon.Error);
                    }
                    RefreshStatus();
                }));
            });
        }

        private void OpenFolder(string sub)
        {
            var home = GatewayControl.Home();
            var folder = sub.Length > 0 ? Path.Combine(home, sub) : home;
            if (!Directory.Exists(folder)) folder = home;
            if (Directory.Exists(folder)) Process.Start("explorer.exe", "\"" + folder + "\"");
        }

        private void EditSettings()
        {
            var file = Path.Combine(GatewayControl.Home(), "settings.json");
            if (!File.Exists(file))
            {
                Msg.Show(this, "settings.json is created the first time a setting is saved, for example when you add an API key. Until then the default lanes are used.", "Lanes", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            Process.Start("notepad.exe", "\"" + file + "\"");
        }
    }

    internal sealed class Choice
    {
        public readonly string Key;
        public readonly string Label;

        public Choice(string key, string label)
        {
            Key = key;
            Label = label;
        }

        public override string ToString()
        {
            return Label;
        }
    }

    // The desktop side of the video settings seam. The command line owns the
    // video settings and where they are kept; the app keeps none of its own. It
    // runs two commands and shows the JSON that either one prints:
    //
    //   dshproxy video settings                                     read
    //   dshproxy video settings set MODEL ROUTE enabled|disabled    write
    //   dshproxy video settings set MODEL none disabled             switch off, no route
    //
    //   {"models":[{"model":"...","enabled":false,"route":null,"routes":["..."]}]}
    //
    // `routes` are the billing routes DSHProxy allows for that model; `route`
    // is the one saved, or null when none is.
    internal static class VideoSettings
    {
        public sealed class Model
        {
            public string Id;
            public bool Enabled;
            // "" when no route is saved.
            public string Route;
            public List<string> Routes;

            // A saved route counts only if DSHProxy allows it for this model.
            public bool HasRoute
            {
                get { return Route.Length > 0 && Routes.Contains(Route); }
            }
        }

        public static string[] ReadCommand()
        {
            return new[] { "video", "settings" };
        }

        // Stands in for "no route" on the command line. It only ever switches a
        // model off: `set MODEL none disabled`. It is not a billing route, is
        // never offered as one, and can never be sent with `enabled`.
        public const string NoRoute = "none";

        public static string[] SetCommand(string model, string route, bool enabled)
        {
            if (!IsName(model) || !IsName(route)) throw new ArgumentException("Not a video model or route name.");
            if (enabled && route == NoRoute) throw new ArgumentException("A video model cannot be enabled without a billing route.");
            return new[] { "video", "settings", "set", model, route, enabled ? "enabled" : "disabled" };
        }

        // Switches off a model that has no usable route saved, leaving it with none.
        public static string[] DisableCommand(string model)
        {
            return SetCommand(model, NoRoute, false);
        }

        // Model and route names go on a command line, so they are plain
        // tokens: letters, digits, dot, dash and underscore, never an option.
        public static bool IsName(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 64) return false;
            for (var i = 0; i < value.Length; i++)
            {
                var c = value[i];
                var alnum = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
                if (!alnum && (i == 0 || (c != '.' && c != '-' && c != '_'))) return false;
            }
            return true;
        }

        // Reads the JSON either command prints. Anything that is not the
        // agreed shape is refused as a whole rather than half shown.
        public static List<Model> Parse(string json)
        {
            object parsed;
            try { parsed = Json.Serializer.DeserializeObject(json ?? ""); }
            catch (ArgumentException) { throw new FormatException("DSHProxy did not answer with JSON."); }
            catch (InvalidOperationException) { throw new FormatException("DSHProxy did not answer with JSON."); }
            var root = parsed as Dictionary<string, object>;
            var list = root == null ? null : Json.Get(root, "models");
            if (!(list is object[]) && !(list is ArrayList)) throw new FormatException("The answer has no list of video models.");
            var models = new List<Model>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in Json.Arr(list))
            {
                var entry = item as Dictionary<string, object>;
                var id = entry == null ? null : Json.Get(entry, "model") as string;
                if (!IsName(id) || !seen.Add(id)) throw new FormatException("The answer lists a video model without a usable, unique name.");
                var model = new Model { Id = id, Enabled = Json.Bool(entry, "enabled"), Routes = new List<string>() };
                foreach (var route in Json.Arr(Json.Get(entry, "routes")))
                {
                    var name = route as string;
                    // "none" is the stand-in for no route, never a route to choose.
                    if (IsName(name) && name != NoRoute && !model.Routes.Contains(name)) model.Routes.Add(name);
                }
                model.Route = Json.Str(Json.Get(entry, "route"));
                if (model.Route == NoRoute) model.Route = "";
                models.Add(model);
            }
            return models;
        }

        // The models a finished command reported, or null and why not.
        public static List<Model> Read(Cli.Result result, out string failure)
        {
            failure = null;
            if (result.Code != 0)
            {
                failure = Failure(result);
                return null;
            }
            try { return Parse(result.Out); }
            catch (FormatException error)
            {
                failure = error.Message;
                return null;
            }
        }

        // One line saying why a command failed.
        public static string Failure(Cli.Result result)
        {
            var text = (result.Err ?? "").Trim();
            if (text.Length == 0) return "The DSHProxy command ended with code " + result.Code.ToString(CultureInfo.InvariantCulture) + ".";
            var line = text.Split('\n')[0].Trim();
            if (line.StartsWith("DSHProxy: ", StringComparison.Ordinal)) line = line.Substring(10);
            return line.Length > 200 ? line.Substring(0, 199) + "\u2026" : line;
        }

        public static string RouteLabel(string route)
        {
            switch (route)
            {
                case "krea": return "Krea workspace";
                case "videorouter": return "VideoRouter";
                case "videorouter-replicate": return "VideoRouter (Replicate)";
                case "kovapi": return "KovAPI";
                case "callirra": return "Callirra";
                default: return route;
            }
        }

        // The label of a route with its exact name, which is what is saved.
        public static string RouteName(string route)
        {
            var label = RouteLabel(route);
            return label == route ? route : label + " \u00B7 " + route;
        }

        // The logos Company can name.
        public static readonly string[] CompanyLogos = { "alibaba", "minimax", "bytedance" };

        // The company behind a model, and the name of its logo in app/logos.
        // The logo is the mark of the company, not a mark of the model. Both
        // are "" for a model this app does not know, which is then shown in
        // text alone.
        public static string Company(string model, out string logo)
        {
            logo = "";
            if (model == "wan-3.0") { logo = "alibaba"; return "Alibaba"; }
            if (model == "minimax-h3") { logo = "minimax"; return "MiniMax"; }
            if (model.StartsWith("seedance-", StringComparison.Ordinal)) { logo = "bytedance"; return "ByteDance"; }
            return "";
        }

        // What a route bills in. The app never converts between them.
        public static string Units(string route)
        {
            switch (route)
            {
                case "krea": return "workspace compute units";
                case "callirra": return "plan credits";
                case "videorouter":
                case "videorouter-replicate":
                case "kovapi": return "US dollars";
                default: return "units not known to this app";
            }
        }

        // Made-up settings for a preview window, in the shape the command
        // line prints. Never read from, or written to, a real configuration.
        // One model is enabled without a route, so that state can be looked at too.
        public const string Sample = "{\"models\":["
            + "{\"model\":\"wan-3.0\",\"enabled\":true,\"route\":\"krea\",\"routes\":[\"videorouter\",\"videorouter-replicate\",\"kovapi\",\"krea\"]},"
            + "{\"model\":\"minimax-h3\",\"enabled\":true,\"route\":\"callirra\",\"routes\":[\"kovapi\",\"callirra\",\"krea\"]},"
            + "{\"model\":\"seedance-2.0\",\"enabled\":true,\"route\":null,\"routes\":[\"videorouter\",\"kovapi\",\"krea\"]},"
            + "{\"model\":\"seedance-2.5\",\"enabled\":false,\"route\":null,\"routes\":[\"videorouter\",\"kovapi\",\"krea\"]}]}";
    }

    // The saved API keys of the pay-per-use video providers, as `dshproxy
    // video key` reports and changes them. This program never sees a saved
    // key: `list` says only whether one is saved, and a new key is handed to
    // `set` on standard input and to nothing else.
    internal static class VideoKeys
    {
        public sealed class Provider
        {
            public string Id;
            public string Label;
            public string Variable;
            public List<string> Routes;
            public bool Saved;
            // False for a saved key that cannot be decrypted.
            public bool Readable;
            public bool InEnvironment;
        }

        public const int MaxLength = 512;

        public static string[] ListCommand()
        {
            return new[] { "video", "key", "list" };
        }

        // The provider is all that goes on the command line, and only as a
        // plain name. The key never does.
        public static string[] SetCommand(string provider)
        {
            if (!VideoSettings.IsName(provider)) throw new ArgumentException("Not a video key provider name.");
            return new[] { "video", "key", "set", provider };
        }

        public static string[] RemoveCommand(string provider)
        {
            if (!VideoSettings.IsName(provider)) throw new ArgumentException("Not a video key provider name.");
            return new[] { "video", "key", "remove", provider };
        }

        // Why a key is not sent to the command line at all, or null when it
        // can be. The rule and the sentences are the command line's own
        // (printable ASCII, at most 512 characters). It is checked here first
        // because the pipe to the command is not UTF-8: a character outside
        // the rule can arrive as another one, and a different key would be saved.
        public static string Refusal(string key)
        {
            if (string.IsNullOrEmpty(key)) return "No video API key was given. Nothing was saved.";
            if (key.Length > MaxLength) return "A video API key can be at most 512 characters. Nothing was saved.";
            foreach (var c in key)
            {
                if (c < 0x21 || c > 0x7E) return "A video API key cannot contain spaces, line breaks or anything else outside printable ASCII. Nothing was saved.";
            }
            return null;
        }

        private static Dictionary<string, object> Root(string json)
        {
            object parsed;
            try { parsed = Json.Serializer.DeserializeObject(json ?? ""); }
            catch (ArgumentException) { throw new FormatException("DSHProxy did not answer with JSON."); }
            catch (InvalidOperationException) { throw new FormatException("DSHProxy did not answer with JSON."); }
            var root = parsed as Dictionary<string, object>;
            if (root == null) throw new FormatException("DSHProxy did not answer with a JSON object.");
            return root;
        }

        // A provider's name as shown: short, printable ASCII.
        private static bool IsLabel(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 40 || value.Trim() != value) return false;
            foreach (var c in value) if (c < 0x20 || c > 0x7E) return false;
            return true;
        }

        // An environment variable name: capitals, digits and underscores.
        private static bool IsVariable(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 64) return false;
            for (var i = 0; i < value.Length; i++)
            {
                var c = value[i];
                if (!((c >= 'A' && c <= 'Z') || (i > 0 && ((c >= '0' && c <= '9') || c == '_')))) return false;
            }
            return true;
        }

        // Reads what `video key list` prints. Anything that is not the agreed
        // shape is refused as a whole: a state is shown as reported or not at all.
        public static List<Provider> Parse(string json)
        {
            var list = Json.Get(Root(json), "providers");
            if (!(list is object[]) && !(list is ArrayList)) throw new FormatException("The answer has no list of video key providers.");
            var providers = new List<Provider>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in Json.Arr(list))
            {
                var entry = item as Dictionary<string, object>;
                var id = entry == null ? null : Json.Get(entry, "provider") as string;
                if (!VideoSettings.IsName(id) || !seen.Add(id)) throw new FormatException("The answer lists a video key provider without a usable, unique name.");
                var label = Json.Get(entry, "label") as string;
                var variable = Json.Get(entry, "variable") as string;
                if (!IsLabel(label) || !IsVariable(variable)) throw new FormatException("The answer names a video key provider or its variable in a form this app does not show.");
                if (!(Json.Get(entry, "saved") is bool) || !(Json.Get(entry, "readable") is bool) || !(Json.Get(entry, "inEnvironment") is bool)) throw new FormatException("The answer does not say whether each video key is saved.");
                var provider = new Provider { Id = id, Label = label, Variable = variable, Routes = new List<string>(), Saved = Json.Bool(entry, "saved"), InEnvironment = Json.Bool(entry, "inEnvironment") };
                provider.Readable = provider.Saved && Json.Bool(entry, "readable");
                foreach (var route in Json.Arr(Json.Get(entry, "routes")))
                {
                    var name = route as string;
                    if (VideoSettings.IsName(name) && !provider.Routes.Contains(name)) provider.Routes.Add(name);
                }
                providers.Add(provider);
            }
            if (providers.Count == 0) throw new FormatException("The answer lists no video key provider.");
            return providers;
        }

        // The providers a finished `list` reported, or null and why not.
        public static List<Provider> Read(Cli.Result result, out string failure)
        {
            failure = null;
            if (result.Code != 0)
            {
                failure = VideoSettings.Failure(result);
                return null;
            }
            try { return Parse(result.Out); }
            catch (FormatException error)
            {
                failure = error.Message;
                return null;
            }
        }

        // Whether a finished `set` answered {"provider":P,"saved":true}.
        public static bool Saved(Cli.Result result, string provider)
        {
            if (result.Code != 0) return false;
            try
            {
                var root = Root(result.Out);
                return (Json.Get(root, "provider") as string) == provider && Json.Bool(root, "saved");
            }
            catch (FormatException) { return false; }
        }

        // What a finished `remove` answered: true when a key was removed,
        // false when none was saved, null when it did not answer as agreed.
        public static bool? Removed(Cli.Result result, string provider)
        {
            if (result.Code != 0) return null;
            try
            {
                var root = Root(result.Out);
                if ((Json.Get(root, "provider") as string) != provider || !(Json.Get(root, "saved") is bool) || Json.Bool(root, "saved") || !(Json.Get(root, "removed") is bool)) return null;
                return Json.Bool(root, "removed");
            }
            catch (FormatException) { return null; }
        }

        // No state says a key works: it is never checked against the provider.
        public static string State(Provider provider)
        {
            var text = !provider.Saved ? "Not saved" : provider.Readable ? "Saved" : "Saved, cannot be read: enter it again";
            return provider.InEnvironment ? text + " \u00B7 also set in the environment" : text;
        }

        public static string Units(Provider provider)
        {
            return VideoSettings.Units(provider.Routes.Count > 0 ? provider.Routes[0] : "");
        }

        // A sentence from the command line, for a status line or the log. The
        // command line never repeats a key; should it ever, the sentence is
        // dropped rather than shown.
        public static string Without(string text, string key)
        {
            if (string.IsNullOrEmpty(key) || (text ?? "").IndexOf(key, StringComparison.Ordinal) < 0) return text ?? "";
            return "DSHProxy refused, with a message that is not shown here because it repeats what was typed.";
        }

        // Made-up rows for a preview window, in the shape `video key list`
        // prints: one saved, one with the longest state there is, one not saved.
        // The rows read exactly as real ones do, so a preview shows whether
        // they fit; the line under the list says they are samples.
        public const string Sample = "{\"providers\":["
            + "{\"provider\":\"videorouter\",\"label\":\"VideoRouter\",\"variable\":\"VIDEOROUTER_API_KEY\",\"routes\":[\"videorouter\",\"videorouter-replicate\"],\"saved\":true,\"readable\":true,\"inEnvironment\":false},"
            + "{\"provider\":\"kovapi\",\"label\":\"KovAPI\",\"variable\":\"KOVAPI_API_KEY\",\"routes\":[\"kovapi\"],\"saved\":true,\"readable\":false,\"inEnvironment\":true},"
            + "{\"provider\":\"callirra\",\"label\":\"Callirra\",\"variable\":\"CALLIRRA_API_KEY\",\"routes\":[\"callirra\"],\"saved\":false,\"readable\":false,\"inEnvironment\":false}]}";
    }

    // What the command line says about DeepSeek Harness and the video tools,
    // the plugin in integrations\dsh-video. This program looks at no profile
    // and installs nothing itself; it runs two commands and reads the one
    // JSON line each prints:
    //
    //   dshproxy dsh bundle status --json     looks, changes nothing
    //   dshproxy dsh bundle install --json    has DeepSeek Harness's own command install the plugin
    //
    //   {"harness":"found"|"not-found","harnessRunning":true,"profile":"desktop","profileExists":true,
    //    "bundle":"installed"|"switched-off"|"other-folder"|"folder-missing"|"not-installed",
    //    "folder":"...","linkedTo":"..."|null,"version":"0.1.0"|null,"canInstall":true,"canInstallAfterQuit":false,"reason":"..."}
    //   {"ok":true,"bundle":"installed","message":"...","log":"..."|null}
    //
    // A line that is not that shape, and a command that fails, are a state
    // of their own, "could not be read": nothing here throws on a bad line.
    // The sentences the app shows about the video tools are all here, so the
    // checklist, the result and the page say the same thing in the same words.
    internal sealed class HarnessSetup
    {
        public enum Kind { Installed, SwitchedOff, OtherFolder, FolderMissing, NotInstalled, NeverOpened, NotFound, Unreadable }

        // What an Apply does about the video tools.
        public enum Plan { Nothing, Install, InstallAfterQuit, Cannot, Unknown }

        // What an Apply did about them.
        public enum Outcome { NothingToInstall, Installed, Failed, Skipped }

        public Kind State;
        public bool HarnessFound;
        public bool ProfileExists;
        public bool HarnessRunning;
        public bool CanInstall;
        // Nothing but a running DeepSeek Harness is in the way.
        public bool CanInstallAfterQuit;
        // This DSHProxy's folder of the video tools; "" when not said.
        public string Folder = "";
        // The folder the profile points at; "" when none.
        public string LinkedTo = "";
        public string Version = "";
        // One sentence from the command line: why the tools cannot be
        // installed, or why nothing could be read.
        public string Reason = "";

        public static string[] StatusCommand()
        {
            return new[] { "dsh", "bundle", "status", "--json" };
        }

        public static string[] InstallCommand()
        {
            return new[] { "dsh", "bundle", "install", "--json" };
        }

        // Whether a DeepSeek Harness process is left. A process list that
        // cannot be read counts as one. Only ever looked at: this program
        // closes and ends no process of DeepSeek Harness.
        public static bool ProcessLeft()
        {
            try
            {
                var found = Process.GetProcessesByName("DeepSeek Harness");
                foreach (var process in found) process.Dispose();
                return found.Length > 0;
            }
            catch (InvalidOperationException) { return true; }
            catch (System.ComponentModel.Win32Exception) { return true; }
            catch (NotSupportedException) { return true; }
        }

        // The layout check puts its own answer here, so no process list is read.
        public static Func<bool> Running = ProcessLeft;

        // What the command line says is shown as text: no control characters, and not without end.
        private static string Clean(object value, int max)
        {
            var text = value as string;
            if (text == null) return "";
            var clean = new StringBuilder(text.Length);
            foreach (var c in text) clean.Append(c < 0x20 || c == 0x7F ? ' ' : c);
            var result = clean.ToString().Trim();
            return result.Length > max ? result.Substring(0, max - 1) + "\u2026" : result;
        }

        // The JSON object on the last line that has anything on it, or null.
        private static Dictionary<string, object> LastLine(string output)
        {
            var lines = (output ?? "").Replace("\r", "").Split('\n');
            for (var i = lines.Length - 1; i >= 0; i--)
            {
                var line = lines[i].Trim();
                if (line.Length == 0) continue;
                if (line.Length > 16384) return null;
                try { return Json.Serializer.DeserializeObject(line) as Dictionary<string, object>; }
                catch (ArgumentException) { return null; }
                catch (InvalidOperationException) { return null; }
            }
            return null;
        }

        public static HarnessSetup Unread(string why)
        {
            return new HarnessSetup { State = Kind.Unreadable, Reason = Clean(why, 300) };
        }

        // Reads the line `dsh bundle status --json` prints. Never throws.
        public static HarnessSetup Parse(string output)
        {
            if ((output ?? "").Trim().Length == 0) return Unread("DSHProxy gave no answer.");
            var root = LastLine(output);
            const string odd = "DSHProxy did not answer as expected.";
            if (root == null) return Unread(odd);
            var harness = Json.Get(root, "harness") as string;
            if (harness != "found" && harness != "not-found") return Unread(odd);
            if (!(Json.Get(root, "harnessRunning") is bool) || !(Json.Get(root, "profileExists") is bool) || !(Json.Get(root, "canInstall") is bool) || !(Json.Get(root, "canInstallAfterQuit") is bool)) return Unread(odd);
            var read = new HarnessSetup
            {
                HarnessFound = harness == "found",
                ProfileExists = Json.Bool(root, "profileExists"),
                HarnessRunning = Json.Bool(root, "harnessRunning"),
                CanInstall = Json.Bool(root, "canInstall"),
                CanInstallAfterQuit = Json.Bool(root, "canInstallAfterQuit"),
                Folder = Clean(Json.Get(root, "folder"), 400),
                LinkedTo = Clean(Json.Get(root, "linkedTo"), 400),
                Version = Clean(Json.Get(root, "version"), 24),
                Reason = Clean(Json.Get(root, "reason"), 300)
            };
            Kind bundle;
            switch (Json.Get(root, "bundle") as string)
            {
                case "installed": bundle = Kind.Installed; break;
                case "switched-off": bundle = Kind.SwitchedOff; break;
                case "other-folder": bundle = Kind.OtherFolder; break;
                case "folder-missing": bundle = Kind.FolderMissing; break;
                case "not-installed": bundle = Kind.NotInstalled; break;
                default: return Unread(odd);
            }
            // A profile that has the tools says so, wherever the program is.
            if (read.ProfileExists && (bundle == Kind.Installed || bundle == Kind.SwitchedOff)) read.State = bundle;
            else if (!read.HarnessFound) read.State = Kind.NotFound;
            else if (!read.ProfileExists) read.State = Kind.NeverOpened;
            else read.State = bundle;
            return read;
        }

        // What a finished `dsh bundle status --json` said.
        public static HarnessSetup Read(Cli.Result result)
        {
            if (result == null) return Unread("DSHProxy gave no answer.");
            return result.Code != 0 ? Unread(VideoSettings.Failure(result)) : Parse(result.Out);
        }

        public sealed class Install
        {
            public bool Ok;
            // The command line's sentence: for a failure, the last line of DeepSeek Harness's command.
            public string Message = "";
            public string Log = "";
        }

        // What a finished `dsh bundle install --json` said. Installed only
        // when the command says so and ended with code 0. Never throws.
        public static Install ReadInstall(Cli.Result result)
        {
            if (result == null) return new Install { Message = "DSHProxy gave no answer." };
            var root = LastLine(result.Out);
            var ok = root == null ? null : Json.Get(root, "ok");
            if (!(ok is bool))
                return new Install { Message = result.Code != 0 ? VideoSettings.Failure(result) : "DSHProxy did not answer as expected, so it is not known whether the video tools were installed." };
            return new Install { Ok = (bool)ok && result.Code == 0, Message = Clean(Json.Get(root, "message"), 400), Log = Clean(Json.Get(root, "log"), 400) };
        }

        public Plan Planned
        {
            get
            {
                switch (State)
                {
                    case Kind.Installed:
                    case Kind.SwitchedOff: return Plan.Nothing;
                    case Kind.Unreadable: return Plan.Unknown;
                    case Kind.NeverOpened:
                    case Kind.NotFound: return Plan.Cannot;
                    default:
                        if (CanInstall) return Plan.Install;
                        // Open is the one obstacle the person can take away
                        // on the spot; the command line says when it is the only one.
                        return CanInstallAfterQuit ? Plan.InstallAfterQuit : Plan.Cannot;
                }
            }
        }

        public bool WillInstall
        {
            get { return Planned == Plan.Install || Planned == Plan.InstallAfterQuit; }
        }

        // ----- the row and the line on the Video > DeepSeek Harness page -----

        public string RowText()
        {
            switch (State)
            {
                case Kind.Installed: return "Yes \u00B7 switched on" + (Version.Length > 0 ? " \u00B7 version " + Version : "");
                case Kind.SwitchedOff: return "Yes \u00B7 switched off in DeepSeek Harness";
                case Kind.OtherFolder: return "Yes \u00B7 from another folder";
                case Kind.FolderMissing: return "Not working \u00B7 its folder is gone";
                case Kind.NotInstalled: return "No \u00B7 Apply to DeepSeek Harness installs them";
                case Kind.NeverOpened: return "No \u00B7 DeepSeek Harness has not been opened yet";
                case Kind.NotFound: return "No \u00B7 DeepSeek Harness was not found";
                default: return "Could not be read";
            }
        }

        public Color RowColor()
        {
            switch (State)
            {
                case Kind.Installed: return Theme.Ok;
                case Kind.FolderMissing:
                case Kind.Unreadable: return Theme.Bad;
                default: return Theme.Warn;
            }
        }

        private const string ApplyName = "Apply to DeepSeek Harness";

        public string PageLine()
        {
            switch (State)
            {
                case Kind.Installed: return "The video tools are installed and switched on in DeepSeek Harness.";
                case Kind.SwitchedOff: return "The video tools are installed, but switched off in DeepSeek Harness. " + ApplyName + " leaves them off: you can switch them on in DeepSeek Harness under Plugins.";
                case Kind.OtherFolder: return "DeepSeek Harness has the video tools from another folder. " + Repair() + (LinkedTo.Length > 0 ? " The other folder: " + LinkedTo : "");
                case Kind.FolderMissing: return "DeepSeek Harness has the video tools from a folder that is gone. Was the DSHProxy folder moved? " + Repair() + (LinkedTo.Length > 0 ? " The folder that is gone: " + LinkedTo : "");
                case Kind.NotInstalled: return "The video tools are not installed in DeepSeek Harness. " + Repair();
                case Kind.NeverOpened: return "DeepSeek Harness has not been opened yet, so the video tools cannot be installed. " + Remedy();
                case Kind.NotFound: return "DeepSeek Harness was not found on this computer, so the video tools cannot be installed.";
                default: return "Could not read whether the video tools are installed in DeepSeek Harness: " + Sentence(Reason);
            }
        }

        // What puts it right, for a state an Apply can put right.
        private string Repair()
        {
            var does = State == Kind.NotInstalled ? "installs them." : "points them at this DSHProxy folder.";
            if (Planned == Plan.Cannot) return ApplyName + " cannot do that from here: " + Sentence(Reason.Length > 0 ? Reason : "DSHProxy did not say why.");
            return ApplyName + ", at the top of the window, " + does;
        }

        private static string Sentence(string text)
        {
            return text.Length == 0 || text.EndsWith(".", StringComparison.Ordinal) || text.EndsWith("\u2026", StringComparison.Ordinal) ? text : text + ".";
        }

        // What the person does about a DeepSeek Harness that is missing or was never opened.
        private string Remedy()
        {
            if (State == Kind.NotFound) return "Install DeepSeek Harness, open it once and quit it, then press " + ApplyName + " again.";
            if (State == Kind.NeverOpened) return "Open DeepSeek Harness once, quit it, then press " + ApplyName + " again.";
            return "";
        }

        // ----- the checklist an Apply asks with -----

        public List<SetupLine> ConfirmLines()
        {
            var lines = new List<SetupLine>();
            if (State == Kind.Unreadable) lines.Add(new SetupLine(SetupMark.Note, "DeepSeek Harness could not be checked.", Sentence(Reason)));
            else if (!HarnessFound) lines.Add(new SetupLine(SetupMark.Cannot, "DeepSeek Harness was not found on this computer.", ""));
            else if (!ProfileExists) lines.Add(new SetupLine(SetupMark.Cannot, "DeepSeek Harness is installed, but has not been opened yet.", ""));
            else lines.Add(new SetupLine(SetupMark.Done, "DeepSeek Harness is installed and has been opened once.", ""));
            lines.Add(new SetupLine(SetupMark.ToDo, "The chat routes will be written into every DeepSeek Harness profile.", "Each profile is backed up first.\nNothing else in it is changed."));
            lines.Add(ToolsPlan());
            lines.Add(new SetupLine(SetupMark.ToDo, (Planned == Plan.InstallAfterQuit ? "Start DeepSeek Harness again afterwards." : "Restart DeepSeek Harness afterwards.") + " DSHProxy does not do that for you.", ""));
            return lines;
        }

        private SetupLine ToolsPlan()
        {
            var after = Planned == Plan.InstallAfterQuit;
            const string open = "DeepSeek Harness is open now.\nYou will be asked to quit it, and you can skip that step.";
            switch (Planned)
            {
                case Plan.Nothing:
                    if (State == Kind.Installed) return new SetupLine(SetupMark.Done, "The video tools are already installed.", "");
                    return new SetupLine(SetupMark.Done, "The video tools are installed, but switched off in DeepSeek Harness.", "They are left off.\nYou can switch them on in DeepSeek Harness under Plugins.");
                case Plan.Unknown:
                    return new SetupLine(SetupMark.Note, "The video tools could not be checked, so they are left as they are.", "");
                case Plan.Cannot:
                    var why = Reason.Length > 0 ? Sentence(Reason) : State == Kind.NotFound || State == Kind.NeverOpened ? "" : "DSHProxy did not say why.";
                    var remedy = Remedy();
                    return new SetupLine(SetupMark.Cannot, "The video tools cannot be installed.", why + (why.Length > 0 && remedy.Length > 0 ? "\n" : "") + remedy);
                default:
                    if (State == Kind.NotInstalled)
                        return new SetupLine(SetupMark.ToDo, after ? "The video tools will be installed after you quit DeepSeek Harness." : "The video tools will be installed in DeepSeek Harness.", after ? open : "");
                    var from = (State == Kind.FolderMissing ? "DeepSeek Harness has them from a folder that is gone:\n" : "DeepSeek Harness has them from another folder:\n") + LinkedTo;
                    return new SetupLine(SetupMark.ToDo, "The video tools will be pointed at this DSHProxy folder" + (after ? " after you quit DeepSeek Harness." : "."), from + (after ? "\n" + open : ""));
            }
        }

        // ----- what an Apply says when it has ended -----

        public sealed class Result
        {
            public string Heading;
            public List<SetupLine> Lines = new List<SetupLine>();
            // The folder a button copies, for installing by hand; null when there is nothing to copy.
            public string CopyPath;
        }

        // `applied`: what `dsh apply` printed. `install`: what the install
        // answered, when it was run. `folder`: this DSHProxy's video tools.
        public Result Summary(string applied, Outcome outcome, Install install, string folder)
        {
            var result = new Result();
            var said = Shown(applied);
            result.Lines.Add(new SetupLine(SetupMark.Done, said.Length > 0 ? "The chat routes were applied. DSHProxy reported:" : "The chat routes were applied.", said));
            const string restart = "If anything above was updated, restart DeepSeek Harness so it uses the change.";
            var byHand = false;
            if (outcome == Outcome.Installed)
            {
                result.Heading = "DeepSeek Harness is set up";
                result.Lines.Add(new SetupLine(SetupMark.Done, "The video tools are installed in DeepSeek Harness.", install == null ? "" : install.Message));
                result.Lines.Add(new SetupLine(SetupMark.ToDo, "Start DeepSeek Harness again.", ""));
            }
            else if (outcome == Outcome.Failed)
            {
                result.Heading = "The video tools were not installed";
                var detail = install == null ? "" : install.Message;
                if (install != null && install.Log.Length > 0) detail += (detail.Length > 0 ? "\n" : "") + "More is in this file:\n" + install.Log;
                result.Lines.Add(new SetupLine(SetupMark.Cannot, "The video tools were not installed.", detail));
                byHand = true;
            }
            else if (outcome == Outcome.Skipped)
            {
                result.Heading = "The video tools were not installed";
                result.Lines.Add(new SetupLine(SetupMark.Note, "The video tools were not installed, because you skipped that step.", ""));
                result.Lines.Add(new SetupLine(SetupMark.ToDo, "To install them, quit DeepSeek Harness and press " + ApplyName + " again.", ""));
                result.Lines.Add(new SetupLine(SetupMark.ToDo, restart, ""));
            }
            else if (Planned == Plan.Nothing && State == Kind.Installed)
            {
                result.Heading = "DeepSeek Harness is set up";
                result.Lines.Add(new SetupLine(SetupMark.Done, "The video tools were already installed. Nothing was changed for them.", ""));
                result.Lines.Add(new SetupLine(SetupMark.ToDo, restart, ""));
            }
            else if (Planned == Plan.Nothing)
            {
                result.Heading = "The video tools were left switched off";
                result.Lines.Add(new SetupLine(SetupMark.Note, "The video tools are installed, but switched off in DeepSeek Harness. They were left off.", "You can switch them on in DeepSeek Harness under Plugins."));
                result.Lines.Add(new SetupLine(SetupMark.ToDo, restart, ""));
            }
            else if (Planned == Plan.Unknown)
            {
                result.Heading = "The video tools were not checked";
                result.Lines.Add(new SetupLine(SetupMark.Note, "The video tools could not be checked. Nothing was installed.", Sentence(Reason)));
                result.Lines.Add(new SetupLine(SetupMark.ToDo, restart, ""));
                result.Lines.Add(new SetupLine(SetupMark.ToDo, "Press " + ApplyName + " again later to check the video tools.", ""));
            }
            else
            {
                result.Heading = "The video tools were not installed";
                var remedy = Remedy();
                result.Lines.Add(new SetupLine(SetupMark.Cannot, "The video tools were not installed.", Reason.Length > 0 ? Sentence(Reason) : State == Kind.NotFound ? "DeepSeek Harness was not found on this computer." : State == Kind.NeverOpened ? "DeepSeek Harness has not been opened yet." : "DSHProxy did not say why."));
                if (remedy.Length > 0)
                {
                    result.Lines.Add(new SetupLine(SetupMark.ToDo, remedy, ""));
                    result.Lines.Add(new SetupLine(SetupMark.ToDo, restart, ""));
                }
                else byHand = true;
            }
            if (byHand)
            {
                // DeepSeek Harness is closed here: an install was tried, or
                // could have been. Starting it also loads the chat routes.
                result.Lines.Add(new SetupLine(SetupMark.ToDo, "To install them by hand, start DeepSeek Harness, open Plugins > Add plugin and choose this folder:", folder ?? ""));
                result.CopyPath = string.IsNullOrEmpty(folder) ? null : folder;
            }
            return result;
        }

        // What `dsh apply` printed, as much of it as a dialog holds. All of it is in the log.
        private static string Shown(string applied)
        {
            var lines = new List<string>();
            foreach (var raw in (applied ?? "").Replace("\r", "").Split('\n'))
            {
                var line = Clean(raw, 200);
                if (line.Length > 0) lines.Add(line);
            }
            if (lines.Count > 10)
            {
                var more = lines.Count - 9;
                lines.RemoveRange(9, more);
                lines.Add("And " + more.ToString(CultureInfo.InvariantCulture) + " more lines, on the Log page.");
            }
            return string.Join("\n", lines.ToArray());
        }

        // A made-up answer for a preview window, in the shape the command
        // line prints: a first Apply, with DeepSeek Harness closed.
        public const string Sample = "{\"harness\":\"found\",\"harnessRunning\":false,\"profile\":\"desktop\",\"profileExists\":true,\"bundle\":\"not-installed\","
            + "\"folder\":\"C:\\\\Sample\\\\DSHProxy\\\\integrations\\\\dsh-video\",\"linkedTo\":null,\"version\":null,\"canInstall\":true,\"canInstallAfterQuit\":false,\"reason\":\"\"}";
    }

    // What this program knows of the Krea sign-in, all of it from the
    // separate helper (bin\dshproxy-krea.js): whether a sign-in is present and
    // until when, the consent address of a sign-in in progress, and how that
    // ended. The sign-in itself never reaches this program.
    internal static class Krea
    {
        public sealed class State
        {
            public bool SignedIn;
            // Local time. Only meaningful when signed in.
            public DateTime Until;
        }

        public static string[] StatusCommand() { return new[] { "status" }; }
        public static string[] LoginCommand() { return new[] { "login" }; }
        public static string[] LogoutCommand() { return new[] { "logout" }; }

        private static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        // Reads the one line `status` prints: {"signedIn":true,"expiresAt":<ms
        // since 1970>} or {"signedIn":false}. Null for anything else,
        // including a sign-in said to last until a time already past.
        public static State ParseStatus(string output, DateTime nowUtc)
        {
            var text = (output ?? "").Trim();
            if (text.Length == 0 || text.Length > 512 || text.IndexOf('\n') >= 0) return null;
            object parsed;
            try { parsed = Json.Serializer.DeserializeObject(text); }
            catch (ArgumentException) { return null; }
            catch (InvalidOperationException) { return null; }
            var root = parsed as Dictionary<string, object>;
            if (root == null) return null;
            var signedIn = Json.Get(root, "signedIn");
            if (!(signedIn is bool)) return null;
            if (!(bool)signedIn) return new State();
            var expires = Json.Get(root, "expiresAt");
            if (!(expires is int) && !(expires is long) && !(expires is double) && !(expires is decimal)) return null;
            var ms = Convert.ToDouble(expires, CultureInfo.InvariantCulture);
            // Not before now, not after the year 2100.
            if (double.IsNaN(ms) || ms > 4102444800000d) return null;
            var until = Epoch.AddMilliseconds(Math.Floor(ms));
            if (until <= nowUtc) return null;
            return new State { SignedIn = true, Until = until.ToLocalTime() };
        }

        public static string Describe(State state)
        {
            return state.SignedIn ? "Signed in \u00B7 until " + state.Until.ToString("ddd d MMM yyyy, HH:mm", CultureInfo.CurrentCulture) : "Not signed in";
        }

        private static readonly string[] Hosts = { "krea.ai", "www.krea.ai", "api.krea.ai" };

        // The consent address to open, from the first line `login` prints, or
        // null when that line is not one: it has to be an https address on
        // krea.ai, www.krea.ai or api.krea.ai, written plainly. Checked twice,
        // as text and as a parsed address, so that no way of writing another
        // host (a name in front of an @, a port, an escaped or foreign letter)
        // gets through.
        public static string ConsentAddress(string line)
        {
            var text = (line ?? "").Trim();
            const string scheme = "https://";
            if (text.Length <= scheme.Length || text.Length > 4096 || !text.StartsWith(scheme, StringComparison.Ordinal)) return null;
            foreach (var c in text) if (c <= 0x20 || c >= 0x7F || c == '\\') return null;
            var end = text.IndexOfAny(new[] { '/', '?', '#' }, scheme.Length);
            var authority = end < 0 ? text.Substring(scheme.Length) : text.Substring(scheme.Length, end - scheme.Length);
            if (Array.IndexOf(Hosts, authority) < 0) return null;
            Uri uri;
            if (!Uri.TryCreate(text, UriKind.Absolute, out uri)) return null;
            if (uri.Scheme != Uri.UriSchemeHttps || !uri.IsDefaultPort || uri.UserInfo.Length > 0 || Array.IndexOf(Hosts, uri.Host) < 0) return null;
            return text;
        }

        // Opens a consent address in the default browser. Nothing but an
        // address ConsentAddress accepts is ever handed to the shell.
        public static bool Open(string address)
        {
            if (address == null || ConsentAddress(address) != address) return false;
            try
            {
                using (Process.Start(new ProcessStartInfo(address) { UseShellExecute = true })) { }
                return true;
            }
            catch (System.ComponentModel.Win32Exception) { return false; }
            catch (InvalidOperationException) { return false; }
        }

        public enum Outcome
        {
            SignedIn,
            Cancelled,
            // The helper's own codes.
            Refused,
            LoginRequired,
            Uncertain,
            // Stopped by this program.
            AddressRefused,
            BrowserNotOpened,
            NoAddressInTime,
            NotFinishedInTime,
            // The helper could not be started, or ended in a way it does not name.
            NotStarted,
            EndedWithoutAddress,
            Failed
        }

        // How a finished `login` ended: exit 0 is signed in, otherwise the
        // code it printed. Its error text is read for that code only and never shown.
        public static Outcome Ended(int exitCode, string errors)
        {
            if (exitCode == 0) return Outcome.SignedIn;
            var outcome = Outcome.Failed;
            foreach (var line in (errors ?? "").Split('\n'))
            {
                switch (line.Trim())
                {
                    case "KREA_REFUSED": outcome = Outcome.Refused; break;
                    case "KREA_LOGIN_REQUIRED": outcome = Outcome.LoginRequired; break;
                    case "KREA_UNCERTAIN": outcome = Outcome.Uncertain; break;
                }
            }
            return outcome;
        }

        // One fixed sentence for each way a sign-in can end.
        public static string Message(Outcome outcome)
        {
            switch (outcome)
            {
                case Outcome.SignedIn: return "Signed in to Krea.";
                case Outcome.Cancelled: return "Sign-in cancelled: the Krea helper was stopped.";
                case Outcome.Refused: return "Krea sign-in did not complete (KREA_REFUSED): it was refused or closed in the browser, took longer than three minutes, or Krea could not be reached.";
                case Outcome.LoginRequired: return "Krea sign-in did not complete (KREA_LOGIN_REQUIRED): no sign-in is present.";
                case Outcome.Uncertain: return "Krea sign-in ended uncertain (KREA_UNCERTAIN): the helper could not tell whether it completed.";
                case Outcome.AddressRefused: return "Refused: the Krea helper gave a consent address that is not an https address on krea.ai, www.krea.ai or api.krea.ai. It was not opened, and the helper was stopped.";
                case Outcome.BrowserNotOpened: return "The consent page could not be opened in your browser. The Krea helper was stopped.";
                case Outcome.NoAddressInTime: return "The Krea helper gave no consent address within a minute. It was stopped.";
                case Outcome.NotFinishedInTime: return "The Krea helper did not finish in time. It was stopped.";
                case Outcome.NotStarted: return "The Krea helper could not be started.";
                case Outcome.EndedWithoutAddress: return "The Krea helper ended without giving a consent address.";
                default: return "The Krea helper ended with an error it did not name.";
            }
        }
    }

    // One sign-in: the helper's `login` from its start to its end. Run blocks,
    // so it is called off the UI thread, and says how the sign-in ended.
    // Cancel may be called from any thread and stops the helper. The consent
    // address goes from the helper's first line to `open` and nowhere else.
    internal sealed class KreaLogin
    {
        private readonly Func<Process> start;
        private readonly Func<string, bool> open;
        private readonly object gate = new object();
        private Process process;
        private bool cancelled;

        // The helper first asks Krea where to sign in (up to 45 seconds), then
        // waits up to three minutes for the browser and saves the sign-in.
        public int AddressMs = 60000;
        public int FinishMs = 240000;

        public KreaLogin(Func<Process> start, Func<string, bool> open)
        {
            this.start = start;
            this.open = open;
        }

        private bool Cancelled
        {
            get { lock (gate) return cancelled; }
        }

        // The helper is ended while the lock is held, and Run lets go of it
        // under the same lock before disposing it: Cancel never holds a
        // process that is being disposed.
        public void Cancel()
        {
            lock (gate)
            {
                cancelled = true;
                if (process != null) Stop(process);
            }
        }

        // Ends the helper and anything it started. Under the lock, like Cancel.
        private void Stop(Process helper)
        {
            lock (gate) ProcessTree.Kill(helper);
        }

        public Krea.Outcome Run(Action waiting)
        {
            if (Cancelled) return Krea.Outcome.Cancelled;
            Process helper;
            try { helper = start(); }
            catch (System.ComponentModel.Win32Exception) { return Krea.Outcome.NotStarted; }
            catch (InvalidOperationException) { return Krea.Outcome.NotStarted; }
            if (helper == null) return Krea.Outcome.NotStarted;
            try
            {
                bool stopNow;
                lock (gate)
                {
                    process = helper;
                    stopNow = cancelled;
                }
                if (stopNow)
                {
                    Stop(helper);
                    return Krea.Outcome.Cancelled;
                }
                // Nothing is typed to the helper.
                try { helper.StandardInput.Close(); }
                catch (InvalidOperationException) { }
                catch (IOException) { }
                var errors = helper.StandardError.ReadToEndAsync();
                var first = helper.StandardOutput.ReadLineAsync();
                string line = null;
                var answered = false;
                try
                {
                    answered = first.Wait(AddressMs);
                    if (answered) line = first.Result;
                }
                catch (AggregateException) { answered = true; }
                if (Cancelled)
                {
                    Stop(helper);
                    return Krea.Outcome.Cancelled;
                }
                if (!answered)
                {
                    Stop(helper);
                    return Krea.Outcome.NoAddressInTime;
                }
                if (line == null)
                {
                    // The helper ended before it had an address to give.
                    if (!helper.WaitForExit(15000))
                    {
                        Stop(helper);
                        return Krea.Outcome.NotFinishedInTime;
                    }
                    if (Cancelled) return Krea.Outcome.Cancelled;
                    var early = Krea.Ended(helper.ExitCode, Text(errors));
                    return early == Krea.Outcome.SignedIn ? Krea.Outcome.EndedWithoutAddress : early;
                }
                var address = Krea.ConsentAddress(line);
                if (address == null)
                {
                    Stop(helper);
                    return Krea.Outcome.AddressRefused;
                }
                bool opened;
                try { opened = open(address); }
                catch (Exception) { opened = false; }
                if (!opened)
                {
                    Stop(helper);
                    return Krea.Outcome.BrowserNotOpened;
                }
                if (waiting != null) waiting();
                // Whatever else the helper prints is read so it cannot block
                // on a full pipe, and is not kept.
                helper.StandardOutput.ReadToEndAsync();
                if (!helper.WaitForExit(FinishMs))
                {
                    Stop(helper);
                    return Cancelled ? Krea.Outcome.Cancelled : Krea.Outcome.NotFinishedInTime;
                }
                if (Cancelled) return Krea.Outcome.Cancelled;
                return Krea.Ended(helper.ExitCode, Text(errors));
            }
            catch (InvalidOperationException) { return Cancelled ? Krea.Outcome.Cancelled : Krea.Outcome.Failed; }
            finally
            {
                lock (gate) process = null;
                helper.Dispose();
            }
        }

        private static string Text(System.Threading.Tasks.Task<string> reading)
        {
            try { return reading.Wait(5000) ? reading.Result : ""; }
            catch (AggregateException) { return ""; }
        }
    }

    // The gateway's own answer to GET <origin>/dshproxy/status. It needs no
    // token and starts no process, so it is what the window asks every few
    // seconds; the command line's full status is kept for when something changed.
    internal static class GatewayStatus
    {
        private const int MaxBytes = 1024 * 1024;

        // A listener on this computer takes a connection at once, however busy
        // the program behind it is. Windows, though, spends two seconds finding
        // out that nothing is listening. So a connection that is not there
        // after this long means there is no gateway, and the window can say so
        // seconds earlier.
        private const int ConnectMs = 400;

        // The body of the answer, or null when the gateway did not give one in
        // time: nothing listening, a slow answer, or anything but HTTP 200.
        // Plain sockets, because the answer is asked for every few seconds.
        public static string Read(string origin, int timeoutMs)
        {
            try
            {
                Uri address;
                if (!Uri.TryCreate(origin, UriKind.Absolute, out address) || address.Scheme != Uri.UriSchemeHttp) return null;
                var clock = Stopwatch.StartNew();
                foreach (var ip in Addresses(address.DnsSafeHost))
                {
                    var body = Ask(ip, address, timeoutMs, clock);
                    if (body != null) return body;
                    if (clock.ElapsedMilliseconds >= timeoutMs) break;
                }
                return null;
            }
            catch (System.Net.Sockets.SocketException) { return null; }
            catch (IOException) { return null; }
            catch (ObjectDisposedException) { return null; }
            catch (ArgumentException) { return null; }
            catch (FormatException) { return null; }
            catch (OverflowException) { return null; }
        }

        // The settings allow 127.0.0.1, ::1 and localhost. The last one is a
        // name, and the gateway listens on whichever address it resolves to.
        private static IPAddress[] Addresses(string host)
        {
            IPAddress ip;
            if (IPAddress.TryParse(host, out ip)) return new[] { ip };
            return Dns.GetHostAddresses(host);
        }

        private static string Ask(IPAddress ip, Uri address, int timeoutMs, Stopwatch clock)
        {
            using (var socket = new System.Net.Sockets.Socket(ip.AddressFamily, System.Net.Sockets.SocketType.Stream, System.Net.Sockets.ProtocolType.Tcp))
            {
                socket.NoDelay = true;
                socket.Blocking = false;
                try { socket.Connect(new IPEndPoint(ip, address.Port)); }
                catch (System.Net.Sockets.SocketException error)
                {
                    if (error.SocketErrorCode != System.Net.Sockets.SocketError.WouldBlock && error.SocketErrorCode != System.Net.Sockets.SocketError.InProgress) return null;
                }
                var wait = Math.Min(IPAddress.IsLoopback(ip) ? ConnectMs : timeoutMs, timeoutMs - (int)clock.ElapsedMilliseconds);
                if (wait <= 0 || !socket.Poll(wait * 1000, System.Net.Sockets.SelectMode.SelectWrite)) return null;
                socket.Blocking = true;
                socket.SendTimeout = timeoutMs;
                // One connection for each check, so none is left open on the
                // gateway between checks.
                socket.Send(Encoding.ASCII.GetBytes("GET /dshproxy/status HTTP/1.1\r\nHost: " + address.Authority + "\r\nAccept: application/json\r\nConnection: close\r\n\r\n"));
                using (var answer = new MemoryStream())
                {
                    var buffer = new byte[8192];
                    while (true)
                    {
                        var left = timeoutMs - (int)clock.ElapsedMilliseconds;
                        if (left <= 0) return null;
                        socket.ReceiveTimeout = left;
                        var read = socket.Receive(buffer);
                        var ended = read <= 0;
                        if (!ended)
                        {
                            if (answer.Length + read > MaxBytes) return null;
                            answer.Write(buffer, 0, read);
                        }
                        string body;
                        if (Whole(answer.GetBuffer(), (int)answer.Length, ended, out body)) return body;
                        if (ended) return null;
                    }
                }
            }
        }

        // Reads an HTTP answer received so far. True when it can be judged:
        // `body` is then its body, or null when it is not a whole 200 answer.
        // False when more has to arrive first. `ended` says the gateway has
        // closed the connection.
        public static bool Whole(byte[] data, int length, bool ended, out string body)
        {
            body = null;
            var head = Find(data, 0, length, true);
            if (head < 0) return ended;
            var lines = Encoding.ASCII.GetString(data, 0, head).Split(new[] { "\r\n" }, StringSplitOptions.None);
            var first = lines[0].Split(' ');
            if (first.Length < 2 || !first[0].StartsWith("HTTP/1.", StringComparison.Ordinal) || first[1] != "200") return true;
            var declared = -1;
            var chunked = false;
            for (var index = 1; index < lines.Length; index++)
            {
                var colon = lines[index].IndexOf(':');
                if (colon < 0) continue;
                var name = lines[index].Substring(0, colon).Trim();
                var value = lines[index].Substring(colon + 1).Trim();
                if (name.Equals("Content-Length", StringComparison.OrdinalIgnoreCase))
                {
                    if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out declared) || declared > MaxBytes) return true;
                }
                else if (name.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase)) chunked = value.IndexOf("chunked", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            var start = head + 4;
            if (chunked)
            {
                using (var joined = new MemoryStream())
                {
                    var at = start;
                    while (true)
                    {
                        var lineEnd = Find(data, at, length, false);
                        if (lineEnd < 0) return ended;
                        var sizeText = Encoding.ASCII.GetString(data, at, lineEnd - at);
                        var semicolon = sizeText.IndexOf(';');
                        if (semicolon >= 0) sizeText = sizeText.Substring(0, semicolon);
                        int size;
                        if (!int.TryParse(sizeText.Trim(), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out size) || size < 0 || size > MaxBytes) return true;
                        at = lineEnd + 2;
                        if (size == 0)
                        {
                            body = Encoding.UTF8.GetString(joined.GetBuffer(), 0, (int)joined.Length);
                            return true;
                        }
                        if (at + size + 2 > length) return ended;
                        joined.Write(data, at, size);
                        at += size + 2;
                    }
                }
            }
            if (declared >= 0)
            {
                if (length - start < declared) return ended;
                body = Encoding.UTF8.GetString(data, start, declared);
                return true;
            }
            // Neither says where the body ends: it ends with the connection.
            if (!ended) return false;
            body = Encoding.UTF8.GetString(data, start, length - start);
            return true;
        }

        // Where the next line break is from `from`, or the empty line that ends
        // the headers when `blankLine` is set; -1 when it has not arrived.
        private static int Find(byte[] data, int from, int length, bool blankLine)
        {
            var need = blankLine ? 4 : 2;
            for (var index = from; index + need <= length; index++)
            {
                if (data[index] != 13 || data[index + 1] != 10) continue;
                if (!blankLine || (data[index + 2] == 13 && data[index + 3] == 10)) return index;
            }
            return -1;
        }

        // Reads an answer: the requests in flight (0 when it does not say), and
        // everything else as one text, which changes only when something other
        // than that count does. False when the answer is not a JSON object.
        public static bool Parse(string body, out int inFlight, out string print)
        {
            inFlight = 0;
            print = null;
            object parsed;
            try { parsed = Json.Serializer.DeserializeObject(body ?? ""); }
            catch (ArgumentException) { return false; }
            catch (InvalidOperationException) { return false; }
            var status = parsed as Dictionary<string, object>;
            if (status == null) return false;
            inFlight = InFlight.Count(status);
            status.Remove("inFlight");
            print = Json.Serializer.Serialize(status);
            return true;
        }
    }

    // Ends a process this program started, and anything that process started.
    internal static class ProcessTree
    {
        public static void Kill(Process process)
        {
            try
            {
                if (process.HasExited) return;
                using (var kill = Process.Start(new ProcessStartInfo("taskkill.exe", "/PID " + process.Id.ToString(CultureInfo.InvariantCulture) + " /T /F") { CreateNoWindow = true, UseShellExecute = false })) kill.WaitForExit(10000);
                if (!process.HasExited) process.Kill();
                process.WaitForExit(5000);
            }
            catch (System.ComponentModel.Win32Exception) { }
            // A process that was disposed meanwhile. It is an InvalidOperationException
            // as well; named so that nobody has to look that up.
            catch (ObjectDisposedException) { }
            catch (InvalidOperationException) { }
        }
    }

    // `dshproxy stop --when-idle --wait 300`: asks the running gateway to stop
    // at a moment with no request in flight. It answers {"stopped":true} with
    // exit code 0 once the gateway has stopped, or {"stopped":false,"inFlight":N}
    // with exit code 2 when the wait ran out and the gateway keeps running.
    // Anything else (no gateway, an older gateway that cannot do this, an
    // answer that did not arrive) is exit code 1 with one sentence. Run
    // blocks, so it is called off the UI thread; Cancel may be called from any
    // thread and ends the command, which the gateway takes as "keep running".
    internal sealed class IdleStop
    {
        public enum Outcome { Stopped, StillBusy, NotDone, Cancelled }

        public sealed class Result
        {
            public Outcome Outcome;
            // The requests still in flight when the wait ran out.
            public int InFlight;
            // Why it was not done, in the command line's own words.
            public string Message;
        }

        public const int WaitSeconds = 300;

        public static string[] Command()
        {
            return new[] { "stop", "--when-idle", "--wait", WaitSeconds.ToString(CultureInfo.InvariantCulture) };
        }

        // What a finished command said.
        public static Result Read(int exitCode, string output, string errors)
        {
            Dictionary<string, object> answer = null;
            try { answer = Json.Serializer.DeserializeObject((output ?? "").Trim()) as Dictionary<string, object>; }
            catch (ArgumentException) { }
            catch (InvalidOperationException) { }
            var stopped = answer == null ? null : Json.Get(answer, "stopped");
            if (exitCode == 0 && stopped is bool && (bool)stopped) return new Result { Outcome = Outcome.Stopped };
            if (exitCode == 2 && stopped is bool && !(bool)stopped && Json.Get(answer, "inFlight") is int && (int)Json.Get(answer, "inFlight") >= 0)
                return new Result { Outcome = Outcome.StillBusy, InFlight = (int)Json.Get(answer, "inFlight") };
            var message = VideoSettings.Failure(new Cli.Result { Code = exitCode, Out = "", Err = errors ?? "" });
            return new Result { Outcome = Outcome.NotDone, Message = exitCode == 0 || exitCode == 2 ? "DSHProxy did not answer as expected when asked to stop the gateway at an idle moment." : message };
        }

        private readonly Func<Process> start;
        private readonly object gate = new object();
        private Process process;
        private bool cancelled;

        public IdleStop(Func<Process> start)
        {
            this.start = start;
        }

        private bool Cancelled
        {
            get { lock (gate) return cancelled; }
        }

        // The command is ended while the lock is held, and Run lets go of it
        // under the same lock before disposing it: Cancel never holds a
        // process that is being disposed.
        public void Cancel()
        {
            lock (gate)
            {
                cancelled = true;
                if (process != null) ProcessTree.Kill(process);
            }
        }

        public Result Run()
        {
            if (Cancelled) return new Result { Outcome = Outcome.Cancelled };
            Process command;
            try { command = start(); }
            catch (System.ComponentModel.Win32Exception) { return new Result { Outcome = Outcome.NotDone, Message = "The DSHProxy command could not be started." }; }
            catch (InvalidOperationException) { return new Result { Outcome = Outcome.NotDone, Message = "The DSHProxy command could not be started." }; }
            try
            {
                bool stopNow;
                lock (gate)
                {
                    process = command;
                    stopNow = cancelled;
                }
                if (stopNow)
                {
                    lock (gate) ProcessTree.Kill(command);
                    return new Result { Outcome = Outcome.Cancelled };
                }
                try { command.StandardInput.Close(); }
                catch (InvalidOperationException) { }
                catch (IOException) { }
                var output = command.StandardOutput.ReadToEndAsync();
                var errors = command.StandardError.ReadToEndAsync();
                // The command itself gives up a minute after the wait.
                if (!command.WaitForExit((WaitSeconds + 90) * 1000))
                {
                    lock (gate) ProcessTree.Kill(command);
                    return Cancelled ? new Result { Outcome = Outcome.Cancelled } : new Result { Outcome = Outcome.NotDone, Message = "The DSHProxy command did not finish in time." };
                }
                // A gateway that stopped in the moment Cancel was pressed has stopped.
                var read = Read(command.ExitCode, Text(output), Text(errors));
                if (read.Outcome != Outcome.Stopped && Cancelled) return new Result { Outcome = Outcome.Cancelled };
                return read;
            }
            catch (InvalidOperationException) { return Cancelled ? new Result { Outcome = Outcome.Cancelled } : new Result { Outcome = Outcome.NotDone, Message = "The DSHProxy command ended unexpectedly." }; }
            finally
            {
                lock (gate) process = null;
                command.Dispose();
            }
        }

        private static string Text(System.Threading.Tasks.Task<string> reading)
        {
            try { return reading.Wait(5000) ? reading.Result : ""; }
            catch (AggregateException) { return ""; }
        }
    }

    // Shown while a restart waits for the requests in flight to finish. It
    // closes when the wait has ended; Cancel, Esc and the close box ask for
    // the wait to end and leave the gateway running.
    internal sealed class RestartWaitDialog : Form
    {
        private readonly Label message;
        private readonly Button cancel;
        private readonly Action onCancel;
        private bool finished;
        private bool cancelling;

        public static string Waiting(int count)
        {
            if (count <= 0) return "Nothing is in flight now. Waiting for the gateway to stop before restarting.";
            return count == 1 ? "Waiting for 1 request to finish before restarting" : "Waiting for " + count.ToString(CultureInfo.InvariantCulture) + " requests to finish before restarting";
        }

        public RestartWaitDialog(int count, Action onCancel)
        {
            this.onCancel = onCancel;
            Text = "Restart gateway";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MinimizeBox = false;
            MaximizeBox = false;
            ShowInTaskbar = false;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Font = Theme.Ui(9.5f);
            Padding = new Padding(14);
            var appIcon = AppIcon.Load(SystemInformation.SmallIconSize);
            if (appIcon != null) Icon = appIcon;

            var layout = Glass.Make(new TableLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 1, RowCount = 3, Padding = new Padding(20, 20, 20, 16) }, 22, true);
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            message = new GlassLabel { Text = Waiting(count), AutoSize = true, MinimumSize = new Size(420, 0), MaximumSize = new Size(420, 0), ForeColor = Theme.Text, Font = Theme.Ui(10.5f, FontStyle.Bold), Margin = new Padding(0, 4, 0, 10), UseMnemonic = false };
            var note = new GlassLabel { Text = "The gateway keeps serving until a moment with nothing in flight, for at most 5 minutes. Cancel leaves it running; the key change is then used after the next restart.", AutoSize = true, MaximumSize = new Size(420, 0), ForeColor = Theme.Muted, Margin = new Padding(0, 0, 0, 18), UseMnemonic = false };
            var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill, Margin = new Padding(0), WrapContents = false };
            cancel = Skin.Primary(new PillButton { Text = "Cancel", Size = new Size(100, 36), Margin = new Padding(8, 0, 0, 0), AccessibleName = "Cancel the restart" });
            cancel.Click += (s, e) => AskToCancel();
            row.Controls.Add(cancel);
            layout.Controls.Add(message, 0, 0);
            layout.Controls.Add(note, 0, 1);
            layout.Controls.Add(row, 0, 2);
            Controls.Add(layout);
            AcceptButton = cancel;
            CancelButton = cancel;
            // Being the cancel button makes a press close the dialog. It must
            // stay until the wait has really ended: the gateway may be stopping.
            cancel.DialogResult = DialogResult.None;
            Shown += (s, e) => cancel.Focus();
            Disposed += (s, e) => { message.Font.Dispose(); Font.Dispose(); };
            Skin.Apply(this);
        }

        // The count the gateway last reported.
        public void SetCount(int count)
        {
            if (finished || cancelling) return;
            var text = Waiting(count);
            if (message.Text != text) message.Text = text;
        }

        // The wait has ended, one way or another.
        public void Finish()
        {
            finished = true;
            Close();
        }

        private void AskToCancel()
        {
            if (finished || cancelling) return;
            cancelling = true;
            cancel.Enabled = false;
            message.Text = "Cancelling the restart...";
            onCancel();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // The close box is Cancel. The dialog itself goes when the wait has
            // ended, or with the program.
            if (!finished && (e.CloseReason == CloseReason.UserClosing || e.CloseReason == CloseReason.None))
            {
                e.Cancel = true;
                AskToCancel();
            }
            base.OnFormClosing(e);
        }
    }

    // The marks of the checklist Apply to DeepSeek Harness shows: in place,
    // will be done, cannot be done, and something to know.
    internal enum SetupMark { Done, ToDo, Cannot, Note }

    // One line of that checklist: a mark, what it says, and under it a
    // quieter line or two (a folder, a reason, what a command printed).
    internal sealed class SetupLine
    {
        public readonly SetupMark Mark;
        public readonly string Text;
        // "" when there is none.
        public readonly string Detail;

        public SetupLine(SetupMark mark, string text, string detail)
        {
            Mark = mark;
            Text = text ?? "";
            Detail = detail ?? "";
        }
    }

    // A mark of the checklist, drawn rather than written so it does not
    // depend on a font having the sign. Each has its own shape as well as
    // its own colour, and a screen reader is given the word.
    internal sealed class MarkGlyph : Control
    {
        private readonly SetupMark mark;

        public MarkGlyph(SetupMark mark)
        {
            this.mark = mark;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
            SetStyle(ControlStyles.Selectable, false);
            Size = new Size(20, 20);
            TabStop = false;
            AccessibleRole = AccessibleRole.StaticText;
            AccessibleName = Word(mark);
        }

        public static string Word(SetupMark mark)
        {
            switch (mark)
            {
                case SetupMark.Done: return "In place";
                case SetupMark.ToDo: return "To do";
                case SetupMark.Cannot: return "Cannot be done";
                default: return "Note";
            }
        }

        private static Color Tint(SetupMark mark)
        {
            switch (mark)
            {
                case SetupMark.Done: return Theme.Ok;
                case SetupMark.ToDo: return Theme.Accent;
                case SetupMark.Cannot: return Theme.Bad;
                default: return Theme.Warn;
            }
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var color = Tint(mark);
            using (var glow = new SolidBrush(Color.FromArgb(40, color))) g.FillEllipse(glow, 0, 0, 19, 19);
            using (var pen = new Pen(color, 2f))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                pen.LineJoin = LineJoin.Round;
                switch (mark)
                {
                    case SetupMark.Done:
                        g.DrawLines(pen, new[] { new PointF(5.4f, 10f), new PointF(8.4f, 13f), new PointF(13.8f, 6.6f) });
                        break;
                    case SetupMark.ToDo:
                        g.DrawLine(pen, 5.2f, 9.5f, 13.4f, 9.5f);
                        g.DrawLines(pen, new[] { new PointF(10.2f, 6.2f), new PointF(13.6f, 9.5f), new PointF(10.2f, 12.8f) });
                        break;
                    case SetupMark.Cannot:
                        g.DrawLine(pen, 6.2f, 6.2f, 12.8f, 12.8f);
                        g.DrawLine(pen, 12.8f, 6.2f, 6.2f, 12.8f);
                        break;
                    default:
                        g.DrawLine(pen, 9.5f, 5.2f, 9.5f, 10.4f);
                        g.DrawLine(pen, 9.5f, 13.6f, 9.5f, 13.8f);
                        break;
                }
            }
        }
    }

    // The two dialogs of Apply to DeepSeek Harness that are a checklist: the
    // question before anything is written, and what happened afterwards.
    internal static class SetupDialog
    {
        public const string Title = "Apply to DeepSeek Harness";
        public const string CopyText = "Copy folder path";
        // The width a line of the checklist wraps at. A folder name without
        // a space in it is broken at this width too.
        private const int TextWidth = 460;

        // True when the person chose to go on.
        public static bool Confirm(IWin32Window owner, HarnessSetup state)
        {
            return Show(owner, "What is in place, and what Apply will do", state.ConfirmLines(), "Apply", "Cancel", null);
        }

        public static void Show(IWin32Window owner, HarnessSetup.Result result)
        {
            Show(owner, result.Heading, result.Lines, "OK", null, result.CopyPath);
        }

        private static bool Show(IWin32Window owner, string heading, List<SetupLine> lines, string accept, string cancel, string copyPath)
        {
            using (var form = new Form())
            using (var headingFont = Theme.Ui(10.5f, FontStyle.Bold))
            {
                form.Text = Title;
                form.FormBorderStyle = FormBorderStyle.FixedDialog;
                form.StartPosition = owner == null ? FormStartPosition.CenterScreen : FormStartPosition.CenterParent;
                form.MinimizeBox = false;
                form.MaximizeBox = false;
                form.ShowInTaskbar = owner == null;
                form.AutoSize = true;
                form.AutoSizeMode = AutoSizeMode.GrowAndShrink;
                form.Font = Theme.Ui(9.5f);
                form.Padding = new Padding(14);
                var appIcon = AppIcon.Load(SystemInformation.SmallIconSize);
                if (appIcon != null) form.Icon = appIcon;

                var rows = 2;
                foreach (var line in lines) rows += line.Detail.Length > 0 ? 2 : 1;
                var layout = Glass.Make(new TableLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 2, RowCount = rows, Padding = new Padding(20, 20, 20, 16) }, 22, true);
                layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
                layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
                var title = new GlassLabel { Text = heading, AutoSize = true, MaximumSize = new Size(TextWidth + 32, 0), ForeColor = Theme.Text, Font = headingFont, Margin = new Padding(0, 4, 0, 14), UseMnemonic = false };
                layout.Controls.Add(title, 0, 0);
                layout.SetColumnSpan(title, 2);
                var row = 1;
                foreach (var line in lines)
                {
                    var last = line.Detail.Length == 0;
                    layout.Controls.Add(new MarkGlyph(line.Mark) { Margin = new Padding(0, 0, 12, 0) }, 0, row);
                    // The word of the mark is read out with the line it belongs to.
                    layout.Controls.Add(new GlassLabel { Text = line.Text, AutoSize = true, MaximumSize = new Size(TextWidth, 0), ForeColor = Theme.Text, Margin = new Padding(0, 1, 0, last ? 12 : 2), UseMnemonic = false, AccessibleName = MarkGlyph.Word(line.Mark) + ": " + line.Text }, 1, row);
                    row++;
                    if (last) continue;
                    layout.Controls.Add(new GlassLabel { Text = line.Detail, AutoSize = true, MaximumSize = new Size(TextWidth, 0), ForeColor = Theme.Muted, Margin = new Padding(0, 0, 0, 12), UseMnemonic = false }, 1, row);
                    row++;
                }

                var buttons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill, Margin = new Padding(0, 6, 0, 0), WrapContents = false };
                var go = Skin.Primary(new PillButton { Text = accept, DialogResult = DialogResult.OK, Size = new Size(100, 36), Margin = new Padding(8, 0, 0, 0) });
                Button stop = go;
                if (cancel != null)
                {
                    stop = new PillButton { Text = cancel, DialogResult = DialogResult.Cancel, Size = new Size(100, 36), Margin = new Padding(8, 0, 0, 0) };
                    buttons.Controls.Add(stop);
                }
                buttons.Controls.Add(go);
                if (copyPath != null)
                {
                    // Stays open: the folder is on the clipboard, and still to be read here.
                    var copy = new PillButton { Text = CopyText, Size = new Size(170, 36), Margin = new Padding(8, 0, 0, 0), AccessibleDescription = "Copies the folder of the video tools, to choose it in DeepSeek Harness." };
                    copy.Click += (s, e) =>
                    {
                        try
                        {
                            Clipboard.SetText(copyPath);
                            copy.Text = "Copied";
                        }
                        catch (System.Runtime.InteropServices.ExternalException) { copy.Text = "Could not copy"; }
                    };
                    buttons.Controls.Add(copy);
                }
                layout.Controls.Add(buttons, 0, row);
                layout.SetColumnSpan(buttons, 2);
                form.Controls.Add(layout);
                form.AcceptButton = go;
                form.CancelButton = stop;
                form.Shown += (s, e) => go.Focus();
                Skin.Apply(form);
                return (owner == null ? form.ShowDialog() : form.ShowDialog(owner)) == DialogResult.OK;
            }
        }
    }

    // Shown after the chat routes are written, while DeepSeek Harness is
    // still open: the video tools can only be installed when it is closed.
    // It looks once a second whether a DeepSeek Harness process is left and
    // closes itself when none is. The one button, Esc and the close box skip
    // the video tools. This program never closes DeepSeek Harness itself.
    internal sealed class HarnessWaitDialog : Form
    {
        public const string SkipText = "Skip the video tools";

        private readonly Func<bool> running;
        private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 1000 };
        private readonly Label heading;
        private bool looking;
        private bool ended;

        // True when the dialog closed because DeepSeek Harness had quit;
        // false when the video tools were skipped.
        public bool HarnessGone { get; private set; }

        public HarnessWaitDialog(Func<bool> running)
        {
            this.running = running;
            Text = SetupDialog.Title;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MinimizeBox = false;
            MaximizeBox = false;
            ShowInTaskbar = false;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Font = Theme.Ui(9.5f);
            Padding = new Padding(14);
            var appIcon = AppIcon.Load(SystemInformation.SmallIconSize);
            if (appIcon != null) Icon = appIcon;

            var layout = Glass.Make(new TableLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 1, RowCount = 5, Padding = new Padding(20, 20, 20, 16) }, 22, true);
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            heading = new GlassLabel { Text = "Quit DeepSeek Harness to install the video tools", AutoSize = true, MinimumSize = new Size(440, 0), MaximumSize = new Size(440, 0), ForeColor = Theme.Text, Font = Theme.Ui(10.5f, FontStyle.Bold), Margin = new Padding(0, 4, 0, 12), UseMnemonic = false };
            layout.Controls.Add(heading, 0, 0);
            var notes = new[]
            {
                "The chat routes are written. The video tools can only be installed while DeepSeek Harness is closed.",
                "Closing its window may not be enough: DeepSeek Harness can stay in the tray, next to the clock. Quit it there too.",
                "This window closes by itself when DeepSeek Harness has quit, and the video tools are installed then. DSHProxy does not close DeepSeek Harness for you."
            };
            for (var i = 0; i < notes.Length; i++)
                layout.Controls.Add(new GlassLabel { Text = notes[i], AutoSize = true, MaximumSize = new Size(440, 0), ForeColor = i == 0 ? Theme.Text : Theme.Muted, Margin = new Padding(0, 0, 0, i == notes.Length - 1 ? 18 : 10), UseMnemonic = false }, 0, i + 1);
            var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill, Margin = new Padding(0), WrapContents = false };
            var skip = new PillButton { Text = SkipText, Size = new Size(190, 36), Margin = new Padding(8, 0, 0, 0), DialogResult = DialogResult.Cancel, AccessibleDescription = "Installs nothing and leaves DeepSeek Harness as it is." };
            row.Controls.Add(skip);
            layout.Controls.Add(row, 0, notes.Length + 1);
            Controls.Add(layout);
            AcceptButton = skip;
            CancelButton = skip;
            Shown += (s, e) =>
            {
                skip.Focus();
                timer.Start();
            };
            timer.Tick += (s, e) => Look();
            Disposed += (s, e) =>
            {
                timer.Dispose();
                heading.Font.Dispose();
                Font.Dispose();
            };
            Skin.Apply(this);
        }

        // Asks, off the UI thread, whether a DeepSeek Harness process is
        // left. A question that fails counts as one left: the dialog stays.
        private void Look()
        {
            if (looking || ended) return;
            looking = true;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                bool left;
                try { left = running(); }
                catch (Exception) { left = true; }
                try
                {
                    BeginInvoke(new Action(() =>
                    {
                        looking = false;
                        if (left || ended) return;
                        HarnessGone = true;
                        Close();
                    }));
                }
                // Closed meanwhile: skipped.
                catch (InvalidOperationException) { }
            });
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            base.OnFormClosing(e);
            if (e.Cancel) return;
            ended = true;
            timer.Stop();
        }
    }

    // Model requests in flight at the gateway, from the status the app polls.
    internal static class InFlight
    {
        // The count in a status answer. A gateway that is not running, or an
        // older one that does not count, gives null or nothing: that is 0.
        public static int Count(Dictionary<string, object> status)
        {
            var value = Json.Get(status, "inFlight");
            if (!(value is int) && !(value is long) && !(value is double) && !(value is decimal)) return 0;
            var number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            if (double.IsNaN(number) || number < 1) return 0;
            return number > 1000000 ? 1000000 : (int)Math.Floor(number);
        }

        // What the restart for a key change asks when the gateway cannot be
        // asked to wait for an idle moment.
        public static string RestartQuestion(int count)
        {
            return (count == 1 ? "1 model request was in flight" : count.ToString(CultureInfo.InvariantCulture) + " model requests were in flight")
                + " when the gateway was last checked, a few seconds ago at most. Restarting the gateway now cuts " + (count == 1 ? "it" : "them") + ".\n\nRestart anyway?";
        }

        // The same when the gateway did not answer the last check: the count,
        // if there was one, is from its last answer.
        private static string Unanswered(int count)
        {
            return "The gateway did not answer when it was last checked, so requests may be in flight."
                + (count <= 0 ? "" : count == 1 ? " 1 model request was in flight when it last answered." : " " + count.ToString(CultureInfo.InvariantCulture) + " model requests were in flight when it last answered.");
        }

        public static string UnansweredQuestion(int count, bool quitting)
        {
            return Unanswered(count) + " " + (quitting ? "Quitting stops the gateway now and cuts any that are" : "Stopping the gateway now cuts any that are") + ".\n\n"
                + (quitting ? "Quit anyway?" : "Stop anyway?");
        }

        public static string UnansweredRestartQuestion(int count)
        {
            return Unanswered(count) + " Restarting the gateway now cuts any that are.\n\nRestart anyway?";
        }

        // What Stop and Quit ask before cutting requests.
        public static string Question(int count, bool quitting)
        {
            var requests = count == 1 ? "1 model request was in flight" : count.ToString(CultureInfo.InvariantCulture) + " model requests were in flight";
            return requests + " when the gateway was last checked, a few seconds ago at most. "
                + (quitting ? "Quitting stops the gateway now and cuts " : "Stopping the gateway now cuts ") + (count == 1 ? "it" : "them") + ".\n\n"
                + (quitting ? "Quit anyway?" : "Stop anyway?");
        }
    }

    // Asks which one billing route a video model is charged to. Nothing is
    // preselected for a model that has no route yet: the app never picks one.
    internal static class RouteDialog
    {
        public static string Ask(IWin32Window owner, string model, List<string> routes, string current, bool enabled)
        {
            using (var form = new Form())
            {
                form.Text = "Video billing route";
                form.FormBorderStyle = FormBorderStyle.FixedDialog;
                form.StartPosition = FormStartPosition.CenterParent;
                form.MinimizeBox = false;
                form.MaximizeBox = false;
                form.ShowInTaskbar = false;
                form.ClientSize = new Size(500, 248);
                form.Font = Theme.Ui(9.5f);
                var label = new GlassLabel { Text = "Charge " + model + " to:", Left = 20, Top = 18, AutoSize = true, Font = Theme.Ui(10.5f, FontStyle.Bold) };
                var combo = new ComboBox { Left = 20, Top = 50, Width = 460, DropDownStyle = ComboBoxStyle.DropDownList, TabIndex = 0, AccessibleName = "Billing route for " + model };
                foreach (var route in routes)
                {
                    combo.Items.Add(new Choice(route, VideoSettings.RouteName(route) + " \u00B7 billed in " + VideoSettings.Units(route)));
                    if (route == current) combo.SelectedIndex = combo.Items.Count - 1;
                }
                var note = new GlassLabel
                {
                    Text = "One route for each model. A paid job is never retried automatically or moved to another route.\r\n\r\nSaving a route does not check a sign-in, a key or a price, and charges nothing."
                        + (enabled ? "" : " The model stays switched off."),
                    Left = 20,
                    Top = 92,
                    Size = new Size(460, 92),
                    ForeColor = Theme.Muted
                };
                var ok = Skin.Primary(new PillButton { Text = "Save route", Left = 248, Top = 194, Width = 128, Height = 38, DialogResult = DialogResult.OK, TabIndex = 1, Enabled = combo.SelectedIndex >= 0 });
                var cancel = new PillButton { Text = "Cancel", Left = 388, Top = 194, Width = 92, Height = 38, DialogResult = DialogResult.Cancel, TabIndex = 2 };
                combo.SelectedIndexChanged += (s, e) => ok.Enabled = combo.SelectedIndex >= 0;
                form.Controls.AddRange(new System.Windows.Forms.Control[] { label, combo, note, ok, cancel });
                form.AcceptButton = ok;
                form.CancelButton = cancel;
                Skin.Apply(form);
                var chosen = form.ShowDialog(owner) == DialogResult.OK ? combo.SelectedItem as Choice : null;
                return chosen == null ? null : chosen.Key;
            }
        }
    }

    // The danger zone for limit resets: shows how many are left, what they would
    // do, and refuses to return a choice until the user types CONFIRM.
    internal static class ResetDialog
    {
        private const string Phrase = "RESET";

        public static Dictionary<string, object> Choose(IWin32Window owner, string label, string email, ArrayList credits, ArrayList windows, int available)
        {
            using (var form = new Form())
            {
                form.Text = "Danger zone: use a limit reset";
                form.FormBorderStyle = FormBorderStyle.FixedDialog;
                form.StartPosition = FormStartPosition.CenterParent;
                form.MinimizeBox = false;
                form.MaximizeBox = false;
                form.ShowInTaskbar = false;
                form.Font = Theme.Ui(9.5f);
                form.ClientSize = new Size(560, 560);

                var body = Glass.Make(new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(22, 18, 22, 10), Margin = new Padding(0) }, 22, true);
                var holder = new Panel { Dock = DockStyle.Fill, Padding = new Padding(14, 14, 14, 0) };
                holder.Controls.Add(body);

                // The banner that makes the risk unmistakable.
                var banner = new Panel { AutoSize = true, BackColor = Theme.BadDim, Padding = new Padding(12, 10, 12, 10), Margin = new Padding(0, 0, 0, 12) };
                var bannerText = new GlassLabel
                {
                    Text = string.Format("\u26A0  DANGER ZONE\r\nUsing a reset spends it for good. There is no undo, and it cannot be moved to another account.\r\n{0} {1} left on this account.", available, available == 1 ? "reset" : "resets"),
                    AutoSize = true,
                    MaximumSize = new Size(470, 0),
                    ForeColor = Theme.Bad,
                    Font = Theme.Ui(9.5f)
                };
                banner.Controls.Add(bannerText);
                body.Controls.Add(banner);
                body.Controls.Add(new GlassLabel { Text = label + " \u00B7 " + email, AutoSize = true, Font = Theme.Ui(12f, FontStyle.Bold), Margin = new Padding(0, 0, 0, 6) });
                body.Controls.Add(new GlassLabel { Text = "A reset makes your used-up limits full again straight away. ChatGPT keeps it only if you have nothing used up.", AutoSize = true, MaximumSize = new Size(470, 0), ForeColor = Theme.Muted, Margin = new Padding(0, 0, 0, 10) });
                foreach (var item in windows)
                {
                    var w = Json.Obj(item);
                    if (Json.Get(w, "reported") is bool && !Json.Bool(w, "reported")) continue;
                    var left = Json.Num(w, "leftPercent", 0);
                    body.Controls.Add(new GlassLabel { Text = string.Format("Now: {0} {1:0}% left \u00B7 {2}", Json.Str(Json.Get(w, "title")), left, Format.Reset(Json.Str(Json.Get(w, "resetsAt")))), AutoSize = true, ForeColor = Theme.ForLeft(left), Margin = new Padding(0, 0, 0, 2) });
                }
                body.Controls.Add(new GlassLabel { Text = "Resets you have:", AutoSize = true, Font = Theme.Ui(9.5f, FontStyle.Bold), Margin = new Padding(0, 12, 0, 4) });

                Dictionary<string, object> picked = null;
                foreach (var item in credits)
                {
                    var credit = Json.Obj(item);
                    var expires = Format.ParseTime(Json.Str(Json.Get(credit, "expiresAt")));
                    var detail = Json.Str(Json.Get(credit, "description"));
                    if (expires.HasValue) detail = (detail.Length > 0 ? detail + " \u00B7 " : "") + "expires " + expires.Value.ToString("d MMM yyyy", CultureInfo.CurrentCulture);
                    var choice = new GlassRadio { Text = Json.Str(Json.Get(credit, "title")), AutoSize = true, Tag = credit, Margin = new Padding(0, 2, 0, 0), Font = Theme.Ui(9.5f, FontStyle.Bold) };
                    choice.CheckedChanged += (s, e) => { if (choice.Checked) picked = (Dictionary<string, object>)choice.Tag; };
                    body.Controls.Add(choice);
                    if (detail.Length > 0) body.Controls.Add(new GlassLabel { Text = detail, AutoSize = true, MaximumSize = new Size(450, 0), ForeColor = Theme.Muted, Margin = new Padding(18, 0, 0, 6) });
                    if (picked == null) choice.Checked = true;
                }

                if (credits.Count == 0) body.Controls.Add(new GlassLabel { Text = "ChatGPT did not name the reset; the next one available would be used.", AutoSize = true, MaximumSize = new Size(450, 0), ForeColor = Theme.Muted, Margin = new Padding(0, 6, 0, 0) });
                body.Controls.Add(new GlassLabel { Text = string.Format("Type {0} to confirm:", Phrase), AutoSize = true, Font = Theme.Ui(9.5f, FontStyle.Bold), ForeColor = Theme.Bad, Margin = new Padding(0, 14, 0, 4) });
                var typing = new TextBox { Width = 180, Font = Theme.Mono(12f), Margin = new Padding(0, 0, 0, 2) };
                body.Controls.Add(typing);

                var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Height = 60, Padding = new Padding(14, 10, 14, 10) };
                var cancel = new PillButton { Text = "Cancel", Width = 104, Height = 38, DialogResult = DialogResult.Cancel };
                var spend = Skin.DangerStrong(new PillButton { Text = "Use this reset", Width = 150, Height = 38, DialogResult = DialogResult.OK, Enabled = false });
                buttons.Controls.Add(cancel);
                buttons.Controls.Add(spend);
                typing.TextChanged += (s, e) => spend.Enabled = string.Equals(typing.Text.Trim(), Phrase, StringComparison.Ordinal);
                form.Controls.Add(holder);
                form.Controls.Add(buttons);
                form.AcceptButton = spend;
                form.CancelButton = cancel;
                form.Shown += (s, e) => typing.Focus();
                Skin.Apply(form);
                // An empty object means "confirmed, ChatGPT picks the reset".
                return form.ShowDialog(owner) == DialogResult.OK ? (picked ?? new Dictionary<string, object>()) : null;
            }
        }
    }

    // Asks for an API key without showing it.
    internal static class KeyDialog
    {
        public static string Ask(IWin32Window owner, string provider)
        {
            using (var form = new Form())
            {
                form.Text = "API key";
                form.FormBorderStyle = FormBorderStyle.FixedDialog;
                form.StartPosition = FormStartPosition.CenterParent;
                form.MinimizeBox = false;
                form.MaximizeBox = false;
                form.ClientSize = new Size(440, 150);
                form.Font = Theme.Ui(9f);
                var label = new GlassLabel { Text = "API key for " + provider + ":", Left = 20, Top = 18, AutoSize = true };
                var box = new TextBox { Left = 20, Top = 44, Width = 400, UseSystemPasswordChar = true };
                var ok = Skin.Primary(new PillButton { Text = "Save", Left = 228, Top = 96, Width = 92, Height = 38, DialogResult = DialogResult.OK });
                var cancel = new PillButton { Text = "Cancel", Left = 328, Top = 96, Width = 92, Height = 38, DialogResult = DialogResult.Cancel };
                form.Controls.AddRange(new System.Windows.Forms.Control[] { label, box, ok, cancel });
                form.AcceptButton = ok;
                form.CancelButton = cancel;
                Skin.Apply(form);
                return form.ShowDialog(owner) == DialogResult.OK ? box.Text.Trim() : null;
            }
        }
    }

    // "Start with Windows": a value under the current user's Run key.
    internal static class Autostart
    {
        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string Name = "DSHProxy";

        public static bool IsOn()
        {
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey)) return key != null && key.GetValue(Name) != null;
        }

        public static void Set(bool on)
        {
            using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (on) key.SetValue(Name, "\"" + Application.ExecutablePath + "\" --hidden");
                else key.DeleteValue(Name, false);
            }
        }
    }
}
