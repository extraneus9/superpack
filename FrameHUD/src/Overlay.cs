using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.Threading;
using System.Windows.Forms;
using Timer = System.Windows.Forms.Timer;

namespace FrameHud
{
    sealed class HudItem
    {
        public string Label, Value, Template;
        public Color ValueColor;
    }

    sealed class OverlayForm : Form
    {
        const int HkToggle = 1, HkMove = 2, HkSettings = 3;
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        readonly HudSettings settings;
        readonly PresentTracker tracker = new PresentTracker();
        readonly Sensors sensors = new Sensors();
        readonly Timer timer = new Timer();
        readonly uint selfPid = (uint)Process.GetCurrentProcess().Id;
        readonly Dictionary<uint, string> names = new Dictionary<uint, string>();
        NotifyIcon tray;
        ToolStripMenuItem miShow, miMove;
        SettingsForm settingsForm;
        bool moveMode, dragging;
        Size lastSize;
        readonly bool openSettingsOnStart;
        readonly List<EventWaitHandle> signals = new List<EventWaitHandle>();

        public Icon AppIcon { get; private set; }
        public bool MoveMode { get { return moveMode; } }
        public string PingStatus { get { return sensors.PingStatus; } }
        public string FpsStatus { get { return tracker.Error ?? "OK — capturing presents (DirectX 9/10/11/12, OpenGL, Vulkan)"; } }

        public OverlayForm(HudSettings s, bool openSettings)
        {
            settings = s;
            openSettingsOnStart = openSettings || HudSettings.FirstRun;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Text = "FrameHUD";
            AppIcon = MakeIcon();
            Icon = AppIcon;
            tracker.Start();
            BuildTray();
            timer.Tick += (o, e) => Tick();
            Listen(Program.OpenSettingsEvent, () => OpenSettings());
            Listen(Program.ExitEvent, () => Close());
        }

        // Named events let a second launch (or the installer) talk to this instance.
        void Listen(string name, Action action)
        {
            try
            {
                var h = new EventWaitHandle(false, EventResetMode.AutoReset, name);
                signals.Add(h);
                ThreadPool.RegisterWaitForSingleObject(h, (st, timedOut) =>
                {
                    try { if (IsHandleCreated) BeginInvoke(action); } catch { }
                }, null, -1, false);
            }
            catch { }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= Native.WS_EX_LAYERED | Native.WS_EX_TRANSPARENT | Native.WS_EX_TOPMOST |
                              Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE;
                return cp;
            }
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            uint mods = Native.MOD_CONTROL | Native.MOD_SHIFT | Native.MOD_NOREPEAT;
            Native.RegisterHotKey(Handle, HkToggle, mods, (uint)Keys.F10);
            Native.RegisterHotKey(Handle, HkMove, mods, (uint)Keys.F11);
            Native.RegisterHotKey(Handle, HkSettings, mods, (uint)Keys.F12);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            ApplySettings();
            timer.Start();
            if (openSettingsOnStart) OpenSettings();
            string msg = "Ctrl+Shift+F12 settings · F11 move · F10 show/hide";
            if (tracker.Error != null) msg = tracker.Error + ". " + msg;
            tray.ShowBalloonTip(4000, "FrameHUD is running", msg, tracker.Error != null ? ToolTipIcon.Warning : ToolTipIcon.Info);
        }

        protected override void WndProc(ref Message m)
        {
            switch (m.Msg)
            {
                case Native.WM_NCHITTEST:
                    if (moveMode) { m.Result = (IntPtr)Native.HTCAPTION; return; }
                    break;
                case Native.WM_ENTERSIZEMOVE:
                    dragging = true;
                    break;
                case Native.WM_EXITSIZEMOVE:
                    dragging = false;
                    CommitDrag();
                    break;
                case Native.WM_HOTKEY:
                    switch (m.WParam.ToInt32())
                    {
                        case HkToggle: ToggleVisible(); break;
                        case HkMove: SetMoveMode(!moveMode); break;
                        case HkSettings: OpenSettings(); break;
                    }
                    return;
            }
            base.WndProc(ref m);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            timer.Stop();
            Native.UnregisterHotKey(Handle, HkToggle);
            Native.UnregisterHotKey(Handle, HkMove);
            Native.UnregisterHotKey(Handle, HkSettings);
            tray.Visible = false;
            tracker.Dispose();
            sensors.Dispose();
            try { settings.Save(); } catch { }
            base.OnFormClosing(e);
        }

        // ---------- public API for the settings window ----------

        public void ApplySettings()
        {
            timer.Interval = Math.Max(100, Math.Min(5000, settings.UpdateMs));
            miShow.Checked = settings.Visible;
            Tick();
        }

        public void OpenSettings()
        {
            if (settingsForm == null || settingsForm.IsDisposed) settingsForm = new SettingsForm(settings, this);
            settingsForm.Show();
            if (settingsForm.WindowState == FormWindowState.Minimized) settingsForm.WindowState = FormWindowState.Normal;
            settingsForm.Activate();
        }

        public void SetMoveMode(bool on)
        {
            moveMode = on;
            long ex = Native.GetWindowLongPtr(Handle, Native.GWL_EXSTYLE).ToInt64();
            ex = on ? ex & ~Native.WS_EX_TRANSPARENT : ex | Native.WS_EX_TRANSPARENT;
            Native.SetWindowLongPtr(Handle, Native.GWL_EXSTYLE, new IntPtr(ex));
            miMove.Checked = on;
            if (on && !settings.Visible) { settings.Visible = true; miShow.Checked = true; }
            if (settingsForm != null && !settingsForm.IsDisposed) settingsForm.SyncMoveMode(on);
            Tick();
        }

        void ToggleVisible()
        {
            settings.Visible = !settings.Visible;
            miShow.Checked = settings.Visible;
            try { settings.Save(); } catch { }
            Tick();
        }

        // ---------- tray ----------

        void BuildTray()
        {
            var menu = new ContextMenuStrip();
            miShow = new ToolStripMenuItem("Show overlay\tCtrl+Shift+F10", null, (o, e) => ToggleVisible());
            miMove = new ToolStripMenuItem("Move mode (drag it)\tCtrl+Shift+F11", null, (o, e) => SetMoveMode(!moveMode));
            menu.Items.Add(miShow);
            menu.Items.Add(miMove);
            menu.Items.Add(new ToolStripMenuItem("Settings…\tCtrl+Shift+F12", null, (o, e) => OpenSettings()));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Exit", null, (o, e) => Close()));
            tray = new NotifyIcon { Icon = AppIcon, Text = "FrameHUD", Visible = true, ContextMenuStrip = menu };
            tray.DoubleClick += (o, e) => OpenSettings();
        }

        static Icon MakeIcon()
        {
            using (var bmp = new Bitmap(32, 32, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    using (var p = RoundRect(new RectangleF(1, 1, 30, 30), 7)) g.FillPath(Brushes.Black, p);
                    using (var b = new SolidBrush(Color.FromArgb(230, 40, 40)))
                    {
                        g.FillRectangle(b, 7, 18, 4, 7);
                        g.FillRectangle(b, 14, 12, 4, 13);
                    }
                    g.FillRectangle(Brushes.White, 21, 7, 4, 18);
                }
                IntPtr h = bmp.GetHicon();
                var icon = (Icon)Icon.FromHandle(h).Clone();
                Native.DestroyIcon(h);
                return icon;
            }
        }

        // ---------- data ----------

        void Tick()
        {
            if (!IsHandleCreated) return;
            if (!settings.Visible && !moveMode)
            {
                if (Visible) Hide();
                return;
            }
            if (!Visible) Show();

            sensors.PingHost = string.IsNullOrWhiteSpace(settings.PingHost) ? "1.1.1.1" : settings.PingHost.Trim();
            sensors.Update();

            uint target = 0;
            FrameStats fs = null;
            uint fg = ForegroundPid();
            if (fg != 0 && fg != selfPid) { fs = tracker.GetStats(fg); if (fs != null) target = fg; }
            if (fs == null && settings.FallbackToBusiest)
            {
                uint b = tracker.Busiest(selfPid);
                if (b != 0) { fs = tracker.GetStats(b); if (fs != null) target = b; }
            }

            uint netPid = fg != 0 && fg != selfPid ? fg : target;
            sensors.GameHost = settings.PingAuto ? tracker.GameServer(netPid) ?? (target != 0 && target != netPid ? tracker.GameServer(target) : null) : null;

            Render(BuildItems(fs, target));
            Native.SetWindowPos(Handle, Native.HWND_TOPMOST, 0, 0, 0, 0,
                Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
        }

        static uint ForegroundPid()
        {
            IntPtr h = Native.GetForegroundWindow();
            if (h == IntPtr.Zero) return 0;
            uint pid;
            Native.GetWindowThreadProcessId(h, out pid);
            return pid;
        }

        string ProcName(uint pid)
        {
            string n;
            if (names.TryGetValue(pid, out n)) return n;
            if (names.Count > 256) names.Clear();
            try { n = Process.GetProcessById((int)pid).ProcessName; } catch { n = "?"; }
            names[pid] = n;
            return n;
        }

        List<HudItem> BuildItems(FrameStats fs, uint target)
        {
            const string na = "N/A";
            var s = sensors;
            Color valueColor = ColorUtil.Parse(settings.ValueColor, Color.White);
            var list = new List<HudItem>();
            foreach (var m in settings.Metrics)
            {
                if (!m.Show) continue;
                var it = new HudItem { Label = m.Label ?? "", ValueColor = valueColor };
                switch (m.Id)
                {
                    case MetricId.Fps:
                        it.Template = "000";
                        it.Value = fs != null ? Math.Round(fs.Fps).ToString("0", Inv) : na;
                        if (fs != null) it.ValueColor = FpsColor(fs.Fps, valueColor);
                        break;
                    case MetricId.FrameTime:
                        it.Template = "00.0";
                        it.Value = fs != null ? fs.FrameMs.ToString("0.0", Inv) : na;
                        break;
                    case MetricId.Low1:
                        it.Template = "000";
                        it.Value = fs != null ? Math.Round(fs.Low1Fps).ToString("0", Inv) : na;
                        if (fs != null) it.ValueColor = FpsColor(fs.Low1Fps, valueColor);
                        break;
                    case MetricId.Gpu: it.Template = "100 %"; it.Value = Fmt(s.GpuPct, "0", " %"); break;
                    case MetricId.GpuTemp: it.Template = "100 °C"; it.Value = Fmt(s.GpuTempC, "0", " °C"); break;
                    case MetricId.Vram: it.Template = "00.0 GB"; it.Value = Fmt(s.VramUsedGb, "0.0", " GB"); break;
                    case MetricId.GpuPower: it.Template = "000 W"; it.Value = Fmt(s.GpuPowerW, "0", " W"); break;
                    case MetricId.GpuClock: it.Template = "0000 MHz"; it.Value = Fmt(s.GpuClockMhz, "0", " MHz"); break;
                    case MetricId.Cpu: it.Template = "100 %"; it.Value = Fmt(s.CpuPct, "0", " %"); break;
                    case MetricId.Ram: it.Template = "00.0 GB"; it.Value = Fmt(s.RamUsedGb, "0.0", " GB"); break;
                    case MetricId.App: it.Template = ""; it.Value = target != 0 ? ProcName(target) : na; break;
                    case MetricId.Ping:
                        it.Template = "000";
                        it.Value = s.PingMs.HasValue ? s.PingMs.Value.ToString("0", Inv) : na;
                        if (s.PingMs.HasValue) it.ValueColor = PingColor(s.PingMs.Value, valueColor);
                        break;
                    case MetricId.Time: it.Template = "00:00"; it.Value = DateTime.Now.ToString("HH:mm", Inv); break;
                }
                list.Add(it);
            }
            return list;
        }

        static string Fmt(double? v, string fmt, string unit)
        {
            return v.HasValue ? v.Value.ToString(fmt, Inv) + unit : "N/A";
        }

        Color PingColor(double ms, Color normal)
        {
            if (!settings.PingColors) return normal;
            if (ms >= settings.PingBadAbove) return ColorUtil.Parse(settings.FpsBadColor, normal);
            if (ms >= settings.PingWarnAbove) return ColorUtil.Parse(settings.FpsWarnColor, normal);
            return ColorUtil.Parse(settings.PingGoodColor, normal);
        }

        Color FpsColor(double fps, Color normal)
        {
            if (!settings.FpsColors) return normal;
            if (fps < settings.FpsBadBelow) return ColorUtil.Parse(settings.FpsBadColor, normal);
            if (fps < settings.FpsWarnBelow) return ColorUtil.Parse(settings.FpsWarnColor, normal);
            return normal;
        }

        // ---------- drawing ----------

        void Render(List<HudItem> items)
        {
            var st = settings;
            if (items.Count == 0) items.Add(new HudItem { Label = "", Value = "FrameHUD", Template = "", ValueColor = Color.White });

            float em = Math.Max(6f, st.FontSize);
            FontFamily fam;
            try { fam = new FontFamily(st.FontFamily); } catch { fam = new FontFamily("Segoe UI"); }
            FontStyle ls = Pick(fam, st.LabelBold ? FontStyle.Bold : FontStyle.Regular);
            FontStyle vs = Pick(fam, st.ValueBold ? FontStyle.Bold : FontStyle.Regular);
            Color labelC = ColorUtil.Parse(st.LabelColor, Color.White);
            Color sepC = ColorUtil.Parse(st.SeparatorColor, Color.Gray);
            Color outlineC = ColorUtil.Parse(st.OutlineColor, Color.Black);
            Color bgRgb = ColorUtil.Parse(st.BackgroundColor, Color.Black);
            float outline = st.Outline ? Math.Max(0f, st.OutlineWidth) : 0f;

            using (fam)
            using (var lf = new Font(fam, em, ls, GraphicsUnit.Pixel))
            using (var vf = new Font(fam, em, vs, GraphicsUnit.Pixel))
            using (var fmt = Typo())
            using (var probe = new Bitmap(1, 1))
            using (var mg = Graphics.FromImage(probe))
            {
                mg.TextRenderingHint = TextRenderingHint.AntiAlias;
                int n = items.Count;
                float pad = Math.Max(0, st.Padding) + outline;
                float gapLV = em * 0.35f, gapItem = em * 0.55f, rowGap = em * 0.2f;
                float lineH = Math.Max(LineHeight(fam, ls, em), LineHeight(fam, vs, em));
                string sep = st.Separator ?? "";
                float sepW = sep.Length > 0 ? Measure(mg, sep, lf, fmt) : 0;

                var lw = new float[n]; var vw = new float[n]; var aw = new float[n];
                for (int i = 0; i < n; i++)
                {
                    lw[i] = Measure(mg, items[i].Label, lf, fmt);
                    aw[i] = Measure(mg, items[i].Value, vf, fmt);
                    vw[i] = Math.Max(aw[i], Measure(mg, items[i].Template, vf, fmt));
                }

                float W, H;
                if (st.Vertical)
                {
                    float colL = 0, colV = 0;
                    for (int i = 0; i < n; i++) { colL = Math.Max(colL, lw[i]); colV = Math.Max(colV, vw[i]); }
                    W = pad * 2 + colL + (colL > 0 ? gapLV * 2 : 0) + colV;
                    H = pad * 2 + n * lineH + (n - 1) * rowGap;
                }
                else
                {
                    W = pad * 2;
                    for (int i = 0; i < n; i++)
                    {
                        W += lw[i] + (lw[i] > 0 ? gapLV : 0) + vw[i];
                        if (i < n - 1) W += sepW > 0 ? gapItem * 2 + sepW : gapItem * 1.5f;
                    }
                    H = pad * 2 + lineH;
                }

                int w = (int)Math.Ceiling(W), h = (int)Math.Ceiling(H);
                using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.TextRenderingHint = TextRenderingHint.AntiAlias;
                    g.Clear(Color.Transparent);

                    int alpha = Math.Max(0, Math.Min(255, st.BackgroundOpacity * 255 / 100));
                    if (moveMode) alpha = Math.Max(alpha, 90);
                    if (alpha > 0)
                        using (var bg = RoundRect(new RectangleF(0, 0, w, h), st.CornerRadius))
                        using (var b = new SolidBrush(Color.FromArgb(alpha, bgRgb)))
                            g.FillPath(b, bg);
                    if (moveMode)
                        using (var bg = RoundRect(new RectangleF(1, 1, w - 2, h - 2), st.CornerRadius))
                        using (var p = new Pen(Color.FromArgb(255, 60, 60), 2) { DashStyle = DashStyle.Dash })
                            g.DrawPath(p, bg);

                    if (st.Vertical)
                    {
                        float y = pad;
                        for (int i = 0; i < n; i++)
                        {
                            DrawText(g, items[i].Label, fam, ls, em, pad, y, labelC, outlineC, outline, fmt);
                            DrawText(g, items[i].Value, fam, vs, em, w - pad - aw[i], y, items[i].ValueColor, outlineC, outline, fmt);
                            y += lineH + rowGap;
                        }
                    }
                    else
                    {
                        float x = pad;
                        for (int i = 0; i < n; i++)
                        {
                            DrawText(g, items[i].Label, fam, ls, em, x, pad, labelC, outlineC, outline, fmt);
                            x += lw[i] + (lw[i] > 0 ? gapLV : 0);
                            DrawText(g, items[i].Value, fam, vs, em, x + vw[i] - aw[i], pad, items[i].ValueColor, outlineC, outline, fmt);
                            x += vw[i];
                            if (i < n - 1)
                            {
                                if (sepW > 0)
                                {
                                    x += gapItem;
                                    DrawText(g, sep, fam, ls, em, x, pad, sepC, outlineC, outline, fmt);
                                    x += sepW + gapItem;
                                }
                                else x += gapItem * 1.5f;
                            }
                        }
                    }

                    lastSize = new Size(w, h);
                    Point pos;
                    Native.RECT r;
                    if (dragging && Native.GetWindowRect(Handle, out r)) pos = new Point(r.Left, r.Top);
                    else pos = ComputePosition(w, h);
                    SetBitmap(bmp, pos);
                }
            }
        }

        static FontStyle Pick(FontFamily fam, FontStyle want)
        {
            if (fam.IsStyleAvailable(want)) return want;
            foreach (FontStyle s in new[] { FontStyle.Regular, FontStyle.Bold, FontStyle.Italic })
                if (fam.IsStyleAvailable(s)) return s;
            return want;
        }

        static float LineHeight(FontFamily fam, FontStyle st, float em)
        {
            return em * (fam.GetCellAscent(st) + fam.GetCellDescent(st)) / fam.GetEmHeight(st);
        }

        static StringFormat Typo()
        {
            var f = (StringFormat)StringFormat.GenericTypographic.Clone();
            f.FormatFlags |= StringFormatFlags.MeasureTrailingSpaces | StringFormatFlags.NoWrap;
            return f;
        }

        static float Measure(Graphics g, string t, Font f, StringFormat fmt)
        {
            return string.IsNullOrEmpty(t) ? 0 : g.MeasureString(t, f, PointF.Empty, fmt).Width;
        }

        static void DrawText(Graphics g, string t, FontFamily fam, FontStyle st, float em, float x, float y,
            Color c, Color outlineC, float outline, StringFormat fmt)
        {
            if (string.IsNullOrEmpty(t)) return;
            using (var path = new GraphicsPath())
            {
                path.AddString(t, fam, (int)st, em, new PointF(x, y), fmt);
                if (outline > 0)
                    using (var pen = new Pen(outlineC, outline * 2) { LineJoin = LineJoin.Round })
                        g.DrawPath(pen, path);
                using (var b = new SolidBrush(c)) g.FillPath(b, path);
            }
        }

        static GraphicsPath RoundRect(RectangleF r, float rad)
        {
            var p = new GraphicsPath();
            float d = Math.Min(rad * 2, Math.Min(r.Width, r.Height));
            if (d < 1) { p.AddRectangle(r); return p; }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        // ---------- position ----------

        Screen TargetScreen()
        {
            var all = Screen.AllScreens;
            return settings.Monitor >= 0 && settings.Monitor < all.Length ? all[settings.Monitor] : Screen.PrimaryScreen;
        }

        Point ComputePosition(int w, int h)
        {
            Rectangle b = TargetScreen().Bounds;
            int ox = settings.OffsetX, oy = settings.OffsetY;
            int left = b.Left + ox, center = b.Left + (b.Width - w) / 2 + ox, right = b.Right - w - ox;
            int top = b.Top + oy, bottom = b.Bottom - h - oy;
            switch (settings.Anchor)
            {
                case HudAnchor.TopLeft: return new Point(left, top);
                case HudAnchor.TopCenter: return new Point(center, top);
                case HudAnchor.BottomLeft: return new Point(left, bottom);
                case HudAnchor.BottomCenter: return new Point(center, bottom);
                case HudAnchor.BottomRight: return new Point(right, bottom);
                default: return new Point(right, top);
            }
        }

        // After a drag, snap to the nearest anchor on whatever monitor it landed on.
        void CommitDrag()
        {
            Native.RECT wr;
            if (!Native.GetWindowRect(Handle, out wr)) return;
            var r = new Rectangle(wr.Left, wr.Top, lastSize.Width, lastSize.Height);
            var all = Screen.AllScreens;
            Screen scr = Screen.FromRectangle(r);
            int idx = Array.IndexOf(all, scr);
            Rectangle b = scr.Bounds;

            int cx = r.Left + r.Width / 2 - b.Left, cy = r.Top + r.Height / 2 - b.Top;
            bool top = cy < b.Height / 2;
            int col = cx < b.Width / 3 ? 0 : cx < b.Width * 2 / 3 ? 1 : 2;
            settings.Monitor = idx < 0 ? 0 : idx;
            settings.Anchor = (HudAnchor)((top ? 0 : 3) + col);
            settings.OffsetX = col == 0 ? r.Left - b.Left
                             : col == 1 ? r.Left - (b.Left + (b.Width - r.Width) / 2)
                             : b.Right - r.Right;
            settings.OffsetY = top ? r.Top - b.Top : b.Bottom - r.Bottom;
            try { settings.Save(); } catch { }
            if (settingsForm != null && !settingsForm.IsDisposed) settingsForm.RefreshPosition();
        }

        void SetBitmap(Bitmap bmp, Point pos)
        {
            IntPtr screenDc = Native.GetDC(IntPtr.Zero);
            IntPtr memDc = Native.CreateCompatibleDC(screenDc);
            IntPtr hBmp = IntPtr.Zero, old = IntPtr.Zero;
            try
            {
                hBmp = bmp.GetHbitmap(Color.FromArgb(0));
                old = Native.SelectObject(memDc, hBmp);
                var size = new Native.SIZE(bmp.Width, bmp.Height);
                var src = new Native.POINT(0, 0);
                var dst = new Native.POINT(pos.X, pos.Y);
                var blend = new Native.BLENDFUNCTION { BlendOp = 0, BlendFlags = 0, SourceConstantAlpha = 255, AlphaFormat = 1 };
                Native.UpdateLayeredWindow(Handle, screenDc, ref dst, ref size, memDc, ref src, 0, ref blend, 2);
            }
            finally
            {
                Native.ReleaseDC(IntPtr.Zero, screenDc);
                if (hBmp != IntPtr.Zero) { Native.SelectObject(memDc, old); Native.DeleteObject(hBmp); }
                Native.DeleteDC(memDc);
            }
        }
    }
}
