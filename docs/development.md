# Developing DMM Mobile

DMM Mobile is a standalone Expo app. What each feature does is in
[features.md](features.md); releases are in [releasing.md](releasing.md).

## Local development

```sh
npm ci
npm run typecheck
npm test
npm start
```

Install the repository's lightweight pre-commit checks once per checkout:

```sh
git config core.hooksPath .githooks
```

Use the Expo development build or simulator commands after the native toolchain
is installed:

```sh
npm run ios
npm run android
```

The app is built on `react-native-tvos`, React Native's TV fork, which also
builds phones. One Android APK serves phones, tablets and TVs; prebuild it with
`EXPO_TV=1` so the manifest gets the TV launcher entry and banner (Java 17 and
the Android SDK required). Fire TV is 32-bit, hence `armeabi-v7a`:

```sh
EXPO_TV=1 npx expo prebuild -p android
cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a
```

The GitHub release (also what Obtainium and IzzyOnDroid take) has one APK per ABI instead, with
compressed native libraries. Build each one on its own and rename it as it is built, since every run
writes `app-release.apk`:

```sh
for abi in arm64-v8a armeabi-v7a; do
  ./gradlew :app:assembleRelease -PreactNativeArchitectures=$abi -Pexpo.useLegacyPackaging=true
  cp app/build/outputs/apk/release/app-release.apk dmm-mobile-<version>-$abi.apk
done
```

1.3.0's are 17.7 MB (arm64-v8a) and 16.7 MB (armeabi-v7a); 1.2.2's, with libVLC, were 36.9 and 34.6 MB.
`expo.useLegacyPackaging` only goes on these APKs: Google Play's bundle keeps its libraries
uncompressed, which Play compresses for the download and a phone then uses in place.

Apple builds one project per platform: `npx expo prebuild -p ios` for iPhone
and iPad, `EXPO_TV=1 npx expo prebuild -p ios` for Apple TV. Run `vlckit/fetch.sh`
once first (plain `curl` from this repository's public release): the player's
VLCKit frameworks are our own build, kept in a GitHub release (below).
`package.json` overrides `react-native` for every package: the fork's own
list component asks for stock React Native, and two copies in one bundle leave the
app unable to start.

`npm run export:web` is a browser preview of the same screens. It is useful for
layout checks, but it does not prove native device behavior; browser previews do
not persist credentials because SecureStore is a native-only facility. The app
does not use a WebView or paid EAS builds.

For a populated preview without provider credentials, use the [fixture QA entry](../qa/README.md)
in a separate checkout.

Installed builds take JavaScript fixes over the air from our own update server,
signed with our own key; native changes ship as store releases. Both are in
[releasing.md](releasing.md).

The pinned Expo CLI has five moderate transitive development-tool advisories; no
incompatible forced dependency downgrade was applied.

## The player on Android: Media3

On Android the built-in player ([features.md](features.md#built-in-player)) is the app's own Expo
module `modules/dmm-player`: Media3's ExoPlayer on a SurfaceView, Jellyfin's build of Media3's FFmpeg
audio decoder, and libass through `io.github.peerless2012:ass-media`. `src/video.android.tsx` gives it
the props, events and calls the player screen uses of `@lunarr/vlc-player`, which Metro picks on
Android only (`src/video.tsx` is libVLC elsewhere); `src/androidPlayer.ts` names its tracks and errors.
`package.json` keeps `@lunarr/vlc-player` out of Android builds (`expo.autolinking.android.exclude`), so
the APK has no libVLC. `MkvFixes.kt` holds what Media3 gets wrong with MKV files (no index, Dolby Vision
profile 7, zlib-compressed tracks), adapted from Plezy; `Delays.kt` the audio and subtitle delays. Its JVM
tests run with `./gradlew :dmm-player:testDebugUnitTest` from `android/` after a prebuild.

`adb shell setprop log.tag.DmmPlayer DEBUG` makes the module log what plays: each track Media3 found
and whether it is selected and supported, the player's states, the first frame and the bytes read
(positions only, never the link), which is how seeks are measured.

## The player's VLCKit on iPhone, iPad and Apple TV

On iPhone, iPad and Apple TV the built-in player is libVLC 3 through `@lunarr/vlc-player`.
The app does not use VideoLAN's MobileVLCKit and
TVVLCKit pods: VLCKit switches FFmpeg's TrueHD decoder off for Apple (its patch
0003), so TrueHD-only files played silent there. `vlckit/build.sh` builds the same
VLCKit 3.7.5 with the decoder back on (about 25 minutes per platform on an M3
Pro), the frameworks sit in this repository's GitHub release `vlckit-3.7.5-truehd`,
`vlckit/fetch.sh` downloads and checks them, and `plugins/withVlcKit.js` points the
Podfile at them. `vlckit/check.sh` plays the real TrueHD clips in `vlckit/check/` in a simulator and
fails unless each one makes sound; run it on every new build. [NOTICE.md](../NOTICE.md)
has the licence details.

`patches/` changes `@lunarr/vlc-player` (applied by `npm ci`): on iPhone, iPad and Apple TV, React
Native reused a closed player's view for the next video, and a video left paused kept the next one
from ever starting. `qa/player-reopen.sh <simulator .app>` pauses and closes one clip, opens another
and fails unless the second plays; run it when the player package changes.

## Store releases

App Store and Google Play releases follow [store/release.md](store/release.md);
the listing copy and form answers are in [listing.md](store/listing.md), and the
reviewer sign-in and test checklist in [review.md](store/review.md). Reviewers
sign in with the demo key `dmmdemo`, which works as any provider's API key and opens a
sample library of open movies without a debrid account. The store slides, feature
graphic and preview videos are built by `store/marketing/render.py` and
`store/marketing/video.py` ([listing.md](store/listing.md)).
