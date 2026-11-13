# Store listings and form answers

One app on both stores: bundle id / package `com.debridmediamanager.library`
(fixed forever once published). Google Play has 1.1.0 (versionCode 3) on the closed
test; the App Store has 1.0.0 (build 2). Apple ships iPhone, iPad
and Apple TV in one App Store record (add the tvOS platform to it); Google Play
ships phones, tablets and Android TV from one app bundle.

| Field | Value |
|---|---|
| Name | App Store: Debrid Media Manager ("DMM Mobile" was taken). Google Play: DMM Mobile. On the device: DMM Mobile |
| Developer / seller | Ben Adrian Sarmiento |
| Privacy policy | https://debridmediamanager.com/privacy |
| Support | https://debridmediamanager.com/support |
| Marketing site | https://debridmediamanager.com |
| Contact email | support@debridmediamanager.com |
| Category | App Store: Utilities (secondary Entertainment). Google Play: Tools |
| Price | Free, no in-app purchases, no ads |

## Copy

**Subtitle** (App Store, 30 max): `Your debrid library, anywhere`

**Short description** (Google Play, 80 max):
`Browse, play and manage your debrid cloud library on phone, tablet and TV.`

**Promotional text** (App Store, 170 max):
`Every file in your debrid accounts in one fast list. Play in the player you like, add new downloads and keep the library tidy, on your phone, tablet or TV.`

**Keywords** (App Store, 100 max):
`debrid,real-debrid,alldebrid,torbox,premiumize,offcloud,debrid-link,cloud,library,player,tv`

**Description** (both stores):

```text
DMM Mobile puts the cloud library of your debrid service on your phone, tablet and TV.

Sign in to Real-Debrid, AllDebrid, TorBox, Premiumize, Offcloud or Debrid-Link and
every file you keep there shows in one fast list, even with thousands of items.

• Play any video in the player you choose, with its subtitles
• Connect Trakt or Simkl: what you play is scrobbled, and watched marks and resume points follow you
• See your Trakt and Simkl watchlists and lists, and play what your library holds
• A calendar of your shows' new episodes, with an optional alert when one airs
• Search your library by name, filter by service, type or state, and sort it
• Add downloads to your service and follow their progress
• Select, delete, reinsert and tidy up duplicates in bulk
• Back up your library and restore it, also from Debrid Media Manager on the web
• Sign in once: your other services and settings come back on every device
• Search titles and open them on debridmediamanager.com, already signed in
• On TV, sign in by scanning a code with your phone and browse with the remote

DMM Mobile needs an account with at least one of these services, which you buy
from the service itself. The app stores no files and sells nothing. Your logins
stay in your device's secure storage.

To look around first, enter dmmdemo as the API key of any service: it opens a
sample library of open movies.

DMM Mobile uses Trakt but is not endorsed or certified by Trakt.
DMM Mobile syncs watch history with Simkl (simkl.com) and is not affiliated with Simkl.
```

Trakt's API use policy asks for its sentence in the store description and in the app
(Settings → Trakt). Simkl's API rules ask apps to name Simkl and link to it where its
data shows, and its terms (9.6) forbid using its name in a way that confuses who owns
it: the app has the same line with a link to simkl.com (Settings → Simkl) and "View on
Simkl" on a title's page while Simkl is connected.

**What's new** (Google Play, 500 max):

- 1.0.0: `First release.`
- 1.1.0:

  ```text
  Your library by title now, with posters, seasons and episodes.
  A built-in player that remembers where you stopped and plays the next episode.
  Home: continue watching, next up and your watchlist.
  Connect Trakt or Simkl to sync what you watch.
  Your Trakt and Simkl lists, and a calendar of your shows with optional new-episode alerts.
  ```

## Screenshots

The App Store sets are marketing slides: a headline over the real screens in device
frames, rebuilt with `python3 docs/store/marketing/render.py` (HTML rendered by
headless Chrome at Apple's exact sizes). Edit the copy there and rerun.

`docs/store/screenshots/`: the app's real screens with a sample library of Blender open
movies (the README's screenshot fixture), status bars at 9:41. No Search screens, which
would show commercial posters.

| Store slot | Size | Files |
|---|---|---|
| App Store iPhone 6.9" | 1320 × 2868 | `appstore-iphone-*.png` (5) |
| App Store iPad 13" | 2064 × 2752 | `appstore-ipad-*.png` (2) |
| App Store Apple TV | 3840 × 2160 | `appstore-appletv-*.png` (3) |
| Play phone | 1080 × 2160 | `play-phone-*.png` |
| Play 10" tablet | 2560 × 1600 | `play-tablet-*.png` |
| Play Android TV | 1920 × 1080 | `../screenshots/firetv-*.png` |
| Play feature graphic | 1024 × 500 | `play-feature-graphic.png` |
| Play icon | 512 × 512 | `play-icon.png` |
| Play TV banner | 1280 × 720 | `play-tv-banner.png` |

## App Store Connect answers

**Age rating:** answer None / No to every content question. "Unrestricted web
access": No (links open in the system browser, not inside the app). Result: 4+.

**App Privacy:**

| Data type | Collected | Linked to the user | Tracking | Purpose |
|---|---|---|---|---|
| Other Data (debrid logins and app settings, the "remembered across devices" copy) | Yes | Yes | No | App Functionality |
| Search History | No: queries are looked up and not kept | | | |
| Everything else | No | | | |

**Export compliance:** the app uses only the system's HTTPS
(`ITSAppUsesNonExemptEncryption` is false in the build), so no documentation.

**Content rights:** "Does your app contain, show, or access third-party content?"
Yes. It shows the user's own files from their own account and title information
from Trakt, and their own watch history from Trakt or Simkl when they connect them; the user has the rights to their account. The demo library is CC BY 3.0.

**Sign in with Apple:** not required (no third-party social login; the logins are
the user's own service credentials).

## Google Play Console answers

**Ads:** No. **Target audience:** 18 and over. **News app:** No.
**Government, financial, health features:** None. **Advertising ID:** Not used
(the manifest has no AD_ID permission).

**Trader status:** the account is declared a trader; the app inherits it. No
Terms of Service URL (DMM has no terms page).

**Content rating (IARC),** submitted 2026-11-10. Category "All Other App Types".
The app streams films that are not in the download (the user's library, the demo
films, Search's titles and posters), so it is rated like a streaming catalog:

| Question | Answer |
|---|---|
| Ratings-relevant content in the app package | No |
| Users interact or exchange content | No |
| Features content not in the download | Yes |
| Violence: can contain it / primary purpose / visual / gory / only cartoony / in text | Yes / No / Yes / No / No / Yes |
| Sexual material or nudity | No |
| Offensive language: can contain / focus / minor / moderate / discriminatory / sexual expletives | Yes / No / Yes / Yes / No / No |
| Drugs: references / focus / visual / in text | Yes / No / No / Yes |
| Age-restricted products, location sharing, digital purchases, cash rewards, browser, news/education | No |

Result: ESRB Teen, PEGI Parental guidance, USK 12, ClassInd 14, IARC 12+.

**Data safety:**

| Question | Answer |
|---|---|
| Does the app collect or share any of the required user data types? | Yes |
| Is all collected data encrypted in transit? | Yes |
| Account creation | The app does not create accounts; users sign in with accounts made outside it ("out of app identification": their service subscription) |
| Do you provide a way for users to request that their data is deleted? | Yes, https://debridmediamanager.com/privacy (email, or unticking "Remember my logins" on the website) |

| Data type | Collected | Shared | Ephemeral | Required | Purpose |
|---|---|---|---|---|---|
| Personal info → Other info (debrid and Trakt logins and settings in the remembered copy) | Yes | No | No | Yes (always on) | App functionality |
| Files and docs → Files and docs (release names in the library, sent to DMM to find which film or show each is; DMM keeps the answer by hash, not by user) | Yes | No | No | Yes | App functionality |
| App activity → Other actions (watch history and resume points, sent to Trakt or Simkl only when the user connects them; not sharing, since the user asked for it) | Yes | No | No | No (optional) | App functionality |
| App activity → In-app search history (Search queries, looked up and not kept) | Yes | No | Yes | No | App functionality |
| Everything else | No | | | | |

The Simkl login stays on the device and goes only to Simkl. New-episode alerts are
scheduled on the device; nothing about them leaves it.

**Permissions** (no declaration form needs them, but reviewers see them in the manifest): `POST_NOTIFICATIONS`,
asked only when the user switches on New-episode alerts in Settings, and `RECEIVE_BOOT_COMPLETED`, so alerts
already scheduled survive a restart. Both come with `expo-notifications`; the push (Firebase Cloud Messaging),
wake-lock, Play install-referrer and launcher-badge permissions it also brings are removed in `app.json`. No exact-alarm permission.
The App Store build has no push entitlement.

**App access:** see `review.md`.
