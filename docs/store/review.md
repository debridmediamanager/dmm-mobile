# App review: sign-in, notes and test steps

Reviewers sign in with the **demo key `dmmdemo`**, typed as the API key of any provider.
It opens a sample library of Blender Foundation open movies (Creative Commons
Attribution 3.0) whose files really play, streamed from the Internet Archive. No
debrid account is involved, it works from any network, and nothing a reviewer does
reaches a real account: adds and deletes change only the demo library on that
device, until the app is closed. The demo key never reaches DMM's sync or the
browser handoff (`src/demo.ts`, tested in `src/demo.test.ts`).

| Demo item | State | What it shows |
|---|---|---|
| Tears of Steel (2012) 1080p | Ready | A video and three subtitle files (en, de, es) |
| Sintel (2010) 2K | Ready | One video |
| Big Buck Bunny (2008) 720p | Ready | One video |
| Cosmos Laundromat (2015) | Downloading, 62 % | Progress, speed and seeders; its file does not open yet |

## App Store Connect: App Review Information

- **Sign-in required:** Yes
- **User name:** `demo`
- **Password:** `dmmdemo`
- **Notes** (paste as is; under 4,000 characters):

```text
DMM Mobile manages the user's own cloud storage at a "debrid" service (Real-Debrid,
AllDebrid, TorBox, Premiumize, Offcloud or Debrid-Link): paid cloud download
services the user already subscribes to. The app lists the files in that account,
plays them in the user's chosen player app, adds new downloads to the account and
deletes old ones. It hosts no content and does not download anything over
BitTorrent or any peer-to-peer network itself; links the user adds are handed to
their own service, which stores the result in their account. Nothing is sold in
the app.

DEMO SIGN-IN (no debrid account needed)
There is no user name. Use "dmmdemo" as the API key of any provider; it opens a
sample library of Blender Foundation open movies (CC BY 3.0) streamed from the
Internet Archive. Changes to it last until the app is closed.

iPhone and iPad
1. Open the app. On "Sign in", scroll to TorBox, type dmmdemo in its API token
   field, then tap "Save key".
2. Home shows the four open movies under Recently Added. Tap "Tears of Steel" for
   its page and tap Open: it plays in the app's own player. Its subtitle button lists
   the film's English, German and Spanish subtitle files. Leave it after half a
   minute or more: back on Home it waits under Continue Watching.
3. Under Releases, tap the release to see its files; tap a subtitle file to open
   it in the browser.
4. Back in the Library, tap Torrents for the list of releases: the menu (three
   dots) on a row has its actions; long-press rows to select several.
5. Tap + to add a magnet link, for example:
   magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny
   It appears as "queued (demo)".
6. Search tab: type a title. Tapping a result opens that title's page on
   debridmediamanager.com in Safari.
7. Settings: choose the video player; links to the privacy policy and support.

Apple TV
1. Open the app. On "Sign in", choose "Enter an API key instead".
2. Under TorBox, select the API token field, type dmmdemo, then "Save key".
3. Browse Home and the Library with the remote; Select opens an item, and its video plays
   in the app's own player (play/pause on the remote; Select shows the controls).
The QR code on that screen signs a TV in from a phone that is signed in to
debridmediamanager.com; it needs a real debrid account, so please use the key.

Contact: support@debridmediamanager.com
```

## Google Play Console: App access

- **All or some functionality is restricted:** Yes
- **Instruction name:** Demo library
- **User name:** `demo`
- **Password:** `dmmdemo`
- **Any other information** (under 500 characters):

```text
No account needed: on Sign in, type dmmdemo as the TorBox API token and tap Save key.
It opens a sample library of open movies (CC BY) that really play. On Android TV,
choose "Enter an API key instead" first. The app manages the user's own debrid
cloud storage; it hosts no content and downloads nothing over peer-to-peer itself.
```

## Test steps per platform

Run these on the release build before each submission, signed in with `dmmdemo`
only (never a real account on a store build under test).

| # | Step | Expected | iPhone | iPad | Apple TV | Android phone | Android tablet | Android TV |
|---|---|---|---|---|---|---|---|---|
| 1 | Fresh install, open | Sign-in screen (TV: QR code and "Enter an API key instead") | | | | | | |
| 2 | TorBox API token `dmmdemo`, Save key | Home with 4 film posters under Recently Added; Library the same 4, Torrents 4 items, Cosmos Laundromat at 62 % | | | | | | |
| 3 | Open Tears of Steel, then its release | Title page with backdrop, plot and one copy; the release has 1 video and 3 subtitle files | | | | | | |
| 4 | Open (title page) | Plays in the built-in player; Subtitles lists the 3 .srt files and shows one when picked; leaving after 30 s and opening again offers Resume; Home lists it under Continue Watching | | | | | | |
| 5 | Open Cosmos Laundromat | "This demo file is still downloading." | | | | | | |
| 6 | Torrents, row menu, Delete Sintel | Sintel gone until the app is closed | | | | | | |
| 7 | Add the magnet from the notes | Big Buck Bunny shows 2 copies; under Torrents a "Big Buck Bunny" row, queued (demo) | | | | | | |
| 8 | Search "sintel", tap a result | DMM page opens in the browser, signed out | | | n/a | | | n/a |
| 9 | Settings, Privacy policy | debridmediamanager.com/privacy opens (TV: address shown) | | | | | | |
| 9a | Home, calendar button | Calendar opens, empty (the demo films are no shows); Settings → New-episode alerts on asks to allow notifications (not on TVs, which have no such setting) | | | n/a | | | n/a |
| 10 | Accounts, Disconnect TorBox | Back to sign-in, library empty | | | | | | |
| 11 | Close and reopen after step 2 | Still signed in, demo library reset to 4 items | | | | | | |

Step 8 opens signed out on purpose: the demo key is not handed to the browser.
