# Attribution

The provider normalization and library behavior in this app are adapted from
Debrid Media Manager, an AGPL-3.0-only project by Ben Adrian Sarmiento. The
standalone app keeps the same license and does not import the web application's
Next.js, DOM, IndexedDB, or server-only modules. Its complete source is
https://github.com/debridmediamanager/dmm-mobile.

The built-in player is libVLC 3 (VideoLAN, https://code.videolan.org/videolan) through
@lunarr/vlc-player (MIT). Its licence differs per platform, and both are compatible with
the app's AGPL-3.0-only.

**Android: GPL.** The app uses `org.videolan.android:libvlc-all` 3.7.5 from Maven Central
unchanged. Its POM names libVLC's own licence, LGPL-2.1, but VideoLAN builds it with their
GPL set of libraries (the default `--license g` of vlc-android's `buildsystem/compile.sh`):
libdvdread, libdvdnav and FFmpeg's libpostproc are GPL-2.0-or-later, and live555 is
LGPL-3.0-or-later. So the library as distributed is under the GPL: its GPL parts are
GPL-2.0-or-later (IzzyOnDroid's scanner lists it so), and with live555 in the same binary
the whole is passed on under version 3, which is what the build script calls this set
("GPLv3"). The GPL version 3 may be combined with the AGPL version 3 (section 13 of each).

**iPhone, iPad and Apple TV: LGPL-2.1-or-later.** MobileVLCKit and TVVLCKit are our build of
VLCKit 3.7.5 (https://code.videolan.org/videolan/VLCKit, tag 3.7.5) with one more patch,
`vlckit/0048-contrib-ffmpeg-build-the-MLP-TrueHD-decoder-again.patch`, which builds
FFmpeg's MLP/TrueHD decoder (LGPL-2.1-or-later). VLCKit builds its libraries with
`--disable-gpl --disable-gnuv3` and with live555 2016.10.21, a release still under the
LGPL-2.1 (its patch 0007), so nothing under the GPL is in them. `vlckit/build.sh` is the
complete build, and the frameworks the app ships are in the GitHub release
`vlckit-3.7.5-truehd` (https://github.com/debridmediamanager/dmm-mobile/releases/tag/vlckit-3.7.5-truehd).
They link dynamically, so they can be replaced. The LGPL lets them be part of an
AGPL-3.0-only app.

Everything else the app bundles (React Native, Expo, React Navigation and their
dependencies, listed in `package-lock.json`) is under permissive licenses (MIT,
Apache-2.0, BSD, ISC); each package carries its own license text.
