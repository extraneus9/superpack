# DepthMotion

Real footage in, pure motion out. DepthMotion turns any clip into motion references for AI video: a clay render, a
depth pass, a normal map, colour depth, 16-bit depth frames and a colour per person (so a video model knows who is who). The motion, timing and camera of a real scene, without
its faces, clothes or set. Windows, NVIDIA graphics card. Made by alva.

Depth comes from [Video Depth Anything](https://github.com/DepthAnything/Video-Depth-Anything) (ByteDance, Apache 2.0
code). The Small model is Apache 2.0; the Large model ("Best") is CC BY-NC 4.0, so it's for non-commercial use.

## Build it

    node build.js            # → dist\DepthMotion  (compiles the launcher with Windows' own csc.exe, adds uv.exe)

Needs Node and [uv](https://github.com/astral-sh/uv) (`uv.exe` is copied from `%USERPROFILE%.localin`).
The first time DepthMotion.exe runs it builds its own private Python + PyTorch (CUDA 12.8) in
`%LOCALAPPDATA%\DepthMotion` and downloads the Small model. No system Python is touched.

## Use it without the app

    python engine/depthmotion.py clip.mp4 --start 2 --end 8 --passes clay,depth,normal --isolate 0.3

## Where things are
- `engine/depthmotion.py` — the engine: decode, depth, normalise (one range per clip = no flicker), every pass, CLI
- `engine/people.py` — finds the people (torchvision Faster R-CNN), follows them (SAM 2.1) and labels each one for its colour
- `engine/server.py` — the local server the window talks to (127.0.0.1 only; quits when the window closes)
- `engine/guard.py` — keeps the PC responsive: one job at a time, sized to the free memory, pauses when RAM gets tight
- `engine/library.py` — the scene library (folders under Videos\DepthMotion, statuses shared with Foldernator)
- `engine/location.py`, `engine/camera_solve.py`, `engine/relocate.py`, `blender/` — New location: solves the camera, builds a set in Blender, merges the people back in
- `engine/vda/` — the parts of Video Depth Anything it needs (Apache 2.0, see its LICENSE)
- `ui/` — the app window (HTML, CSS, JS)
- `launcher/DepthMotion.cs` — the exe: first-run setup with progress, then opens the window
- `make-type.js` — renders the title picture (Ogg Text can't ship as a font)

Change anything you like — that's the point.
