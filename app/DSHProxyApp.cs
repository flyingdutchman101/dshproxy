// DeepSeekProxy (DSHProxy) for Windows: a window and tray icon that run and control the gateway.
//
// The app owns no gateway logic. It starts `node bin/dshproxy.js start` as a
// hidden child process, reads `dshproxy status --json`, and talks to the
// running gateway's local control API for sign-in, accounts and limits. Built
// with the C# compiler that ships with Windows (see app/build.ps1), so the
// code stays within C# 5.

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
            var parts = new List<string> { Quote(Path.Combine(Root, "bin", "dshproxy.js")) };
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
            using (var process = Process.Start(Info(args)))
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

        // Starts the long-running gateway, hidden.
        public Process StartHidden(string[] args)
        {
            var info = Info(args);
            info.RedirectStandardInput = false;
            return Process.Start(info);
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
            body.Controls.Clear();
            buttons.Controls.Clear();
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
                var codeLabel = new GlassLabel { Text = code, AutoSize = true, Font = Theme.Mono(22f, FontStyle.Bold), ForeColor = Theme.Accent, Margin = new Padding(0, 4, 16, 0) };
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
        private bool refreshing;
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
        private readonly Panel accountsPanel = new Panel { Dock = DockStyle.Fill, AutoScroll = true, Padding = new Padding(0, 4, 0, 4) };
        private readonly Label limitsNote = new GlassLabel { AutoSize = true, ForeColor = Theme.Muted, Padding = new Padding(0, 8, 0, 0) };
        private readonly ListView keysList = new DarkList();
        private readonly ComboBox keyProviderCombo = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200 };
        private readonly ComboBox keyRegionCombo = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 220 };
        private readonly ListView lanesList = new DarkList();
        private readonly ListView modelsList = new DarkList();
        private readonly Label modelsNote = new GlassLabel { AutoSize = true, ForeColor = Theme.Muted, Padding = new Padding(0, 8, 0, 0) };
        private readonly FlowLayoutPanel suggestionsPanel = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(14, 8, 14, 8), Margin = new Padding(0, 0, 0, 8), Visible = false };
        private readonly FlowLayoutPanel updateBar = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Padding = new Padding(18, 8, 18, 8), Visible = false };
        private readonly Label updateLabel = new GlassLabel { AutoSize = true, Margin = new Padding(0, 8, 12, 0) };
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
            Width = 1000;
            Height = 760;
            MinimumSize = new Size(860, 600);
            StartPosition = FormStartPosition.CenterScreen;
            Font = Theme.Ui(9.5f);
            Icon = AppIcon.Load(SystemInformation.IconSize);

            BuildLayout();
            BuildTray();
            Skin.Apply(this);

            // Dragging the window edge to a new size: show a stretched snapshot
            // of the window and lay out again when the drag ends. Rebuilding the
            // glass for every dragged pixel is what tore the window apart.
            ResizeBegin += (s, e) => BeginResizePreview();
            ResizeEnd += (s, e) => EndResizePreview();
            Resize += (s, e) => { if (resizePreview != null) { resizeWatchdog.Stop(); resizeWatchdog.Start(); } };

            startButton.Click += (s, e) => StartGateway();
            stopButton.Click += (s, e) => StopGateway();
            autostartBox.Checked = Autostart.IsOn();
            autostartBox.CheckedChanged += (s, e) => Autostart.Set(autostartBox.Checked);

            timer.Interval = 3000;
            timer.Tick += (s, e) => RefreshStatus();
            limitsTimer.Interval = 60000;
            limitsTimer.Tick += (s, e) => LoadLimits(false);
            Shown += (s, e) => OnShownOnce();
            // --tab <n>: open on that tab (used to check the layout).
            var args = Environment.GetCommandLineArgs();
            var tabArg = Array.IndexOf(args, "--tab");
            int tabIndex;
            if (tabArg >= 0 && tabArg + 1 < args.Length && int.TryParse(args[tabArg + 1], out tabIndex) && tabIndex >= 0 && tabIndex < tabs.TabPages.Count) tabs.SelectedIndex = tabIndex;
            FormClosing += OnClosing;
            accountsPanel.Resize += (s, e) => FitCards();
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
                BeginInvoke(new Action(() => { RefreshStatus(); timer.Start(); }));
                return;
            }
            BeginInvoke(new Action(() =>
            {
                StartGateway();
                RefreshStatus();
                timer.Start();
                limitsTimer.Start();
            }));
        }

        // ---------- layout ----------

        private static FlowLayoutPanel Row(params System.Windows.Forms.Control[] controls)
        {
            var row = new FlowLayoutPanel { Dock = DockStyle.Bottom, AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = true, Padding = new Padding(0, 10, 0, 0) };
            foreach (var item in controls) row.Controls.Add(item);
            return row;
        }

        private static Label Note(string text)
        {
            return new GlassLabel { Text = text, Dock = DockStyle.Top, AutoSize = false, Height = 40, ForeColor = Theme.Muted, Padding = new Padding(0, 2, 0, 0) };
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
            header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

            var mark = new AppMark { Size = new Size(60, 60), Margin = new Padding(0, 0, 16, 0) };
            var big = AppIcon.Load(new Size(64, 64));
            if (big != null) mark.Picture = big.ToBitmapExact(64, Color.Black);
            header.Controls.Add(mark, 0, 0);

            var text = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, Dock = DockStyle.Fill, WrapContents = false, Margin = new Padding(0) };
            var nameRow = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, WrapContents = false, Margin = new Padding(0) };
            nameRow.Controls.Add(new GlassLabel { Text = "DeepSeekProxy", AutoSize = true, Font = Theme.Light(22f), ForeColor = Theme.Text, Margin = new Padding(0, 0, 0, 0) });
            nameRow.Controls.Add(stateLabel);
            text.Controls.Add(nameRow);
            text.Controls.Add(detailLabel);
            text.Controls.Add(lowestLabel);
            header.Controls.Add(text, 1, 0);

            var buttons = new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Anchor = AnchorStyles.Right | AnchorStyles.Top, Margin = new Padding(0, 8, 0, 0) };
            buttons.Controls.Add(startButton);
            buttons.Controls.Add(stopButton);
            header.Controls.Add(buttons, 2, 0);
            return header;
        }

        // The status pill next to the app name.
        private void ShowState(string text, Color color)
        {
            SetText(stateLabel, text);
            if (stateLabel.Tint != color) stateLabel.Tint = color;
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
            lanesTop.Controls.Add(Note("A lane tries each model in order until one answers. Green: can serve. Amber: sitting out after running out of quota. Red: no account or key."), 0, 0);
            lanesTop.Controls.Add(presetRow, 0, 1);
            lanesTop.Controls.Add(presetNote, 0, 2);
            tabs.TabPages.Add(Page("Lanes", lanesList, lanesTop, Row(editLanes)));


            // Models
            modelsList.View = View.Details;
            modelsList.CheckBoxes = true;
            foreach (var c in new[] { new object[] { "Model", 210 }, new object[] { "Service", 140 }, new object[] { "Context", 80 }, new object[] { "Output", 75 }, new object[] { "Reasoning", 165 }, new object[] { "Status", 200 } }) modelsList.Columns.Add((string)c[0], (int)c[1]);
            modelsList.FullRowSelect = true;
            modelsList.Dock = DockStyle.Fill;
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
            modelsList.BringToFront();
            tabs.TabPages.Add(modelsPage);

            // DeepSeek Harness
            profilesList.View = View.Details;
            foreach (var c in new[] { "Profile", "Routes", "Models", "Points at this gateway" }) profilesList.Columns.Add(c, 200);
            profilesList.FullRowSelect = true;
            profilesList.Dock = DockStyle.Fill;
            var preview = new PillButton { Text = "Preview changes", AutoSize = true };
            preview.Click += (s, e) => RunAndShow(new[] { "dsh", "apply", "--dry-run" }, "Preview", false);
            var apply = Skin.Primary(new PillButton { Text = "Apply to DeepSeek Harness", AutoSize = true });
            apply.Click += (s, e) => ApplyToHarness();
            var verify = Skin.Outline(new PillButton { Text = "Verify", AutoSize = true });
            verify.Click += (s, e) => VerifyHarness();
            var remove = Skin.Danger(new PillButton { Text = "Remove from DeepSeek Harness", AutoSize = true });
            remove.Click += (s, e) => RemoveFromHarness();
            tabs.TabPages.Add(Page("DeepSeek Harness", profilesList,
                Note("Apply writes the DSHProxy routes into every DeepSeek Harness profile and keeps everything else. Verify checks the profiles back: routes, models, default model and credential. Restart DeepSeek Harness after a change."),
                Row(preview, apply, verify, remove)));

            // Log
            var logPage = new Panel { Text = "Log", Padding = new Padding(22, 8, 22, 14) };
            logPage.Controls.Add(Framed(logBox));
            logBox.BorderStyle = BorderStyle.None;
            var openLogFolder = new PillButton { Text = "Open data folder", AutoSize = true };
            openLogFolder.Click += (s, e) => OpenFolder("");
            logPage.Controls.Add(Row(openLogFolder));
            tabs.TabPages.Add(logPage);

            tabs.SelectedIndexChanged += (s, e) =>
            {
                // A control on a hidden page must not keep the focus: WinForms
                // then scrolls its AutoScroll panel on the way back, which looks
                // like the page jumping.
                if (navStrip != null) navStrip.Focus();
                if (tabs.SelectedIndex == 0)
                {
                    accountsPanel.AutoScrollPosition = Point.Empty;
                    LoadLimits(false);
                }
            };

            var bottom = new TableLayoutPanel { Dock = DockStyle.Bottom, Height = 42, ColumnCount = 2, Padding = new Padding(22, 8, 22, 8) };
            bottom.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            bottom.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            footer.Margin = new Padding(0, 5, 0, 0);
            bottom.Controls.Add(footer, 0, 0);
            bottom.Controls.Add(autostartBox, 1, 0);
            
            var nav = new NavStrip(tabs);
            navStrip = nav;
            Controls.Add(tabs);
            Controls.Add(nav);
            Controls.Add(updateBar);
            Controls.Add(bottom);
            Controls.Add(header);
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
            menu.Items.Add("Stop gateway", null, (s, e) => StopGateway());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit", null, (s, e) => Quit());
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += (s, e) => ShowWindow();
            tray.BalloonTipClicked += (s, e) => { ShowWindow(); tabs.SelectedIndex = 0; };
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
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(lastOrigin + "/dshproxy/status");
                request.Timeout = 1500;
                using (var response = (HttpWebResponse)request.GetResponse()) return (int)response.StatusCode == 200;
            }
            catch (WebException) { return false; }
        }

        private void StartGateway()
        {
            if (ReadOnly) return;
            if (gateway != null && !gateway.HasExited) return;
            if (GatewayAnswers())
            {
                AppendLog("A gateway is already running on " + lastOrigin + "; showing its status.");
                return;
            }
            try
            {
                gateway = cli.StartHidden(new[] { "start" });
                gateway.EnableRaisingEvents = true;
                gateway.OutputDataReceived += (s, e) => AppendLog(e.Data);
                gateway.ErrorDataReceived += (s, e) => AppendLog(e.Data);
                gateway.Exited += (s, e) => AppendLog("Gateway stopped.");
                gateway.BeginOutputReadLine();
                gateway.BeginErrorReadLine();
                AppendLog("Starting the gateway...");
            }
            catch (System.ComponentModel.Win32Exception error)
            {
                AppendLog("Could not start the gateway: " + error.Message);
            }
        }

        private void StopGateway()
        {
            if (ReadOnly) return;
            if (gateway == null || gateway.HasExited)
            {
                if (GatewayAnswers()) AppendLog("The running gateway was not started by this window. Stop it from the window it was started in.");
                return;
            }
            // Stops the gateway and the backend it started.
            try
            {
                var kill = Process.Start(new ProcessStartInfo("taskkill.exe", "/PID " + gateway.Id + " /T /F") { CreateNoWindow = true, UseShellExecute = false });
                kill.WaitForExit(10000);
            }
            catch (System.ComponentModel.Win32Exception error)
            {
                AppendLog("Could not stop the gateway: " + error.Message);
            }
            gateway = null;
            try { File.Delete(Path.Combine(GatewayControl.Home(), "control.token")); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }

        // ---------- status ----------

        private void RefreshStatus()
        {
            Dbg.Write("tick start");
            RefreshStatusCore();
            Dbg.Write("tick end");
        }

        private void RefreshStatusCore()
        {
            if (refreshing) return;
            refreshing = true;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Cli.Result result;
                try { result = cli.Run(new[] { "status", "--json" }, null, 20000); }
                catch (Exception error) { result = new Cli.Result { Code = -1, Out = "", Err = error.Message }; }
                try { BeginInvoke(new Action(() => { refreshing = false; ShowStatus(result); })); }
                catch (InvalidOperationException) { refreshing = false; }
            });
        }

        private void ShowStatus(Cli.Result result)
        {
            if (result.Code != 0)
            {
                // A single slow or failed poll must not wipe the window: doing so
                // made the cards and lists flash every few seconds.
                failedPolls++;
                if (failedPolls < 3) return;
                ShowState("Status unavailable", Theme.Bad);
                SetText(detailLabel, result.Err.Trim());
                return;
            }
            failedPolls = 0;
            Dictionary<string, object> status;
            try { status = Json.Obj(Json.Serializer.DeserializeObject(result.Out)); }
            catch (ArgumentException) { return; }

            var wasRunning = running;
            running = Json.Bool(status, "running");
            lastOrigin = Json.Str(Json.Get(status, "origin"));
            var backend = Json.Obj(Json.Get(status, "backend"));
            var models = Json.Arr(Json.Get(status, "models"));
            var accountCount = Json.Arr(Json.Get(status, "accounts")).Count;

            ShowState(running ? "\u25CF Running" : "\u25CF Stopped", running ? Theme.Ok : Theme.Bad);
            SetText(detailLabel, running
                ? string.Format("{0}  \u00B7  {1} {2}  \u00B7  {3} account{4}  \u00B7  {5} models offered", lastOrigin, Json.Str(Json.Get(backend, "name")), Json.Str(Json.Get(backend, "version")), accountCount, accountCount == 1 ? "" : "s", models.Count)
                : "The gateway is not running. Press Start.");
            startButton.Enabled = !running;
            stopButton.Enabled = running;
            tray.Text = running ? "DSHProxy: running" : "DSHProxy: stopped";
            SetText(footer, "Data: " + Json.Str(Json.Get(status, "home")) + "    Program: " + cli.Root + "    Build: " + BuildInfo.Stamp);
            loginProviders = Json.Arr(Json.Get(status, "loginProviders"));

            if (running && !wasRunning) LoadLimits(false);
            // Only speak up when the gateway actually went down, not on every
            // poll that reports it: replacing the cards each tick was a flash.
            if (!running && wasRunning) ShowAccountsMessage("The gateway is not running. Press Start to see accounts and limits.", Theme.Muted);

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
            accountsPanel.Controls.Clear();
            accountsPanel.Controls.Add(new GlassLabel { Text = text, Dock = DockStyle.Top, Height = 60, ForeColor = color, TextAlign = ContentAlignment.MiddleCenter, Font = Theme.Ui(10f) });
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
            accountsPanel.Controls.Clear();
            if (accounts.Count == 0)
            {
                ShowAccountsMessage("No accounts yet. Press \"+ Add account\" to sign in to Claude, ChatGPT, Gemini or Kimi.", Theme.Muted);
                lowestLabel.Text = "";
                accountsPanel.ResumeLayout();
                return;
            }
            string lowestText = null;
            double lowest = 101;
            // Docked to the top, so they are added last-first.
            for (var index = accounts.Count - 1; index >= 0; index -= 1)
            {
                var account = Json.Obj(accounts[index]);
                accountsPanel.Controls.Add(new Panel { Dock = DockStyle.Top, Height = 14 });
                accountsPanel.Controls.Add(BuildCard(account));
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
            lowestLabel.Text = lowestText ?? "";
            lowestLabel.ForeColor = lowestText == null ? Theme.Muted : Theme.ForLeft(lowest);
            accountsPanel.ResumeLayout();
            FitCards();
        }

        // Cards keep a readable width on a wide monitor instead of stretching
        // the meters across the whole screen.
        private const int MaxCardWidth = 1600;

        private void FitCards()
        {
            // The cards are docked, so their width comes from this padding. They
            // line up with the page text and stop growing on a wide monitor.
            var available = accountsPanel.ClientSize.Width;
            var left = accountsPanel.Padding.Left;
            var right = Math.Max(left, available - left - MaxCardWidth);
            if (accountsPanel.Padding.Right != right) accountsPanel.Padding = new Padding(left, 4, right, 4);
        }

        private TableLayoutPanel BuildCard(Dictionary<string, object> account)
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

            var title = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Margin = new Padding(0, 0, 0, 6) };
            var logo = Logos.Sized(Json.Str(Json.Get(account, "provider")), 24);
            if (logo != null) title.Controls.Add(new GlassPicture { Image = logo, Size = new Size(24, 24), Margin = new Padding(0, 1, 8, 0) });
            title.Controls.Add(new GlassLabel { Text = label, AutoSize = true, Font = Theme.Ui(11f, FontStyle.Bold), Margin = new Padding(0, 2, 8, 0) });
            title.Controls.Add(new GlassLabel { Text = email, AutoSize = true, Font = Theme.Ui(10f), ForeColor = Theme.Muted, Margin = new Padding(0, 4, 10, 0) });
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

            var row = 1;
            foreach (var item in windows)
            {
                var w = Json.Obj(item);
                var reported = !(Json.Get(w, "reported") is bool) || Json.Bool(w, "reported");
                var left = Json.Num(w, "leftPercent", 0);
                card.Controls.Add(new GlassLabel { Text = Json.Str(Json.Get(w, "title")), AutoSize = true, Margin = new Padding(0, 4, 0, 4), Font = Theme.Ui(9.5f), ForeColor = reported ? Theme.Text : Theme.Muted }, 0, row);
                if (reported)
                {
                    card.Controls.Add(new Meter { LeftPercent = left, Dock = DockStyle.Fill }, 1, row);
                    card.Controls.Add(new GlassLabel { Text = string.Format("{0:0}% left \u00B7 {1}", left, Format.Reset(Json.Str(Json.Get(w, "resetsAt")))), AutoSize = true, MinimumSize = new Size(330, 0), ForeColor = Theme.ForLeft(left), Margin = new Padding(0, 4, 0, 4) }, 2, row);
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
                var useReset = Skin.DangerStrong(new PillButton { Text = "Use a reset\u2026", AutoSize = true });
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
            foreach (var m in visible)
            {
                var reason = Json.Str(Json.Get(m, "reason"));
                var offered = Json.Bool(m, "offered");
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
                var row = new ListViewItem(new[]
                {
                    Json.Str(Json.Get(m, "id")),
                    service ?? Json.Str(Json.Get(m, "account")),
                    Tokens(Json.Num(m, "contextWindow", 0)),
                    Tokens(Json.Num(m, "maxTokens", 0)),
                    efforts.Count > 0 ? string.Join(", ", efforts.ToArray()) : "none",
                    label
                })
                {
                    Checked = offered,
                    Tag = Json.Str(Json.Get(m, "id")),
                    ImageKey = Json.Str(Json.Get(m, "account")),
                    ToolTipText = Json.Str(Json.Get(m, "name"))
                };
                if (reason == "new" && offered) { row.ForeColor = Theme.Accent; row.Font = new Font(modelsList.Font, FontStyle.Bold); }
                else if (!offered) row.ForeColor = Theme.Muted;
                modelsList.Items.Add(row);
            }
            modelsList.EndUpdate();
            fillingModels = false;
        }

        private void OnModelChecked(ItemCheckEventArgs e)
        {
            if (fillingModels) return;
            var id = modelsList.Items[e.Index].Tag as string;
            if (id == null) return;
            if (!running)
            {
                e.NewValue = e.CurrentValue;
                Msg.Show(this, "Start the gateway first.", "Models", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            var on = e.NewValue == CheckState.Checked;
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
            suggestionsPanel.Controls.Clear();
            foreach (var item in list)
            {
                var s = Json.Obj(item);
                var from = Json.Str(Json.Get(s, "from"));
                var to = Json.Str(Json.Get(s, "to"));
                var lanes = new List<string>();
                foreach (var l in Json.Arr(Json.Get(s, "lanes"))) lanes.Add(Json.Str(l));
                var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Margin = new Padding(0, 2, 0, 2) };
                row.Controls.Add(new GlassLabel { Text = string.Format("Newer model: {0} could replace {1} on lane {2}.", to, from, string.Join(", ", lanes.ToArray())), AutoSize = true, Margin = new Padding(0, 7, 10, 0) });
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

        private void ApplyToHarness()
        {
            if (Msg.Show(this, "Write the DSHProxy routes into every DeepSeek Harness profile?\n\nEach profile is backed up first, and nothing else in it is changed. Restart DeepSeek Harness afterwards.", "DeepSeek Harness", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            RunAndShow(new[] { "dsh", "apply" }, "DeepSeek Harness", false);
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
                        if (Msg.Show(this, text + "\n\nRestart the gateway now so it uses the change?", title, MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes)
                        {
                            StopGateway();
                            StartGateway();
                        }
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
