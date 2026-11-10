# Releasing to the App Store and Google Play

The store copy and form answers are in `listing.md`; the reviewer sign-in, notes
and test checklist are in `review.md`. Bump `version`, `ios.buildNumber` and
`android.versionCode` in `app.json` for every upload: the stores refuse a build
number they have seen.

`version` is also the runtime version that over-the-air updates target. After
uploading, tag the exact commit you built as `v<version>` and publish its GitHub
release (`../releasing.md`); the OTA workflow refuses to publish for a version
without that tag.

## Before each submission

1. `npm ci && npm run typecheck && npm test`
2. Build the release for every platform (below) and run the checklist in
   `review.md` on each, signed in with `dmmdemo` only.
3. Check https://debridmediamanager.com/privacy and /support load signed out.

## Google Play

### Upload key (once)

Play signs the app it ships with its own key (Play App Signing); we sign uploads
with an upload key. Make one with the JDK's keytool, keep the file and its
passwords in Bitwarden, never in this repository:

```sh
keytool -genkeypair -v -keystore dmm-upload.jks -alias upload \
  -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Debrid Media Manager"
```

A lost upload key can be reset from Play Console; the app signing key cannot be
lost, Google holds it.

### Build the app bundle

Play takes an `.aab`. `plugins/withReleaseSigning.js` signs a release with the
upload key when these Gradle properties are set (in `~/.gradle/gradle.properties`
on the build machine, or as `-P` flags), and with the debug key otherwise:

```properties
DMM_UPLOAD_STORE_FILE=C:/keys/dmm-upload.jks
DMM_UPLOAD_STORE_PASSWORD=…
DMM_UPLOAD_KEY_ALIAS=upload
DMM_UPLOAD_KEY_PASSWORD=…
```

```sh
EXPO_TV=1 npx expo prebuild -p android --clean
cd android && ./gradlew :app:bundleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a,x86_64
# android/app/build/outputs/bundle/release/app-release.aab
```

With CMake 4 (the Windows build uses 4.1.2 for its long-path ninja), set
`CMAKE_POLICY_VERSION_MINIMUM=3.5` in the environment first: expo-updates'
`CMakeLists.txt` still asks for a minimum below 3.5, which CMake 4 refuses.
Check the result is signed by the upload key before uploading:
`keytool -printcert -jarfile app-release.aab` must show SHA-256
`1D:66:B5:7B:…:F8:A1:01`.

`EXPO_TV=1` adds the Android TV launcher entry and banner; the same bundle serves
phones, tablets and TVs. Builds run on `ssh ben@windows` (see the project memory
for the toolchain); the Mac has no JDK.

### First release on a personal account: the 14-day closed test

Status: app created and the closed test sent for review on 2026-11-10 (Play
Console account 6907620095512694450, app 4974392213799747854, developer
benadriansarmiento@gmail.com). Testers join the Google Group
`dmm-mobile-beta@googlegroups.com` (anyone can join; only managers see members),
then opt in at https://play.google.com/apps/testing/com.debridmediamanager.library
once the review passes. Feedback in Play goes to support@debridmediamanager.com.

Play lets a personal developer account created after 13 November 2023 publish to
production only after a closed test with **at least 12 testers opted in for 14
days in a row**. Internal testing does not count, and pausing the track restarts
the 14 days.

1. Create the app in Play Console: name "DMM Mobile", app, free.
2. Fill in every item under "Set up your app" from `listing.md` (App access from
   `review.md`).
3. Testing → Closed testing → the default track "Closed testing - Alpha" (Play
   refuses the name "Beta"): add all countries, testers as a Google Group, upload
   the `.aab`, then Publishing overview → send the changes for review.
4. Recruit at least 15 testers (a margin for drop-outs) from the DMM Discord and
   Patreon with the message below. Keep them opted in for 14 full days; upload
   fixed builds to the same track, which does not restart the clock.
5. After 14 days, Dashboard → "Apply for production". Google asks how testers were
   recruited, what feedback came in and what changed; keep notes during the test.
6. Then Production → create release with the same or a newer bundle → review.

Tester invitation (Discord/Patreon):

```text
DMM Mobile is coming to Google Play, and before it can, Google needs 12 people to
test it for two weeks. If you have an Android phone, tablet or TV and a debrid
account, you can help:

1. Join the testers group: https://groups.google.com/g/dmm-mobile-beta
2. Open the test link on your phone and tap "Become a tester":
   https://play.google.com/apps/testing/com.debridmediamanager.library
3. Install DMM Mobile from Google Play and sign in to your debrid service.
4. Keep it installed for 14 days and use it now and then. Tell us what breaks in
   #dmm-mobile on Discord.

No debrid account? Enter dmmdemo as any service's API key to try a sample library.
```

### Android TV

Play reviews Android TV separately once "Android TV" is enabled under Release →
Advanced settings → Form factors. Upload the TV screenshots and the 1280 × 720 banner
(`listing.md`). The manifest already has the leanback launcher entry, no required
touchscreen, and a TV banner. Fire TV is not on Google Play; it needs the Amazon
Appstore, a separate submission.

## App Store (iPhone, iPad, Apple TV)

Team `7RX5G7H8DW` (Ben Adrian Sarmiento) has an Apple Distribution certificate on
this Mac; Xcode creates the App Store profiles with `-allowProvisioningUpdates`.

### App Store Connect record (once)

My Apps → + → New App: platforms iOS **and** tvOS, name "DMM Mobile", bundle id
`com.debridmediamanager.library`, SKU `dmm-mobile`. Fill in the fields from
`listing.md` and App Review Information from `review.md`.

### Build and upload

iPhone/iPad and Apple TV are separate projects from the same source:

```sh
# iPhone and iPad
npx expo prebuild -p ios --clean
xcodebuild -workspace ios/DMMMobile.xcworkspace -scheme DMMMobile -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/DMMMobile-ios.xcarchive \
  DEVELOPMENT_TEAM=7RX5G7H8DW CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates archive

# Apple TV
EXPO_TV=1 npx expo prebuild -p ios --clean
xcodebuild -workspace ios/DMMMobile.xcworkspace -scheme DMMMobile -configuration Release \
  -destination 'generic/platform=tvOS' -archivePath build/DMMMobile-tvos.xcarchive \
  DEVELOPMENT_TEAM=7RX5G7H8DW CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates archive
```

Export each archive with `docs/store/ExportOptions.plist` and upload the `.ipa`
with `altool`, using the app-specific password in Bitwarden ("Apple notarytool
app-specific password", Apple ID benadriansarmiento@icloud.com, which owns the team):

```sh
xcodebuild -exportArchive -archivePath build/DMMMobile-ios.xcarchive -exportPath build/ios \
  -exportOptionsPlist docs/store/ExportOptions.plist -allowProvisioningUpdates
ASC_PW=$(rbw get 'Apple notarytool app-specific password' benadriansarmiento@icloud.com) \
  xcrun altool --upload-app --type ios --file build/ios/DMMMobile.ipa \
  --username benadriansarmiento@icloud.com --password @env:ASC_PW   # --type appletvos for the TV build
```

The App Store record is "Debrid Media Manager" (Apple ID 6832736483): "DMM Mobile"
was taken on the App Store, and the name under the icon stays DMM Mobile. The
App Store Connect API key in Bitwarden ("App Store Connect API key (dmm-mobile
release)", role App Manager) does everything after the upload without a browser
or a two-factor code: store text, screenshots, attaching builds, submitting. Both platforms appear under the same app; attach the
iOS build to the iOS version and the tvOS build to the Apple TV version, then
submit both for review. TestFlight first is cheap: the same builds, testers by
email, review of the first build only.

### If review cites guideline 5.2.3

Apple rejects apps that "facilitate illegal file sharing". The notes in
`review.md` explain that the app manages the user's own cloud storage and
downloads nothing peer to peer. If it is rejected anyway, reply in Resolution
Center first; the fallback is a store build without Add, the magnet/.torrent
handlers and Search, which leaves a manager and player for the user's own files.
