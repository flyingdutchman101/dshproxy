// dshgate for Windows: a window and tray icon that run and control the gateway.
//
// The app owns no logic of its own. It starts `node bin/dshgate.js start` as a
// hidden child process, shows `dshgate status --json`, and runs the other CLI
// commands when a button is pressed. Built with the C# compiler that ships with
// Windows (see app/build.ps1).

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace Dshgate
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            bool created;
            using (var mutex = new Mutex(true, "dshgate-windows-app", out created))
            {
                if (!created)
                {
                    MessageBox.Show("dshgate is already running. Open it from the tray icon.", "dshgate", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm(Array.IndexOf(args, "--hidden") >= 0));
            }
        }
    }

    // Runs the dshgate command line.
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
                if (File.Exists(Path.Combine(dir.FullName, "bin", "dshgate.js"))) return dir.FullName;
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

        private ProcessStartInfo Info(string[] args, bool hidden)
        {
            var parts = new List<string> { Quote(Path.Combine(Root, "bin", "dshgate.js")) };
            foreach (var arg in args) parts.Add(Quote(arg));
            var info = new ProcessStartInfo(Node, string.Join(" ", parts.ToArray()))
            {
                WorkingDirectory = Root,
                UseShellExecute = false,
                CreateNoWindow = hidden
            };
            if (hidden)
            {
                info.RedirectStandardOutput = true;
                info.RedirectStandardError = true;
                info.RedirectStandardInput = true;
                info.StandardOutputEncoding = Encoding.UTF8;
                info.StandardErrorEncoding = Encoding.UTF8;
            }
            return info;
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
            using (var process = Process.Start(Info(args, true)))
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

        // Starts a long-running hidden process (the gateway).
        public Process StartHidden(string[] args)
        {
            var info = Info(args, true);
            info.RedirectStandardInput = false;
            return Process.Start(info);
        }

        // Opens a console window for a command that needs the user, such as a
        // browser sign-in.
        public Process StartInConsole(string[] args)
        {
            return Process.Start(Info(args, false));
        }
    }

    internal sealed class MainForm : Form
    {
        private static readonly Color Ok = Color.FromArgb(22, 128, 61);
        private static readonly Color Bad = Color.FromArgb(185, 28, 28);
        private static readonly Color Muted = Color.FromArgb(100, 100, 100);

        private readonly Cli cli;
        private readonly bool startHidden;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        private readonly NotifyIcon tray = new NotifyIcon();
        private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        private Process gateway;
        private bool quitting;
        private bool refreshing;
        private bool balloonShown;

        private readonly Label stateLabel = new Label { AutoSize = true, Font = new Font("Segoe UI", 12f, FontStyle.Bold) };
        private readonly Label detailLabel = new Label { AutoSize = true, ForeColor = Muted };
        private readonly Button startButton = new Button { Text = "Start", Width = 90 };
        private readonly Button stopButton = new Button { Text = "Stop", Width = 90 };
        private readonly ListView accountsList = new ListView();
        private readonly ComboBox loginCombo = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200 };
        private readonly ListView keysList = new ListView();
        private readonly ComboBox keyProviderCombo = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200 };
        private readonly ComboBox keyRegionCombo = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 220 };
        private readonly ListView lanesList = new ListView();
        private readonly ListView profilesList = new ListView();
        private readonly TextBox logBox = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, WordWrap = false, Dock = DockStyle.Fill, Font = new Font("Consolas", 9f), BackColor = Color.White };
        private readonly CheckBox autostartBox = new CheckBox { Text = "Start with Windows", AutoSize = true };
        private readonly Label footer = new Label { AutoSize = true, ForeColor = Muted };

        private ArrayList providers = new ArrayList();

        public MainForm(bool hidden)
        {
            startHidden = hidden;
            var root = Cli.FindRoot();
            var node = Cli.FindNode();
            if (root == null || node == null)
            {
                MessageBox.Show(root == null ? "dshgate.exe must stay in the dshgate folder (next to bin\\dshgate.js)." : "Node.js was not found. Install Node.js 22 or later.", "dshgate", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Environment.Exit(1);
            }
            cli = new Cli(root, node);

            Text = "dshgate";
            Width = 980;
            Height = 720;
            MinimumSize = new Size(820, 560);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 9f);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (ArgumentException) { }

            BuildLayout();
            BuildTray();

            startButton.Click += (s, e) => StartGateway();
            stopButton.Click += (s, e) => StopGateway();
            autostartBox.Checked = Autostart.IsOn();
            autostartBox.CheckedChanged += (s, e) => Autostart.Set(autostartBox.Checked);

            timer.Interval = 3000;
            timer.Tick += (s, e) => RefreshStatus();
            Shown += (s, e) => OnShownOnce();
            FormClosing += OnClosing;
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

        private bool shownOnce;
        private void OnShownOnce()
        {
            if (shownOnce) return;
            shownOnce = true;
            BeginInvoke(new Action(() =>
            {
                StartGateway();
                RefreshStatus();
                timer.Start();
            }));
        }

        // ---------- layout ----------

        private static ListView NewList(params string[] columns)
        {
            var list = new ListView { View = View.Details, FullRowSelect = true, HideSelection = false, Dock = DockStyle.Fill, HeaderStyle = ColumnHeaderStyle.Nonclickable };
            foreach (var column in columns) list.Columns.Add(column, 150);
            return list;
        }

        private static FlowLayoutPanel Row(params Control[] controls)
        {
            var row = new FlowLayoutPanel { Dock = DockStyle.Bottom, AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = true, Padding = new Padding(0, 6, 0, 0) };
            foreach (var control in controls) row.Controls.Add(control);
            return row;
        }

        private static Label Note(string text)
        {
            return new Label { Text = text, Dock = DockStyle.Top, AutoSize = false, Height = 38, ForeColor = Muted };
        }

        private TabPage Page(string title, Control body, Control top, Control bottom)
        {
            var page = new TabPage(title) { Padding = new Padding(10) };
            page.Controls.Add(body);
            if (bottom != null) page.Controls.Add(bottom);
            if (top != null) page.Controls.Add(top);
            return page;
        }

        private void BuildLayout()
        {
            var header = new TableLayoutPanel { Dock = DockStyle.Top, Height = 72, ColumnCount = 2, Padding = new Padding(12, 8, 12, 8) };
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            var stateStack = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, Dock = DockStyle.Fill, WrapContents = false };
            stateStack.Controls.Add(stateLabel);
            stateStack.Controls.Add(detailLabel);
            var buttons = new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Anchor = AnchorStyles.Right | AnchorStyles.Top, Margin = new Padding(0, 6, 0, 0) };
            buttons.Controls.Add(startButton);
            buttons.Controls.Add(stopButton);
            header.Controls.Add(stateStack, 0, 0);
            header.Controls.Add(buttons, 1, 0);

            var tabs = new TabControl { Dock = DockStyle.Fill };

            // Accounts
            accountsList.View = View.Details;
            foreach (var c in new[] { "Service", "Account", "State" }) accountsList.Columns.Add(c, c == "Account" ? 320 : 180);
            accountsList.FullRowSelect = true;
            accountsList.Dock = DockStyle.Fill;
            var loginButton = new Button { Text = "Sign in", Width = 100 };
            loginButton.Click += (s, e) => SignIn();
            var authFolder = new Button { Text = "Open credentials folder", AutoSize = true };
            authFolder.Click += (s, e) => OpenFolder("auth");
            tabs.TabPages.Add(Page("Accounts", accountsList,
                Note("Subscription accounts the gateway can use. Signing in opens your browser; the account appears here when you finish."),
                Row(new Label { Text = "Sign in to:", AutoSize = true, Padding = new Padding(0, 6, 0, 0) }, loginCombo, loginButton, authFolder)));

            // API keys
            keysList.View = View.Details;
            foreach (var c in new[] { "Provider", "Region", "State" }) keysList.Columns.Add(c, 220);
            keysList.FullRowSelect = true;
            keysList.Dock = DockStyle.Fill;
            var addKey = new Button { Text = "Add or replace key", AutoSize = true };
            addKey.Click += (s, e) => AddKey();
            var removeKey = new Button { Text = "Remove selected", AutoSize = true };
            removeKey.Click += (s, e) => RemoveKey();
            keyProviderCombo.SelectedIndexChanged += (s, e) => FillRegions();
            tabs.TabPages.Add(Page("API keys", keysList,
                Note("Pay-per-use API keys. Keys are stored encrypted for your Windows account. Restart the gateway after a change."),
                Row(keyProviderCombo, keyRegionCombo, addKey, removeKey)));

            // Lanes
            lanesList.View = View.Details;
            lanesList.Columns.Add("Lane", 110);
            lanesList.Columns.Add("Ladder (first to last)", 760);
            lanesList.FullRowSelect = true;
            lanesList.Dock = DockStyle.Fill;
            var editLanes = new Button { Text = "Edit lanes (settings.json)", AutoSize = true };
            editLanes.Click += (s, e) => EditSettings();
            tabs.TabPages.Add(Page("Lanes", lanesList,
                Note("A lane tries each model in order until one answers. \u2713 can serve, \u2717 no account or key, \u23F8 sitting out after running out of quota."),
                Row(editLanes)));

            // DeepSeek Harness
            profilesList.View = View.Details;
            foreach (var c in new[] { "Profile", "Routes", "Models", "Points at this gateway" }) profilesList.Columns.Add(c, 200);
            profilesList.FullRowSelect = true;
            profilesList.Dock = DockStyle.Fill;
            var preview = new Button { Text = "Preview changes", AutoSize = true };
            preview.Click += (s, e) => RunAndShow(new[] { "dsh", "apply", "--dry-run" }, "Preview");
            var apply = new Button { Text = "Apply to DeepSeek Harness", AutoSize = true };
            apply.Click += (s, e) => ApplyToHarness();
            var remove = new Button { Text = "Remove from DeepSeek Harness", AutoSize = true };
            remove.Click += (s, e) => RemoveFromHarness();
            tabs.TabPages.Add(Page("DeepSeek Harness", profilesList,
                Note("Apply writes the dshgate routes into every DeepSeek Harness profile and keeps everything else. Restart DeepSeek Harness afterwards."),
                Row(preview, apply, remove)));

            // Log
            var logPage = new TabPage("Log") { Padding = new Padding(10) };
            logPage.Controls.Add(logBox);
            var openLogFolder = new Button { Text = "Open data folder", AutoSize = true };
            openLogFolder.Click += (s, e) => OpenFolder("");
            logPage.Controls.Add(Row(openLogFolder));
            tabs.TabPages.Add(logPage);

            var bottom = new TableLayoutPanel { Dock = DockStyle.Bottom, Height = 34, ColumnCount = 2, Padding = new Padding(12, 4, 12, 4) };
            bottom.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            bottom.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            bottom.Controls.Add(footer, 0, 0);
            bottom.Controls.Add(autostartBox, 1, 0);

            Controls.Add(tabs);
            Controls.Add(bottom);
            Controls.Add(header);
        }

        private void BuildTray()
        {
            tray.Icon = Icon ?? SystemIcons.Application;
            tray.Text = "dshgate";
            tray.Visible = true;
            var menu = new ContextMenuStrip();
            menu.Items.Add("Open dshgate", null, (s, e) => ShowWindow());
            menu.Items.Add("Start gateway", null, (s, e) => StartGateway());
            menu.Items.Add("Stop gateway", null, (s, e) => StopGateway());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit", null, (s, e) => Quit());
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += (s, e) => ShowWindow();
        }

        private void ShowWindow()
        {
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }

        private void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (quitting || e.CloseReason == CloseReason.WindowsShutDown) return;
            // Closing the window keeps the gateway running in the tray.
            e.Cancel = true;
            Hide();
            if (!balloonShown)
            {
                balloonShown = true;
                tray.ShowBalloonTip(4000, "dshgate is still running", "The gateway keeps serving DeepSeek Harness. Right-click the tray icon to quit.", ToolTipIcon.Info);
            }
        }

        private void Quit()
        {
            quitting = true;
            timer.Stop();
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
                var request = (System.Net.HttpWebRequest)System.Net.WebRequest.Create(lastOrigin + "/dshgate/status");
                request.Timeout = 1500;
                using (var response = (System.Net.HttpWebResponse)request.GetResponse()) return (int)response.StatusCode == 200;
            }
            catch (System.Net.WebException) { return false; }
        }

        private string lastOrigin = "http://127.0.0.1:8417";

        private void StartGateway()
        {
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
        }

        // ---------- status ----------

        private void RefreshStatus()
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

        private static string Str(object value)
        {
            return value == null ? "" : Convert.ToString(value);
        }

        private static Dictionary<string, object> Obj(object value)
        {
            return value as Dictionary<string, object> ?? new Dictionary<string, object>();
        }

        private static ArrayList Arr(object value)
        {
            return value as ArrayList ?? new ArrayList();
        }

        private void ShowStatus(Cli.Result result)
        {
            if (result.Code != 0)
            {
                stateLabel.Text = "Status unavailable";
                stateLabel.ForeColor = Bad;
                detailLabel.Text = result.Err.Trim();
                return;
            }
            Dictionary<string, object> status;
            try { status = json.Deserialize<Dictionary<string, object>>(result.Out); }
            catch (ArgumentException) { return; }

            var running = status.ContainsKey("running") && (bool)status["running"];
            lastOrigin = Str(status["origin"]);
            var backend = Obj(status["backend"]);
            var accounts = Arr(status["accounts"]);
            var models = Arr(status["models"]);

            stateLabel.Text = running ? "Running" : "Stopped";
            stateLabel.ForeColor = running ? Ok : Bad;
            detailLabel.Text = running
                ? string.Format("{0}  \u00B7  {1} {2}  \u00B7  {3} models offered", lastOrigin, Str(backend["name"]), Str(backend["version"]), models.Count)
                : "The gateway is not running. Press Start.";
            startButton.Enabled = !running;
            stopButton.Enabled = running;
            tray.Text = running ? "dshgate: running" : "dshgate: stopped";
            footer.Text = "Data: " + Str(status["home"]) + "    Program: " + cli.Root;

            // Accounts
            accountsList.BeginUpdate();
            accountsList.Items.Clear();
            foreach (var item in accounts)
            {
                var account = Obj(item);
                var disabled = account.ContainsKey("disabled") && (bool)account["disabled"];
                var row = new ListViewItem(new[] { Str(account["label"]), Str(account["account"]), disabled ? "Disabled" : "Active" });
                row.ForeColor = disabled ? Muted : Color.Black;
                accountsList.Items.Add(row);
            }
            if (accounts.Count == 0) accountsList.Items.Add(new ListViewItem(new[] { "No accounts yet", "Pick a service below and press Sign in.", "" }) { ForeColor = Muted });
            accountsList.EndUpdate();
            if (loginCombo.Items.Count == 0)
            {
                foreach (var item in Arr(status["loginProviders"])) loginCombo.Items.Add(new Choice(Str(Obj(item)["key"]), Str(Obj(item)["label"])));
                if (loginCombo.Items.Count > 0) loginCombo.SelectedIndex = 0;
            }

            // API keys
            var keys = Obj(status["apiKeys"]);
            var readable = new Dictionary<string, string>();
            foreach (var item in Arr(keys["readable"])) readable[Str(Obj(item)["provider"])] = Str(Obj(item)["region"]);
            var unreadable = new HashSet<string>();
            foreach (var item in Arr(keys["unreadable"])) unreadable.Add(Str(item));
            providers = Arr(status["providers"]);
            keysList.BeginUpdate();
            keysList.Items.Clear();
            foreach (var item in providers)
            {
                var provider = Obj(item);
                var key = Str(provider["key"]);
                string state;
                Color color;
                if (readable.ContainsKey(key)) { state = "Saved"; color = Ok; }
                else if (unreadable.Contains(key)) { state = "Saved, cannot be read: add it again"; color = Bad; }
                else { state = "Not set"; color = Muted; }
                var region = readable.ContainsKey(key) ? RegionLabel(provider, readable[key]) : "";
                keysList.Items.Add(new ListViewItem(new[] { Str(provider["label"]), region, state }) { ForeColor = color, Tag = key });
            }
            keysList.EndUpdate();
            if (keyProviderCombo.Items.Count == 0)
            {
                foreach (var item in providers) keyProviderCombo.Items.Add(new Choice(Str(Obj(item)["key"]), Str(Obj(item)["label"])));
                if (keyProviderCombo.Items.Count > 0) keyProviderCombo.SelectedIndex = 0;
            }

            // Lanes
            lanesList.BeginUpdate();
            lanesList.Items.Clear();
            foreach (var item in Arr(status["lanes"]))
            {
                var lane = Obj(item);
                var parts = new List<string>();
                foreach (var rungItem in Arr(lane["ladder"]))
                {
                    var rung = Obj(rungItem);
                    var available = rung.ContainsKey("available") && (bool)rung["available"];
                    var cooling = Str(rung["coolingUntil"]);
                    var mark = !available ? "\u2717" : cooling.Length > 0 ? "\u23F8" : "\u2713";
                    parts.Add(mark + " " + Str(rung["model"]));
                }
                lanesList.Items.Add(new ListViewItem(new[] { "lane-" + Str(lane["name"]), string.Join("   \u2192   ", parts.ToArray()) }));
            }
            lanesList.EndUpdate();

            // DeepSeek Harness
            var harness = Obj(status["deepseekHarness"]);
            profilesList.BeginUpdate();
            profilesList.Items.Clear();
            foreach (var item in Arr(harness["profiles"]))
            {
                var p = Obj(item);
                var routes = Arr(p["routes"]);
                var count = 0;
                foreach (var route in routes) count += Convert.ToInt32(Obj(route)["models"]);
                var error = Str(p["error"]);
                var current = p.ContainsKey("current") && (bool)p["current"];
                string pointing = error.Length > 0 ? error : routes.Count == 0 ? "Not applied" : current ? "Yes" : "No: apply again";
                profilesList.Items.Add(new ListViewItem(new[] { Str(p["profile"]), routes.Count.ToString(), count.ToString(), pointing })
                {
                    ForeColor = routes.Count > 0 && current ? Ok : Muted
                });
            }
            profilesList.EndUpdate();
        }

        private static string RegionLabel(Dictionary<string, object> provider, string regionKey)
        {
            foreach (var item in Arr(provider["regions"]))
            {
                if (Str(Obj(item)["key"]) == regionKey) return Str(Obj(item)["label"]);
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
                var provider = Obj(item);
                if (Str(provider["key"]) != choice.Key) continue;
                foreach (var region in Arr(provider["regions"])) keyRegionCombo.Items.Add(new Choice(Str(Obj(region)["key"]), Str(Obj(region)["label"])));
            }
            if (keyRegionCombo.Items.Count > 0) keyRegionCombo.SelectedIndex = 0;
        }

        // ---------- actions ----------

        private void SignIn()
        {
            var choice = loginCombo.SelectedItem as Choice;
            if (choice == null) return;
            try
            {
                cli.StartInConsole(new[] { "login", choice.Key });
                AppendLog("Sign-in for " + choice.Label + " opened in a new window. Finish it in your browser.");
            }
            catch (System.ComponentModel.Win32Exception error)
            {
                MessageBox.Show(this, error.Message, "Sign in", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

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
            if (MessageBox.Show(this, "Remove the saved " + keysList.SelectedItems[0].Text + " key?", "API key", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            RunInBackground(new[] { "key", "remove", key }, null, "API key", true);
        }

        private void ApplyToHarness()
        {
            if (MessageBox.Show(this, "Write the dshgate routes into every DeepSeek Harness profile?\n\nEach profile is backed up first, and nothing else in it is changed. Restart DeepSeek Harness afterwards.", "DeepSeek Harness", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            RunAndShow(new[] { "dsh", "apply" }, "DeepSeek Harness");
        }

        private void RemoveFromHarness()
        {
            if (MessageBox.Show(this, "Remove the dshgate routes from every DeepSeek Harness profile?", "DeepSeek Harness", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            RunAndShow(new[] { "dsh", "remove" }, "DeepSeek Harness");
        }

        private void RunAndShow(string[] args, string title)
        {
            RunInBackground(args, null, title, false);
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
                        if (MessageBox.Show(this, text + "\n\nRestart the gateway now so it uses the change?", title, MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes)
                        {
                            StopGateway();
                            StartGateway();
                        }
                    }
                    else
                    {
                        MessageBox.Show(this, text.Length > 0 ? text : "Done.", title, MessageBoxButtons.OK, result.Code == 0 ? MessageBoxIcon.Information : MessageBoxIcon.Error);
                    }
                    RefreshStatus();
                }));
            });
        }

        private void OpenFolder(string sub)
        {
            var home = Environment.GetEnvironmentVariable("DSHGATE_HOME");
            if (string.IsNullOrEmpty(home)) home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dshgate");
            var folder = sub.Length > 0 ? Path.Combine(home, sub) : home;
            if (!Directory.Exists(folder)) folder = home;
            if (Directory.Exists(folder)) Process.Start("explorer.exe", "\"" + folder + "\"");
        }

        private void EditSettings()
        {
            var home = Environment.GetEnvironmentVariable("DSHGATE_HOME");
            if (string.IsNullOrEmpty(home)) home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dshgate");
            var file = Path.Combine(home, "settings.json");
            if (!File.Exists(file))
            {
                MessageBox.Show(this, "settings.json is created the first time a setting is saved, for example when you add an API key. Until then the default lanes are used.", "Lanes", MessageBoxButtons.OK, MessageBoxIcon.Information);
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
                form.ClientSize = new Size(420, 130);
                form.Font = new Font("Segoe UI", 9f);
                var label = new Label { Text = "API key for " + provider + ":", Left = 12, Top = 14, AutoSize = true };
                var box = new TextBox { Left = 12, Top = 38, Width = 396, UseSystemPasswordChar = true };
                var ok = new Button { Text = "Save", Left = 236, Top = 84, Width = 80, DialogResult = DialogResult.OK };
                var cancel = new Button { Text = "Cancel", Left = 328, Top = 84, Width = 80, DialogResult = DialogResult.Cancel };
                form.Controls.AddRange(new Control[] { label, box, ok, cancel });
                form.AcceptButton = ok;
                form.CancelButton = cancel;
                return form.ShowDialog(owner) == DialogResult.OK ? box.Text.Trim() : null;
            }
        }
    }

    // "Start with Windows": a value under the current user's Run key.
    internal static class Autostart
    {
        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string Name = "dshgate";

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
