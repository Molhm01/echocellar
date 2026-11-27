#!/usr/bin/env bash
# iOS Simulator smoke: boot a simulator, install the unsigned build, launch,
# confirm the process starts, terminate. Radio-off (airplane mode) testing is
# not automatable on the iOS Simulator; that verification lives in the
# Android emulator job (mobile/ci/airplane-smoke.sh).
set -euo pipefail
APP_PATH=$(find build/Build/Products -name "App.app" -maxdepth 2 | head -1)
[ -n "$APP_PATH" ] || { echo "FAIL: App.app not found"; exit 1; }
DEVICE=$(xcrun simctl list devices available | grep -m1 "iPhone" | sed -E 's/.*\(([0-9A-F-]+)\).*/\1/')
echo "using simulator $DEVICE"
xcrun simctl boot "$DEVICE" 2>/dev/null || true
xcrun simctl bootstatus "$DEVICE" -b
xcrun simctl install "$DEVICE" "$APP_PATH"
OUT=$(xcrun simctl launch "$DEVICE" app.echocellar 2>&1) || { echo "FAIL: launch: $OUT"; exit 1; }
echo "launch: $OUT"
sleep 8
xcrun simctl terminate "$DEVICE" app.echocellar || true
xcrun simctl shutdown "$DEVICE" || true
echo "IOS SIMULATOR SMOKE PASS"
