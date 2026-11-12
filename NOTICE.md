# Attribution

The provider normalization and library behavior in this app are adapted from
Debrid Media Manager, an AGPL-3.0-only project by Ben Adrian Sarmiento. The
standalone app keeps the same license and does not import the web application's
Next.js, DOM, IndexedDB, or server-only modules.

The built-in player is libVLC 3 (VideoLAN, LGPL-2.1-or-later: libvlc-all on Android,
MobileVLCKit and TVVLCKit on iOS and tvOS) through @lunarr/vlc-player (MIT). libVLC's
source is at https://code.videolan.org/videolan; this app's own source, which links
it, is available under the AGPL as above.

MobileVLCKit and TVVLCKit are modified: they are VLCKit 3.7.5
(https://code.videolan.org/videolan/VLCKit, tag 3.7.5) built with one more patch,
`vlckit/0048-contrib-ffmpeg-build-the-MLP-TrueHD-decoder-again.patch`, which builds
FFmpeg's MLP/TrueHD decoder. `vlckit/build.sh` is the complete build; both remain
under the LGPL-2.1-or-later and link dynamically, so they can be replaced.
