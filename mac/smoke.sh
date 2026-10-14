#!/bin/bash
# Smoke tests on the build Mac — each app must actually start. Called by build.sh after packaging.
#   the player          stays running with a test video, and its bundled FFmpeg runs
#   The Prompterinator  its engine answers on http://127.0.0.1:8787/engine.json
#   No More Writing     --prefetch loads whisper.cpp and downloads its speech model (proves the frozen app works)
#   Install superpack   the real window installs the three apps into a test folder (screenshots in out/shots)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/out"
APPS="$OUT/apps"
fail=0
ok() { echo "PASS  $1"; }
bad() { echo "FAIL  $1"; fail=1; }
# macOS has no `timeout`: perl alarm does the same
tmo() { perl -e 'alarm shift; exec @ARGV' "$@"; }

# ---------- the player ----------
FF="$APPS/the player.app/Contents/Resources/ffmpeg"
"$FF/ffprobe" -version >/dev/null 2>&1 && ok "bundled ffprobe runs" || bad "bundled ffprobe runs"
"$FF/ffmpeg" -hide_banner -loglevel error -f lavfi -i testsrc=duration=2:size=640x360:rate=30 -f lavfi -i sine=duration=2 -shortest -pix_fmt yuv420p "$OUT/test.mp4" \
  && ok "bundled ffmpeg encodes" || bad "bundled ffmpeg encodes"
"$APPS/the player.app/Contents/MacOS/the player" --mute-audio "$OUT/test.mp4" >"$OUT/player.log" 2>&1 &
P=$!; sleep 15
if kill -0 $P 2>/dev/null; then ok "the player starts and stays up with a video"; kill $P; else bad "the player starts (log: $(tail -5 "$OUT/player.log"))"; fi

# ---------- The Prompterinator ----------
"$APPS/The Prompterinator.app/Contents/MacOS/Prompterinator" >"$OUT/prompter.log" 2>&1 &
P=$!; up=""
for i in $(seq 1 60); do up=$(curl -s http://127.0.0.1:8787/engine.json || true); [ -n "$up" ] && break; sleep 1; done
echo "$up" | grep -q '"prompterinator"' && ok "The Prompterinator engine answers ($up)" || bad "The Prompterinator engine (log: $(tail -5 "$OUT/prompter.log"))"
curl -s http://127.0.0.1:8787/index.html | grep -qi "prompterinator" && ok "The Prompterinator page is served" || bad "The Prompterinator page"
kill $P 2>/dev/null; pkill -f "Google Chrome.*127.0.0.1:8787" 2>/dev/null || true

# ---------- No More Writing ----------
NMW="$APPS/No More Writing.app/Contents/MacOS/NoMoreWriting"
LOG="$HOME/Library/Application Support/NoMoreWriting/prefetch.log"
rm -f "$LOG"
tmo 1200 "$NMW" --prefetch >"$OUT/nmw.log" 2>&1
grep -q '^ok' "$LOG" 2>/dev/null && ok "No More Writing loads its speech model ($(cat "$LOG"))" || bad "No More Writing --prefetch ($(cat "$LOG" 2>/dev/null) $(tail -5 "$OUT/nmw.log"))"
[ -f "$HOME/Library/Application Support/NoMoreWriting/config.json" ] && grep -q '"input_device": null' "$HOME/Library/Application Support/NoMoreWriting/config.json" \
  && ok "No More Writing starts from the clean default config" || bad "No More Writing clean config"

# ---------- Install superpack (the real window, off-screen, into a test folder) ----------
T="$OUT/install-test"; rm -rf "$T"
SUPERPACK_QA=1 SUPERPACK_QA_DIR="$T" SUPERPACK_SHOTS="$OUT/shots" \
  tmo 600 "$OUT/stage/Install superpack.app/Contents/MacOS/Install superpack" >"$OUT/installer.log" 2>&1
for a in "the player.app" "The Prompterinator.app" "No More Writing.app"; do
  [ -x "$T/$a/Contents/MacOS/$(defaults read "$T/$a/Contents/Info" CFBundleExecutable 2>/dev/null)" ] && ok "installer copied $a" || bad "installer copied $a"
done
[ -f "$OUT/shots/e2-done.png" ] && ok "installer reached 'All set'" || bad "installer end screen ($(ls "$OUT/shots" 2>/dev/null)) $(tail -5 "$OUT/installer.log")"
codesign --verify --deep "$T/the player.app" 2>/dev/null && ok "copied apps keep a valid signature" || bad "signature after copy"

exit $fail
