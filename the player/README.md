# the player

A modern video and audio player for Windows that plays every format. Made by alva.

## Run it from source
You need [Node.js](https://nodejs.org) (20 or newer). For formats Chromium can't play on its own, put
[FFmpeg](https://ffmpeg.org) (ffmpeg.exe + ffprobe.exe) on your PATH.

    npm install
    npm start

## Build your own .exe
    npm run install-app     # packages it to %LOCALAPPDATA%\Programs\the player and registers it with Windows

## Where things are
- `src/main` — the Electron main process (window, Windows integration, FFmpeg bridge, settings)
- `src/renderer` — the interface: looks, home page, settings, file details

Change anything you like — that's the point.
