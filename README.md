# DMM Library for iOS and Android

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

`npm run export:web` is a browser preview of the same screens. It is useful for
layout checks, but it does not prove native device behavior; browser previews do
not persist credentials because SecureStore is a native-only facility. The app
does not use a WebView, paid EAS builds, signing, or store publication.

## Credentials and provider behavior

Provider API keys/tokens are validated with a read-only account request and then
stored only in the platform secure store. They remain in memory only while the
app is running. Disconnecting a provider deletes its secure-store item and
invalidates outstanding requests before clearing that provider's library rows.

All six providers supported by the DMM web library are available: Real-Debrid,
AllDebrid, TorBox, Premiumize, Offcloud, and Debrid-Link. Download links are
resolved only after a user taps a file and are handed to the native operating
system; the app does not share credential-bearing links. Magnets can be shared
through the native share sheet.

This project is distributed under AGPL-3.0-only. See `LICENSE` and `NOTICE.md`.

For a populated preview without provider credentials, use the [fixture QA entry](qa/README.md) in a separate checkout.

The first version uses pasted provider API keys/tokens. OAuth sign-in, an embedded
player, background downloads, and store distribution are outside this release.
Physical-device runtime and live-account calls have not been tested. The pinned
Expo CLI currently has five moderate transitive development-tool advisories;
no incompatible forced dependency downgrade was applied.
