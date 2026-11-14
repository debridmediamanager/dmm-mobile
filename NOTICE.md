# Attribution

The provider normalization and library behavior in this app are adapted from
Debrid Media Manager, an AGPL-3.0-only project by Ben Adrian Sarmiento. The
standalone app keeps the same license and does not import the web application's
Next.js, DOM, IndexedDB, or server-only modules. Its complete source is
https://github.com/debridmediamanager/dmm-mobile.

The built-in player is Media3 on Android and libVLC 3 on iPhone, iPad and Apple TV. Every part's licence
is compatible with the app's AGPL-3.0-only.

**Android: Media3 with FFmpeg and libass** (`modules/dmm-player`), from Maven Central, unchanged:

- AndroidX Media3 1.11.1 (`androidx.media3:media3-exoplayer`, `-ui`, `-effect`), Apache-2.0
  (https://github.com/androidx/media).
- Media3's FFmpeg audio decoder as Jellyfin builds it (`org.jellyfin.media3:media3-ffmpeg-decoder` 1.9.0+1,
  https://github.com/jellyfin/jellyfin-androidx-media), GPL-3.0; its FFmpeg is LGPL-2.1-or-later. The GPL version 3
  may be combined with the AGPL version 3 (section 13 of each).
- libass (ISC, https://github.com/libass/libass) in peerless2012's Android build (`io.github.peerless2012:ass-media`
  and `ass-kt` 0.5.1, MIT, https://github.com/peerless2012/libass-android), which links FreeType (FreeType Licence),
  FriBidi (LGPL-2.1-or-later), HarfBuzz (MIT), Fontconfig (MIT) and Expat (MIT) into `libass.so`.
- Code adapted from Plezy (https://github.com/edde746/plezy, GPL-3.0): seeking in MKV files without an index or with
  their tracks after the video (`CuelessSeekExtractorWrapper`), Dolby Vision profile 7 played as its HDR10 base layer,
  zlib-compressed MKV tracks (`ZlibMatroskaExtractor`), and the audio and subtitle delays. Each place says what it
  took (`modules/dmm-player/android/.../MkvFixes.kt`, `Delays.kt`).

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
