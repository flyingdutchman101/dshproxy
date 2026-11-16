// The DeepSeekProxy look: a dark theme taken from the app icon (deep
// black-green with a glowing green), applied to every window, control and
// dialog. Built for .NET Framework 4.8 WinForms and the C# 5 compiler that
// ships with Windows.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace DSHProxy
{
    internal static class Theme
    {
        // Surfaces, darkest to lightest.
        public static readonly Color Page = Hex("#020706");     // window background (the icon's background)
        public static readonly Color Input = Hex("#050C0A");    // lists, text boxes
        public static readonly Color Card = Hex("#0A1411");     // cards, dialogs, raised panels
        public static readonly Color Raised = Hex("#0F1D19");   // buttons
        public static readonly Color Hover = Hex("#152922");    // button and row hover
        public static readonly Color Border = Hex("#17302A");
        public static readonly Color Track = Hex("#17302A");    // empty part of a limit bar

        // Text.
        public static readonly Color Text = Hex("#E6F2EC");
        public static readonly Color Muted = Hex("#8FA89D");

        // The icon's glow: primary actions, focus, good state.
        public static readonly Color Accent = Hex("#5BE38C");
        public static readonly Color AccentHover = Hex("#7DEBA5");
        public static readonly Color AccentInk = Hex("#02130A");  // text on the accent
        public static readonly Color AccentDim = Hex("#0F2E1E");  // badges, selected rows
        public static readonly Color Banner = Hex("#0B1D16");     // update and suggestion bars

        // States.
        public static readonly Color Ok = Accent;
        public static readonly Color Warn = Hex("#E0A33A");
        public static readonly Color Bad = Hex("#F0605A");
        public static readonly Color BadDim = Hex("#2A1210");

        public static Color ForLeft(double left)
        {
            if (left <= 10) return Bad;
            if (left <= 30) return Warn;
            return Ok;
        }

        private static Color Hex(string hex)
        {
            return ColorTranslator.FromHtml(hex);
        }

        // Fonts: Segoe UI Variable (Display for headings, Text for the rest)
        // and Cascadia Mono for codes and logs, each falling back to what
        // every Windows has.
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

        public static Font Mono(float size, FontStyle style = FontStyle.Regular)
        {
            return new Font(Pick("Cascadia Mono", "Consolas"), size, style);
        }
    }

    internal static class SkinExtensions
    {
        // Mixes a translucent colour onto an opaque background, because
        // WinForms labels cannot have a translucent background.
        public static Color Blend(this Color top, Color under)
        {
            var a = top.A / 255f;
            return Color.FromArgb((int)(top.R * a + under.R * (1 - a)), (int)(top.G * a + under.G * (1 - a)), (int)(top.B * a + under.B * (1 - a)));
        }

        [DllImport("user32.dll")]
        private static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int width, int height, int step, IntPtr brush, int flags);

        // The icon frame closest to `size`, drawn at exactly that size on
        // `background`. Windows draws it (DrawIconEx), because GDI+ cannot
        // decode the PNG frames that modern .ico files hold.
        public static Bitmap ToBitmapExact(this Icon icon, int size, Color background)
        {
            var bitmap = new Bitmap(size, size);
            using (var g = Graphics.FromImage(bitmap))
            {
                g.Clear(background);
                var dc = g.GetHdc();
                try { DrawIconEx(dc, 0, 0, icon.Handle, size, size, 0, IntPtr.Zero, 3); }
                finally { g.ReleaseHdc(dc); }
            }
            return bitmap;
        }
    }

    // How a button is drawn. Set with Skin.Primary / Skin.Danger / Skin.Outline.
    internal enum ButtonKind { Normal, Primary, Danger, Outline }

    internal static class Skin
    {
        private const string PrimaryTag = "skin:primary";
        private const string DangerTag = "skin:danger";
        private const string OutlineTag = "skin:outline";

        public static T Primary<T>(T button) where T : Button { button.Tag = PrimaryTag; return button; }
        public static T Danger<T>(T button) where T : Button { button.Tag = DangerTag; return button; }
        public static T Outline<T>(T button) where T : Button { button.Tag = OutlineTag; return button; }

        private static ButtonKind KindOf(Button button)
        {
            var tag = button.Tag as string;
            if (tag == PrimaryTag) return ButtonKind.Primary;
            if (tag == DangerTag) return ButtonKind.Danger;
            if (tag == OutlineTag) return ButtonKind.Outline;
            return ButtonKind.Normal;
        }

        // Styles a window and everything in it, now and whatever is added later.
        public static void Apply(Control root)
        {
            var form = root as Form;
            if (form != null)
            {
                form.BackColor = Theme.Page;
                form.ForeColor = Theme.Text;
                if (form.IsHandleCreated) DarkTitleBar(form.Handle);
                form.HandleCreated += (s, e) => DarkTitleBar(form.Handle);
            }
            Walk(root);
        }

        private static void Walk(Control control)
        {
            Style(control);
            control.ControlAdded += (s, e) => Walk(e.Control);
            foreach (Control child in control.Controls) Walk(child);
        }

        private static void Style(Control control)
        {
            var button = control as Button;
            if (button != null) { StyleButton(button); return; }
            var list = control as ListView;
            if (list != null) { StyleList(list); return; }
            var text = control as TextBox;
            if (text != null)
            {
                text.BackColor = Theme.Input;
                text.ForeColor = Theme.Text;
                text.BorderStyle = BorderStyle.FixedSingle;
                DarkScrollbars(text);
                return;
            }
            var combo = control as ComboBox;
            if (combo != null) { StyleCombo(combo); return; }
            var check = control as CheckBox;
            if (check != null) { StyleCheck(check); return; }
            var radio = control as RadioButton;
            if (radio != null)
            {
                radio.FlatStyle = FlatStyle.Flat;
                radio.FlatAppearance.BorderColor = Theme.Muted;
                radio.FlatAppearance.CheckedBackColor = Theme.Accent;
                radio.ForeColor = Theme.Text;
                radio.Cursor = Cursors.Hand;
                return;
            }
            var page = control as TabPage;
            if (page != null)
            {
                page.UseVisualStyleBackColor = false;
                page.BackColor = Theme.Page;
                page.ForeColor = Theme.Text;
                return;
            }
            var scroller = control as ScrollableControl;
            if (scroller != null && scroller.AutoScroll) DarkScrollbars(scroller);
            // Panels made later can switch AutoScroll on; theme them as well.
            if (scroller != null) DarkScrollbars(scroller);
        }

        private static void StyleButton(Button button)
        {
            var kind = KindOf(button);
            button.FlatStyle = FlatStyle.Flat;
            button.UseVisualStyleBackColor = false;
            button.Cursor = Cursors.Hand;
            button.FlatAppearance.BorderSize = 1;
            if (button.AutoSize)
            {
                button.Padding = new Padding(10, 2, 10, 2);
                button.MinimumSize = new Size(0, 30);
            }
            Color back, border, hover, down, fore;
            switch (kind)
            {
                case ButtonKind.Primary:
                    back = Theme.Accent; border = Theme.Accent; hover = Theme.AccentHover; down = Theme.Accent; fore = Theme.AccentInk;
                    if (button.Font.Style == FontStyle.Regular) button.Font = new Font(button.Font, FontStyle.Bold);
                    break;
                case ButtonKind.Danger:
                    back = Theme.Raised; border = Theme.Border; hover = Theme.BadDim; down = Theme.BadDim; fore = Theme.Bad;
                    break;
                case ButtonKind.Outline:
                    back = Theme.Page; border = Theme.Accent; hover = Theme.AccentDim; down = Theme.AccentDim; fore = Theme.Accent;
                    break;
                default:
                    back = Theme.Raised; border = Theme.Border; hover = Theme.Hover; down = Theme.Border; fore = Theme.Text;
                    break;
            }
            button.BackColor = back;
            button.ForeColor = fore;
            button.FlatAppearance.BorderColor = border;
            button.FlatAppearance.MouseOverBackColor = hover;
            button.FlatAppearance.MouseDownBackColor = down;
            // A disabled button must look disabled: WinForms would otherwise
            // keep the accent fill and only grey the text.
            EventHandler enabled = (s, e) =>
            {
                button.BackColor = button.Enabled ? back : Theme.Card;
                button.FlatAppearance.BorderColor = button.Enabled ? border : Theme.Border;
                button.Cursor = button.Enabled ? Cursors.Hand : Cursors.Default;
            };
            button.EnabledChanged += enabled;
            enabled(button, EventArgs.Empty);
            button.Paint += (s, e) =>
            {
                if (button.Enabled) return;
                // Draw the label in the muted colour on the flat background.
                e.Graphics.Clear(Theme.Card);
                using (var edge = new Pen(Theme.Border)) e.Graphics.DrawRectangle(edge, 0, 0, button.Width - 1, button.Height - 1);
                TextRenderer.DrawText(e.Graphics, button.Text, button.Font, button.ClientRectangle, Color.FromArgb(0x4E, 0x63, 0x5A), TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            };
            // A visible focus ring for keyboard users.
            var focusColor = kind == ButtonKind.Primary ? Theme.Text : Theme.Accent;
            button.GotFocus += (s, e) => { button.FlatAppearance.BorderColor = focusColor; button.FlatAppearance.BorderSize = 2; };
            button.LostFocus += (s, e) => { button.FlatAppearance.BorderColor = border; button.FlatAppearance.BorderSize = 1; };
        }

        // A check box drawn as a rounded box with a tick, like the model list.
        private static void StyleCheck(CheckBox check)
        {
            check.ForeColor = Theme.Text;
            check.Cursor = Cursors.Hand;
            check.FlatStyle = FlatStyle.Flat;
            check.Padding = new Padding(2, 0, 0, 0);
            check.Paint += (s, e) =>
            {
                var g = e.Graphics;
                g.Clear(check.Parent != null ? check.Parent.BackColor : Theme.Page);
                var box = new Rectangle(1, (check.Height - 16) / 2, 16, 16);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (var path = Rounded(box, 4))
                {
                    if (check.Checked)
                    {
                        using (var fill = new SolidBrush(Theme.Accent)) g.FillPath(fill, path);
                        using (var tick = new Pen(Theme.AccentInk, 2f)) g.DrawLines(tick, new[] { new Point(box.X + 4, box.Y + 8), new Point(box.X + 7, box.Y + 11), new Point(box.X + 12, box.Y + 5) });
                    }
                    else using (var edge = new Pen(check.Focused ? Theme.Accent : Theme.Muted, 1.5f)) g.DrawPath(edge, path);
                }
                g.SmoothingMode = SmoothingMode.None;
                var text = new Rectangle(box.Right + 7, 0, check.Width - box.Right - 7, check.Height);
                TextRenderer.DrawText(g, check.Text, check.Font, text, check.Enabled ? Theme.Text : Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.Left);
                if (check.Focused)
                {
                    var size = TextRenderer.MeasureText(check.Text, check.Font);
                    using (var line = new Pen(Theme.Accent)) g.DrawLine(line, text.X, text.Y + (check.Height + size.Height) / 2, text.X + size.Width - 4, text.Y + (check.Height + size.Height) / 2);
                }
            };
            check.CheckedChanged += (s, e) => check.Invalidate();
            check.GotFocus += (s, e) => check.Invalidate();
            check.LostFocus += (s, e) => check.Invalidate();
            if (check.AutoSize)
            {
                check.AutoSize = false;
                check.Size = new Size(TextRenderer.MeasureText(check.Text, check.Font).Width + 30, 24);
            }
        }

        private static void StyleCombo(ComboBox combo)
        {
            combo.FlatStyle = FlatStyle.Flat;
            combo.BackColor = Theme.Raised;
            combo.ForeColor = Theme.Text;
            combo.DrawMode = DrawMode.OwnerDrawFixed;
            combo.ItemHeight = 22;
            combo.DrawItem += (s, e) =>
            {
                if (e.Index < 0) return;
                var selected = (e.State & DrawItemState.Selected) != 0;
                using (var back = new SolidBrush(selected ? Theme.AccentDim : Theme.Raised)) e.Graphics.FillRectangle(back, e.Bounds);
                TextRenderer.DrawText(e.Graphics, combo.GetItemText(combo.Items[e.Index]), combo.Font, new Rectangle(e.Bounds.X + 6, e.Bounds.Y, e.Bounds.Width - 6, e.Bounds.Height), selected ? Theme.Accent : Theme.Text, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
            };
            DarkScrollbars(combo, "DarkMode_CFD");
        }

        // ---------- lists ----------

        private static void StyleList(ListView list)
        {
            list.BackColor = Theme.Card;
            list.ForeColor = Theme.Text;
            list.BorderStyle = BorderStyle.None;
            list.OwnerDraw = true;
            list.GridLines = false;
            if (list.SmallImageList == null) list.SmallImageList = new ImageList { ImageSize = new Size(1, 26) };
            typeof(Control).GetProperty("DoubleBuffered", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic).SetValue(list, true, null);
            list.DrawColumnHeader += (s, e) =>
            {
                using (var back = new SolidBrush(Theme.Page)) e.Graphics.FillRectangle(back, e.Bounds);
                using (var line = new Pen(Theme.Border)) e.Graphics.DrawLine(line, e.Bounds.Left, e.Bounds.Bottom - 1, e.Bounds.Right, e.Bounds.Bottom - 1);
                var bounds = new Rectangle(e.Bounds.X + 8, e.Bounds.Y, e.Bounds.Width - 10, e.Bounds.Height);
                using (var font = Theme.Ui(8.5f, FontStyle.Bold)) TextRenderer.DrawText(e.Graphics, e.Header.Text, font, bounds, Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
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
            // The last column fills the width, so no light header area is left.
            EventHandler fill = (s, e) => { if (list.Columns.Count > 0) list.Columns[list.Columns.Count - 1].Width = -2; };
            list.Resize += fill;
            list.HandleCreated += fill;
            DarkScrollbars(list);
        }

        private static void DrawCell(ListView list, DrawListViewSubItemEventArgs e)
        {
            var g = e.Graphics;
            var hovered = list.Tag is int && (int)list.Tag == e.ItemIndex;
            var back = e.Item.Selected ? Theme.AccentDim : hovered ? Theme.Hover : Theme.Card;
            // Column 0 reports the whole row; keep it to its column.
            var bounds = e.ColumnIndex == 0 ? new Rectangle(e.Bounds.X, e.Bounds.Y, list.Columns[0].Width, e.Bounds.Height) : e.Bounds;
            using (var brush = new SolidBrush(back)) g.FillRectangle(brush, bounds);
            using (var line = new Pen(Theme.Page)) g.DrawLine(line, bounds.Left, bounds.Bottom - 1, bounds.Right, bounds.Bottom - 1);

            var x = bounds.X + 8;
            if (e.ColumnIndex == 0)
            {
                if (list.CheckBoxes)
                {
                    var box = new Rectangle(bounds.X + 6, bounds.Y + (bounds.Height - 16) / 2, 16, 16);
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    using (var path = Rounded(box, 4))
                    {
                        if (e.Item.Checked)
                        {
                            using (var fill = new SolidBrush(Theme.Accent)) g.FillPath(fill, path);
                            using (var tick = new Pen(Theme.AccentInk, 2f)) g.DrawLines(tick, new[] { new Point(box.X + 4, box.Y + 8), new Point(box.X + 7, box.Y + 11), new Point(box.X + 12, box.Y + 5) });
                        }
                        else using (var edge = new Pen(Theme.Muted, 1.5f)) g.DrawPath(edge, path);
                    }
                    g.SmoothingMode = SmoothingMode.None;
                    x = box.Right + 8;
                }
                var images = list.SmallImageList;
                if (images != null && images.ImageSize.Width > 1 && !string.IsNullOrEmpty(e.Item.ImageKey) && images.Images.ContainsKey(e.Item.ImageKey))
                {
                    var size = images.ImageSize;
                    g.DrawImage(images.Images[e.Item.ImageKey], x, bounds.Y + (bounds.Height - size.Height) / 2, size.Width, size.Height);
                    x += size.Width + 8;
                }
            }
            // A ladder ("\u0001"-separated steps, each starting with a mark) is
            // drawn as chips joined by arrows.
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
                Color edge, ink;
                if (mark == '\u2717') { edge = Theme.Border; ink = Color.FromArgb(0x5E, 0x75, 0x6B); }
                else if (mark == '\u23F8') { edge = Theme.Warn; ink = Theme.Warn; }
                else { edge = Color.FromArgb(0x2B, 0x6B, 0x45); ink = Theme.Text; }
                var size = TextRenderer.MeasureText(g, name, font, Size.Empty, TextFormatFlags.NoPadding);
                var chip = new Rectangle(x, area.Y + (area.Height - 22) / 2, size.Width + 26, 22);
                if (chip.Right > area.Right) break;
                using (var path = Rounded(chip, 11))
                {
                    using (var fill = new SolidBrush(mark == '\u2717' ? Theme.Page : Theme.Raised)) g.FillPath(fill, path);
                    using (var pen = new Pen(edge)) g.DrawPath(pen, path);
                }
                using (var dot = new SolidBrush(mark == '\u2717' ? Theme.Bad : mark == '\u23F8' ? Theme.Warn : Theme.Accent)) g.FillEllipse(dot, chip.X + 8, chip.Y + 8, 6, 6);
                TextRenderer.DrawText(g, name, font, new Rectangle(chip.X + 18, chip.Y, chip.Width - 20, chip.Height), ink, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPadding);
                x = chip.Right;
                if (i < steps.Length - 1)
                {
                    TextRenderer.DrawText(g, "\u2192", font, new Rectangle(x, area.Y, 22, area.Height), Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter);
                    x += 22;
                }
            }
            g.SmoothingMode = SmoothingMode.None;
        }

        public static GraphicsPath Rounded(Rectangle r, int radius)
        {
            var path = new GraphicsPath();
            var d = radius * 2;
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        // A 1 px border around a panel, drawn on its own surface.
        public static void Border(Control panel)
        {
            panel.Paint += (s, e) =>
            {
                using (var pen = new Pen(Theme.Border)) e.Graphics.DrawRectangle(pen, 0, 0, panel.Width - 1, panel.Height - 1);
            };
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

        // Dark title bar (Windows 10 2004+) in the app's colours (Windows 11).
        public static void DarkTitleBar(IntPtr hwnd)
        {
            try
            {
                var on = 1;
                DwmSetWindowAttribute(hwnd, 20, ref on, 4);
                var caption = ColorRef(Theme.Page);
                DwmSetWindowAttribute(hwnd, 35, ref caption, 4);
                var border = ColorRef(Theme.Border);
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

        // Tray and other menus.
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
            public override Color ToolStripDropDownBackground { get { return Theme.Card; } }
            public override Color ImageMarginGradientBegin { get { return Theme.Card; } }
            public override Color ImageMarginGradientMiddle { get { return Theme.Card; } }
            public override Color ImageMarginGradientEnd { get { return Theme.Card; } }
            public override Color MenuBorder { get { return Theme.Border; } }
            public override Color MenuItemBorder { get { return Theme.AccentDim; } }
            public override Color MenuItemSelected { get { return Theme.AccentDim; } }
            public override Color MenuItemSelectedGradientBegin { get { return Theme.AccentDim; } }
            public override Color MenuItemSelectedGradientEnd { get { return Theme.AccentDim; } }
            public override Color SeparatorDark { get { return Theme.Border; } }
            public override Color SeparatorLight { get { return Theme.Border; } }
        }
    }

    // A ListView that paints the area below its last row in the panel colour.
    // Windows otherwise draws column separators there in the light theme.
    internal sealed class DarkList : ListView
    {
        protected override void WndProc(ref Message m)
        {
            base.WndProc(ref m);
            if (m.Msg != 0x000F || View != View.Details) return; // WM_PAINT
            var top = Items.Count > 0 ? Items[Items.Count - 1].Bounds.Bottom : HeaderHeight();
            if (top >= ClientSize.Height) return;
            using (var g = CreateGraphics())
            using (var brush = new SolidBrush(BackColor)) g.FillRectangle(brush, 0, top, ClientSize.Width, ClientSize.Height - top);
        }

        private int HeaderHeight()
        {
            return Font.Height + 10;
        }
    }

    // A TabControl without its own tab headers or border; NavStrip shows the tabs.
    internal sealed class FlatTabs : TabControl
    {
        protected override void WndProc(ref Message m)
        {
            // TCM_ADJUSTRECT: let the pages fill the whole control.
            if (m.Msg == 0x1328 && !DesignMode) { m.Result = (IntPtr)1; return; }
            base.WndProc(ref m);
        }
    }

    // The tab bar: page titles, the selected one bright with an accent line.
    // Click or use Left/Right when focused.
    internal sealed class NavStrip : Control
    {
        private readonly TabControl tabs;
        private readonly List<Rectangle> slots = new List<Rectangle>();
        private int hover = -1;

        public NavStrip(TabControl tabs)
        {
            this.tabs = tabs;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
            Dock = DockStyle.Top;
            Height = 42;
            BackColor = Theme.Page;
            Font = Theme.Ui(10f);
            TabStop = true;
            Cursor = Cursors.Hand;
            AccessibleRole = AccessibleRole.PageTabList;
            AccessibleName = "Sections";
            tabs.SelectedIndexChanged += (s, e) => Invalidate();
            tabs.ControlAdded += (s, e) => Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(BackColor);
            using (var line = new Pen(Theme.Border)) g.DrawLine(line, 0, Height - 1, Width, Height - 1);
            slots.Clear();
            var x = 14;
            using (var bold = new Font(Font, FontStyle.Bold))
            {
                for (var i = 0; i < tabs.TabPages.Count; i++)
                {
                    var selected = i == tabs.SelectedIndex;
                    var title = tabs.TabPages[i].Text;
                    var font = selected ? bold : Font;
                    var width = TextRenderer.MeasureText(g, title, bold).Width + 20;
                    var slot = new Rectangle(x, 0, width, Height);
                    slots.Add(slot);
                    if (i == hover && !selected) using (var h = new SolidBrush(Theme.Card)) g.FillRectangle(h, slot.X, 6, slot.Width, Height - 12);
                    TextRenderer.DrawText(g, title, font, slot, selected ? Theme.Text : i == hover ? Theme.Text : Theme.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                    if (selected) using (var accent = new SolidBrush(Theme.Accent)) g.FillRectangle(accent, slot.X + 8, Height - 3, slot.Width - 16, 3);
                    if (selected && Focused)
                    {
                        g.SmoothingMode = SmoothingMode.AntiAlias;
                        using (var ring = new Pen(Theme.Accent, 1.5f))
                        using (var path = Skin.Rounded(new Rectangle(slot.X + 2, 6, slot.Width - 4, Height - 14), 6)) g.DrawPath(ring, path);
                        g.SmoothingMode = SmoothingMode.None;
                    }
                    x += width + 4;
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

        protected override void OnMouseLeave(EventArgs e)
        {
            hover = -1;
            Invalidate();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            var at = SlotAt(e.Location);
            if (at >= 0) tabs.SelectedIndex = at;
        }

        protected override bool IsInputKey(Keys keyData)
        {
            return keyData == Keys.Left || keyData == Keys.Right || base.IsInputKey(keyData);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            var count = tabs.TabPages.Count;
            if (e.KeyCode == Keys.Right) tabs.SelectedIndex = (tabs.SelectedIndex + 1) % count;
            if (e.KeyCode == Keys.Left) tabs.SelectedIndex = (tabs.SelectedIndex + count - 1) % count;
        }

        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
    }

    // An indeterminate progress line in the accent colour.
    internal sealed class Marquee : Control
    {
        private readonly Timer timer = new Timer { Interval = 30 };
        private float position;

        public Marquee()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            Height = 4;
            timer.Tick += (s, e) => { position = (position + 0.012f) % 1.4f; Invalidate(); };
            timer.Start();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Parent != null ? Parent.BackColor : Theme.Card);
            using (var track = new SolidBrush(Theme.Track)) e.Graphics.FillRectangle(track, 0, 0, Width, Height);
            var w = Width * 0.3f;
            var x = (position - 0.3f) * Width;
            using (var bar = new SolidBrush(Theme.Accent)) e.Graphics.FillRectangle(bar, x, 0, w, Height);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) timer.Dispose();
            base.Dispose(disposing);
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
                form.Padding = new Padding(0);
                var appIcon = AppIcon.Load(SystemInformation.SmallIconSize);
                if (appIcon != null) form.Icon = appIcon;

                var layout = new TableLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 2, RowCount = 2, Padding = new Padding(20, 20, 20, 14), BackColor = Theme.Card };
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
                var mark = new Glyph(glyph, glyphColor) { Margin = new Padding(0, 2, 16, 0) };
                layout.Controls.Add(mark, 0, 0);
                layout.Controls.Add(new Label { Text = text, AutoSize = true, MaximumSize = new Size(420, 0), ForeColor = Theme.Text, Margin = new Padding(0, 6, 0, 18), UseMnemonic = false }, 1, 0);

                var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill, Margin = new Padding(0), WrapContents = false };
                Button accept;
                Button cancel;
                if (buttons == MessageBoxButtons.YesNo || buttons == MessageBoxButtons.OKCancel)
                {
                    var yesNo = buttons == MessageBoxButtons.YesNo;
                    var no = new Button { Text = yesNo ? "No" : "Cancel", DialogResult = yesNo ? DialogResult.No : DialogResult.Cancel, Size = new Size(96, 32), Margin = new Padding(8, 0, 0, 0) };
                    var yes = Skin.Primary(new Button { Text = yesNo ? "Yes" : "OK", DialogResult = yesNo ? DialogResult.Yes : DialogResult.OK, Size = new Size(96, 32), Margin = new Padding(8, 0, 0, 0) });
                    row.Controls.Add(no);
                    row.Controls.Add(yes);
                    accept = defaultButton == MessageBoxDefaultButton.Button2 ? no : yes;
                    cancel = no;
                }
                else
                {
                    var ok = Skin.Primary(new Button { Text = "OK", DialogResult = DialogResult.OK, Size = new Size(96, 32), Margin = new Padding(8, 0, 0, 0) });
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
                form.BackColor = Theme.Card;
                return owner == null ? form.ShowDialog() : form.ShowDialog(owner);
            }
        }

        private sealed class Glyph : Control
        {
            private readonly string symbol;
            private readonly Color color;

            public Glyph(string symbol, Color color)
            {
                this.symbol = symbol;
                this.color = color;
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
                Size = new Size(34, 34);
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                e.Graphics.Clear(Parent != null ? Parent.BackColor : Theme.Card);
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using (var ring = new SolidBrush(Color.FromArgb(40, color))) e.Graphics.FillEllipse(ring, 0, 0, 33, 33);
                using (var edge = new Pen(color, 1.5f)) e.Graphics.DrawEllipse(edge, 1, 1, 31, 31);
                using (var font = Theme.Ui(13f, FontStyle.Bold)) TextRenderer.DrawText(e.Graphics, symbol, font, new Rectangle(0, 0, 34, 33), color, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            }
        }
    }
}
