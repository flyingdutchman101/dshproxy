// The DeepSeekProxy look: dark "liquid glass" in emerald and teal. Every
// window has a soft glowing backdrop; panels are frosted glass that show the
// backdrop behind them; buttons and tabs are glass pills. Built for .NET
// Framework 4.8 WinForms and the C# 5 compiler that ships with Windows.
//
// WinForms cannot blur what is behind a control, so the backdrop is drawn
// already soft (rendered small and scaled up), and each glass surface paints
// the part of it that lies behind it, then a translucent fill and a lit edge.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace DSHProxy
{
    internal static class Theme
    {
        // Maritime palette: night sea and wet teak for the surfaces, sea spray
        // for text, brass for the fittings.
        public static readonly Color Page = Hex("#02101A");      // window base under the backdrop
        public static readonly Color Card = Hex("#0A2230");      // solid stand-in for glass
        public static readonly Color Input = Hex("#061824");     // text boxes, drop-downs
        public static readonly Color GlassDeep = Hex("#04121C"); // the log
        public static readonly Color Raised = Hex("#0D2B39");
        public static readonly Color Hover = Hex("#12374A");
        public static readonly Color Border = Color.FromArgb(46, 255, 255, 255);
        public static readonly Color Track = Color.FromArgb(26, 255, 255, 255);

        // Text: sea spray.
        public static readonly Color Text = Hex("#F5FCFB");
        public static readonly Color Muted = Hex("#B4CCD4");

        // Brass (primary actions), sea glass (accents) and the deck.
        public static readonly Color Accent = Hex("#E4B26A");
        public static readonly Color AccentHover = Hex("#F3CB8B");
        public static readonly Color AccentDeep = Hex("#B8873F");
        public static readonly Color AccentInk = Hex("#1E1403");
        public static readonly Color AccentDim = Hex("#15303E");
        public static readonly Color Teal = Hex("#57D9C9");
        public static readonly Color GlassBase = Hex("#04161D");
        public static readonly Color Banner = AccentDim;

        // Navigation lights: starboard green, brass amber, port red.
        public static readonly Color Ok = Hex("#5BDCA8");
        public static readonly Color Warn = Hex("#F2C14E");
        public static readonly Color Bad = Hex("#F27C6C");
        public static readonly Color BadDim = Hex("#3A1A18");

        public static Color ForLeft(double left)
        {
            if (left <= 10) return Bad;
            if (left <= 30) return Warn;
            return Ok;
        }

        public static Color Alpha(Color c, int alpha)
        {
            return Color.FromArgb(Math.Max(0, Math.Min(255, alpha)), c.R, c.G, c.B);
        }

        private static Color Hex(string hex)
        {
            return ColorTranslator.FromHtml(hex);
        }

        private static readonly HashSet<string> Installed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        static Theme()
        {
            foreach (var family in FontFamily.Families) Installed.Add(family.Name);
        }

        private static string Pick(params string[] names)
        {
            foreach (var name in names) if (Installed.Contains(name)) return name;
            return "Segoe UI";
        }

        public static Font Ui(float size, FontStyle style = FontStyle.Regular)
        {
            return new Font(size >= 12f ? Pick("Segoe UI Variable Display", "Segoe UI") : Pick("Segoe UI Variable Text", "Segoe UI"), size, style);
        }

        // Large, light headings.
        public static Font Light(float size)
        {
            return new Font(Pick("Segoe UI Variable Display Light", "Segoe UI Light", "Segoe UI"), size, FontStyle.Regular);
        }

        public static Font Mono(float size, FontStyle style = FontStyle.Regular)
        {
            return new Font(Pick("Cascadia Mono", "Consolas"), size, style);
        }
    }

    internal static class SkinExtensions
    {
        public static Color Blend(this Color top, Color under)
        {
            var a = top.A / 255f;
            return Color.FromArgb((int)(top.R * a + under.R * (1 - a)), (int)(top.G * a + under.G * (1 - a)), (int)(top.B * a + under.B * (1 - a)));
        }

        [DllImport("user32.dll")]
        private static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int width, int height, int step, IntPtr brush, int flags);

        // The icon frame closest to `size`, drawn by Windows (GDI+ cannot decode
        // the PNG frames modern .ico files hold), with transparency kept.
        public static Bitmap ToBitmapExact(this Icon icon, int size, Color background)
        {
            var bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bitmap))
            {
                g.Clear(background);
                var dc = g.GetHdc();
                try { DrawIconEx(dc, 0, 0, icon.Handle, size, size, 0, IntPtr.Zero, 3); }
                finally { g.ReleaseHdc(dc); }
            }
            return bitmap;
        }

        // Turns on control styles that are protected in WinForms.
        public static void Styles(this Control control, ControlStyles styles, bool on)
        {
            typeof(Control).GetMethod("SetStyle", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(control, new object[] { styles, on });
        }
    }

    // ---------------------------------------------------------------------
    // The backdrop: a deep night sky, dark top to bottom, scattered with stars.
    // Earlier versions had a horizon, a lit sea and a moon; on a full-screen
    // window those bands read as scaling artifacts, so the scene is one even
    // colour now and the glass does the rest.
    // ---------------------------------------------------------------------
    internal static class Backdrop
    {
        private static readonly Dictionary<Form, Bitmap> Cache = new Dictionary<Form, Bitmap>();
        private static readonly Dictionary<Form, Timer> Pending = new Dictionary<Form, Timer>();

        // Bumped whenever the cached scene changes, so glass caches rebuild.
        public static int Version { get; private set; }

        public static Bitmap For(Form form)
        {
            var size = form.ClientSize;
            if (size.Width < 1 || size.Height < 1) return null;
            Bitmap bitmap;
            if (Cache.TryGetValue(form, out bitmap) && bitmap.Size == size) return bitmap;
            if (bitmap != null)
            {
                // Mid-resize: bridge with the previous scene stretched to the new
                // size, then render the real one once the size settles. Rendering
                // at full resolution on every dragged pixel made maximizing hitch.
                var bridge = Scaled(bitmap, size);
                bitmap.Dispose();
                Cache[form] = bridge;
                Version++;
                Schedule(form);
                return bridge;
            }
            bitmap = Render(size);
            Cache[form] = bitmap;
            Version++;
            return bitmap;
        }

        private static void Schedule(Form form)
        {
            Timer timer;
            if (Pending.TryGetValue(form, out timer)) { timer.Stop(); timer.Start(); return; }
            timer = new Timer { Interval = 160 };
            timer.Tick += (s, e) =>
            {
                timer.Stop();
                Pending.Remove(form);
                var size = form.ClientSize;
                if (size.Width < 1 || size.Height < 1) return;
                Bitmap current;
                if (Cache.TryGetValue(form, out current) && current.Size == size) return;
                if (current != null) current.Dispose();
                Cache[form] = Render(size);
                Version++;
                form.Invalidate(true);
            };
            Pending[form] = timer;
            timer.Start();
        }

        private static Bitmap Scaled(Bitmap source, Size size)
        {
            var scaled = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppPArgb);
            using (var g = Graphics.FromImage(scaled))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                g.PixelOffsetMode = PixelOffsetMode.HighSpeed;
                g.DrawImage(source, new Rectangle(0, 0, size.Width, size.Height));
            }
            return scaled;
        }

        public static void Forget(Form form)
        {
            Timer timer;
            if (Pending.TryGetValue(form, out timer)) { timer.Stop(); timer.Dispose(); Pending.Remove(form); }
            Bitmap bitmap;
            if (Cache.TryGetValue(form, out bitmap)) { bitmap.Dispose(); Cache.Remove(form); Version++; }
        }

        private static void Blob(Graphics g, float cx, float cy, float rx, float ry, Color color)
        {
            using (var path = new GraphicsPath())
            {
                path.AddEllipse(cx - rx, cy - ry, rx * 2, ry * 2);
                using (var brush = new PathGradientBrush(path))
                {
                    brush.CenterColor = color;
                    brush.SurroundColors = new[] { Color.FromArgb(0, color) };
                    brush.FocusScales = new PointF(0.15f, 0.15f);
                    g.FillPath(brush, path);
                }
            }
        }

        private static Bitmap Render(Size size)
        {
            Dbg.Write("backdrop render");
            // One deep, even night colour top to bottom. Earlier versions had a
            // horizon, a lit sea and swell lines; at full-screen sizes the bands
            // read as scaling artifacts, and the bright lower half hurt contrast.
            var full = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppPArgb);
            using (var g = Graphics.FromImage(full))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.CompositingQuality = CompositingQuality.HighQuality;
                var w = (float)size.Width;
                var h = (float)size.Height;
                // A very slight vertical fall-off: lighter at the top, so the
                // window keeps some depth without any bands.
                using (var sky = new LinearGradientBrush(new RectangleF(0, 0, w, h), ColorTranslator.FromHtml("#061A24"), ColorTranslator.FromHtml("#020B11"), LinearGradientMode.Vertical)) g.FillRectangle(sky, 0, 0, w, h);
                // Stars only: no moon or glow, whose radial gradients band
                // visibly on a large dark surface.
                var random = new Random(1846);
                using (var star = new SolidBrush(Color.FromArgb(72, 0xE6, 0xF3, 0xF2)))
                {
                    for (var i = 0; i < 150; i++)
                    {
                        var sx = random.Next(size.Width);
                        var sy = random.Next((int)(h * 0.62f));
                        var big = random.Next(12) == 0;
                        g.FillRectangle(star, sx, sy, big ? 2 : 1, big ? 2 : 1);
                    }
                }
                return full;
            }
        }

        // Paints the backdrop of `form` into `g` for the area `clip` given in
        // the form's client coordinates.
        public static void Paint(Graphics g, Form form, Rectangle clip)
        {
            var bitmap = For(form);
            if (bitmap == null) return;
            var area = Rectangle.Intersect(clip, new Rectangle(Point.Empty, bitmap.Size));
            if (area.Width <= 0 || area.Height <= 0) return;
            g.DrawImage(bitmap, area, area, GraphicsUnit.Pixel);
        }
    }

    // ---------------------------------------------------------------------
    // Glass surfaces.
    // ---------------------------------------------------------------------
    internal static class Glass
    {
        private sealed class Surface
        {
            public int Radius;
            public bool Strong;
            public Color? Tint;
            // The backdrop plus this surface's own body, composed once and
            // reused: every child inside it then paints with a single blit
            // instead of re-blending the whole background on every repaint.
            public Bitmap Background;
            public Point BackgroundAt;
            public Size BackgroundSize;
            public int BackgroundVersion = -1;
        }

        private static readonly Dictionary<Control, Surface> Surfaces = new Dictionary<Control, Surface>();

        public static bool IsGlass(Control control)
        {
            return Surfaces.ContainsKey(control);
        }

        // Makes a panel a glass surface.
        public static T Make<T>(T control, int radius = 20, bool strong = false, Color? tint = null) where T : Control
        {
            if (Surfaces.ContainsKey(control)) return control;
            Surfaces[control] = new Surface { Radius = radius, Strong = strong, Tint = tint };
            control.Styles(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.ResizeRedraw, true);
            control.BackColor = Theme.Page;
            Skin.PaintsBehind(control);
            control.Paint += (s, e) =>
            {
                // The body is drawn by PaintBehind (which includes this surface
                // itself); drawing it again here would double the tint and leave
                // lighter patches wherever a child recomposed the background.
                var surface = Surfaces[control];
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                Edge(e.Graphics, new Rectangle(0, 0, control.Width - 1, control.Height - 1), surface.Radius);
            };
            control.Disposed += (s, e) =>
            {
                Surface surface;
                if (Surfaces.TryGetValue(control, out surface) && surface.Background != null) surface.Background.Dispose();
                Surfaces.Remove(control);
            };
            return control;
        }

        public static GraphicsPath Rounded(RectangleF r, float radius)
        {
            var path = new GraphicsPath();
            var d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
            if (d < 1) { path.AddRectangle(r); return path; }
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        // The body of a glass surface: a translucent fill and a sheen at the top.
        public static void Body(Graphics g, Rectangle r, int radius, bool strong, Color? tint = null)
        {
            using (var path = Rounded(r, radius))
            {
                var baseColor = tint.HasValue ? tint.Value : Theme.GlassBase;
                var alpha = tint.HasValue ? (strong ? 105 : 72) : (strong ? 178 : 150);
                using (var fill = new SolidBrush(Color.FromArgb(alpha, baseColor))) g.FillPath(fill, path);
                var sheenHeight = Math.Max(2, Math.Min(r.Height, 80));
                var sheen = new Rectangle(r.X, r.Y, r.Width, sheenHeight);
                using (var brush = new LinearGradientBrush(new Rectangle(sheen.X, sheen.Y - 1, sheen.Width, sheen.Height + 2), Color.FromArgb(strong ? 30 : 20, 255, 255, 255), Color.FromArgb(0, 255, 255, 255), 90f))
                {
                    var old = g.Clip;
                    g.SetClip(path, CombineMode.Intersect);
                    g.FillRectangle(brush, sheen);
                    g.Clip = old;
                }
            }
        }

        // The lit edge: bright at the top, faint at the bottom.
        public static void Edge(Graphics g, Rectangle r, int radius, Color? tint = null, int strength = 100)
        {
            using (var path = Rounded(r, radius))
            {
                var top = tint.HasValue ? Theme.Alpha(tint.Value, 230 * strength / 100) : Color.FromArgb(120 * strength / 100, 255, 255, 255);
                var bottom = tint.HasValue ? Theme.Alpha(tint.Value, 120 * strength / 100) : Color.FromArgb(28 * strength / 100, 255, 255, 255);
                using (var brush = new LinearGradientBrush(new Rectangle(r.X, r.Y - 1, Math.Max(1, r.Width), r.Height + 2), top, bottom, 90f))
                using (var pen = new Pen(brush, 1f)) g.DrawPath(pen, path);
            }
        }

        public static void Draw(Graphics g, Rectangle r, int radius, bool strong, bool edge)
        {
            Body(g, r, radius, strong);
            if (edge) Edge(g, r, radius);
        }

        // Paints what is behind `rect` of `control`: the backdrop and the
        // bodies of every glass surface it sits on. Used by native controls
        // (lists) that cannot be transparent.
        public static void PaintBehind(Graphics g, Control control, Rectangle rect)
        {
            var form = control.FindForm();
            if (form == null) { Dbg.Write("fallback fill " + control.GetType().Name); using (var b = new SolidBrush(Theme.Card)) g.FillRectangle(b, rect); return; }

            // Find the glass surface this control sits on (itself included).
            Control hostControl = null;
            Surface host = null;
            for (var c = control; c != null && c != form; c = c.Parent)
            {
                Surface candidate;
                if (Surfaces.TryGetValue(c, out candidate)) { host = candidate; hostControl = c; break; }
            }

            if (host != null)
            {
                var at = hostControl.PointToScreen(Point.Empty);
                var size = hostControl.ClientSize;
                var version = Backdrop.Version;
                if (host.Background == null || host.BackgroundAt != at || host.BackgroundSize != size || host.BackgroundVersion != version)
                {
                    Dbg.Write("glass cache rebuild " + hostControl.GetType().Name + " " + size.Width + "x" + size.Height);
                    if (host.Background != null) host.Background.Dispose();
                    host.Background = new Bitmap(Math.Max(1, size.Width), Math.Max(1, size.Height));
                    using (var bg = Graphics.FromImage(host.Background))
                        Compose(bg, hostControl, new Rectangle(0, 0, host.Background.Width, host.Background.Height));
                    host.BackgroundAt = at;
                    host.BackgroundSize = size;
                    host.BackgroundVersion = version;
                }
                var origin = control.PointToScreen(Point.Empty);
                var source = new Rectangle(origin.X - at.X + rect.X, origin.Y - at.Y + rect.Y, rect.Width, rect.Height);
                var cache = host.Background;
                if (source.X < 0 || source.Y < 0 || source.Right > cache.Width || source.Bottom > cache.Height)
                {
                    // Part of the control lies outside the cached surface (a control
                    // straddling a card edge). Blitting that slice would leave the
                    // uncovered part untouched, so compose it directly instead.
                    Compose(g, control, rect);
                    return;
                }
                var state = g.Save();
                g.SetClip(rect, CombineMode.Intersect);
                g.DrawImage(cache, new Rectangle(rect.X, rect.Y, rect.Width, rect.Height), source, GraphicsUnit.Pixel);
                g.Restore(state);
                return;
            }

            Compose(g, control, rect);
        }

        // Backdrop plus the bodies of every glass surface the control sits on,
        // drawn straight to the target. Used to build a surface's cache and for
        // controls that are not on a glass surface at all.
        private static void Compose(Graphics g, Control control, Rectangle rect)
        {
            var form = control.FindForm();
            if (form == null) { using (var b = new SolidBrush(Theme.Card)) g.FillRectangle(b, rect); return; }
            var origin = form.PointToClient(control.PointToScreen(Point.Empty));
            var state = g.Save();
            g.SetClip(rect, CombineMode.Intersect);
            g.TranslateTransform(-origin.X, -origin.Y);
            Backdrop.Paint(g, form, new Rectangle(rect.X + origin.X, rect.Y + origin.Y, rect.Width, rect.Height));
            g.Restore(state);

            var chain = new List<Control>();
            for (var c = control; c != null && c != form; c = c.Parent) if (Surfaces.ContainsKey(c)) chain.Insert(0, c);
            var mode = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            foreach (var glass in chain)
            {
                var surface = Surfaces[glass];
                var bounds = control.RectangleToClient(glass.RectangleToScreen(new Rectangle(0, 0, glass.Width - 1, glass.Height - 1)));
                var clip = g.Save();
                g.SetClip(rect, CombineMode.Intersect);
                Body(g, bounds, surface.Radius, surface.Strong, surface.Tint);
                g.Restore(clip);
            }
            g.SmoothingMode = mode;
        }
    }

    // ---------------------------------------------------------------------
    // Controls.
    // ---------------------------------------------------------------------

    // A glass pill button. Kind comes from Skin.Primary / Danger / Outline;
    // a button with an image is drawn as a glass tile instead.
    internal class PillButton : Button
    {
        private bool hover;
        private bool down;
        private Bitmap background;
        private Point backgroundAt;

        // The glass under a button almost never changes, so it is composed once
        // and reused: a hover then repaints one blit instead of re-composing the
        // backdrop, which is what flickered. The position is part of the key:
        // scrolling the page moves the button over a different part of the
        // backdrop, and a stale cache would leave a lighter patch behind it.
        private void Forget()
        {
            if (background != null) { background.Dispose(); background = null; }
            Invalidate();
        }

        private void PaintBackground(Graphics g)
        {
            var form = FindForm();
            var at = form == null ? Point.Empty : form.PointToClient(PointToScreen(Point.Empty));
            if (background == null || background.Width != Width || background.Height != Height || backgroundAt != at)
            {
                if (background != null) background.Dispose();
                background = new Bitmap(Math.Max(1, Width), Math.Max(1, Height));
                backgroundAt = at;
                using (var bg = Graphics.FromImage(background)) Glass.PaintBehind(bg, this, new Rectangle(0, 0, Width, Height));
            }
            g.DrawImageUnscaled(background, 0, 0);
        }

        public PillButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            Cursor = Cursors.Hand;
            ForeColor = Theme.Text;
        }

        protected override void OnLocationChanged(EventArgs e) { Forget(); base.OnLocationChanged(e); }
        protected override void OnParentChanged(EventArgs e) { Forget(); base.OnParentChanged(e); }
        protected override void OnVisibleChanged(EventArgs e) { Forget(); base.OnVisibleChanged(e); }
        protected override void OnResize(EventArgs e) { Forget(); base.OnResize(e); }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; down = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { down = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { down = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
        protected override void OnEnabledChanged(EventArgs e) { Cursor = Enabled ? Cursors.Hand : Cursors.Default; Invalidate(); base.OnEnabledChanged(e); }

        public override Size GetPreferredSize(Size proposed)
        {
            var text = TextRenderer.MeasureText(Text, Font);
            return new Size(text.Width + Padding.Horizontal + 28, Math.Max(36, text.Height + 16));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            PaintBackground(g);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var tile = Image != null;
            var r = new Rectangle(1, 1, Width - 2, Height - 2);
            var radius = tile ? 16 : r.Height / 2;
            var kind = Skin.KindOf(this);
            var focus = Focused && ShowFocusCues;
            Color text;

            if (!Enabled)
            {
                using (var path = Glass.Rounded(r, radius)) using (var fill = new SolidBrush(Color.FromArgb(10, 255, 255, 255))) g.FillPath(fill, path);
                Glass.Edge(g, r, radius, null, 40);
                text = Color.FromArgb(110, Theme.Muted);
            }
            else if (kind == ButtonKind.Primary)
            {
                var top = hover ? Theme.AccentHover : Theme.Accent;
                var bottom = down ? Theme.AccentDeep : Theme.Accent;
                using (var path = Glass.Rounded(r, radius))
                {
                    // A soft glow under the button.
                    using (var glow = new Pen(Color.FromArgb(hover ? 70 : 40, Theme.Accent), 3f)) g.DrawPath(glow, path);
                    using (var fill = new LinearGradientBrush(new Rectangle(r.X, r.Y - 1, r.Width, r.Height + 2), top, bottom, 90f)) g.FillPath(fill, path);
                    var sheen = new Rectangle(r.X + 2, r.Y + 1, r.Width - 4, r.Height / 2);
                    using (var shine = new LinearGradientBrush(new Rectangle(sheen.X, sheen.Y - 1, sheen.Width, sheen.Height + 2), Color.FromArgb(90, 255, 255, 255), Color.FromArgb(0, 255, 255, 255), 90f))
                    using (var sheenPath = Glass.Rounded(sheen, sheen.Height / 2)) g.FillPath(shine, sheenPath);
                }
                Glass.Edge(g, r, radius, Color.White, 60);
                text = Theme.AccentInk;
            }
            else if (kind == ButtonKind.DangerStrong)
            {
                // Filled red: the one action on the card that spends something.
                using (var path = Glass.Rounded(r, radius))
                using (var fill = new SolidBrush(Color.FromArgb(down ? 235 : hover ? 225 : 200, Theme.Bad))) g.FillPath(fill, path);
                Glass.Edge(g, r, radius, Color.White, 45);
                text = Color.White;
            }
            else
            {
                if (kind == ButtonKind.Danger && hover) using (var path = Glass.Rounded(r, radius)) using (var fill = new SolidBrush(Color.FromArgb(46, Theme.Bad))) g.FillPath(fill, path);
                if (kind == ButtonKind.Outline && hover) using (var path = Glass.Rounded(r, radius)) using (var fill = new SolidBrush(Color.FromArgb(30, Theme.Accent))) g.FillPath(fill, path);
                if (down) using (var path = Glass.Rounded(r, radius)) using (var fill = new SolidBrush(Color.FromArgb(18, 0, 0, 0))) g.FillPath(fill, path);
                Glass.Body(g, r, radius, false);
                using (var path = Glass.Rounded(r, radius)) using (var fill = new SolidBrush(Color.FromArgb(down ? 22 : hover ? 52 : 34, 255, 255, 255))) g.FillPath(fill, path);
                if (kind == ButtonKind.Outline) Glass.Edge(g, r, radius, Theme.Accent);
                else Glass.Edge(g, r, radius);
                text = kind == ButtonKind.Danger ? Theme.Bad : kind == ButtonKind.Outline ? Theme.Accent : Theme.Text;
            }

            if (focus)
            {
                // Dashed and inset, so it cannot read as a second border.
                var ring = Rectangle.Inflate(r, -4, -4);
                using (var path = Glass.Rounded(ring, Math.Max(4, radius - 4)))
                using (var pen = new Pen(kind == ButtonKind.Primary ? Theme.AccentInk : Theme.Accent, 1.3f) { DashStyle = DashStyle.Dot }) g.DrawPath(pen, path);
            }

            if (tile)
            {
                var size = Image.Width;
                var x = r.X + 14;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.DrawImage(Image, x, r.Y + (r.Height - size) / 2, size, size);
                x += size + 14;
                var lines = Text.Split(new[] { Environment.NewLine, "\n" }, 2, StringSplitOptions.None);
                using (var bold = Theme.Ui(10.5f, FontStyle.Bold))
                {
                    var titleHeight = TextRenderer.MeasureText(lines[0], bold).Height;
                    var total = titleHeight + (lines.Length > 1 ? Font.Height + 2 : 0);
                    var y = r.Y + (r.Height - total) / 2;
                    TextRenderer.DrawText(g, lines[0], bold, new Rectangle(x, y, r.Right - x - 10, titleHeight), Enabled ? Theme.Text : Theme.Muted, TextFormatFlags.Left | TextFormatFlags.NoPrefix);
                    if (lines.Length > 1) TextRenderer.DrawText(g, lines[1], Font, new Rectangle(x, y + titleHeight + 2, r.Right - x - 10, Font.Height + 2), Theme.Muted, TextFormatFlags.Left | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
                }
                return;
            }
            using (var font = kind == ButtonKind.Primary ? new Font(Font, FontStyle.Bold) : (Font)Font.Clone())
                TextRenderer.DrawText(g, Text, font, r, text, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
        }
    }

    // A glass check box: rounded box, mint when ticked.
    internal sealed class GlassCheck : CheckBox
    {
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
        }

        public GlassCheck()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            ForeColor = Theme.Text;
            Cursor = Cursors.Hand;
        }

        public override Size GetPreferredSize(Size proposed)
        {
            return new Size(TextRenderer.MeasureText(Text, Font).Width + 34, 28);
        }

        protected override void OnCheckedChanged(EventArgs e) { Invalidate(); base.OnCheckedChanged(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var box = new Rectangle(2, (Height - 18) / 2, 18, 18);
            Skin.Tick(g, box, Checked, Focused && ShowFocusCues);
            var text = new Rectangle(box.Right + 9, 0, Width - box.Right - 9, Height);
            TextRenderer.DrawText(g, Text, Font, text, Enabled ? ForeColor : Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPrefix);
        }
    }

    // A glass radio button.
    internal sealed class GlassRadio : RadioButton
    {
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
        }

        public GlassRadio()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            ForeColor = Theme.Text;
            Cursor = Cursors.Hand;
        }

        public override Size GetPreferredSize(Size proposed)
        {
            return new Size(TextRenderer.MeasureText(Text, Font).Width + 34, 28);
        }

        protected override void OnCheckedChanged(EventArgs e) { Invalidate(); base.OnCheckedChanged(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var box = new Rectangle(2, (Height - 18) / 2, 18, 18);
            using (var fill = new SolidBrush(Color.FromArgb(24, 255, 255, 255))) g.FillEllipse(fill, box);
            using (var pen = new Pen(Focused && ShowFocusCues ? Theme.Accent : Color.FromArgb(150, 255, 255, 255), 1.5f)) g.DrawEllipse(pen, box);
            if (Checked) using (var dot = new SolidBrush(Theme.Accent)) g.FillEllipse(dot, Rectangle.Inflate(box, -5, -5));
            var text = new Rectangle(box.Right + 9, 0, Width - box.Right - 9, Height);
            TextRenderer.DrawText(g, Text, Font, text, ForeColor, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPrefix);
        }
    }

    // One side of a two-way switch (Chat / Video). It stays a native radio
    // button, so the arrow keys move between the two and a screen reader
    // announces them as a radio group; only the drawing is replaced. The
    // chosen side is a brass pill inside the glass capsule that holds both.
    internal sealed class SegmentRadio : RadioButton
    {
        private bool hover;

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
        }

        public SegmentRadio()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            ForeColor = Theme.Text;
            Cursor = Cursors.Hand;
            Margin = new Padding(0);
            // Both sides are given the same size by whoever places them.
            AutoSize = false;
            AccessibleRole = AccessibleRole.RadioButton;
        }

        public override Size GetPreferredSize(Size proposed)
        {
            return new Size(TextRenderer.MeasureText(Text, Font).Width + 44, 34);
        }

        protected override void OnCheckedChanged(EventArgs e) { Invalidate(); base.OnCheckedChanged(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var r = new Rectangle(0, 0, Width - 1, Height - 1);
            var radius = r.Height / 2;
            if (Checked)
            {
                using (var path = Glass.Rounded(r, radius))
                using (var fill = new LinearGradientBrush(new Rectangle(r.X, r.Y - 1, r.Width, r.Height + 2), hover ? Theme.AccentHover : Theme.Accent, Theme.Accent, 90f)) g.FillPath(fill, path);
                Glass.Edge(g, r, radius, Color.White, 55);
            }
            else if (hover)
            {
                using (var path = Glass.Rounded(r, radius)) using (var fill = new SolidBrush(Color.FromArgb(22, 255, 255, 255))) g.FillPath(fill, path);
            }
            if (Focused && ShowFocusCues)
            {
                // Dotted and inset, like the focus ring on the pill buttons.
                var ring = Rectangle.Inflate(r, -4, -4);
                using (var path = Glass.Rounded(ring, Math.Max(4, radius - 4)))
                using (var pen = new Pen(Checked ? Theme.AccentInk : Theme.Accent, 1.3f) { DashStyle = DashStyle.Dot }) g.DrawPath(pen, path);
            }
            using (var font = Checked ? new Font(Font, FontStyle.Bold) : (Font)Font.Clone())
                TextRenderer.DrawText(g, Text, font, r, Checked ? Theme.AccentInk : hover ? Theme.Text : Theme.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
        }
    }

    // A small glass pill with tinted text: status, plan and similar labels.
    internal sealed class Chip : Label
    {
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
        }

        private Color tint = Theme.Accent;

        public Chip()
        {
            AutoSize = true;
            Padding = new Padding(10, 3, 10, 3);
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint, true);
        }

        public Color Tint
        {
            get { return tint; }
            set { tint = value; ForeColor = value; Invalidate(); }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var r = new Rectangle(0, 0, Width - 1, Height - 1);
            using (var path = Glass.Rounded(r, r.Height / 2f))
            {
                using (var fill = new SolidBrush(Color.FromArgb(40, tint))) g.FillPath(fill, path);
                using (var pen = new Pen(Color.FromArgb(110, tint))) g.DrawPath(pen, path);
            }
            TextRenderer.DrawText(g, Text, Font, r, tint, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
        }
    }

    // A label that paints the backdrop and glass behind it instead of relying
    // on WinForms transparency. Transparency ghosts text at some sizes; this
    // never does.
    internal sealed class GlassLabel : Label
    {
        public GlassLabel()
        {
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Page;
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
        }
    }

    // A picture that paints the backdrop and glass behind it, for the same reason.
    internal sealed class GlassPicture : PictureBox
    {
        public GlassPicture()
        {
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Page;
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
        }
    }

    // The app icon as a rounded glass tile.
    internal sealed class AppMark : Control
    {
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
        }

        public Image Picture;

        public AppMark()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            var r = new Rectangle(2, 2, Width - 5, Height - 5);
            using (var glow = Glass.Rounded(Rectangle.Inflate(r, 1, 1), 16)) using (var pen = new Pen(Color.FromArgb(60, Theme.Accent), 3f)) g.DrawPath(pen, glow);
            if (Picture != null)
            {
                using (var path = Glass.Rounded(r, 15))
                {
                    var old = g.Clip;
                    g.SetClip(path, CombineMode.Intersect);
                    g.DrawImage(Picture, r);
                    g.Clip = old;
                }
            }
            Glass.Edge(g, r, 15);
        }
    }

    // Shows one of several pages; NavStrip switches between them.
    internal sealed class PageHost : Panel
    {
        public sealed class PageList
        {
            private readonly PageHost host;
            private readonly List<Panel> pages = new List<Panel>();

            public PageList(PageHost host) { this.host = host; }

            public int Count { get { return pages.Count; } }
            public Panel this[int index] { get { return pages[index]; } }

            public void Add(Panel page)
            {
                page.Dock = DockStyle.Fill;
                page.Visible = pages.Count == host.selected;
                pages.Add(page);
                host.Controls.Add(page);
                host.OnPagesChanged();
            }
        }

        private int selected;
        public readonly PageList TabPages;
        public event EventHandler SelectedIndexChanged;
        public event EventHandler PagesChanged;

        public PageHost()
        {
            TabPages = new PageList(this);
        }

        private void OnPagesChanged()
        {
            if (PagesChanged != null) PagesChanged(this, EventArgs.Empty);
        }

        public int SelectedIndex
        {
            get { return selected; }
            set
            {
                if (value < 0 || value >= TabPages.Count || value == selected) return;
                // Hide the old page only after the new one is on top, so there
                // is never a blank frame between them.
                SuspendLayout();
                var previous = TabPages[selected];
                selected = value;
                var next = TabPages[selected];
                next.Visible = true;
                next.BringToFront();
                previous.Visible = false;
                ResumeLayout(true);
                next.Invalidate(true);
                if (SelectedIndexChanged != null) SelectedIndexChanged(this, EventArgs.Empty);
            }
        }
    }

    // The section switcher: a glass capsule with the current section as a
    // brighter pill inside (like iOS segmented controls). Click, or use
    // Left/Right when focused.
    internal sealed class NavStrip : Control
    {
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
        }

        private readonly PageHost pages;
        private readonly List<Rectangle> slots = new List<Rectangle>();
        private int hover = -1;

        public NavStrip(PageHost pages)
        {
            this.pages = pages;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
            Dock = DockStyle.Top;
            Height = 58;
            Font = Theme.Ui(10f);
            TabStop = true;
            Cursor = Cursors.Hand;
            AccessibleRole = AccessibleRole.PageTabList;
            AccessibleName = "Sections";
            pages.SelectedIndexChanged += (s, e) => Invalidate();
            pages.PagesChanged += (s, e) => Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            slots.Clear();
            using (var bold = new Font(Font, FontStyle.Bold))
            {
                var widths = new List<int>();
                var total = 8;
                for (var i = 0; i < pages.TabPages.Count; i++)
                {
                    var w = TextRenderer.MeasureText(g, pages.TabPages[i].Text, bold).Width + 34;
                    widths.Add(w);
                    total += w + 2;
                }
                var capsule = new Rectangle(0, 8, total + 6, 42);
                Glass.Draw(g, capsule, capsule.Height / 2, true, true);
                var x = capsule.X + 5;
                for (var i = 0; i < pages.TabPages.Count; i++)
                {
                    var slot = new Rectangle(x, capsule.Y + 5, widths[i], capsule.Height - 10);
                    slots.Add(slot);
                    var selected = i == pages.SelectedIndex;
                    if (selected)
                    {
                        using (var path = Glass.Rounded(slot, slot.Height / 2f))
                        {
                            using (var fill = new LinearGradientBrush(new Rectangle(slot.X, slot.Y - 1, slot.Width, slot.Height + 2), Color.FromArgb(70, 255, 255, 255), Color.FromArgb(34, 255, 255, 255), 90f)) g.FillPath(fill, path);
                        }
                        Glass.Edge(g, slot, slot.Height / 2, null, 110);
                        if (Focused) using (var ring = Glass.Rounded(Rectangle.Inflate(slot, 2, 2), slot.Height / 2f + 2)) using (var pen = new Pen(Theme.Accent, 1.5f)) g.DrawPath(pen, ring);
                    }
                    else if (i == hover)
                    {
                        using (var path = Glass.Rounded(slot, slot.Height / 2f)) using (var fill = new SolidBrush(Color.FromArgb(18, 255, 255, 255))) g.FillPath(fill, path);
                    }
                    TextRenderer.DrawText(g, pages.TabPages[i].Text, selected ? bold : Font, slot, selected || i == hover ? Theme.Text : Theme.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                    x += widths[i] + 2;
                }
            }
        }

        private int SlotAt(Point p)
        {
            for (var i = 0; i < slots.Count; i++) if (slots[i].Contains(p)) return i;
            return -1;
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            var at = SlotAt(e.Location);
            if (at != hover) { hover = at; Invalidate(); }
        }

        protected override void OnMouseLeave(EventArgs e) { hover = -1; Invalidate(); }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            var at = SlotAt(e.Location);
            if (at >= 0) pages.SelectedIndex = at;
        }

        protected override bool IsInputKey(Keys keyData)
        {
            return keyData == Keys.Left || keyData == Keys.Right || base.IsInputKey(keyData);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            var count = pages.TabPages.Count;
            if (e.KeyCode == Keys.Right) pages.SelectedIndex = (pages.SelectedIndex + 1) % count;
            if (e.KeyCode == Keys.Left) pages.SelectedIndex = (pages.SelectedIndex + count - 1) % count;
        }

        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
    }

    // An indeterminate progress line: a mint glow sliding along a glass track.
    internal sealed class Marquee : Control
    {
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
        }

        private readonly Timer timer = new Timer { Interval = 30 };
        private float position;

        public Marquee()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            Height = 6;
            timer.Tick += (s, e) => { position = (position + 0.012f) % 1.4f; Invalidate(); };
            timer.Start();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var r = new RectangleF(0, 0, Width - 1, Height - 1);
            using (var path = Glass.Rounded(r, r.Height / 2)) using (var track = new SolidBrush(Theme.Track)) g.FillPath(track, path);
            var w = Width * 0.3f;
            var x = (position - 0.3f) * Width;
            var bar = new RectangleF(x, 0, w, Height - 1);
            using (var path = Glass.Rounded(bar, bar.Height / 2))
            using (var fill = new LinearGradientBrush(new RectangleF(bar.X - 1, 0, bar.Width + 2, Height), Theme.Teal, Theme.Accent, 0f)) g.FillPath(fill, path);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) timer.Dispose();
            base.Dispose(disposing);
        }
    }

    // A ListView that paints the empty area below its last row as glass;
    // Windows would otherwise draw light column lines there.
    internal sealed class DarkList : ListView
    {
        private const int LVM_SETEXTENDEDLISTVIEWSTYLE = 0x1036;
        private const int LVS_EX_DOUBLEBUFFER = 0x00010000;

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            // Windows' own buffering for the list control. ControlStyles
            // double buffering is what produced half-painted rows on scroll.
            SendMessage(Handle, LVM_SETEXTENDEDLISTVIEWSTYLE, (IntPtr)LVS_EX_DOUBLEBUFFER, (IntPtr)LVS_EX_DOUBLEBUFFER);
        }

        protected override void WndProc(ref Message m)
        {
            base.WndProc(ref m);
            if (m.Msg != 0x000F || View != View.Details) return; // WM_PAINT
            var top = Items.Count > 0 ? Items[Items.Count - 1].Bounds.Bottom : Font.Height + 12;
            if (top >= ClientSize.Height) return;
            using (var g = CreateGraphics()) Glass.PaintBehind(g, this, new Rectangle(0, top, ClientSize.Width, ClientSize.Height - top));
        }
    }

    // ---------------------------------------------------------------------
    // Applying the look.
    // ---------------------------------------------------------------------
    internal enum ButtonKind { Normal, Primary, Danger, DangerStrong, Outline }

    internal static class Skin
    {
        private const string PrimaryTag = "skin:primary";
        private const string DangerTag = "skin:danger";
        private const string OutlineTag = "skin:outline";
        private const string DangerStrongTag = "skin:danger-strong";
        private static readonly HashSet<Control> Walked = new HashSet<Control>();

        public static T Primary<T>(T button) where T : Button { button.Tag = PrimaryTag; button.Invalidate(); return button; }
        public static T Danger<T>(T button) where T : Button { button.Tag = DangerTag; button.Invalidate(); return button; }
        public static T DangerStrong<T>(T button) where T : Button { button.Tag = DangerStrongTag; button.Invalidate(); return button; }
        public static T Outline<T>(T button) where T : Button { button.Tag = OutlineTag; button.Invalidate(); return button; }

        private static readonly HashSet<Control> Painting = new HashSet<Control>();

        // True while the window is being dragged to a new size.
        public static bool SuppressBackdrop;

        // Makes a container paint the backdrop and any glass behind it first.
        public static void PaintsBehind(Control control)
        {
            if (!Painting.Add(control)) return;
            control.Disposed += (s, e) => Painting.Remove(control);
            control.Paint += (s, e) => Glass.PaintBehind(e.Graphics, control, e.ClipRectangle);
            // The handler must run before any other Paint handler.
            var field = typeof(Control).GetField("EventPaint", BindingFlags.Static | BindingFlags.NonPublic);
            if (field == null) return;
            var key = field.GetValue(null);
            var events = (System.ComponentModel.EventHandlerList)typeof(System.ComponentModel.Component).GetProperty("Events", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(control, null);
            var all = events[key] as PaintEventHandler;
            if (all == null) return;
            var handlers = all.GetInvocationList();
            if (handlers.Length < 2) return;
            foreach (PaintEventHandler h in handlers) events.RemoveHandler(key, h);
            events.AddHandler(key, handlers[handlers.Length - 1]);
            for (var i = 0; i < handlers.Length - 1; i++) events.AddHandler(key, handlers[i]);
        }

        public static ButtonKind KindOf(Button button)
        {
            var tag = button.Tag as string;
            if (tag == PrimaryTag) return ButtonKind.Primary;
            if (tag == DangerTag) return ButtonKind.Danger;
            if (tag == DangerStrongTag) return ButtonKind.DangerStrong;
            if (tag == OutlineTag) return ButtonKind.Outline;
            return ButtonKind.Normal;
        }

        // A card or panel drawn as glass.
        public static void Border(Control panel)
        {
            Glass.Make(panel, 20, true);
        }

        // Styles a window and everything in it, now and whatever is added later.
        public static void Apply(Control root)
        {
            var form = root as Form;
            if (form != null)
            {
                form.BackColor = Theme.Page;
                form.ForeColor = Theme.Text;
                form.Styles(ControlStyles.ResizeRedraw | ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint, true);
                form.Paint += (s, e) =>
                {
                    // While the user drags the window edge the app shows a
                    // stretched snapshot instead; re-rendering the scene for
                    // every dragged pixel is what made the window tear.
                    if (SuppressBackdrop) { using (var fill = new SolidBrush(Theme.Page)) e.Graphics.FillRectangle(fill, e.ClipRectangle); return; }
                    Backdrop.Paint(e.Graphics, form, e.ClipRectangle);
                };
                form.Resize += (s, e) => form.Invalidate(true);
                form.FormClosed += (s, e) => Backdrop.Forget(form);
                if (form.IsHandleCreated) DarkTitleBar(form.Handle);
                form.HandleCreated += (s, e) => DarkTitleBar(form.Handle);
            }
            Walk(root);
        }

        private static void Walk(Control control)
        {
            if (Walked.Add(control))
            {
                control.Disposed += (s, e) => Walked.Remove(control);
                control.ControlAdded += (s, e) => Walk(e.Control);
            }
            Style(control);
            foreach (Control child in control.Controls) Walk(child);
        }

        private static void Style(Control control)
        {
            if (control is Form) return;
            // Every control paints into its own buffer: an un-buffered container
            // flickers under the glass whenever a child repaints (hovering a
            // button, switching tabs).
            Buffered(control);
            var button = control as Button;
            if (button != null) { StyleButton(button); return; }
            var list = control as ListView;
            if (list != null) { StyleList(list); return; }
            var text = control as TextBox;
            if (text != null)
            {
                text.BackColor = text.Multiline ? Theme.GlassDeep : Theme.Input;
                text.ForeColor = Theme.Text;
                text.BorderStyle = text.Multiline ? BorderStyle.None : BorderStyle.FixedSingle;
                DarkScrollbars(text);
                return;
            }
            var combo = control as ComboBox;
            if (combo != null) { StyleCombo(combo); return; }
            if (control is GlassCheck || control is GlassRadio || control is SegmentRadio || control is Chip || control is AppMark || control is NavStrip || control is Marquee) return;
            if (Glass.IsGlass(control)) { DarkScrollbars(control); return; }
            if (control is PillButton) return;
            // Containers paint the backdrop and glass behind them; labels and
            // pictures are transparent over an opaque container. (WinForms
            // transparent parents ghost their children's text, so containers
            // are never transparent.)
            if (control is Panel || control is GroupBox || control is PageHost)
            {
                control.BackColor = Theme.Page;
                control.Styles(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.ResizeRedraw, true);
                PaintsBehind(control);
            }
            else if (control is Label || control is PictureBox)
            {
                control.Styles(ControlStyles.SupportsTransparentBackColor, true);
                control.BackColor = Color.Transparent;
            }
            var scroller = control as ScrollableControl;
            if (scroller != null) DarkScrollbars(scroller);
        }

        private static readonly PropertyInfo DoubleBufferedProperty = typeof(Control).GetProperty("DoubleBuffered", BindingFlags.Instance | BindingFlags.NonPublic);

        private static void Buffered(Control control)
        {
            if (DoubleBufferedProperty == null || !DoubleBufferedProperty.CanWrite) return;
            // A ListView manages its own painting; ControlStyles double buffering
            // there leaves half-painted rows when it scrolls (see DarkList).
            if (control is TextBox || control is ComboBox || control is ListView) return;
            DoubleBufferedProperty.SetValue(control, true, null);
        }

        private static void StyleButton(Button button)
        {
            button.Cursor = Cursors.Hand;
            if (button.AutoSize)
            {
                button.Padding = new Padding(8, 0, 8, 0);
                button.MinimumSize = new Size(0, 36);
            }
            else if (button.Height < 36 && button.Image == null)
            {
                button.Height = 36;
            }
            button.Invalidate();
        }

        private static void StyleCombo(ComboBox combo)
        {
            combo.FlatStyle = FlatStyle.Flat;
            combo.BackColor = Theme.Input;
            combo.ForeColor = Theme.Text;
            combo.DrawMode = DrawMode.OwnerDrawFixed;
            combo.ItemHeight = 24;
            combo.DrawItem += (s, e) =>
            {
                if (e.Index < 0) return;
                var selected = (e.State & DrawItemState.Selected) != 0;
                using (var back = new SolidBrush(selected ? Theme.AccentDim : Theme.Input)) e.Graphics.FillRectangle(back, e.Bounds);
                TextRenderer.DrawText(e.Graphics, combo.GetItemText(combo.Items[e.Index]), combo.Font, new Rectangle(e.Bounds.X + 8, e.Bounds.Y, e.Bounds.Width - 8, e.Bounds.Height), selected ? Theme.Accent : Theme.Text, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
            };
            DarkScrollbars(combo, "DarkMode_CFD");
        }

        // The tick box used by check boxes and the model list.
        public static void Tick(Graphics g, Rectangle box, bool on, bool focused)
        {
            using (var path = Glass.Rounded(box, 5))
            {
                if (on)
                {
                    using (var fill = new LinearGradientBrush(new Rectangle(box.X, box.Y - 1, box.Width, box.Height + 2), Theme.AccentHover, Theme.AccentDeep, 90f)) g.FillPath(fill, path);
                    using (var tick = new Pen(Theme.AccentInk, 2f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                        g.DrawLines(tick, new[] { new Point(box.X + 4, box.Y + box.Height / 2), new Point(box.X + 7, box.Y + box.Height / 2 + 3), new Point(box.Right - 4, box.Y + 5) });
                }
                else
                {
                    using (var fill = new SolidBrush(Color.FromArgb(22, 255, 255, 255))) g.FillPath(fill, path);
                    using (var edge = new Pen(Color.FromArgb(150, 255, 255, 255), 1.3f)) g.DrawPath(edge, path);
                }
                if (focused) using (var ring = Glass.Rounded(Rectangle.Inflate(box, 3, 3), 7)) using (var pen = new Pen(Theme.Accent, 1.5f)) g.DrawPath(pen, ring);
            }
        }

        // ---------- lists ----------

        private static void StyleList(ListView list)
        {
            list.BackColor = Theme.Card;
            list.ForeColor = Theme.Text;
            list.BorderStyle = BorderStyle.None;
            list.OwnerDraw = true;
            list.GridLines = false;
            if (list.SmallImageList == null) list.SmallImageList = new ImageList { ImageSize = new Size(1, 30) };
            // Not ControlStyles.OptimizedDoubleBuffer: on a ListView that leaves
            // partial rows behind while scrolling or resizing. Windows' own list
            // double buffering (set in DarkList.OnHandleCreated) does it properly.
            typeof(Control).GetProperty("DoubleBuffered", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(list, false, null);
            list.DrawColumnHeader += (s, e) =>
            {
                Glass.PaintBehind(e.Graphics, list, e.Bounds);
                using (var line = new Pen(Color.FromArgb(34, 255, 255, 255))) e.Graphics.DrawLine(line, e.Bounds.Left, e.Bounds.Bottom - 1, e.Bounds.Right, e.Bounds.Bottom - 1);
                var bounds = new Rectangle(e.Bounds.X + 10, e.Bounds.Y, e.Bounds.Width - 12, e.Bounds.Height);
                using (var font = Theme.Ui(8.5f, FontStyle.Bold)) TextRenderer.DrawText(e.Graphics, e.Header.Text.ToUpperInvariant() == e.Header.Text ? e.Header.Text : e.Header.Text, font, bounds, Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
            };
            list.DrawItem += (s, e) => { e.DrawDefault = false; };
            list.DrawSubItem += (s, e) => DrawCell(list, e);
            list.ItemChecked += (s, e) => list.Invalidate(e.Item.Bounds);
            list.MouseMove += (s, e) =>
            {
                var hit = list.GetItemAt(e.X, e.Y);
                var index = hit == null ? -1 : hit.Index;
                var last = list.Tag is int ? (int)list.Tag : -1;
                if (index == last) return;
                list.Tag = index;
                if (last >= 0 && last < list.Items.Count) list.Invalidate(list.Items[last].Bounds);
                if (hit != null) list.Invalidate(hit.Bounds);
            };
            list.MouseLeave += (s, e) =>
            {
                var last = list.Tag is int ? (int)list.Tag : -1;
                list.Tag = -1;
                if (last >= 0 && last < list.Items.Count) list.Invalidate(list.Items[last].Bounds);
            };
            EventHandler fill = (s, e) => { if (list.Columns.Count > 0) list.Columns[list.Columns.Count - 1].Width = -2; };
            list.Resize += fill;
            list.HandleCreated += fill;
            DarkScrollbars(list);
        }

        private static void DrawCell(ListView list, DrawListViewSubItemEventArgs e)
        {
            var g = e.Graphics;
            var hovered = list.Tag is int && (int)list.Tag == e.ItemIndex;
            var bounds = e.ColumnIndex == 0 ? new Rectangle(e.Bounds.X, e.Bounds.Y, list.Columns[0].Width, e.Bounds.Height) : e.Bounds;
            Glass.PaintBehind(g, list, bounds);
            // Selected and hovered rows are a lighter band across the row.
            if (e.Item.Selected || hovered)
            {
                using (var band = new SolidBrush(e.Item.Selected ? Color.FromArgb(44, Theme.Accent) : Color.FromArgb(16, 255, 255, 255))) g.FillRectangle(band, bounds);
            }
            using (var line = new Pen(Color.FromArgb(18, 255, 255, 255))) g.DrawLine(line, bounds.Left, bounds.Bottom - 1, bounds.Right, bounds.Bottom - 1);

            g.SmoothingMode = SmoothingMode.AntiAlias;
            var x = bounds.X + 10;
            if (e.ColumnIndex == 0)
            {
                if (list.CheckBoxes)
                {
                    var box = new Rectangle(bounds.X + 8, bounds.Y + (bounds.Height - 18) / 2, 18, 18);
                    Tick(g, box, e.Item.Checked, false);
                    x = box.Right + 10;
                }
                var images = list.SmallImageList;
                if (images != null && images.ImageSize.Width > 1 && !string.IsNullOrEmpty(e.Item.ImageKey) && images.Images.ContainsKey(e.Item.ImageKey))
                {
                    var size = images.ImageSize;
                    g.DrawImage(images.Images[e.Item.ImageKey], x, bounds.Y + (bounds.Height - size.Height) / 2, size.Width, size.Height);
                    x += size.Width + 10;
                }
            }
            g.SmoothingMode = SmoothingMode.None;
            if (e.SubItem.Text.IndexOf('\u0001') >= 0 || (e.ColumnIndex == 1 && list.Columns.Count == 2 && e.SubItem.Text.Length > 0 && "\u2713\u2717\u23F8".IndexOf(e.SubItem.Text[0]) >= 0))
            {
                DrawLadder(g, list.Font, e.SubItem.Text.Split('\u0001'), new Rectangle(x, bounds.Y, bounds.Right - x, bounds.Height));
                return;
            }
            var color = e.Item.ForeColor;
            if (color == list.ForeColor || color.IsEmpty) color = Theme.Text;
            if (e.ColumnIndex > 0 && !e.Item.UseItemStyleForSubItems) color = e.SubItem.ForeColor;
            var text = new Rectangle(x, bounds.Y, Math.Max(0, bounds.Right - x - 6), bounds.Height);
            TextRenderer.DrawText(g, e.SubItem.Text, e.Item.Font ?? list.Font, text, color, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        }

        // A lane ladder: glass chips joined by arrows.
        private static void DrawLadder(Graphics g, Font font, string[] steps, Rectangle area)
        {
            var x = area.X;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            for (var i = 0; i < steps.Length; i++)
            {
                var step = steps[i].Trim();
                if (step.Length == 0) continue;
                var mark = step[0];
                var name = step.Substring(1).Trim();
                var off = mark == '\u2717';
                var resting = mark == '\u23F8';
                var color = off ? Theme.Bad : resting ? Theme.Warn : Theme.Ok;
                var size = TextRenderer.MeasureText(g, name, font, Size.Empty, TextFormatFlags.NoPadding);
                var chip = new Rectangle(x, area.Y + (area.Height - 24) / 2, size.Width + 30, 24);
                if (chip.Right > area.Right) break;
                using (var path = Glass.Rounded(chip, 12))
                {
                    using (var fill = new SolidBrush(Color.FromArgb(off ? 8 : 26, 255, 255, 255))) g.FillPath(fill, path);
                    using (var pen = new Pen(off ? Color.FromArgb(30, 255, 255, 255) : Color.FromArgb(120, color))) g.DrawPath(pen, path);
                }
                using (var glow = new SolidBrush(Color.FromArgb(70, color))) g.FillEllipse(glow, chip.X + 7, chip.Y + 7, 10, 10);
                using (var dot = new SolidBrush(color)) g.FillEllipse(dot, chip.X + 9, chip.Y + 9, 6, 6);
                TextRenderer.DrawText(g, name, font, new Rectangle(chip.X + 21, chip.Y, chip.Width - 22, chip.Height), off ? Color.FromArgb(150, Theme.Muted) : Theme.Text, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPadding);
                x = chip.Right;
                if (i < steps.Length - 1)
                {
                    TextRenderer.DrawText(g, "\u203A", Theme.Ui(12f), new Rectangle(x, area.Y, 22, area.Height), Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter);
                    x += 22;
                }
            }
            g.SmoothingMode = SmoothingMode.None;
        }

        public static GraphicsPath Rounded(Rectangle r, int radius)
        {
            return Glass.Rounded(r, radius);
        }

        // ---------- native dark parts ----------

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)]
        private static extern int SetWindowTheme(IntPtr hwnd, string appName, string idList);

        private static int ColorRef(Color c)
        {
            return c.R | (c.G << 8) | (c.B << 16);
        }

        public static void DarkTitleBar(IntPtr hwnd)
        {
            try
            {
                var on = 1;
                DwmSetWindowAttribute(hwnd, 20, ref on, 4);
                var caption = ColorRef(ColorTranslator.FromHtml("#04202E"));
                DwmSetWindowAttribute(hwnd, 35, ref caption, 4);
                var border = ColorRef(ColorTranslator.FromHtml("#1C4657"));
                DwmSetWindowAttribute(hwnd, 34, ref border, 4);
                var text = ColorRef(Theme.Text);
                DwmSetWindowAttribute(hwnd, 36, ref text, 4);
            }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
        }

        private static void DarkScrollbars(Control control, string theme = "DarkMode_Explorer")
        {
            Action set = () => { try { SetWindowTheme(control.Handle, theme, null); } catch (DllNotFoundException) { } };
            if (control.IsHandleCreated) set();
            control.HandleCreated += (s, e) => set();
        }

        public static void Menu(ToolStrip menu)
        {
            menu.Renderer = new DarkMenuRenderer();
            menu.BackColor = Theme.Card;
            menu.ForeColor = Theme.Text;
            menu.Font = Theme.Ui(9.5f);
        }

        private sealed class DarkMenuRenderer : ToolStripProfessionalRenderer
        {
            public DarkMenuRenderer() : base(new DarkColors()) { RoundedEdges = false; }

            protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
            {
                e.TextColor = e.Item.Enabled ? Theme.Text : Theme.Muted;
                base.OnRenderItemText(e);
            }
        }

        private sealed class DarkColors : ProfessionalColorTable
        {
            private static readonly Color Line = ColorTranslator.FromHtml("#1C4657");
            public override Color ToolStripDropDownBackground { get { return Theme.Card; } }
            public override Color ImageMarginGradientBegin { get { return Theme.Card; } }
            public override Color ImageMarginGradientMiddle { get { return Theme.Card; } }
            public override Color ImageMarginGradientEnd { get { return Theme.Card; } }
            public override Color MenuBorder { get { return Line; } }
            public override Color MenuItemBorder { get { return Theme.AccentDim; } }
            public override Color MenuItemSelected { get { return Theme.AccentDim; } }
            public override Color MenuItemSelectedGradientBegin { get { return Theme.AccentDim; } }
            public override Color MenuItemSelectedGradientEnd { get { return Theme.AccentDim; } }
            public override Color SeparatorDark { get { return Line; } }
            public override Color SeparatorLight { get { return Line; } }
        }
    }

    // Message boxes in the app's style. Same calls as MessageBox.Show.
    internal static class Msg
    {
        public static DialogResult Show(string text, string title, MessageBoxButtons buttons, MessageBoxIcon icon)
        {
            return Show(null, text, title, buttons, icon, MessageBoxDefaultButton.Button1);
        }

        public static DialogResult Show(IWin32Window owner, string text, string title, MessageBoxButtons buttons, MessageBoxIcon icon)
        {
            return Show(owner, text, title, buttons, icon, MessageBoxDefaultButton.Button1);
        }

        public static DialogResult Show(IWin32Window owner, string text, string title, MessageBoxButtons buttons, MessageBoxIcon icon, MessageBoxDefaultButton defaultButton)
        {
            using (var form = new Form())
            {
                form.Text = title;
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

                var layout = Glass.Make(new TableLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 2, RowCount = 2, Padding = new Padding(20, 20, 20, 16) }, 22, true);
                layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
                layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

                Color glyphColor;
                string glyph;
                switch (icon)
                {
                    case MessageBoxIcon.Error: glyphColor = Theme.Bad; glyph = "\u00D7"; break;
                    case MessageBoxIcon.Warning: glyphColor = Theme.Warn; glyph = "!"; break;
                    case MessageBoxIcon.Question: glyphColor = Theme.Accent; glyph = "?"; break;
                    default: glyphColor = Theme.Accent; glyph = "i"; break;
                }
                layout.Controls.Add(new Glyph(glyph, glyphColor) { Margin = new Padding(0, 2, 16, 0) }, 0, 0);
                layout.Controls.Add(new GlassLabel { Text = text, AutoSize = true, MaximumSize = new Size(420, 0), ForeColor = Theme.Text, Margin = new Padding(0, 6, 0, 18), UseMnemonic = false }, 1, 0);

                var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill, Margin = new Padding(0), WrapContents = false };
                Button accept;
                Button cancel;
                if (buttons == MessageBoxButtons.YesNo || buttons == MessageBoxButtons.OKCancel)
                {
                    var yesNo = buttons == MessageBoxButtons.YesNo;
                    var no = new PillButton { Text = yesNo ? "No" : "Cancel", DialogResult = yesNo ? DialogResult.No : DialogResult.Cancel, Size = new Size(100, 36), Margin = new Padding(8, 0, 0, 0) };
                    var yes = new PillButton { Text = yesNo ? "Yes" : "OK", DialogResult = yesNo ? DialogResult.Yes : DialogResult.OK, Size = new Size(100, 36), Margin = new Padding(8, 0, 0, 0) };
                    row.Controls.Add(no);
                    row.Controls.Add(yes);
                    accept = defaultButton == MessageBoxDefaultButton.Button2 ? no : yes;
                    cancel = no;
                    // The default (safe) choice is the lit one; a destructive
                    // Yes never looks like the recommended action.
                    Skin.Primary(accept);
                }
                else
                {
                    var ok = Skin.Primary(new PillButton { Text = "OK", DialogResult = DialogResult.OK, Size = new Size(100, 36), Margin = new Padding(8, 0, 0, 0) });
                    row.Controls.Add(ok);
                    accept = ok;
                    cancel = ok;
                }
                layout.Controls.Add(row, 0, 1);
                layout.SetColumnSpan(row, 2);
                form.Controls.Add(layout);
                form.AcceptButton = accept;
                form.CancelButton = cancel;
                form.Shown += (s, e) => accept.Focus();
                Skin.Apply(form);
                return owner == null ? form.ShowDialog() : form.ShowDialog(owner);
            }
        }

        private sealed class Glyph : Control
        {
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            Glass.PaintBehind(e.Graphics, this, ClientRectangle);
        }

            private readonly string symbol;
            private readonly Color color;

            public Glyph(string symbol, Color color)
            {
                this.symbol = symbol;
                this.color = color;
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
                    Size = new Size(38, 38);
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                Glass.PaintBehind(e.Graphics, this, ClientRectangle);
                var g = e.Graphics;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (var glow = new SolidBrush(Color.FromArgb(36, color))) g.FillEllipse(glow, 0, 0, 37, 37);
                using (var edge = new Pen(Color.FromArgb(200, color), 1.5f)) g.DrawEllipse(edge, 2, 2, 33, 33);
                using (var font = Theme.Ui(14f, FontStyle.Bold)) TextRenderer.DrawText(g, symbol, font, new Rectangle(0, 0, 38, 37), color, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            }
        }
    }
}
