# DMM Mobile for iOS and Android

This standalone Expo app manages a user's existing DMM library directly from
native iOS and Android screens. It talks to each provider from the device; the
DMM web app and its server-side session are not required.

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

A release APK that runs without Metro (Java 17 and the Android SDK required):

```sh
npx expo prebuild -p android
cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
```

`npm run export:web` is a browser preview of the same screens. It is useful for
layout checks, but it does not prove native device behavior; browser previews do
not persist credentials because SecureStore is a native-only facility. The app
does not use a WebView, paid EAS builds, signing, or store publication.

## Signing in

The app opens on a sign-in screen until at least one provider is connected.

| Provider | Sign-in | Paste a key |
|---|---|---|
| Real-Debrid | Device code (OAuth); the token renews itself every 24 hours | API token |
| AllDebrid | PIN, which hands back an API key | API key |
| Premiumize | Device code (OAuth); the token lasts ten years | API key |
| Debrid-Link | Device code (OAuth); the token renews itself daily | API token |
| TorBox | none offered by TorBox | API key |
| Offcloud | none offered by Offcloud | API key |

"Sign in with …" shows a short code and opens the provider's approval page in
the browser; the app finishes on its own once the code is approved. The client
ids are the public ones DMM web uses, and the app calls the providers directly.
Every credential is checked with a read-only account request before it is
saved, and free or lapsed accounts are refused the way DMM web refuses them
(TorBox free plan, non-premium Premiumize, Offcloud and Debrid-Link).

Credentials are kept only in the platform secure store. Disconnecting a
provider deletes its secure-store item and invalidates outstanding requests
before clearing that provider's library rows.

## Library

The library page of DMM web, on the phone. One dense list across every
connected provider, one row per item, built for libraries of thousands
(measured with 7,205 items on a Pixel 6: a full refresh of six providers in
about 6 s, smooth scrolling, search under a second per keystroke).

- **Search** like DMM web: every word must match the name (as a pattern), an
  id, a provider prefix such as `rd:`, an info hash or a provider status.
- **Filters**: provider, movies / TV / other, and the web's views (in
  progress, slow, failed, uncached, names Real-Debrid blocks, same hash, same
  title, selected). Sort by newest, oldest, title, size or progress.
- **Rows** show the provider, size, type, date, progress and speed, and how many
  copies share the hash or title; a row's ⋯ menu opens just that group, and has
  the row's own actions.
- **Selection and bulk actions**: long press selects. Actions take the
  selection, or everything shown when nothing is selected: reinsert, delete,
  share a hash list, back up, delete duplicates (keep the bigger, smaller,
  newer or older) and merge copies of one hash.
- **Add** magnets, info hashes (Debrid-Link only when cached), `.torrent` files
  and, on TorBox, web links. `magnet:` links and `.torrent` files opened from
  other apps (Open with, a browser download) land in Add, on the provider used last.
- **Backup and restore** use DMM web's `.dmm.json`, so either side restores the
  other's; TorBox and AllDebrid can restore only what is cached.
- **Item detail**: files, open a file in another app, share its links, reinsert
  (Real-Debrid; active TorBox torrents; failed AllDebrid magnets), and choose
  Real-Debrid files, including on a finished torrent.

Download links are resolved only after a user taps a file. Videos open in the
player chosen in Settings (VLC, MX Player, Just Player or Android's app
picker; Infuse, VLC, VidHub, Outplayer, SenPlayer or Aether on iOS), the same
list DMM web offers; other files go to the operating system. Hash lists open on DMM web's `/hashlist` page, carried
in the link itself.

## Remembered across devices

Always on. The app keeps your logins and settings in DMM's "remember my logins
and settings across devices" store, behind each provider login, in DMM web's own
format. Sign in to one provider (in the app or on DMM web with that option
ticked) and the other logins and settings come back; keys DMM web keeps that the
app does not use are saved back untouched. Anyone who can sign in to one of
those accounts gets all of them, so keep shared debrid accounts out of the app.
Settings (video player, the provider adds start on) use DMM web's
`settings:player` and `settings:addMagnetProvider`.

Not in the app, because they need DMM's servers: casting to Stremio, sending
to Real-Debrid through DMM's uploader, title identification and the media
info panel.

## Screenshots

Pixel 6, Android 16, release build.

<p>
<img src="docs/screenshots/sign-in.png" width="180" alt="Sign-in screen listing each provider">
<img src="docs/screenshots/device-code.png" width="180" alt="Premiumize device code waiting for approval">
<img src="docs/screenshots/library.png" width="180" alt="Library rows filtered to Real-Debrid, Blender open movies">
<img src="docs/screenshots/detail.png" width="180" alt="Tears of Steel detail with file selection">
<img src="docs/screenshots/accounts.png" width="180" alt="Accounts with Real-Debrid connected">
</p>

The library shows Blender open movies (CC BY) on a test account.

### Tested on the device (2026-11-09)

| Provider | Result |
|---|---|
| Real-Debrid | Device sign-in approved in the browser, library, add magnet, file selection, open a file |
| Premiumize | Device sign-in approved, library |
| Debrid-Link | Device sign-in approved (the delete scope is listed), library |
| AllDebrid | Pasted key and library; the PIN is created and shown on AllDebrid's page, approval not completed in this test |
| TorBox | Pasted key and library; a free-plan key is refused |
| Offcloud | Pasted key, library, provider filter, open a file (sizes show as unknown: Offcloud's history and file list carry none) |

This project is distributed under AGPL-3.0-only. See `LICENSE` and `NOTICE.md`.

For a populated preview without provider credentials, use the [fixture QA entry](qa/README.md) in a separate checkout.

An embedded player, background downloads and store distribution are outside
this release. The pinned Expo CLI has five moderate transitive development-tool
advisories; no incompatible forced dependency downgrade was applied.
