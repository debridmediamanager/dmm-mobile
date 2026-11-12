#!/bin/sh
# Checks that the built-in player opens a second video in the same app session: plays qa/clips/a.mkv, pauses and
# closes it, opens qa/clips/b.mp4 and fails unless B starts. Fabric reused the closed player's native view on iOS, which
# kept the pause, so B hung at 0:00 (2026-11-12). Give it an iOS simulator build of the app (README, Local development);
# it runs a copy with qa/player-reopen.tsx as its JavaScript in a throwaway simulator:
#   qa/player-reopen.sh path/to/Release-iphonesimulator/DMMMobile.app
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(mktemp -d)
APP="$OUT/DMMMobile.app"
cp -R "$1" "$APP"
mkdir "$APP/player-reopen"
cp "$HERE"/clips/* "$APP/player-reopen/"
(cd "$HERE/.." && npx expo export:embed --platform ios --dev false --bytecode --entry-file qa/player-reopen.tsx \
	--bundle-output "$APP/main.jsbundle" --assets-dest "$OUT/assets" >/dev/null)
# Its own bundle, not an update from the server.
plutil -replace EXUpdatesEnabled -bool NO "$APP/Expo.plist"
codesign --force --sign - --preserve-metadata=entitlements "$APP" 2>/dev/null

SIM=$(xcrun simctl create player-reopen 'iPhone 17 Pro')
trap 'xcrun simctl delete "$SIM"; rm -rf "$OUT"' EXIT
xcrun simctl bootstatus "$SIM" -b >/dev/null
xcrun simctl install "$SIM" "$APP"
xcrun simctl launch "$SIM" com.debridmediamanager.library >/dev/null
RESULT="$(xcrun simctl get_app_container "$SIM" com.debridmediamanager.library data)/Documents/player-reopen.txt"
for _ in $(seq 120); do
	[ -s "$RESULT" ] && break
	sleep 1
done
[ -s "$RESULT" ] || { echo 'FAIL: no result in 120 s'; exit 1; }
cat "$RESULT"; echo
grep -q '^PASS' "$RESULT"
