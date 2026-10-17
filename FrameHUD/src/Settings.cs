using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Xml.Serialization;

namespace FrameHud
{
    public enum MetricId { Fps, FrameTime, Low1, Gpu, GpuTemp, Vram, GpuPower, GpuClock, Cpu, Ram, App, Time, Ping }
    public enum HudAnchor { TopLeft, TopCenter, TopRight, BottomLeft, BottomCenter, BottomRight }

    public class MetricSetting
    {
        public MetricId Id;
        public bool Show;
        public string Label;
        public MetricSetting() { }
        public MetricSetting(MetricId id, bool show, string label) { Id = id; Show = show; Label = label; }
    }

    public class HudSettings
    {
        // Not initialised here: XmlSerializer appends to pre-filled lists.
        public List<MetricSetting> Metrics;

        public bool Vertical = false;
        public string Separator = "|";
        public string FontFamily = "Segoe UI";
        public float FontSize = 16f;
        public bool LabelBold = false;
        public bool ValueBold = true;
        public string LabelColor = "#FFFFFF";
        public string ValueColor = "#FFFFFF";
        public string SeparatorColor = "#80FFFFFF";
        public string BackgroundColor = "#000000";
        public int BackgroundOpacity = 75;
        public int CornerRadius = 4;
        public int Padding = 8;
        public bool Outline = false;
        public string OutlineColor = "#000000";
        public float OutlineWidth = 2f;
        public bool FpsColors = false;
        public int FpsWarnBelow = 60;
        public int FpsBadBelow = 30;
        public string FpsWarnColor = "#FFC83D";
        public string FpsBadColor = "#FF4545";
        public HudAnchor Anchor = HudAnchor.TopRight;
        public int Monitor = 0;
        public int OffsetX = 12;
        public int OffsetY = 8;
        public int UpdateMs = 500;
        public bool FallbackToBusiest = true;
        public bool Visible = true;
        public string PingHost = "1.1.1.1";
        public bool PingAuto = true;
        public bool PingColors = true;
        public int PingWarnAbove = 80;
        public int PingBadAbove = 150;
        public string PingGoodColor = "#4CE06A";

        public static string Dir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "FrameHUD"); }
        }

        public static string FilePath { get { return Path.Combine(Dir, "settings.xml"); } }

        public static List<MetricSetting> DefaultMetrics()
        {
            return new List<MetricSetting>
            {
                new MetricSetting(MetricId.Fps, true, "FPS"),
                new MetricSetting(MetricId.FrameTime, true, "MS"),
                new MetricSetting(MetricId.Ping, true, "PING"),
                new MetricSetting(MetricId.Low1, false, "1% LOW"),
                new MetricSetting(MetricId.Gpu, true, "GPU"),
                new MetricSetting(MetricId.GpuTemp, false, "TEMP"),
                new MetricSetting(MetricId.Vram, false, "VRAM"),
                new MetricSetting(MetricId.GpuPower, false, "PWR"),
                new MetricSetting(MetricId.GpuClock, false, "CLK"),
                new MetricSetting(MetricId.Cpu, true, "CPU"),
                new MetricSetting(MetricId.Ram, false, "RAM"),
                new MetricSetting(MetricId.App, false, "APP"),
                new MetricSetting(MetricId.Time, false, "TIME"),
            };
        }

        public static string DisplayName(MetricId id)
        {
            switch (id)
            {
                case MetricId.Fps: return "Framerate (FPS)";
                case MetricId.FrameTime: return "Frame time (ms)";
                case MetricId.Low1: return "1% low FPS";
                case MetricId.Gpu: return "GPU usage";
                case MetricId.GpuTemp: return "GPU temperature";
                case MetricId.Vram: return "VRAM used";
                case MetricId.GpuPower: return "GPU power draw";
                case MetricId.GpuClock: return "GPU clock";
                case MetricId.Cpu: return "CPU usage";
                case MetricId.Ram: return "RAM used";
                case MetricId.App: return "Measured app name";
                case MetricId.Time: return "Clock";
                case MetricId.Ping: return "Ping / internet latency (ms)";
            }
            return id.ToString();
        }

        public static HudSettings CreateDefault()
        {
            var s = new HudSettings();
            s.Normalize();
            return s;
        }

        public static bool FirstRun { get; private set; }

        public static HudSettings Load()
        {
            HudSettings s = null;
            FirstRun = !File.Exists(FilePath);
            try
            {
                if (File.Exists(FilePath))
                    using (var f = File.OpenRead(FilePath))
                        s = (HudSettings)new XmlSerializer(typeof(HudSettings)).Deserialize(f);
            }
            catch { s = null; }
            if (s == null) s = new HudSettings();
            s.Normalize();
            return s;
        }

        public void Save()
        {
            Directory.CreateDirectory(Dir);
            string tmp = FilePath + ".tmp";
            using (var f = File.Create(tmp))
                new XmlSerializer(typeof(HudSettings)).Serialize(f, this);
            if (File.Exists(FilePath)) File.Delete(FilePath);
            File.Move(tmp, FilePath);
        }

        public void CopyFrom(HudSettings other)
        {
            foreach (FieldInfo f in typeof(HudSettings).GetFields(BindingFlags.Public | BindingFlags.Instance))
                f.SetValue(this, f.GetValue(other));
            Metrics = other.Metrics.Select(m => new MetricSetting(m.Id, m.Show, m.Label)).ToList();
        }

        void Normalize()
        {
            var defaults = DefaultMetrics();
            if (Metrics == null) Metrics = new List<MetricSetting>();
            Metrics = Metrics.GroupBy(m => m.Id).Select(g => g.First()).ToList();
            foreach (var d in defaults)
                if (!Metrics.Any(m => m.Id == d.Id)) Metrics.Add(d);
            foreach (var m in Metrics) if (m.Label == null) m.Label = "";
            if (FontSize < 6) FontSize = 6;
            if (UpdateMs < 100) UpdateMs = 100;
        }
    }

    static class ColorUtil
    {
        public static bool TryParse(string hex, out Color c)
        {
            c = Color.White;
            if (string.IsNullOrWhiteSpace(hex)) return false;
            string h = hex.Trim().TrimStart('#');
            uint v;
            if ((h.Length != 6 && h.Length != 8) ||
                !uint.TryParse(h, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v)) return false;
            if (h.Length == 6) v |= 0xFF000000;
            c = Color.FromArgb(unchecked((int)v));
            return true;
        }

        public static Color Parse(string hex, Color fallback)
        {
            Color c;
            return TryParse(hex, out c) ? c : fallback;
        }

        public static string ToHex(Color c)
        {
            return c.A == 255
                ? string.Format("#{0:X2}{1:X2}{2:X2}", c.R, c.G, c.B)
                : string.Format("#{0:X2}{1:X2}{2:X2}{3:X2}", c.A, c.R, c.G, c.B);
        }
    }
}
