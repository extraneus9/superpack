// Runs ON a Mac (GitHub Actions, macos-14, Apple Silicon) from the repo root. Called by mac/build.sh:
//   node mac/pack.js player     → out/apps/the player.app        (Electron, FFmpeg inside)
//   node mac/pack.js manifest   → out/installer.json             (what "Install superpack" offers)
//   node mac/pack.js installer  → out/stage/Install superpack.app (the setup window, with the apps inside)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const ELECTRON = '44.5.1';
const what = process.argv[2];

function du(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((n, f) => n + du(path.join(p, f)), 0);
}
const human = (b) => (b >= 1e9 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`);

// the player: every format Finder knows as a movie or audio file can "Open With" it
const DOC_TYPES = [
  { CFBundleTypeName: 'Video', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['public.movie', 'public.video', 'public.mpeg-4', 'com.apple.quicktime-movie', 'org.matroska.mkv', 'public.avi', 'org.webmproject.webm'] },
  { CFBundleTypeName: 'Audio', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['public.audio', 'public.mp3', 'public.mpeg-4-audio', 'com.microsoft.waveform-audio', 'public.aiff-audio', 'org.xiph.flac', 'org.xiph.ogg-audio'] },
];

async function player() {
  const packager = require(path.join(ROOT, 'the player', 'node_modules', '@electron', 'packager'));
  // FFmpeg for Apple Silicon (open-source static builds from the ffmpeg-static / ffprobe-static npm packages)
  const ff = path.join(OUT, 'ffmpeg');
  fs.mkdirSync(ff, { recursive: true });
  const nm = path.join(ROOT, 'the player', 'node_modules');
  fs.copyFileSync(require(path.join(nm, 'ffmpeg-static')), path.join(ff, 'ffmpeg'));
  fs.copyFileSync(require(path.join(nm, 'ffprobe-static')).path, path.join(ff, 'ffprobe'));
  for (const b of ['ffmpeg', 'ffprobe']) fs.chmodSync(path.join(ff, b), 0o755);
  fs.writeFileSync(path.join(ff, 'SOURCE.txt'), 'FFmpeg (GPL/LGPL) static builds via the ffmpeg-static and ffprobe-static npm packages. Source: https://ffmpeg.org/download.html\n');
  const [built] = await packager({
    dir: path.join(ROOT, 'the player'), out: path.join(OUT, 'build'), overwrite: true, platform: 'darwin', arch: 'arm64',
    electronVersion: ELECTRON, name: 'the player', executableName: 'the player', appBundleId: 'app.alva.player',
    icon: path.join(OUT, 'icons', 'player.icns'), asar: true, prune: true, quiet: true,
    ignore: [/^\/scripts($|\/)/, /^\/package-lock\.json$/],
    extraResource: [ff],
    extendInfo: { CFBundleDocumentTypes: DOC_TYPES, NSHumanReadableCopyright: 'alva · MIT' },
  });
  fs.mkdirSync(path.join(OUT, 'apps'), { recursive: true });
  fs.renameSync(path.join(built, 'the player.app'), path.join(OUT, 'apps', 'the player.app'));
  console.log('the player.app');
}

// Foldernator: same app, its Mac helper (src/main/mac-helper.js) replaces the Windows C# helper
async function foldernator() {
  const packager = require(path.join(ROOT, 'Foldernator', 'node_modules', '@electron', 'packager'));
  const [built] = await packager({
    dir: path.join(ROOT, 'Foldernator'), out: path.join(OUT, 'build'), overwrite: true, platform: 'darwin', arch: 'arm64',
    electronVersion: ELECTRON, name: 'Foldernator', executableName: 'Foldernator', appBundleId: 'app.alva.foldernator',
    icon: path.join(OUT, 'icons', 'foldernator.icns'), asar: true, prune: true, quiet: true,
    ignore: [/^\/bin($|\/)/, /^\/native($|\/)/, /^\/scripts($|\/)/, /\.py$/, /^\/package-lock\.json$/],
    extendInfo: { NSHumanReadableCopyright: 'alva · MIT', NSDesktopFolderUsageDescription: 'Foldernator shows and organises your files.', NSDocumentsFolderUsageDescription: 'Foldernator shows and organises your files.', NSDownloadsFolderUsageDescription: 'Foldernator shows and organises your files.', NSRemovableVolumesUsageDescription: 'Foldernator shows the files on your drives.', NSAppleEventsUsageDescription: 'Foldernator asks Finder for Get Info windows.' },
  });
  fs.mkdirSync(path.join(OUT, 'apps'), { recursive: true });
  fs.renameSync(path.join(built, 'Foldernator.app'), path.join(OUT, 'apps', 'Foldernator.app'));
  console.log('Foldernator.app');
}

function manifest() {
  const apps = [
    { key: 'player', name: 'the player', bundle: 'the player.app' },
    { key: 'foldernator', name: 'Foldernator', bundle: 'Foldernator.app' },
    { key: 'prompterinator', name: 'The Prompterinator', bundle: 'The Prompterinator.app' },
    { key: 'nomorewriting', name: 'No More Writing', bundle: 'No More Writing.app', extra: '+ 5 GB of AI models' },
  ].filter((a) => fs.existsSync(path.join(OUT, 'apps', a.bundle))).map((a) => {
    const bytes = du(path.join(OUT, 'apps', a.bundle));
    return { ...a, bytes, size: human(bytes), exe: a.bundle };
  });
  fs.writeFileSync(path.join(OUT, 'installer.json'), JSON.stringify({ mode: 'pack', title: 'superpack', windowIcon: 'icons/superpack.ico', apps }, null, 2));
  console.log('installer.json:', apps.map((a) => `${a.name} ${a.size}`).join(', '));
}

async function installer() {
  const packager = require(path.join(ROOT, 'installer', 'node_modules', '@electron', 'packager'));
  const [built] = await packager({
    dir: path.join(ROOT, 'installer'), out: path.join(OUT, 'build'), overwrite: true, platform: 'darwin', arch: 'arm64',
    electronVersion: ELECTRON, name: 'Install superpack', executableName: 'Install superpack', appBundleId: 'app.alva.superpack.setup',
    icon: path.join(OUT, 'icons', 'superpack.icns'), asar: true, prune: true, quiet: true,
    ignore: [/^\/make-type\.js$/, /^\/node_modules($|\/)/],
    // the apps, their source code and the list ride inside: Contents/Resources/{apps,source,installer.json}
    extraResource: [path.join(OUT, 'apps'), path.join(OUT, 'source'), path.join(OUT, 'installer.json')],
  });
  fs.mkdirSync(path.join(OUT, 'stage'), { recursive: true });
  fs.renameSync(path.join(built, 'Install superpack.app'), path.join(OUT, 'stage', 'Install superpack.app'));
  console.log('Install superpack.app');
}

({ player, foldernator, manifest, installer }[what] || (() => { throw new Error(`unknown step ${what}`); }))();
