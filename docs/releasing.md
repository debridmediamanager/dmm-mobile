# Releasing DMM Mobile

The app ships two ways. A **store release** is a new binary that users install
from Google Play or the App Store (or as an APK on Fire TV). An **over-the-air
(OTA) update** sends new JavaScript, images and fonts to binaries that are
already installed. Each one is recorded as a GitHub release.

| | Store release | OTA update |
|---|---|---|
| Carries | the whole app: native code, permissions, icons, app config | `src/` and pure-JavaScript packages, images, fonts |
| Needed for | a new or updated native module, an Expo SDK or React Native upgrade, any change to `app.json` or `plugins/`, icons, permissions | everything else |
| Reaches | users after store review, once they install the new version | every installed build **of the same version** where Settings → Get fixes automatically is on (below): downloaded when the app starts, used from the next start |
| GitHub release | `v1.2.0`, marked Latest, with the APK attached | `ota-1.2.0-<run>`, a pre-release holding the signed manifests and files |
| Started by | a person: build, upload, tag | Actions → **Publish OTA update** → Run workflow |

The version in `app.json` is the **runtime version**: an OTA update goes only to
builds with exactly that version, so an update can never reach a binary that
lacks the native code it expects. The workflow enforces that rule (below).

## Store release

1. On `main`, raise `version` in `app.json` (and `ios.buildNumber` /
   `android.versionCode`; the stores refuse a number they have already seen).
   Commit it. Every native change since the last store release ships now.
2. Build every platform from that commit ([development.md](development.md)) and upload it
   to the stores as in `docs/store/release.md`.
3. Tag **exactly the commit you built** and publish the GitHub release with the
   Android APK, which Fire TV users sideload:

   ```sh
   git tag v1.2.0 <commit> && git push origin v1.2.0
   gh release create v1.2.0 --title "DMM Mobile 1.2.0" --notes "…" dmm-mobile-1.2.0.apk
   ```

   The OTA workflow compares the native code of every later update with this
   tag, so tag before publishing any update for 1.2.0.

The built-in player (libVLC, on `main` since 2026-11-12) is native code that the
1.0.0 builds lack, so from then on `main` cannot be published to 1.0.0 over the
air: the workflow's fingerprint check refuses it. It reaches users with the next
store release; until then a fix for 1.0.0 goes out from a branch off `v1.0.0`
(below).

The same holds for 1.1.0 since 2026-11-14: the player's chapters and Android's
picture in picture changed its native code (`patches/@lunarr+vlc-player+2.1.1.patch`)
and the Android manifest (`plugins/withPictureInPicture.js`). They reach users with
the next store release; a fix for 1.1.0 goes out from a branch off `v1.1.0`.

1.2.1 (2026-11-14) is an Android-only store release: its alerts module replaces
`expo-notifications` on Android. iPhone, iPad and Apple TV stay on 1.2.0, so `main` (runtime 1.2.1) no longer
reaches them over the air; an iOS fix for 1.2.0 goes out from a branch off `v1.2.0`.

The same holds for 1.2.1 since 2026-11-14: Android allows plain HTTP for a
self-hosted DMM (`plugins/withCleartextTraffic.js`, `android:usesCleartextTraffic`
in the manifest). It reaches users with the next store release; a fix for 1.2.1
goes out from a branch off `v1.2.1`.

1.2.2 (2026-11-14, Android only) asks before it downloads updates: expo-updates no longer
checks at launch by itself (`checkAutomatically: NEVER` in `app.json`), and `src/updates.ts`
checks at start instead when Settings → **Get fixes automatically** is on. It starts on in an
install from Google Play, the Amazon Appstore or the App Store, and off in any other (the
GitHub APKs, Obtainium, IzzyOnDroid, whose inclusion policy wants code from outside its
checks to be opt-in) until the user switches it on. **Check** under Version works either
way. The `app.json` change is native, so `main` (runtime 1.2.2) no longer reaches 1.2.1
over the air, and iPhone, iPad and Apple TV get the switch with their next store release.

A binary runs its own code until an update newer than the build itself is
published: updates are ordered by date, so one published before the build is
ignored. Builds of older versions keep the last update published for their version. To
fix one of them as well, branch from its tag (`git switch -c release/1.1 v1.1.0`),
apply the fix there and run the OTA workflow on that branch.

## OTA update

1. Land the change on `main` with CI green, and run it in a release build first
   when it touches anything you cannot see in tests. A release build from the
   same commit runs the same JavaScript the update ships.
2. GitHub → Actions → **Publish OTA update** → Run workflow, on `main`.
   The workflow:
   - runs the type check and tests;
   - reads the runtime version from `app.json` and stops if there is no tag
     `v<version>` or if the native fingerprint (native modules, `app.json`,
     plugins) differs from that tag. That means the change needs a store release;
   - exports Android and iOS, signs each manifest and checks the signature against
     `certs/certificate.pem`, the certificate built into the apps;
   - creates a draft pre-release `ota-<version>-<run>` with every file, uploads
     the files to the update server, then the manifests, and publishes the release.
3. Phones and TVs with Get fixes automatically on fetch the update at their next start
   and run it from the start after that. The update server can answer with the previous
   update for up to a minute after publishing. Settings → Version shows "Updated <date>" once an update is running,
   and its button checks now, then offers **Restart** when one has downloaded. A
   TV that is never closed only updates through that button.

### Rolling back

Run the workflow again on the last good commit: pick its `ota-…` tag in the Run
workflow branch menu. That publishes the old code as a newer update, which every
phone takes. Deleting or editing a GitHub release changes nothing on phones, and
publishing an older update under its old date would not replace a newer one
already installed.

If a new update crashes as the app starts, expo-updates goes back to the previous
update on that device by itself; still roll back so other devices stop
downloading it.

## Store rules for OTA updates

Both stores allow downloaded JavaScript that runs in the app's interpreter:
Apple's guideline 3.3.1(B) (it must not change the app's primary purpose or add
features that bypass review) and Google Play's Device and Network Abuse policy
(code in a virtual machine or interpreter is exempt). Use OTA for fixes and for
features that fit the reviewed app; a change a reviewer would see as a different
app goes through a store release.

## Keys and the update server

| What | Where |
|---|---|
| Signing key (RSA, keyid `main`) | Bitwarden "DMM Mobile OTA signing key" (base64 of the PEM) and the Actions secret `OTA_SIGNING_KEY`. Never commit it. |
| Certificate | `certs/certificate.pem`, built into every binary. A new certificate only reaches users through a store release, so a lost key means a store release before the next OTA update. |
| Update server | Cloudflare Worker `dmm-mobile-ota` (`ota/worker.ts`) at `https://ota.debridmediamanager.com` (also `https://dmm-mobile-ota.bensarmiento.workers.dev`, which only the 0.1.0 test build uses), reading the KV namespace `dmm-mobile-ota`. |
| Publish token | Bitwarden "Cloudflare dmm-mobile OTA publish token" (Workers KV write only) and the Actions secret `CLOUDFLARE_OTA_TOKEN`. |

Every app has the server URL built in, so the Worker keeps its name and both
addresses. **Keep Bot Fight Mode off on the debridmediamanager.com zone**
(Security → Bots): it answers the app's update requests with a challenge page,
which phones cannot pass, and the free plan cannot exempt one host. It was
switched off for this on 2026-11-09. Deploy a change to the Worker with the account's Cloudflare credentials:

```sh
cd ota && npx wrangler@4.152.0 deploy
```

The Worker answers `GET /manifest` with the signed manifest for the
`expo-platform` and `expo-runtime-version` headers, or 204 when none is newer
than the one the device runs, and `GET /assets/<sha256>` with a file.
`ota/publish.mjs` builds and uploads updates; `ota/ota.test.ts` covers both.
