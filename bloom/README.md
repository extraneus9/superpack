# bloom

Your Windows notifications, redesigned. bloom reads every notification Windows receives and shows it in its own style
(8 designs, your colours, your sound), and can switch off Windows' own popup for every app with one click (undo restores
it exactly). Windows only. Made by alva.

## Run it from source
You need [Node.js](https://nodejs.org) 20+.

    npm install
    npm start

## Build your own .exe
    npm run install-app      # builds bloom.exe and installs it to %LOCALAPPDATA%\Programs\bloom

## Where things are
- `src/watcher.js` — reads Windows' notification store (wpndatabase.db) for new notifications
- `src/overlay.*`, `src/designs-more.css` — the notification designs
- `src/settings.*` — the app window (designs, colours, sound, history)
- `src/winpopups.js` — "Hide Windows' own popup": the per-app "Show notification banners" setting, in bulk, with undo
- `src/sound.js` — the sound library; `scripts/make-chime.js` renders the default chime

Change anything you like — that's the point.
