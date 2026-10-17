// Tiny native-OpenGL renderer used to QA FrameHUD's OpenGL frame counting (Minecraft Java path).
// GLTest.exe <targetFps|0=uncapped> <seconds> <outFile>
// Opens a small no-activate window on a secondary monitor, swaps buffers at the target rate
// with vsync off, and writes the FPS it actually rendered to outFile.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

static class GLTest
{
    [StructLayout(LayoutKind.Sequential)]
    struct PFD
    {
        public ushort nSize, nVersion; public uint dwFlags; public byte iPixelType, cColorBits, r, rs, g, gs, b, bs, a, @as,
        accum, ar, ag, ab, aa, cDepthBits, cStencilBits, cAux, iLayerType, bReserved; public uint lm, vm, dm;
    }
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
    [DllImport("gdi32.dll")] static extern int ChoosePixelFormat(IntPtr dc, ref PFD p);
    [DllImport("gdi32.dll")] static extern bool SetPixelFormat(IntPtr dc, int f, ref PFD p);
    [DllImport("gdi32.dll")] static extern bool SwapBuffers(IntPtr dc);
    [DllImport("opengl32.dll")] static extern IntPtr wglCreateContext(IntPtr dc);
    [DllImport("opengl32.dll")] static extern bool wglMakeCurrent(IntPtr dc, IntPtr rc);
    [DllImport("opengl32.dll")] static extern bool wglDeleteContext(IntPtr rc);
    [DllImport("opengl32.dll")] static extern IntPtr wglGetProcAddress(string name);
    [DllImport("opengl32.dll")] static extern void glClearColor(float r, float g, float b, float a);
    [DllImport("opengl32.dll")] static extern void glClear(uint mask);
    [DllImport("opengl32.dll")] static extern IntPtr glGetString(uint name);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate bool SwapInterval(int i);

    sealed class Win : Form
    {
        protected override bool ShowWithoutActivation { get { return true; } }
    }

    [STAThread]
    static int Main(string[] a)
    {
        int target = a.Length > 0 ? int.Parse(a[0]) : 120;
        double secs = a.Length > 1 ? double.Parse(a[1]) : 10;
        string outFile = a.Length > 2 ? a[2] : "gltest.txt";

        Screen scr = Screen.PrimaryScreen;
        foreach (var s in Screen.AllScreens) if (!s.Primary && s.Bounds.X >= scr.Bounds.X) scr = s;
        var f = new Win { Text = "FrameHUD GL test", FormBorderStyle = FormBorderStyle.FixedToolWindow,
                          StartPosition = FormStartPosition.Manual, ClientSize = new Size(320, 200) };
        f.Location = new Point(scr.Bounds.Right - 360, scr.Bounds.Bottom - 280);
        f.Show();
        Application.DoEvents();

        IntPtr dc = GetDC(f.Handle);
        var pfd = new PFD { nSize = (ushort)Marshal.SizeOf(typeof(PFD)), nVersion = 1, dwFlags = 0x4 | 0x20 | 0x1, cColorBits = 32, cDepthBits = 24 };
        SetPixelFormat(dc, ChoosePixelFormat(dc, ref pfd), ref pfd);
        IntPtr rc = wglCreateContext(dc);
        wglMakeCurrent(dc, rc);
        string renderer = Marshal.PtrToStringAnsi(glGetString(0x1F01)) ?? "?";
        IntPtr si = wglGetProcAddress("wglSwapIntervalEXT");
        if (si != IntPtr.Zero) ((SwapInterval)Marshal.GetDelegateForFunctionPointer(si, typeof(SwapInterval)))(0);

        var sw = Stopwatch.StartNew();
        long frames = 0, warm = 0; double warmT = 1.0;
        double period = target > 0 ? 1.0 / target : 0;
        while (sw.Elapsed.TotalSeconds < secs)
        {
            float t = (float)(frames % 120) / 120f;
            glClearColor(t, 0.1f, 1 - t, 1);
            glClear(0x4000);
            SwapBuffers(dc);
            frames++;
            if (warm == 0 && sw.Elapsed.TotalSeconds >= warmT) warm = frames;
            if ((frames & 15) == 0) Application.DoEvents();
            if (period > 0) while (sw.Elapsed.TotalSeconds < frames * period) { }
        }
        double fps = (frames - warm) / (sw.Elapsed.TotalSeconds - warmT);
        File.WriteAllText(outFile, "pid " + Process.GetCurrentProcess().Id + "\ntarget " + target + "\nrendered_fps " + fps.ToString("F1") + "\nrenderer " + renderer + "\n");
        wglMakeCurrent(IntPtr.Zero, IntPtr.Zero); wglDeleteContext(rc);
        return 0;
    }
}
