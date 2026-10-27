// DepthMotion.exe — sets up the GPU engine once, then opens the app in its own window.
// Engine = a private Python + PyTorch (CUDA 12.8) made by uv.exe in %LOCALAPPDATA%\DepthMotion. Nothing touches a system Python.
//   DepthMotion.exe            open the app (sets up first if needed, with a progress window)
//   DepthMotion.exe --setup    set up only, no window (the installer runs this); progress lines go to setup.log
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;

static class DepthMotion
{
    static readonly string App = AppDomain.CurrentDomain.BaseDirectory;
    static readonly string Home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DepthMotion");
    static readonly string Runtime = Path.Combine(Home, "runtime");
    static readonly string Py = Path.Combine(Runtime, "Scripts", "python.exe");
    static readonly string PyW = Path.Combine(Runtime, "Scripts", "pythonw.exe");
    static readonly string Ready = Path.Combine(Runtime, "depthmotion.ready");
    static readonly string Log = Path.Combine(Home, "setup.log");
    const string Torch = "https://download.pytorch.org/whl/cu128";

    [STAThread]
    static int Main(string[] args)
    {
        Directory.CreateDirectory(Home);
        bool silent = Array.IndexOf(args, "--setup") >= 0;
        if (silent) return Setup(null) ? 0 : 1;

        Application.EnableVisualStyles();
        if (!HasNvidia() && MessageBox.Show("DepthMotion needs an NVIDIA graphics card, and none was found on this PC.\n\nOpen it anyway?",
                "DepthMotion", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return 1;
        if (!File.Exists(Ready) && !SetupWindow()) return 1;
        CatchUp();
        return Open() ? 0 : 1;
    }

    // an update that needs a new Python package installs just that, quietly, the next time the app opens
    static readonly string Installed = Path.Combine(Runtime, "requirements.installed");
    static void CatchUp()
    {
        string want = File.ReadAllText(Path.Combine(App, "requirements.txt"));
        if (File.Exists(Installed) && File.ReadAllText(Installed) == want) return;
        try
        {
            Run(Path.Combine(App, "uv.exe"), "pip install --python \"" + Py + "\" -r \"" + Path.Combine(App, "requirements.txt") + "\"");
            File.WriteAllText(Installed, want);
        }
        catch (Exception e) { Append("catch-up failed: " + e.Message); }
    }

    // ---------- first-run setup ----------
    static bool Setup(Action<string, int> say)
    {
        say = say ?? ((m, p) => { });
        try
        {
            File.WriteAllText(Log, "");
            string uv = Path.Combine(App, "uv.exe");
            if (Directory.Exists(Runtime)) Directory.Delete(Runtime, true);
            say("Getting Python ready", 4);
            Run(uv, "venv \"" + Runtime + "\" --python 3.12 --seed");
            say("Downloading PyTorch for your graphics card (about 3 GB, once)", 12);
            Run(uv, "pip install --python \"" + Py + "\" torch torchvision --index-url " + Torch);
            say("Installing the rest", 78);
            Run(uv, "pip install --python \"" + Py + "\" -r \"" + Path.Combine(App, "requirements.txt") + "\"");
            say("Downloading the depth model", 88);
            Run(Py, "\"" + Path.Combine(App, "engine", "depthmotion.py") + "\" --prefetch vits");
            try { Directory.Delete(Path.Combine(Home, "cache"), true); } catch { }
            File.WriteAllText(Ready, DateTime.Now.ToString("s"));
            File.WriteAllText(Installed, File.ReadAllText(Path.Combine(App, "requirements.txt")));
            say("Ready", 100);
            return true;
        }
        catch (Exception e)
        {
            File.AppendAllText(Log, "\r\nFAILED: " + e.Message + "\r\n");
            say("Setup failed: " + e.Message, -1);
            return false;
        }
    }

    static void Run(string exe, string args)
    {
        var psi = new ProcessStartInfo(exe, args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        psi.EnvironmentVariables["UV_PYTHON_INSTALL_DIR"] = Path.Combine(Home, "python");
        psi.EnvironmentVariables["UV_CACHE_DIR"] = Path.Combine(Home, "cache");
        psi.EnvironmentVariables["UV_PYTHON_PREFERENCE"] = "only-managed";
        psi.EnvironmentVariables["UV_LINK_MODE"] = "copy";
        psi.EnvironmentVariables["DEPTHMOTION_HOME"] = Home;
        psi.EnvironmentVariables["SAM2_BUILD_CUDA"] = "0";  // SAM 2 runs fine without its optional CUDA extension
        using (var p = Process.Start(psi))
        {
            p.OutputDataReceived += (s, e) => { if (e.Data != null) Append(e.Data); };
            p.ErrorDataReceived += (s, e) => { if (e.Data != null) Append(e.Data); };
            p.BeginOutputReadLine(); p.BeginErrorReadLine();
            p.WaitForExit();
            if (p.ExitCode != 0) throw new Exception(Path.GetFileName(exe) + " stopped (code " + p.ExitCode + "). Details in " + Log);
        }
    }
    static readonly object LogLock = new object();
    static void Append(string line) { lock (LogLock) File.AppendAllText(Log, line + "\r\n"); }

    static bool SetupWindow()
    {
        var f = new Form { Text = "DepthMotion", ClientSize = new Size(460, 170), FormBorderStyle = FormBorderStyle.FixedSingle, MaximizeBox = false,
            StartPosition = FormStartPosition.CenterScreen, BackColor = Color.FromArgb(246, 245, 242), Font = new Font("Segoe UI", 9.5f) };
        try { f.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        var title = new Label { Text = "Setting up DepthMotion", Font = new Font("Segoe UI Semibold", 13f), ForeColor = Color.FromArgb(17, 17, 17), AutoSize = true, Location = new Point(24, 22) };
        var msg = new Label { Text = "Starting", ForeColor = Color.FromArgb(76, 73, 67), AutoSize = false, Size = new Size(412, 40), Location = new Point(25, 58) };
        var bar = new ProgressBar { Location = new Point(26, 108), Size = new Size(408, 6), Style = ProgressBarStyle.Continuous };
        var note = new Label { Text = "This happens once. Keep the PC online.", ForeColor = Color.FromArgb(138, 134, 126), AutoSize = true, Location = new Point(24, 128) };
        f.Controls.AddRange(new Control[] { title, msg, bar, note });
        bool ok = false;
        f.Shown += (s, e) => new Thread(() =>
        {
            ok = Setup((m, p) => f.BeginInvoke((Action)(() => { msg.Text = m; if (p >= 0) bar.Value = Math.Min(100, p); })));
            f.BeginInvoke((Action)(() =>
            {
                if (!ok) MessageBox.Show(f, "DepthMotion couldn't finish setting up.\n\nCheck your internet connection and open it again. Details are in:\n" + Log, "DepthMotion", MessageBoxButtons.OK, MessageBoxIcon.Error);
                f.Close();
            }));
        }) { IsBackground = true }.Start();
        Application.Run(f);
        return ok;
    }

    // ---------- open ----------
    static bool Open()
    {
        string portFile = Path.Combine(Home, "port");
        int port = 0;
        if (File.Exists(portFile) && int.TryParse(File.ReadAllText(portFile).Trim(), out port) && Alive(port))
        {
            // an engine is already running: reuse it — unless it's from an older build (then ask it to step aside)
            string buildFile = Path.Combine(App, "engine", "BUILD");
            string build = File.Exists(buildFile) ? File.ReadAllText(buildFile).Trim() : "";
            if (build == "" || State(port).Contains("\"build\": \"" + build + "\"")) { Window(port); return true; }
            try { using (var c = new WebClient()) c.UploadString("http://127.0.0.1:" + port + "/api/quit", "{}"); }
            catch (WebException e)
            {
                var r = e.Response as HttpWebResponse;
                if (r != null && (int)r.StatusCode == 409) { Window(port); return true; }  // busy rendering: keep it
                // an engine too old to step aside: start the new one beside it (the old one quits once its window is gone)
            }
            for (int i = 0; i < 50 && Alive(port); i++) Thread.Sleep(100);
        }
        port = FreePort();
        var psi = new ProcessStartInfo(File.Exists(PyW) ? PyW : Py, "server.py " + port) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.Combine(App, "engine") };
        psi.EnvironmentVariables["DEPTHMOTION_HOME"] = Home;
        Process.Start(psi);
        for (int i = 0; i < 300 && !Alive(port); i++) Thread.Sleep(100);  // torch import takes a few seconds
        if (!Alive(port)) { MessageBox.Show("DepthMotion's engine didn't start. Try opening it again.", "DepthMotion", MessageBoxButtons.OK, MessageBoxIcon.Error); return false; }
        File.WriteAllText(portFile, port.ToString());
        Window(port);
        return true;
    }

    static void Window(int port)
    {
        string url = "http://127.0.0.1:" + port + "/";
        string edge = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe");
        if (!File.Exists(edge)) edge = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe");
        if (File.Exists(edge))
            Process.Start(edge, "--app=" + url + " --window-size=1500,920 --user-data-dir=\"" + Path.Combine(Home, "window") + "\" --no-first-run --disable-features=Translate");
        else
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }

    static bool HasNvidia()
    {
        string smi = Path.Combine(Environment.SystemDirectory, "nvidia-smi.exe");
        return File.Exists(smi) || File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"));
    }
    static int FreePort() { var l = new TcpListener(IPAddress.Loopback, 0); l.Start(); int p = ((IPEndPoint)l.LocalEndpoint).Port; l.Stop(); return p; }
    static bool Alive(int port) { return State(port) != ""; }
    static string State(int port)
    {
        try { using (var c = new WebClient()) return c.DownloadString("http://127.0.0.1:" + port + "/api/state"); }
        catch { return ""; }
    }
}
