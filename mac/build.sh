#!/bin/bash
# superpack for Mac — builds the three Mac apps + "Install superpack" and wraps them in one .dmg.
# Runs ON a Mac (Apple Silicon) from the repo root: GitHub Actions (.github/workflows/mac.yml) or anyone's own Mac.
# Unsigned on purpose (open source): everything is ad-hoc signed, which Apple Silicon needs to run code at all.
# Output: out/superpack for Mac.dmg  (+ out/shots/*.png from the installer test)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/out"
rm -rf "$OUT"; mkdir -p "$OUT/apps" "$OUT/icons" "$OUT/stage"
cd "$ROOT"

# PNG → .icns (every size macOS asks for)
mkicns() {
  local src="$1" dst="$2" set; set="$(mktemp -d)/i.iconset"; mkdir -p "$set"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$src" --out "$set/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$src" --out "$set/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$set" -o "$dst"
}
sign() { codesign --force --deep --sign - "$1"; }

echo "── icons"
mkicns "the player/assets/icon.png" "$OUT/icons/player.icns"
mkicns "installer/assets/icons/superpack.png" "$OUT/icons/superpack.icns"
mkicns "The Prompterinator/packaging/icon_preview.png" "The Prompterinator/packaging/icon.icns"
mkicns "No More Writing/assets/icon_256.png" "No More Writing/assets/icon.icns"

echo "── the player"
(cd "the player" && npm ci --no-audit --no-fund && npm i --no-save --no-audit --no-fund @electron/packager@18.3.6 ffmpeg-static@5.2.0 ffprobe-static@3.1.0)
node mac/pack.js player
codesign --force --sign - "$OUT/apps/the player.app/Contents/Resources/ffmpeg/ffmpeg" "$OUT/apps/the player.app/Contents/Resources/ffmpeg/ffprobe"
sign "$OUT/apps/the player.app"

echo "── The Prompterinator"
python3 -m venv "$OUT/venv-prompter"
"$OUT/venv-prompter/bin/pip" install -q -r "The Prompterinator/server/requirements.txt" pyinstaller
(cd "The Prompterinator" && "$OUT/venv-prompter/bin/pyinstaller" --noconfirm --distpath "$OUT/dist-prompter" --workpath "$OUT/work-prompter" packaging/Prompterinator-mac.spec)
mv "$OUT/dist-prompter/The Prompterinator.app" "$OUT/apps/"
sign "$OUT/apps/The Prompterinator.app"

echo "── No More Writing"
python3 -m venv "$OUT/venv-nmw"
"$OUT/venv-nmw/bin/pip" install -q -r "No More Writing/requirements.txt" pyinstaller
(cd "No More Writing" && "$OUT/venv-nmw/bin/pyinstaller" --noconfirm --distpath "$OUT/dist-nmw" --workpath "$OUT/work-nmw" NoMoreWriting-mac.spec)
mv "$OUT/dist-nmw/NoMoreWriting.app" "$OUT/apps/No More Writing.app"
sign "$OUT/apps/No More Writing.app"

echo "── source code (the same folders as this repo)"
mkdir -p "$OUT/source"
cp README.md LICENSE "$OUT/source/"
for a in "the player" "The Prompterinator" "No More Writing"; do
  rsync -a --exclude node_modules --exclude __pycache__ --exclude '*.icns' "$a/" "$OUT/source/$a/"
done

echo "── Install superpack"
node mac/pack.js manifest
(cd installer && npm i --no-save --no-audit --no-fund @electron/packager@18.3.6)
node mac/pack.js installer
sign "$OUT/stage/Install superpack.app"

echo "── smoke tests"
bash mac/smoke.sh

echo "── dmg"
cp mac/How-to-open.txt "$OUT/stage/How to open.txt"
hdiutil create -volname "superpack" -srcfolder "$OUT/stage" -ov -format UDZO "$OUT/superpack for Mac.dmg"
ls -lh "$OUT/superpack for Mac.dmg"
