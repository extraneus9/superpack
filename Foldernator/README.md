# Foldernator

A file explorer for Windows with status colours on folders, themes and Liquid Glass. Made by alva.

## Run it from source
You need [Node.js](https://nodejs.org) (20 or newer) and Windows. The native helper (`native/ShellHelper.cs`) is
compiled with the C# compiler that ships with Windows' .NET Framework:

    npm install
    npm run helper          # builds bin/ShellHelper.exe
    npm start

## Where things are
- `src/main` — Electron main process (file system, shell integration, settings)
- `src/renderer` — the interface: panes, themes, status colours, media details
- `native/ShellHelper.cs` — Windows shell calls (folder icons, copy/move, Properties)

Change anything you like — that's the point.
