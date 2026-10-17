// WPF (Direct3D 9Ex) renderer used to QA that FrameHUD still reads DirectX apps from the
// runtime events after the kernel (OpenGL) path was added.
// DXTest.exe <seconds> <outFile>  — animates continuously, so it presents every refresh.
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;

static class DXTest
{
    [STAThread]
    static int Main(string[] a)
    {
        double secs = a.Length > 0 ? double.Parse(a[0]) : 10;
        string outFile = a.Length > 1 ? a[1] : "dxtest.txt";
        var scr = System.Windows.Forms.Screen.AllScreens.OrderBy(s => s.Bounds.X).Last();
        var rect = new Rectangle { Width = 60, Height = 60, Fill = Brushes.OrangeRed };
        var canvas = new Canvas { Background = Brushes.Black };
        canvas.Children.Add(rect);
        var w = new Window { Title = "FrameHUD DX test", Width = 320, Height = 200, ShowActivated = false,
                             WindowStartupLocation = WindowStartupLocation.Manual, Content = canvas,
                             Left = scr.Bounds.Right - 720, Top = scr.Bounds.Bottom - 280 };
        var sw = Stopwatch.StartNew();
        long frames = 0;
        var app = new Application();
        CompositionTarget.Rendering += (o, e) =>
        {
            frames++;
            Canvas.SetLeft(rect, 20 + 200 * Math.Abs(Math.Sin(sw.Elapsed.TotalSeconds * 3)));
            if (sw.Elapsed.TotalSeconds >= secs)
            {
                File.WriteAllText(outFile, "pid " + Process.GetCurrentProcess().Id + "\nrendering_callbacks_per_s " + (frames / sw.Elapsed.TotalSeconds).ToString("F1") + "\n");
                app.Shutdown();
            }
        };
        return app.Run(w);
    }
}
