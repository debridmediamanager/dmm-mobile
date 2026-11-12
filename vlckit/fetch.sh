#!/bin/sh
# Downloads the VLCKit frameworks vlckit/build.sh made from this repository's GitHub release
# (needs `gh` signed in with access to it), checks them against the build's sums and unpacks
# them into vlckit/, where the pods take them from. Run it before `expo prebuild -p ios`.
set -eu
cd "$(dirname "$0")"
gh release download vlckit-3.7.5-truehd --repo debridmediamanager/dmm-mobile --pattern '*.tar.xz' --clobber
shasum -a 256 -c <<'EOF'
72cff36a54cd5d576b8c56ddad14e4a6aff20c81d643763841ca782015cbb176  MobileVLCKit-3.7.5-truehd.tar.xz
cbbac3a87b035de7a672ff60117ba2817099d6f38257352f16d376ec91dc1a6d  TVVLCKit-3.7.5-truehd.tar.xz
EOF
for kit in MobileVLCKit TVVLCKit; do
	rm -rf $kit.xcframework
	tar -xJf $kit-3.7.5-truehd.tar.xz
	rm $kit-3.7.5-truehd.tar.xz
done
