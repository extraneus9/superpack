using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

namespace FrameHud
{
    sealed class FrameStats
    {
        public double Fps, FrameMs, Low1Fps;
    }

    // Counts Present() calls per process through a real-time ETW session on the
    // DXGI (DX10/11/12 + Vulkan/GL layered on DXGI) and D3D9 providers, plus the
    // DxgKrnl kernel present events that also catch native OpenGL / Vulkan apps
    // (Minecraft Java) that never touch DXGI. Same sources PresentMon uses.
    // Needs admin rights.
    sealed class PresentTracker : IDisposable
    {
        readonly string SessionName;
        const long Second = 10000000;            // FILETIME ticks
        const long Keep = 5 * Second;
        const int PropsSize = 120, NameBytes = 1024, LogfileSize = 448;

        static readonly Guid DxgiGuid = new Guid("CA11C036-0102-4A2D-A6AD-F03CFED5D3C9");
        static readonly Guid D3d9Guid = new Guid("783ACA0A-790E-4D7F-8451-AA850511C6B9");
        static readonly Guid KrnGuid = new Guid("802EC45A-1E99-4B83-9920-87C98277BA9D"); // Microsoft-Windows-DxgKrnl
        const ulong KrnKeywords = 0x1UL | 0x8000000000000000UL;                           // Base | Performance
        static readonly Guid NetGuid = new Guid("7DD42A49-5329-4832-8DFD-43D979153A88"); // Microsoft-Windows-Kernel-Network

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        delegate void EventRecordCallback(IntPtr record);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "StartTraceW")]
        static extern int StartTrace(out ulong handle, string name, IntPtr props);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "ControlTraceW")]
        static extern int ControlTrace(ulong handle, string name, IntPtr props, uint code);
        [DllImport("advapi32.dll")]
        static extern int EnableTraceEx2(ulong handle, ref Guid provider, uint control, byte level,
            ulong matchAny, ulong matchAll, uint timeout, IntPtr parameters);
        [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "OpenTraceW")]
        static extern ulong OpenTrace(IntPtr logfile);
        [DllImport("advapi32.dll")]
        static extern int ProcessTrace(ulong[] handles, uint count, IntPtr start, IntPtr end);
        [DllImport("advapi32.dll")]
        static extern int CloseTrace(ulong handle);

        sealed class Proc
        {
            public readonly Queue<long> Dxgi = new Queue<long>();
            public readonly Queue<long> D3d9 = new Queue<long>();
            public readonly Dictionary<int, Queue<long>> Krn = new Dictionary<int, Queue<long>>(); // by DxgKrnl event id
            public long Last;
            // User-mode runtime events are exactly one per Present(); the kernel stream is the
            // fallback for apps without them. Within it, use the single busiest event id so one
            // frame is never counted twice (a blt present can log Blit + Present).
            public Queue<long> Main
            {
                get
                {
                    var q = Dxgi.Count >= D3d9.Count ? Dxgi : D3d9;
                    Queue<long> k = null;
                    foreach (var x in Krn.Values) if (k == null || x.Count > k.Count) k = x;
                    // A hooked overlay can leave a stray low-rate DXGI stream in an OpenGL app;
                    // when the kernel sees clearly more presents, the kernel is the truth.
                    if (k != null && (q.Count < 3 || k.Count > q.Count * 3)) return k;
                    return q;
                }
            }
        }

        readonly Dictionary<uint, Proc> procs = new Dictionary<uint, Proc>();
        readonly object gate = new object();
        readonly EventRecordCallback callback;
        readonly long dxA, dxB, d9A, d9B, kA, kB, nA, nB;
        ulong session, trace = ulong.MaxValue;
        IntPtr logfile, loggerName;
        Thread thread;

        public string Error { get; private set; }

        public PresentTracker() : this("FrameHUD-PresentTrace") { }

        public PresentTracker(string sessionName)
        {
            SessionName = sessionName;
            byte[] b = DxgiGuid.ToByteArray();
            dxA = BitConverter.ToInt64(b, 0); dxB = BitConverter.ToInt64(b, 8);
            b = D3d9Guid.ToByteArray();
            d9A = BitConverter.ToInt64(b, 0); d9B = BitConverter.ToInt64(b, 8);
            b = KrnGuid.ToByteArray();
            kA = BitConverter.ToInt64(b, 0); kB = BitConverter.ToInt64(b, 8);
            b = NetGuid.ToByteArray();
            nA = BitConverter.ToInt64(b, 0); nB = BitConverter.ToInt64(b, 8);
            callback = OnEvent;
        }

        public bool Start()
        {
            StopSession(); // leftover from a crash
            IntPtr props = AllocProps();
            try
            {
                int err = StartTrace(out session, SessionName, props);
                if (err != 0)
                {
                    Error = err == 5 ? "FPS capture needs administrator rights (error 5)" : "ETW StartTrace error " + err;
                    return false;
                }
            }
            finally { Marshal.FreeHGlobal(props); }

            Guid g = DxgiGuid;
            EnableTraceEx2(session, ref g, 1, 5, ulong.MaxValue, 0, 0, IntPtr.Zero);
            g = D3d9Guid;
            EnableTraceEx2(session, ref g, 1, 5, ulong.MaxValue, 0, 0, IntPtr.Zero);
            g = KrnGuid;
            KrnStatus = EnableTraceEx2(session, ref g, 1, KrnLevel, KrnMask, 0, 0, IntPtr.Zero);
            g = NetGuid;
            NetStatus = EnableTraceEx2(session, ref g, 1, 5, ulong.MaxValue, 0, 0, IntPtr.Zero);

            logfile = Marshal.AllocHGlobal(LogfileSize);
            Marshal.Copy(new byte[LogfileSize], 0, logfile, LogfileSize);
            loggerName = Marshal.StringToHGlobalUni(SessionName);
            Marshal.WriteIntPtr(logfile, 8, loggerName);                    // LoggerName
            Marshal.WriteInt32(logfile, 28, 0x100 | 0x10000000);            // REAL_TIME | EVENT_RECORD
            Marshal.WriteIntPtr(logfile, 424, Marshal.GetFunctionPointerForDelegate(callback));

            trace = OpenTrace(logfile);
            if (trace == ulong.MaxValue)
            {
                Error = "ETW OpenTrace error " + Marshal.GetLastWin32Error();
                StopSession();
                return false;
            }

            ulong h = trace;
            thread = new Thread(() => { try { ProcessTrace(new[] { h }, 1, IntPtr.Zero, IntPtr.Zero); } catch { } });
            thread.IsBackground = true;
            thread.Name = "ETW presents";
            thread.Start();
            Error = null;
            return true;
        }

        static IntPtr AllocProps()
        {
            int total = PropsSize + NameBytes;
            IntPtr p = Marshal.AllocHGlobal(total);
            Marshal.Copy(new byte[total], 0, p, total);
            Marshal.WriteInt32(p, 0, total);          // Wnode.BufferSize
            Marshal.WriteInt32(p, 40, 1);             // Wnode.ClientContext = QPC clock
            Marshal.WriteInt32(p, 44, 0x00020000);    // WNODE_FLAG_TRACED_GUID
            Marshal.WriteInt32(p, 48, 16);            // BufferSize (KB)
            Marshal.WriteInt32(p, 52, 4);             // MinimumBuffers
            Marshal.WriteInt32(p, 56, 64);            // MaximumBuffers
            Marshal.WriteInt32(p, 64, 0x100 | 0x10);  // REAL_TIME_MODE | USE_MS_FLUSH_TIMER
            Marshal.WriteInt32(p, 68, 100);           // flush every 100 ms
            Marshal.WriteInt32(p, 116, PropsSize);    // LoggerNameOffset
            return p;
        }

        void StopSession()
        {
            IntPtr p = AllocProps();
            try { ControlTrace(0, SessionName, p, 1); }
            finally { Marshal.FreeHGlobal(p); }
        }

        void OnEvent(IntPtr r)
        {
            long a = Marshal.ReadInt64(r, 24), b = Marshal.ReadInt64(r, 32);   // ProviderId
            if (a == nA && b == nB) { OnNet(r); return; }
            bool dx = a == dxA && b == dxB, krn = a == kA && b == kB;
            if (!dx && !krn && !(a == d9A && b == d9B)) return;
            int id = (ushort)Marshal.ReadInt16(r, 40);                           // EventDescriptor.Id
            uint pid = (uint)Marshal.ReadInt32(r, 12);
            if (krn)
            {
                if (DebugPresents) CountDebug(pid, id, Marshal.ReadInt64(r, 48));
                // Blit_Info, Flip_Info, Present_Info, FlipMultiPlaneOverlay_Info: logged in the
                // presenting process' context.
                if (id != 166 && id != 168 && id != 184 && id != 252) return;
                if (pid == 0 || pid == 4) return;
            }
            else if (dx ? (id != 42 && id != 55) : id != 1) return;              // Present_Start
            long ts = Marshal.ReadInt64(r, 16);                                  // FILETIME (UTC)

            lock (gate)
            {
                Proc p;
                if (!procs.TryGetValue(pid, out p)) { p = new Proc(); procs[pid] = p; }
                Queue<long> q;
                if (krn) { if (!p.Krn.TryGetValue(id, out q)) { q = new Queue<long>(); p.Krn[id] = q; } }
                else q = dx ? p.Dxgi : p.D3d9;
                q.Enqueue(ts);
                if (ts > p.Last) p.Last = ts;
                while (q.Count > 0 && (q.Peek() < ts - Keep || q.Count > 20000)) q.Dequeue();
            }
        }

        public FrameStats GetStats(uint pid)
        {
            long[] ts;
            lock (gate)
            {
                Proc p;
                if (!procs.TryGetValue(pid, out p)) return null;
                ts = p.Main.ToArray();
            }
            return Compute(ts);
        }

        // Process with the most presents in the last 2 s (excluding `exclude`), or 0.
        public uint Busiest(uint exclude)
        {
            long now = DateTime.UtcNow.ToFileTimeUtc();
            uint best = 0;
            int bestN = 0;
            lock (gate)
            {
                foreach (var dead in procs.Where(kv => now - kv.Value.Last > 10 * Second).Select(kv => kv.Key).ToList())
                    procs.Remove(dead);
                foreach (var kv in procs)
                {
                    if (kv.Key == exclude || IsCompositor(kv.Key)) continue;
                    int n = kv.Value.Main.Count(t => t > now - 2 * Second);
                    if (n > bestN) { bestN = n; best = kv.Key; }
                }
            }
            return bestN >= 4 ? best : 0;
        }

        // dwm.exe presents every refresh through the kernel; it is never "the game".
        uint[] compositor = new uint[0];
        int compositorAt;
        bool IsCompositor(uint pid)
        {
            int now = Environment.TickCount;
            if (compositorAt == 0 || now - compositorAt > 10000)
            {
                compositorAt = now == 0 ? 1 : now;
                try { compositor = System.Diagnostics.Process.GetProcessesByName("dwm").Select(x => (uint)x.Id).ToArray(); } catch { }
            }
            return Array.IndexOf(compositor, pid) >= 0;
        }

        static FrameStats Compute(long[] ts)
        {
            if (ts.Length < 3) return null;
            Array.Sort(ts); // real-time buffers can arrive slightly out of order
            long last = ts[ts.Length - 1];
            if (DateTime.UtcNow.ToFileTimeUtc() - last > 2 * Second) return null; // app stopped rendering

            int first = ts.Length - 1;
            while (first > 0 && ts[first - 1] >= last - Second) first--;
            int n = ts.Length - 1 - first;
            double span = last - ts[first];
            if (n < 1 || span <= 0) return null;

            var s = new FrameStats();
            s.Fps = n * 1e7 / span;
            s.FrameMs = span / n / 1e4;

            var iv = new long[ts.Length - 1];
            for (int i = 1; i < ts.Length; i++) iv[i - 1] = ts[i] - ts[i - 1];
            Array.Sort(iv);
            long p99 = iv[(int)Math.Round(0.99 * (iv.Length - 1))];
            s.Low1Fps = p99 > 0 ? Math.Min(s.Fps, 1e7 / p99) : s.Fps;
            return s;
        }

        // ---------- game-server detection (Kernel-Network UDP/TCP events) ----------

        sealed class Remote
        {
            public byte[] Addr;
            public bool Udp;
            public int Port, Cur, Prev;
            public long WinStart, Last;
        }

        readonly Dictionary<uint, Dictionary<ulong, Remote>> net = new Dictionary<uint, Dictionary<ulong, Remote>>();
        readonly object netGate = new object();
        readonly Dictionary<int, int> netCounts = new Dictionary<int, int>();
        readonly Dictionary<int, string> netSamples = new Dictionary<int, string>();
        public int NetStatus { get; private set; }

        void OnNet(IntPtr r)
        {
            int id = (ushort)Marshal.ReadInt16(r, 40);
            bool udp, v6, send;
            switch (id)
            {
                case 10: udp = false; v6 = false; send = true; break;
                case 11: udp = false; v6 = false; send = false; break;
                case 26: udp = false; v6 = true; send = true; break;
                case 27: udp = false; v6 = true; send = false; break;
                case 42: udp = true; v6 = false; send = true; break;
                case 43: udp = true; v6 = false; send = false; break;
                case 58: udp = true; v6 = true; send = true; break;
                case 59: udp = true; v6 = true; send = false; break;
                default: return;
            }
            int len = (ushort)Marshal.ReadInt16(r, 86);
            IntPtr d = Marshal.ReadIntPtr(r, 96);
            int alen = v6 ? 16 : 4;
            if (d == IntPtr.Zero || len < 8 + alen * 2 + 4) return;

            if (DebugMode)
                lock (netGate)
                {
                    int c; netCounts.TryGetValue(id, out c); netCounts[id] = c + 1;
                    if (!netSamples.ContainsKey(id))
                    {
                        var raw = new byte[Math.Min(len, 48)];
                        Marshal.Copy(d, raw, 0, raw.Length);
                        netSamples[id] = BitConverter.ToString(raw);
                    }
                }

            uint pid = (uint)Marshal.ReadInt32(d, 0);
            var da = new byte[alen]; var sa = new byte[alen];
            Marshal.Copy(d + 8, da, 0, alen);
            Marshal.Copy(d + 8 + alen, sa, 0, alen);
            int dport = Swap(Marshal.ReadInt16(d, 8 + alen * 2));
            int sport = Swap(Marshal.ReadInt16(d, 8 + alen * 2 + 2));

            bool dp = IsPublic(da), sp = IsPublic(sa);
            byte[] remote; int rport;
            if (dp && !sp) { remote = da; rport = dport; }
            else if (sp && !dp) { remote = sa; rport = sport; }
            else if (dp && send) { remote = da; rport = dport; }
            else return;
            if (rport == 53 || rport == 5353 || rport == 123) return;           // DNS / NTP
            if (!udp && (rport == 80 || rport == 443)) return;                  // web traffic, not gameplay

            ulong key = udp ? 1UL << 62 : 0;
            for (int i = 0; i < remote.Length; i++) key = key * 1099511628211UL ^ remote[i];
            long ts = Marshal.ReadInt64(r, 16);

            lock (netGate)
            {
                Dictionary<ulong, Remote> map;
                if (!net.TryGetValue(pid, out map)) { map = new Dictionary<ulong, Remote>(); net[pid] = map; }
                Remote e;
                if (!map.TryGetValue(key, out e)) { e = new Remote { Addr = remote, Udp = udp, Port = rport, WinStart = ts }; map[key] = e; }
                if (ts - e.WinStart > 2 * Second) { e.Prev = ts - e.WinStart > 4 * Second ? 0 : e.Cur; e.Cur = 0; e.WinStart = ts; }
                e.Cur++;
                e.Last = ts;
            }
        }

        static int Swap(short v) { int u = (ushort)v; return ((u & 0xFF) << 8) | (u >> 8); }

        static bool IsPublic(byte[] a)
        {
            if (a.Length == 4)
            {
                int b0 = a[0], b1 = a[1];
                if (b0 == 0 || b0 == 10 || b0 == 127 || b0 >= 224) return false;
                if (b0 == 169 && b1 == 254) return false;
                if (b0 == 172 && b1 >= 16 && b1 <= 31) return false;
                if (b0 == 192 && b1 == 168) return false;
                if (b0 == 100 && b1 >= 64 && b1 <= 127) return false;               // carrier NAT
                return true;
            }
            bool v4mapped = true;
            for (int i = 0; i < 10; i++) if (a[i] != 0) v4mapped = false;
            if (v4mapped && a[10] == 0xFF && a[11] == 0xFF) return IsPublic(new[] { a[12], a[13], a[14], a[15] });
            if ((a[0] & 0xE0) != 0x20) return false;                                // only global unicast 2000::/3
            return true;
        }

        // The remote the game is talking to most right now (UDP preferred), or null.
        public string GameServer(uint pid)
        {
            long now = DateTime.UtcNow.ToFileTimeUtc();
            lock (netGate)
            {
                foreach (var dead in net.Where(kv => !kv.Value.Values.Any(e => now - e.Last < 30 * Second)).Select(kv => kv.Key).ToList())
                    net.Remove(dead);
                Dictionary<ulong, Remote> map;
                if (pid == 0 || !net.TryGetValue(pid, out map)) return null;
                Remote best = null;
                int bestScore = 0;
                foreach (var e in map.Values)
                {
                    if (now - e.Last > 4 * Second) continue;
                    int score = (e.Cur + e.Prev) * (e.Udp ? 4 : 1);
                    if (score > bestScore) { bestScore = score; best = e; }
                }
                return best != null && bestScore >= 12 ? new System.Net.IPAddress(best.Addr).ToString() : null;
            }
        }

        public bool DebugMode;

        // ---------- present diagnostics (--presenttest) ----------
        public bool DebugPresents;
        public byte KrnLevel = 4;
        public ulong KrnMask = KrnKeywords;
        public int KrnStatus { get; private set; }
        readonly Dictionary<long, long[]> krnDebug = new Dictionary<long, long[]>(); // (pid<<16|id) -> {count, keyword}

        void CountDebug(uint pid, int id, long keyword)
        {
            lock (krnDebug)
            {
                long k = ((long)pid << 16) | (uint)id;
                long[] v;
                if (!krnDebug.TryGetValue(k, out v)) { v = new long[2]; krnDebug[k] = v; }
                v[0]++; v[1] = keyword;
            }
        }

        public string PresentDump(double seconds, uint focusPid)
        {
            var sb = new System.Text.StringBuilder();
            long ts0 = DateTime.UtcNow.ToFileTimeUtc() - (long)(Math.Min(seconds, 5) * Second);
            double rs = Math.Min(seconds, 5); // runtime queues keep 5 s
            sb.AppendLine("EnableTraceEx2(DxgKrnl) = " + KrnStatus + "  level " + KrnLevel + "  mask 0x" + KrnMask.ToString("X"));
            lock (krnDebug)
                foreach (var g in krnDebug.GroupBy(kv => (uint)(kv.Key >> 16)).OrderByDescending(g => g.Sum(x => x.Value[0])).Take(25))
                {
                    string name;
                    try { name = System.Diagnostics.Process.GetProcessById((int)g.Key).ProcessName; } catch { name = "?"; }
                    string rt = "";
                    lock (gate)
                    {
                        Proc pr;
                        if (procs.TryGetValue(g.Key, out pr)) rt = "  [dxgi " + pr.Dxgi.Count(t => t > ts0) / rs + "/s, d3d9 " + pr.D3d9.Count(t => t > ts0) / rs + "/s, main " + (pr.Main == pr.Dxgi ? "dxgi" : pr.Main == pr.D3d9 ? "d3d9" : "kernel") + "]";
                    }
                    sb.AppendLine((g.Key == focusPid ? "*** " : "    ") + "pid " + g.Key + " " + name + rt);
                    foreach (var kv in g.OrderBy(x => (int)(x.Key & 0xFFFF)))
                        sb.AppendLine("        id " + (kv.Key & 0xFFFF) + "  " + (kv.Value[0] / seconds).ToString("F1") + "/s  kw 0x" + kv.Value[1].ToString("X"));
                }
            if (focusPid != 0)
            {
                var st = GetStats(focusPid);
                sb.AppendLine("GetStats(" + focusPid + ") = " + (st == null ? "null" : st.Fps.ToString("F1") + " fps, " + st.FrameMs.ToString("F2") + " ms, 1% low " + st.Low1Fps.ToString("F1")));
            }
            return sb.ToString();
        }

        public string NetDump()
        {
            var sb = new System.Text.StringBuilder();
            lock (netGate)
            {
                sb.AppendLine("EnableTraceEx2(Kernel-Network) = " + NetStatus);
                foreach (var kv in netCounts) sb.AppendLine("event " + kv.Key + ": " + kv.Value + "   sample " + netSamples[kv.Key]);
                long now = DateTime.UtcNow.ToFileTimeUtc();
                foreach (var p in net)
                {
                    string name;
                    try { name = System.Diagnostics.Process.GetProcessById((int)p.Key).ProcessName; } catch { name = "?"; }
                    sb.AppendLine("pid " + p.Key + " " + name + "  -> server " + (GameServer(p.Key) ?? "-"));
                    foreach (var e in p.Value.Values.OrderByDescending(x => x.Cur + x.Prev).Take(6))
                        sb.AppendLine("    " + (e.Udp ? "UDP " : "TCP ") + new System.Net.IPAddress(e.Addr) + ":" + e.Port +
                                      "  pkts " + (e.Cur + e.Prev) + "  age " + (now - e.Last) / 10000 + " ms");
                }
            }
            return sb.ToString();
        }

        public void Dispose()
        {
            StopSession();
            if (trace != ulong.MaxValue) { CloseTrace(trace); trace = ulong.MaxValue; }
            if (thread != null) thread.Join(1500);
            if (logfile != IntPtr.Zero) { Marshal.FreeHGlobal(logfile); logfile = IntPtr.Zero; }
            if (loggerName != IntPtr.Zero) { Marshal.FreeHGlobal(loggerName); loggerName = IntPtr.Zero; }
        }
    }
}
