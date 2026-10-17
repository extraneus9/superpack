using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Net.NetworkInformation;
using System.Threading;

namespace FrameHud
{
    // CPU/RAM from Windows counters; GPU from a streaming nvidia-smi (falls back to
    // the Windows "GPU Engine" counters when there is no NVIDIA driver).
    sealed class Sensors : IDisposable
    {
        public double? CpuPct, RamUsedGb, RamTotalGb;
        public double? PingMs;
        public volatile string PingHost = "1.1.1.1";      // fixed / fallback host
        public volatile string GameHost;                   // detected game server, or null
        public volatile string PingStatus = "starting";
        volatile bool disposed;

        public double? GpuPct, GpuTempC, VramUsedGb, VramTotalGb, GpuPowerW, GpuClockMhz;

        PerformanceCounter cpu;
        Process smi;
        bool smiAvailable = true;
        DateTime smiStarted;
        readonly object smiGate = new object();
        string smiLine;
        DateTime smiLineTime;
        List<PerformanceCounter> gpuEngines;
        DateTime gpuEnginesAt;

        public Sensors()
        {
            try { cpu = new PerformanceCounter("Processor Information", "% Processor Utility", "_Total"); cpu.NextValue(); }
            catch
            {
                try { cpu = new PerformanceCounter("Processor", "% Processor Time", "_Total"); cpu.NextValue(); }
                catch { cpu = null; }
            }
            StartSmi();
            var t = new Thread(PingLoop) { IsBackground = true, Name = "ping" };
            t.Start();
        }

        // One ICMP echo per second, like a game scoreboard. Pings the detected game server;
        // if that server ignores ping, falls back to PingHost and retries the server every 30 s.
        void PingLoop()
        {
            using (var ping = new Ping())
            {
                int fails = 0, gameFails = 0;
                string blocked = null;
                DateTime blockedUntil = DateTime.MinValue;
                while (!disposed)
                {
                    var started = DateTime.UtcNow;
                    string game = GameHost;
                    bool useGame = game != null && !(game == blocked && started < blockedUntil);
                    string host = useGame ? game : PingHost;
                    bool ok = false;
                    try
                    {
                        var reply = ping.Send(host, 1000);
                        if (reply.Status == IPStatus.Success) { PingMs = reply.RoundtripTime; ok = true; }
                    }
                    catch { }

                    if (ok)
                    {
                        fails = 0;
                        if (useGame) gameFails = 0;
                        PingStatus = useGame ? "game server " + host
                            : game != null ? host + " (game server " + game + " doesn't answer ping)"
                            : host + " (general internet \u2014 no game server detected)";
                    }
                    else if (useGame)
                    {
                        if (++gameFails >= 3) { blocked = game; blockedUntil = started.AddSeconds(30); gameFails = 0; }
                        continue; // try the fallback right away
                    }
                    else if (++fails >= 2) { PingMs = null; PingStatus = host + " not answering"; }

                    int wait = 1000 - (int)(DateTime.UtcNow - started).TotalMilliseconds;
                    if (wait > 0) Thread.Sleep(wait);
                }
            }
        }
        void StartSmi()
        {
            smiStarted = DateTime.UtcNow;
            try
            {
                var psi = new ProcessStartInfo("nvidia-smi",
                    "--id=0 --query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw,clocks.gr " +
                    "--format=csv,noheader,nounits -lms 500");
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.CreateNoWindow = true;
                var p = Process.Start(psi);
                smi = p;
                var t = new Thread(() =>
                {
                    try
                    {
                        string line;
                        while ((line = p.StandardOutput.ReadLine()) != null)
                            lock (smiGate) { smiLine = line; smiLineTime = DateTime.UtcNow; }
                    }
                    catch { }
                });
                t.IsBackground = true;
                t.Start();
            }
            catch { smi = null; smiAvailable = false; }
        }

        public void Update()
        {
            try { CpuPct = cpu != null ? Math.Min(100.0, cpu.NextValue()) : (double?)null; } catch { CpuPct = null; }

            var m = new Native.MEMORYSTATUSEX();
            if (Native.GlobalMemoryStatusEx(m))
            {
                RamTotalGb = m.ullTotalPhys / 1073741824.0;
                RamUsedGb = (m.ullTotalPhys - m.ullAvailPhys) / 1073741824.0;
            }

            string line; DateTime at;
            lock (smiGate) { line = smiLine; at = smiLineTime; }
            if (line != null && (DateTime.UtcNow - at).TotalSeconds < 3)
            {
                var f = line.Split(',');
                GpuPct = Num(f, 0);
                GpuTempC = Num(f, 1);
                VramUsedGb = Num(f, 2) / 1024.0;
                VramTotalGb = Num(f, 3) / 1024.0;
                GpuPowerW = Num(f, 4);
                GpuClockMhz = Num(f, 5);
                return;
            }

            GpuTempC = VramUsedGb = VramTotalGb = GpuPowerW = GpuClockMhz = null;
            if (smiAvailable)
            {
                GpuPct = null;
                if ((smi == null || smi.HasExited) && (DateTime.UtcNow - smiStarted).TotalSeconds > 10) StartSmi();
            }
            else GpuPct = PdhGpu();
        }

        static double? Num(string[] f, int i)
        {
            double v;
            if (i < f.Length && double.TryParse(f[i].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out v)) return v;
            return null;
        }

        double? PdhGpu()
        {
            try
            {
                if (gpuEngines == null || (DateTime.UtcNow - gpuEnginesAt).TotalSeconds > 10)
                {
                    if (gpuEngines != null) foreach (var c in gpuEngines) c.Dispose();
                    gpuEngines = new PerformanceCounterCategory("GPU Engine").GetInstanceNames()
                        .Where(n => n.EndsWith("engtype_3D"))
                        .Select(n => new PerformanceCounter("GPU Engine", "Utilization Percentage", n)).ToList();
                    foreach (var c in gpuEngines) { try { c.NextValue(); } catch { } }
                    gpuEnginesAt = DateTime.UtcNow;
                    return GpuPct;
                }
                double sum = 0;
                foreach (var c in gpuEngines) { try { sum += c.NextValue(); } catch { } }
                return Math.Min(100.0, sum);
            }
            catch { return null; }
        }

        public void Dispose()
        {
            disposed = true;
            try { if (smi != null && !smi.HasExited) smi.Kill(); } catch { }
            if (cpu != null) cpu.Dispose();
            if (gpuEngines != null) foreach (var c in gpuEngines) c.Dispose();
        }
    }
}
