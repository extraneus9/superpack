using System;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace FrameHud
{
    static class Program
    {
        const string MutexName = "Global\\FrameHUD-SingleInstance";
        public const string OpenSettingsEvent = "Global\\FrameHUD-OpenSettings";
        public const string ExitEvent = "Global\\FrameHUD-Exit";

        [STAThread]
        static int Main(string[] args)
        {
            string cmd = args.Length > 0 ? args[0].ToLowerInvariant() : "";

            // Installer / command-line helpers (no UI).
            if (cmd == "--autostart")
            {
                bool on = args.Length > 1 && args[1].ToLowerInvariant() == "on";
                return AutoStart.Set(on) == null ? 0 : 1;
            }
            if (cmd == "--nettest")
            {
                var t = new PresentTracker("FrameHUD-NetTest") { DebugMode = true };
                string outPath = Path.Combine(HudSettings.Dir, "nettest.txt");
                Directory.CreateDirectory(HudSettings.Dir);
                if (!t.Start()) { File.WriteAllText(outPath, "start failed: " + t.Error + " | elevated=" + new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent()).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator)); return 1; }
                Thread.Sleep(15000);
                File.WriteAllText(outPath, t.NetDump());
                t.Dispose();
                return 0;
            }
            if (cmd == "--presenttest")
            {
                // --presenttest <seconds> <outFile> [processName] [level] [keywordMaskHex]
                double secs = args.Length > 1 ? double.Parse(args[1], System.Globalization.CultureInfo.InvariantCulture) : 8;
                string outPath = args.Length > 2 ? args[2] : Path.Combine(HudSettings.Dir, "presenttest.txt");
                string focus = args.Length > 3 ? args[3] : "";
                var t = new PresentTracker("FrameHUD-PresentTest") { DebugPresents = true };
                if (args.Length > 4) t.KrnLevel = byte.Parse(args[4]);
                if (args.Length > 5) t.KrnMask = Convert.ToUInt64(args[5], 16);
                if (!t.Start()) { File.WriteAllText(outPath, "start failed: " + t.Error); return 1; }
                Thread.Sleep((int)(secs * 1000));
                uint pid = 0;
                if (focus != "") foreach (var p in System.Diagnostics.Process.GetProcessesByName(focus)) pid = (uint)p.Id;
                File.WriteAllText(outPath, t.PresentDump(secs, pid));
                t.Dispose();
                return 0;
            }
            if (cmd == "--exit")
            {
                Signal(ExitEvent);
                WaitForExit();
                return 0;
            }

            bool created;
            using (var mutex = new Mutex(true, MutexName, out created))
            {
                if (!created)
                {
                    // Already running: clicking the app again opens its settings.
                    Signal(OpenSettingsEvent);
                    return 0;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.ThreadException += (o, e) => Log(e.Exception);
                AppDomain.CurrentDomain.UnhandledException += (o, e) => Log(e.ExceptionObject as Exception);
                Application.Run(new OverlayForm(HudSettings.Load(), cmd == "--settings"));
            }
            return 0;
        }

        static void Signal(string name)
        {
            try
            {
                EventWaitHandle h;
                if (EventWaitHandle.TryOpenExisting(name, out h)) using (h) h.Set();
            }
            catch { }
        }

        static void WaitForExit()
        {
            try
            {
                using (var m = new Mutex(false, MutexName))
                {
                    try { if (m.WaitOne(8000)) m.ReleaseMutex(); }
                    catch (AbandonedMutexException) { }
                }
            }
            catch { }
        }

        static void Log(Exception ex)
        {
            try
            {
                Directory.CreateDirectory(HudSettings.Dir);
                File.AppendAllText(Path.Combine(HudSettings.Dir, "error.log"), DateTime.Now + "  " + ex + Environment.NewLine);
            }
            catch { }
        }
    }
}
