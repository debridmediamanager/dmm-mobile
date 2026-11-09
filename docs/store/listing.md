# Store listings and form answers

One app on both stores: bundle id / package `com.debridmediamanager.library`
(fixed forever once published), version 1.0.0, build 1. Apple ships iPhone, iPad
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
```

**What's new** (1.0.0): `First release.`

## Screenshots

`docs/store/screenshots/`: the app's real screens with a sample library of Blender open
movies (the README's screenshot fixture), status bars at 9:41. No Search screens, which
would show commercial posters.

| Store slot | Size | Files |
|---|---|---|
| App Store iPhone 6.9" | 1320 × 2868 | `ios-iphone-*.png` |
| App Store iPad 13" | 2064 × 2752 | `ios-ipad-*.png` |
| App Store Apple TV | 3840 × 2160 | `../screenshots/appletv-*.png` |
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
from Trakt; the user has the rights to their account. The demo library is CC BY 3.0.

**Sign in with Apple:** not required (no third-party social login; the logins are
the user's own service credentials).

## Google Play Console answers

**Ads:** No. **Target audience:** 18 and over. **News app:** No.
**Government, financial, health features:** None. **Advertising ID:** Not used
(the manifest has no AD_ID permission).

**Content rating (IARC):** category "Utility, Productivity, Communication, or
Other"; No to violence, sexuality, language, controlled substances, gambling.
"Does the app allow users to interact or exchange content?" No. "Does it share the
user's location?" No. "Does it allow purchases of digital goods?" No.

**Data safety:**

| Question | Answer |
|---|---|
| Does the app collect or share any of the required user data types? | Yes |
| Is all collected data encrypted in transit? | Yes |
| Do you provide a way for users to request that their data is deleted? | Yes (email, or unticking "Remember my logins" on the website) |

| Data type | Collected | Shared | Ephemeral | Required | Purpose |
|---|---|---|---|---|---|
| Personal info → Other info (debrid logins and settings in the remembered copy) | Yes | No | No | Yes (always on) | App functionality |
| App activity → In-app search history (Search queries, looked up and not kept) | Yes | No | Yes | No | App functionality |
| Everything else | No | | | | |

**App access:** see `review.md`.
