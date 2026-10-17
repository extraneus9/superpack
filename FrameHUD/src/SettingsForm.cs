using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security;
using System.Text;
using System.Windows.Forms;
using Timer = System.Windows.Forms.Timer;

namespace FrameHud
{
    sealed class SettingsForm : Form
    {
        readonly HudSettings s;
        readonly OverlayForm overlay;
        bool loading;
        DataGridView grid;
        ComboBox cbAnchor, cbMonitor;
        NumericUpDown nuOffX, nuOffY;
        CheckBox chkMove;

        public SettingsForm(HudSettings settings, OverlayForm ov)
        {
            s = settings;
            overlay = ov;
            Text = "FrameHUD — Settings";
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96f, 96f);
            Font = new Font("Segoe UI", 9f);
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = false;
            ClientSize = new Size(560, 640);
            MinimumSize = new Size(480, 480);
            Icon = ov.AppIcon;

            loading = true;
            var tabs = new TabControl { Dock = DockStyle.Fill };
            tabs.TabPages.Add(MetricsTab());
            tabs.TabPages.Add(StyleTab());
            tabs.TabPages.Add(PositionTab());
            tabs.TabPages.Add(GeneralTab());

            var bottom = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, AutoSize = true, Padding = new Padding(6) };
            var close = new Button { Text = "Done (keeps running in tray)", AutoSize = true };
            close.Click += (o, e) => Close();
            var reset = new Button { Text = "Reset to defaults", AutoSize = true };
            reset.Click += (o, e) => ResetDefaults();
            var quit = new Button { Text = "Quit FrameHUD", AutoSize = true };
            quit.Click += (o, e) => { Close(); overlay.Close(); };
            bottom.Controls.Add(close);
            bottom.Controls.Add(reset);
            bottom.Controls.Add(quit);

            Controls.Add(tabs);
            Controls.Add(bottom);
            tabs.BringToFront();
            loading = false;
        }

        void Changed()
        {
            if (loading) return;
            overlay.ApplySettings();
            try { s.Save(); } catch { }
        }

        void ResetDefaults()
        {
            if (MessageBox.Show(this, "Reset every setting to default?", "FrameHUD", MessageBoxButtons.OKCancel) != DialogResult.OK) return;
            s.CopyFrom(HudSettings.CreateDefault());
            Changed();
            Close();
            overlay.BeginInvoke(new Action(overlay.OpenSettings));
        }

        public void RefreshPosition()
        {
            loading = true;
            cbAnchor.SelectedIndex = (int)s.Anchor;
            if (s.Monitor < cbMonitor.Items.Count) cbMonitor.SelectedIndex = s.Monitor;
            nuOffX.Value = Clamp(nuOffX, s.OffsetX);
            nuOffY.Value = Clamp(nuOffY, s.OffsetY);
            loading = false;
        }

        public void SyncMoveMode(bool on)
        {
            loading = true;
            chkMove.Checked = on;
            loading = false;
        }

        // ---------- tabs ----------

        TabPage MetricsTab()
        {
            var page = new TabPage("Metrics") { Padding = new Padding(8) };
            grid = new DataGridView
            {
                Dock = DockStyle.Fill,
                AllowUserToAddRows = false,
                AllowUserToDeleteRows = false,
                AllowUserToResizeRows = false,
                RowHeadersVisible = false,
                SelectionMode = DataGridViewSelectionMode.FullRowSelect,
                MultiSelect = false,
                AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill,
                BackgroundColor = SystemColors.Window,
                BorderStyle = BorderStyle.FixedSingle,
            };
            grid.Columns.Add(new DataGridViewCheckBoxColumn { HeaderText = "Show", FillWeight = 16 });
            grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Metric", ReadOnly = true, FillWeight = 50 });
            grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Label on overlay (editable)", FillWeight = 44 });
            FillGrid();
            grid.CurrentCellDirtyStateChanged += (o, e) =>
            {
                if (grid.IsCurrentCellDirty && grid.CurrentCell is DataGridViewCheckBoxCell)
                    grid.CommitEdit(DataGridViewDataErrorContexts.Commit);
            };
            grid.CellValueChanged += (o, e) =>
            {
                if (loading || e.RowIndex < 0) return;
                var row = grid.Rows[e.RowIndex];
                var m = (MetricSetting)row.Tag;
                if (e.ColumnIndex == 0) { object v = row.Cells[0].Value; m.Show = v is bool && (bool)v; }
                else if (e.ColumnIndex == 2) m.Label = Convert.ToString(row.Cells[2].Value);
                Changed();
            };

            var side = new FlowLayoutPanel { Dock = DockStyle.Right, FlowDirection = FlowDirection.TopDown, AutoSize = true, Padding = new Padding(6, 0, 0, 0) };
            var up = new Button { Text = "▲  Up", Width = 80 };
            up.Click += (o, e) => MoveMetric(-1);
            var down = new Button { Text = "▼  Down", Width = 80 };
            down.Click += (o, e) => MoveMetric(1);
            side.Controls.Add(up);
            side.Controls.Add(down);

            var opts = Table();
            opts.Dock = DockStyle.Bottom;
            var cbLayout = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 160 };
            cbLayout.Items.AddRange(new object[] { "Horizontal (one row)", "Vertical (list)" });
            cbLayout.SelectedIndex = s.Vertical ? 1 : 0;
            cbLayout.SelectedIndexChanged += (o, e) => { s.Vertical = cbLayout.SelectedIndex == 1; Changed(); };
            var tbSep = new TextBox { Text = s.Separator, Width = 60 };
            tbSep.TextChanged += (o, e) => { s.Separator = tbSep.Text; Changed(); };
            Row(opts, "Layout", cbLayout);
            Row(opts, "Separator (row layout, empty = none)", tbSep);

            page.Controls.Add(grid);
            page.Controls.Add(side);
            page.Controls.Add(opts);
            grid.BringToFront();
            return page;
        }

        void FillGrid()
        {
            bool was = loading;
            loading = true;
            grid.Rows.Clear();
            foreach (var m in s.Metrics)
            {
                int r = grid.Rows.Add(m.Show, HudSettings.DisplayName(m.Id), m.Label);
                grid.Rows[r].Tag = m;
            }
            loading = was;
        }

        void MoveMetric(int d)
        {
            if (grid.CurrentRow == null) return;
            int i = grid.CurrentRow.Index, j = i + d;
            if (j < 0 || j >= s.Metrics.Count) return;
            var t = s.Metrics[i];
            s.Metrics[i] = s.Metrics[j];
            s.Metrics[j] = t;
            FillGrid();
            grid.CurrentCell = grid.Rows[j].Cells[1];
            Changed();
        }

        TabPage StyleTab()
        {
            var page = new TabPage("Style") { Padding = new Padding(8), AutoScroll = true };
            var t = Table();

            var cbFont = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 230, MaxDropDownItems = 24 };
            foreach (var f in FontFamily.Families) cbFont.Items.Add(f.Name);
            if (!cbFont.Items.Contains(s.FontFamily)) cbFont.Items.Insert(0, s.FontFamily);
            cbFont.SelectedItem = s.FontFamily;
            cbFont.SelectedIndexChanged += (o, e) => { s.FontFamily = (string)cbFont.SelectedItem; Changed(); };

            Row(t, "Font", cbFont);
            Row(t, "Text size (px)", Num(6, 200, (decimal)s.FontSize, 1, v => s.FontSize = (float)v));
            Row(t, "", Check("Bold labels", s.LabelBold, v => s.LabelBold = v));
            Row(t, "", Check("Bold values", s.ValueBold, v => s.ValueBold = v));
            Row(t, "Label color", ColorPicker(() => s.LabelColor, v => s.LabelColor = v));
            Row(t, "Value color", ColorPicker(() => s.ValueColor, v => s.ValueColor = v));
            Row(t, "Separator color (#AARRGGBB ok)", ColorPicker(() => s.SeparatorColor, v => s.SeparatorColor = v));
            Row(t, "Background color", ColorPicker(() => s.BackgroundColor, v => s.BackgroundColor = v));
            Row(t, "Background opacity (%)", Num(0, 100, s.BackgroundOpacity, 0, v => s.BackgroundOpacity = (int)v));
            Row(t, "Corner radius (px)", Num(0, 100, s.CornerRadius, 0, v => s.CornerRadius = (int)v));
            Row(t, "Padding (px)", Num(0, 100, s.Padding, 0, v => s.Padding = (int)v));
            Row(t, "", Check("Text outline (readable on any background)", s.Outline, v => s.Outline = v));
            Row(t, "Outline color", ColorPicker(() => s.OutlineColor, v => s.OutlineColor = v));
            Row(t, "Outline width (px)", Num(0, 20, (decimal)s.OutlineWidth, 1, v => s.OutlineWidth = (float)v));
            Row(t, "", Check("Color FPS by threshold", s.FpsColors, v => s.FpsColors = v));
            Row(t, "Warning below (FPS)", Num(1, 1000, s.FpsWarnBelow, 0, v => s.FpsWarnBelow = (int)v));
            Row(t, "Warning color (FPS + ping)", ColorPicker(() => s.FpsWarnColor, v => s.FpsWarnColor = v));
            Row(t, "Bad below (FPS)", Num(1, 1000, s.FpsBadBelow, 0, v => s.FpsBadBelow = (int)v));
            Row(t, "Bad color (FPS + ping)", ColorPicker(() => s.FpsBadColor, v => s.FpsBadColor = v));
            Row(t, "", Check("Color PING by quality", s.PingColors, v => s.PingColors = v));
            Row(t, "Good ping color", ColorPicker(() => s.PingGoodColor, v => s.PingGoodColor = v));
            Row(t, "Ping warning at (ms)", Num(1, 5000, s.PingWarnAbove, 0, v => s.PingWarnAbove = (int)v));
            Row(t, "Ping bad at (ms)", Num(1, 5000, s.PingBadAbove, 0, v => s.PingBadAbove = (int)v));

            page.Controls.Add(t);
            return page;
        }

        TabPage PositionTab()
        {
            var page = new TabPage("Position") { Padding = new Padding(8) };
            var t = Table();

            cbAnchor = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 160 };
            cbAnchor.Items.AddRange(new object[] { "Top left", "Top center", "Top right", "Bottom left", "Bottom center", "Bottom right" });
            cbAnchor.SelectedIndex = (int)s.Anchor;
            cbAnchor.SelectedIndexChanged += (o, e) => { s.Anchor = (HudAnchor)cbAnchor.SelectedIndex; Changed(); };

            cbMonitor = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 230 };
            var all = Screen.AllScreens;
            for (int i = 0; i < all.Length; i++)
                cbMonitor.Items.Add(string.Format("{0}: {1} x {2}{3}", i + 1, all[i].Bounds.Width, all[i].Bounds.Height, all[i].Primary ? "  (primary)" : ""));
            cbMonitor.SelectedIndex = s.Monitor < all.Length ? Math.Max(0, s.Monitor) : 0;
            cbMonitor.SelectedIndexChanged += (o, e) => { s.Monitor = cbMonitor.SelectedIndex; Changed(); };

            nuOffX = Num(-10000, 10000, s.OffsetX, 0, v => s.OffsetX = (int)v);
            nuOffY = Num(-10000, 10000, s.OffsetY, 0, v => s.OffsetY = (int)v);
            chkMove = new CheckBox { Text = "Move mode — drag the overlay with the mouse", AutoSize = true, Checked = overlay.MoveMode };
            chkMove.CheckedChanged += (o, e) => { if (!loading) overlay.SetMoveMode(chkMove.Checked); };

            Row(t, "Corner", cbAnchor);
            Row(t, "Monitor", cbMonitor);
            Row(t, "Offset X from edge (px)", nuOffX);
            Row(t, "Offset Y from edge (px)", nuOffY);
            Row(t, "", chkMove);
            Row(t, "", Note("Drag it anywhere in Move mode (Ctrl+Shift+F11). When you let go it locks to the nearest corner/edge, so it stays put when the text changes width."));

            page.Controls.Add(t);
            return page;
        }

        TabPage GeneralTab()
        {
            var page = new TabPage("General") { Padding = new Padding(8) };
            var t = Table();

            var nuRate = Num(100, 5000, s.UpdateMs, 0, v => s.UpdateMs = (int)v);
            nuRate.Increment = 50;
            Row(t, "Refresh every (ms)", nuRate);
            Row(t, "", Check("If the focused window isn't rendering, measure the busiest app instead", s.FallbackToBusiest, v => s.FallbackToBusiest = v));

            var tbPing = new TextBox { Text = s.PingHost, Width = 180 };
            tbPing.TextChanged += (o, e) => { s.PingHost = tbPing.Text.Trim(); Changed(); };
            Row(t, "", Check("Auto: ping the server the game is connected to", s.PingAuto, v => s.PingAuto = v));
            Row(t, "Fallback / fixed ping host", tbPing);
            var lblPing = Note(overlay.PingStatus);
            Row(t, "Pinging now", lblPing);
            var pingTimer = new Timer { Interval = 1000 };
            pingTimer.Tick += (o, e) => lblPing.Text = overlay.PingStatus;
            pingTimer.Start();
            FormClosed += (o, e) => pingTimer.Dispose();
            Row(t, "", Note("Auto finds the game's server from its network traffic. If that server ignores ping, it falls back to the host above (1.1.1.1 = general internet)."));

            var chkAuto = new CheckBox { Text = "Start with Windows (no admin prompt)", AutoSize = true, Checked = AutoStart.IsEnabled() };
            chkAuto.CheckedChanged += (o, e) =>
            {
                string err = AutoStart.Set(chkAuto.Checked);
                if (err != null) MessageBox.Show(this, err, "FrameHUD");
            };
            Row(t, "", chkAuto);
            Row(t, "FPS capture", Note(overlay.FpsStatus));
            Row(t, "Hotkeys", Note("Ctrl+Shift+F10  show / hide\r\nCtrl+Shift+F11  move mode\r\nCtrl+Shift+F12  this window"));
            Row(t, "Settings file", Note(HudSettings.FilePath));

            page.Controls.Add(t);
            return page;
        }

        // ---------- control helpers ----------

        static TableLayoutPanel Table()
        {
            var t = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2, Padding = new Padding(2) };
            t.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            return t;
        }

        static void Row(TableLayoutPanel t, string label, Control c)
        {
            t.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(3, 7, 12, 3) });
            c.Margin = new Padding(3, 4, 3, 4);
            t.Controls.Add(c);
        }

        static Label Note(string text)
        {
            return new Label { Text = text, AutoSize = true, MaximumSize = new Size(330, 0), ForeColor = SystemColors.GrayText };
        }

        static decimal Clamp(NumericUpDown n, decimal v)
        {
            return Math.Max(n.Minimum, Math.Min(n.Maximum, v));
        }

        NumericUpDown Num(decimal min, decimal max, decimal val, int decimals, Action<decimal> set)
        {
            var n = new NumericUpDown { Minimum = min, Maximum = max, DecimalPlaces = decimals, Width = 90, Increment = decimals > 0 ? 0.5m : 1m };
            n.Value = Clamp(n, val);
            n.ValueChanged += (o, e) => { if (loading) return; set(n.Value); Changed(); };
            return n;
        }

        CheckBox Check(string text, bool val, Action<bool> set)
        {
            var c = new CheckBox { Text = text, AutoSize = true, Checked = val };
            c.CheckedChanged += (o, e) => { if (loading) return; set(c.Checked); Changed(); };
            return c;
        }

        Control ColorPicker(Func<string> get, Action<string> set)
        {
            var panel = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0) };
            var swatch = new Button { Width = 34, Height = 24, FlatStyle = FlatStyle.Flat, Margin = new Padding(0, 0, 6, 0) };
            var box = new TextBox { Width = 100, Text = get(), CharacterCasing = CharacterCasing.Upper };
            Action paint = () => swatch.BackColor = Color.FromArgb(255, ColorUtil.Parse(get(), Color.White));
            paint();
            swatch.Click += (o, e) =>
            {
                Color cur = ColorUtil.Parse(get(), Color.White);
                using (var d = new ColorDialog { Color = Color.FromArgb(255, cur), FullOpen = true, AnyColor = true })
                {
                    if (d.ShowDialog(this) != DialogResult.OK) return;
                    box.Text = ColorUtil.ToHex(Color.FromArgb(cur.A, d.Color)); // keeps any alpha
                }
            };
            box.TextChanged += (o, e) =>
            {
                Color c;
                if (!ColorUtil.TryParse(box.Text, out c)) return;
                set(ColorUtil.ToHex(c));
                paint();
                Changed();
            };
            panel.Controls.Add(swatch);
            panel.Controls.Add(box);
            return panel;
        }
    }

    // Logon task with highest privileges: starts elevated without a UAC prompt.
    static class AutoStart
    {
        const string TaskName = "FrameHUD";

        public static bool IsEnabled()
        {
            return Run("/query /tn " + TaskName) == 0;
        }

        public static string Set(bool on)
        {
            if (!on) return Run("/delete /tn " + TaskName + " /f") == 0 ? null : "Could not remove the startup task.";

            string user = SecurityElement.Escape(Environment.UserDomainName + "\\" + Environment.UserName);
            string exe = SecurityElement.Escape(Application.ExecutablePath);
            string xml =
                "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\r\n" +
                "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">" +
                "<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>" + user + "</UserId><Delay>PT5S</Delay></LogonTrigger></Triggers>" +
                "<Principals><Principal id=\"Author\"><UserId>" + user + "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>" +
                "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>" +
                "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>5</Priority></Settings>" +
                "<Actions Context=\"Author\"><Exec><Command>" + exe + "</Command></Exec></Actions></Task>";
            string file = Path.Combine(Path.GetTempPath(), "framehud-task.xml");
            File.WriteAllText(file, xml, Encoding.Unicode);
            try
            {
                return Run("/create /tn " + TaskName + " /xml \"" + file + "\" /f") == 0 ? null : "Could not create the startup task.";
            }
            finally { try { File.Delete(file); } catch { } }
        }

        static int Run(string args)
        {
            var psi = new ProcessStartInfo("schtasks.exe", args)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using (var p = Process.Start(psi))
            {
                p.StandardOutput.ReadToEnd();
                p.StandardError.ReadToEnd();
                p.WaitForExit(10000);
                return p.ExitCode;
            }
        }
    }
}
