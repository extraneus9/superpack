# FrameHUD

An FPS and performance overlay for Windows games: FPS, frame time and 1% lows (DirectX, OpenGL and Vulkan), GPU,
CPU, RAM and ping to the game's own server, in a click-through overlay you style yourself. Windows only. Made by alva.

## Build it
No SDK needed: it compiles with the C# compiler that ships with Windows (.NET Framework 4.8).

    build.cmd                # → build\FrameHUD.exe (+ an installer if Inno Setup 6 is installed)

## Where things are
- `src/PresentTracker.cs` — counts frames per process from Windows' own present events (ETW: DXGI, D3D9 and the
  DxgKrnl kernel events that catch OpenGL / Vulkan), and finds the game server from network events
- `src/Sensors.cs` — GPU (nvidia-smi), CPU, RAM and ping
- `src/Overlay.cs` — the overlay window; `src/SettingsForm.cs` — the settings window
- `tools/qa-opengl.ps1` with `GLTest.cs` / `DXTest.cs` — checks the frame counting against test windows of known FPS

Counting frames needs administrator rights (Windows only gives ETW sessions to admins).

Change anything you like — that's the point.
