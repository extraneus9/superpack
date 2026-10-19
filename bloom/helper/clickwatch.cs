// bloom's click helper: Chromium inside bloom's click-through overlay drops real clicks on some PCs (2026-10-19), so the
// left mouse button is read here instead. stdin: "on" = watch, "off" = idle, "quit". stdout: "down X Y" / "up X Y"
// (physical screen pixels). Polls only while "on"; no hooks, nothing injected, nothing sent anywhere.
using System;
using System.Runtime.InteropServices;
using System.Threading;

static class ClickWatch {
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  struct POINT { public int X, Y; }
  static volatile bool on = false, quit = false;

  static void Main() {
    var reader = new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        line = line.Trim();
        if (line == "on") on = true; else if (line == "off") on = false; else if (line == "quit") break;
      }
      quit = true; // stdin closed = bloom is gone
    });
    reader.IsBackground = true; reader.Start();
    int btn = GetSystemMetrics(23) != 0 ? 0x02 : 0x01; // SM_SWAPBUTTON: the "primary" button
    bool was = false;
    while (!quit) {
      if (!on) { was = false; Thread.Sleep(100); continue; }
      bool down = (GetAsyncKeyState(btn) & 0x8000) != 0;
      if (down != was) {
        POINT p; GetCursorPos(out p);
        Console.Out.WriteLine((down ? "down " : "up ") + p.X + " " + p.Y); Console.Out.Flush();
        was = down;
      }
      Thread.Sleep(12);
    }
  }
}
