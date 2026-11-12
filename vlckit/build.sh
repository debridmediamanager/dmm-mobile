#!/bin/sh
# Builds MobileVLCKit (iOS) and TVVLCKit (tvOS) 3.7.5 the way VideoLAN does, plus FFmpeg's
# MLP/TrueHD decoder, which VLCKit's patch 0003 switches off. arm64 only (devices and Apple
# silicon simulators). Leaves the framework in vlckit/, where the pods take it from, and the
# archive to attach to the GitHub release vlckit/fetch.sh downloads in vlckit/out/.
# Usage: vlckit/build.sh ios|tvos
set -eu
TAG=3.7.5
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-$HERE/build}/$1
KIT=$([ "$1" = tvos ] && echo TVVLCKit || echo MobileVLCKit)
# VLCKit's script commits its libVLC patches with git am: no signing for those.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false

[ -d "$WORK" ] || git clone --depth 1 --branch $TAG https://code.videolan.org/videolan/VLCKit.git "$WORK"
cd "$WORK"
cp "$HERE"/0048-*.patch libvlc/patches/

# VideoLAN's CI has its host tools installed; built here, they need two fixes. Native compiles (the
# tools, meson's build-machine checks) use the selected Xcode's macOS SDK: macOS picks the Command
# Line Tools SDK, which on macOS 27 is too new for Xcode 26's linker and libc++. And the jobserver
# Ninja that VLC builds for make 3.81 leaves make's job pipe non-blocking, which 3.81 cannot read
# ("read jobs pipe: Resource temporarily unavailable"), so Ninja runs without the jobserver.
HOST=$WORK/host
mkdir -p "$HOST"
for cc in cc gcc clang c99 c++ g++ clang++; do
	printf '#!/bin/sh\nSDKROOT=%s exec /usr/bin/%s "$@"\n' "$(xcrun --sdk macosx --show-sdk-path)" $cc > "$HOST/$cc"
done
printf '#!/bin/sh\nunset MAKEFLAGS\nexec %s "$@"\n' "$WORK/libvlc/vlc/extras/tools/build/bin/ninja.jobserver" > "$HOST/ninja"
chmod +x "$HOST"/*
export VLC_PATH=$HOST

# Upstream packs a simulator slice only for x86_64; ours is arm64. Xcode 26 builds iOS 12 and up.
git checkout -q buildMobileVLCKit.sh
sed -i '' -e 's/|| (is_simulator_arch \$arch)/|| [ "$BUILD_SIMULATOR" = yes ]/' -e 's/^SDK_MIN=9.0/SDK_MIN=12.0/' \
	-e 's/^    info "Building tools"$/&; export SDKROOT=$(xcrun --sdk macosx --show-sdk-path)/' \
	-e 's/^    make \.buildgas$/&; unset SDKROOT; [ ! -e build\/bin\/ninja ] || mv build\/bin\/ninja build\/bin\/ninja.jobserver/' \
	buildMobileVLCKit.sh
./buildMobileVLCKit.sh -a aarch64 $([ "$1" = tvos ] && echo -t)

rm -rf "$HERE/$KIT.xcframework"
cp -R build/$KIT.xcframework "$HERE/"
mkdir -p "$HERE/out"
tar -C build -cJf "$HERE/out/$KIT-$TAG-truehd.tar.xz" $KIT.xcframework
shasum -a 256 "$HERE/out/$KIT-$TAG-truehd.tar.xz"
