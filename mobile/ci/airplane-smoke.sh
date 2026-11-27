#!/usr/bin/env bash
# Airplane-mode smoke test for the Echocellar Android APK.
# Verifies: install, cold start with connectivity, cold start with all radios
# off (airplane mode + wifi + mobile data disabled), no fatal crashes.
set -euo pipefail
PKG=app.echocellar
APK=${1:-apk/app-debug.apk}

dump_crashes() {
  adb logcat -d | grep -iE "echocellar|FATAL|AndroidRuntime" | tail -60 || true
}

adb wait-for-device
adb install -r "$APK"
adb logcat -c || true
adb shell am start -n "$PKG/.MainActivity"
sleep 15
PID=$(adb shell pidof "$PKG" | tr -d '\r' || true)
if [ -z "$PID" ]; then
  echo "FAIL: app not running after online launch; crash log:"
  dump_crashes
  exit 1
fi
echo "PASS: online cold start (pid $PID)"

adb shell settings put global airplane_mode_on 1
adb shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true || true
adb shell svc wifi disable || true
adb shell svc data disable || true
sleep 3
adb shell am force-stop "$PKG"
adb shell am start -n "$PKG/.MainActivity"
sleep 15
PID=$(adb shell pidof "$PKG" | tr -d '\r' || true)
if [ -z "$PID" ]; then
  echo "FAIL: app not running after airplane-mode relaunch; crash log:"
  dump_crashes
  exit 1
fi
echo "PASS: airplane-mode cold start (pid $PID)"

if adb logcat -d | grep -q "FATAL EXCEPTION"; then
  echo "FAIL: fatal exception in logcat"
  dump_crashes
  exit 1
fi

adb shell settings put global airplane_mode_on 0
adb shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state false || true
adb shell svc wifi enable || true
echo "AIRPLANE MODE SMOKE PASS"
