#!/usr/bin/env bash
# Build Sentinel for macOS — RUN THIS ON A MAC (a Mac app cannot be cross-built from Windows).
#   bash tools/build_mac.sh
# Needs: macOS with Python 3.10+ and Xcode command-line tools (`xcode-select --install`).
set -e
cd "$(dirname "$0")/.."
PY="${PYTHON:-python3}"

echo ">> installing build dependencies ..."
"$PY" -m pip install --upgrade \
  pyinstaller yara-python pystray pillow pywebview \
  pyobjc-framework-Cocoa pyobjc-framework-WebKit pyobjc-framework-Quartz \
  pyzipper certifi psutil

echo ">> building Sentinel.app ..."
# NOTE: on macOS/Linux --add-data uses ':' as the separator (Windows uses ';').
"$PY" -m PyInstaller --noconfirm --windowed --name Sentinel \
  --add-data "webui:webui" \
  --add-data "sentinel/rules.json:sentinel" \
  --add-data "yara_rules/sentinel_starter.yar:yara_rules" \
  --collect-all yara --collect-all webview --collect-all pyzipper \
  --collect-all Cryptodome --collect-all certifi --collect-all psutil \
  run_sentinel.py

echo ""
echo "Built: dist/Sentinel.app"
echo "Run it:   open dist/Sentinel.app"
echo "First launch is blocked by Gatekeeper (unsigned): right-click the app -> Open -> Open,"
echo "or: System Settings -> Privacy & Security -> 'Open Anyway'."
echo "To distribute without that prompt you need an Apple Developer ID to sign + notarize it."
