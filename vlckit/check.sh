#!/bin/sh
# Plays the clips in vlckit/check (or the files given) with a VLCKit framework in a throwaway
# simulator, and fails unless every one makes sound. Run it on each build of the frameworks:
#   vlckit/check.sh vlckit/MobileVLCKit.xcframework
#   vlckit/check.sh vlckit/TVVLCKit.xcframework
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
XC=$(cd "$1" && pwd)
shift
KIT=$(basename "$XC" .xcframework)
if [ "$KIT" = TVVLCKit ]; then
	SDK=appletvsimulator MIN=-mtvos-simulator-version-min=16.4 DEVICE='Apple TV 4K (3rd generation)'
else
	SDK=iphonesimulator MIN=-mios-simulator-version-min=16.4 DEVICE='iPhone 17 Pro'
fi
SLICE=$(ls -d "$XC"/*-simulator)
OUT=$(mktemp -d)
xcrun --sdk $SDK clang -arch arm64 $MIN -F "$SLICE" -framework "$KIT" -Wl,-rpath,"$SLICE" -o "$OUT/sound" "$HERE/check/sound.c"
SIM=$(xcrun simctl create vlckit-check "$DEVICE")
trap 'xcrun simctl delete "$SIM"; rm -rf "$OUT"' EXIT
xcrun simctl boot "$SIM"
[ $# -gt 0 ] || set -- "$HERE"/check/*.mk?
xcrun simctl spawn "$SIM" "$OUT/sound" "$@"
