⁷# 🌙 Moonlight

A music player for Android with a Spotify-style interface and a moon-and-stars theme. Moonlight plays the music already stored on your phone, keeps playing in the background, and can even download songs from links and file them into playlists for you.

It began as the music panel of the **Novel Reader** app and is now an app of its own, with its own package (`com.scell.moonlight`), signed APKs and in-app updates.

---

## Table of contents

- [Features](#features)
- [Screens](#screens)
- [Supported formats](#supported-formats)
- [How your music is organised](#how-your-music-is-organised)
- [Installing](#installing)
- [Permissions](#permissions)
- [Updating](#updating)
- [Your settings and song lists](#your-settings-and-song-lists)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Building](#building)
- [Setting up the repo](#setting-up-the-repo-once)
- [Testing](#testing)
- [Version numbering](#version-numbering)
- [Known limitations](#known-limitations)

---

## Features

### Playback
- **Background playback**: music keeps playing with the screen off or the app closed (Media3 / ExoPlayer in a foreground service).
- **Notification and lock-screen controls** with artwork, title/artist, play/pause, and next/previous.
- **Bluetooth and headset buttons** work, and playback pauses when headphones or Bluetooth disconnect.
- **Audio focus handling**: ducks or pauses for calls and other apps.
- **Near-gapless playback**: the next track is pre-buffered while the current one plays.
- **Crossfade**: overlap tracks by 1 to 12 seconds on an equal-power curve (loudness stays steady). Each track keeps its own volume level during the fade.
- **Volume normalisation (ReplayGain)**: Off / Track / Album. Reads the ReplayGain tags already in your files (ID3v2, APEv2, FLAC/Vorbis/Opus comments, iTunes-style M4A atoms). Loud tracks are turned down; quiet ones are boosted by the background player, never past the point of clipping.
- **A-B repeat**: loop a section of a song with the A / B buttons under the seek bar.
- **Sleep timer**: stop after a set number of minutes or at the end of the current track, with a fade-out.
- **Unplayable files are skipped** instead of stalling the player.
- **Muting the phone pauses the music** and it carries on when you turn the volume back up. While it waits like that, the app no longer closes itself after 10 minutes (it holds on for up to 3 hours).
- **Remembers the last song**: on the next launch it is ready in the player (not started) from the beginning.
- **Optional auto-start over Bluetooth**: when Bluetooth audio connects, Moonlight can start playing the current song by itself.

### Library and organisation
- **Library scan** reads your folders and tags (title, artist, album, cover art). Tap **Scan the sky** on Home to rescan.
- **Folder playlists**: every sub-folder inside your music folder becomes a playlist.
- **Your own playlists**: create hand-picked playlists that aren't tied to a folder, and add songs to them from anywhere.
- **Liked songs**: heart a song to add it to **Liked**.
- **Recently played**: newest first, up to 100 songs.
- **Visible queue** ("up next") with a playlist tag on each row when browsing All songs.
- **Shuffle in rounds**: every song in the playlist plays once, in random order, before any song repeats. The app remembers which songs it already played (even after you close it), so reopening never starts on the same song again. With repeat **all**, a new random round starts when the old one ends, and it never opens with the song that just played. **Repeat** has three modes: off / all / one.
- Shuffle, repeat and next/previous all stay inside the playlist you are playing.

### Download songs
- **Paste links** from your clipboard. Every web link found is queued as a song (up to 50 at a time).
- A **bundled yt-dlp (with Python and ffmpeg)** downloads the best audio and converts it to MP3 with tags and cover art. No other app is needed.
- A step-by-step wizard for each song: **download → name it → pick a playlist → place it**. While you name one song, the next one is already downloading in the background.
- Choose an existing playlist, make a **New playlist**, or pick **No playlist**.
- Failed downloads offer **Retry** and **Skip**.
- Names are cleaned up automatically (file name and title tag stay in sync).
- If yt-dlp breaks because a site changed, the app updates yt-dlp by itself after the first failure.
- Leaving the tab before a song is placed cancels running downloads and deletes the staged files.
- **It remembers what you downloaded.** Every saved song's link and the name it was saved under go into `downloads.txt` on the phone. Paste a link you downloaded before (even written another way, like `youtu.be/…` or `youtube.com/watch?v=…`) and the app says **Already downloaded**, shows the name, playlist and date, and whether the file is still on your phone. By default it skips them; flip **Again** on any you want anyway. A song whose file was deleted since is offered again automatically.
- **Duplicate names are caught while you name a song.** Songs already on your phone (or downloaded before) with the same or a similar name are listed under the name box, ignoring capitals, punctuation and tags like "(Official Video)". If one has the same name you get a warning, and **Don't keep this song** deletes just that download.

### Look and feel
- **Spotify-style design**: mini player, "..." action sheet, album/playlist headers, 2×2 cover mosaics on playlist rows.
- **Cover-art tint**: the panel takes its colours from the current cover.
- **Moon theme**: stars, glows and a **live moon-phase badge** on Home that shows today's real phase.
- **Home screen** with a time-based greeting (Good morning / afternoon / evening / night), quick tiles, a "Made for you" shelf (Your whole sky, Recently played, Liked) and your **Constellations** (folders and your own playlists).
- **Animated equalizer** on the playlist that holds the current song.
- Bundled fonts (Lora, Newsreader, Manrope, Atkinson) so the app looks the same offline.
- **Smooth with big libraries**: indexed song look-ups, off-screen rows are skipped by the renderer, and entrance animations are limited to the first rows.
- A custom launcher icon, status/navigation bar insets handled for edge-to-edge display.

### Search
- A **Search** tab (second in the bottom bar) works like Spotify's. Results appear as you type: a **Top result**, then **Songs**, **Playlists** and **Artists**, with the letters you typed highlighted.
- Every word you type must match somewhere in a song's **title, artist, album or playlist**. Capitals, accents and punctuation don't matter, a small typo is forgiven, and `lofi` finds `Lo-fi`.
- Chips narrow it to **Songs**, **Playlists** or **Artists**. Tap a song to play it, tap the heart to like it, tap a playlist to open it, tap an artist to see their songs.
- With nothing typed it shows your **recent searches** (tap to repeat, × to remove, Clear all) and a **Browse all** grid of your playlists.

### Settings menu
- **Swipe right on Home** (or tap the gear button at the top right) and a **Settings** menu slides in from the left. It follows your finger, and a quick flick opens or closes it from any distance. Swipe left, tap the dark area, tap the X or press Back to close it.
- **Playback:** volume normalisation (Off / Track / Album), crossfade length, and **Play when Bluetooth connects**.
- **Appearance:** **Twinkling stars** (turn off for still stars, calmer and easier on the battery) and **Colours from the cover** (tint the screens from the song that's playing).
- **Updates sit at the bottom:** the update bar (download / install progress), the **Update automatically** switch, the version number and a **Check for updates** button. A small dot on the gear button shows when there is an update to act on.

### Updates
- The app checks this repo's **GitHub Releases** on start (at most every 6 hours) and downloads new versions on Wi-Fi only.
- **It also updates while closed**: Android's JobScheduler wakes a background check about every 6 hours (Wi-Fi only, not when the battery is low, and again after a reboot). A newer version is downloaded and installed by itself. On Android 12+ this can happen with no screen at all; otherwise a **notification** appears and one tap installs it. No Firebase or server is needed.
- The install waits while **music is playing** or a **song download** is running (it retries 30 minutes later), because an install restarts the app.
- - When the app is open, the update bar appears at the bottom of the **Settings menu**; use **Check for updates** to check right now.
- An **Update automatically** switch controls both the in-app and the background checking.
- APK size and SHA-256 (when GitHub provides it) are verified before install, and Android always has the final say.

---

## Screens

Swipe sideways or use the bottom bar to move between five tabs:

| Tab | What it does |
| --- | --- |
| **Home** | Greeting, moon phase, quick tiles, Made for you, your Constellations, **Scan the sky**, and the **Settings** button (or swipe right) |
| **Search** | Search your songs, playlists and artists as you type; recent searches; Browse all |
| **Songs** | The full library, playlists and the visible queue |
| **Now playing** | Artwork, seek bar, like, shuffle/repeat, A-B repeat, volume, sleep timer |
| **Download** | The paste-a-link song download wizard |

The Back button closes dialogs and sheets first, then returns to Home, then leaves the app.

---

## Supported formats

`mp3`, `m4a` / `aac`, `flac`, `ogg`, `opus`, `wav`

---

## How your music is organised

Moonlight reads music from:

```
/storage/emulated/0/Novel/Audio
```

The folder is created on first launch. (The path is kept so a library you already built with Novel Reader keeps working.)

**Playlists are just folders:**

```text
Novel/Audio/
  Lo-fi Focus/2AM.mp3        -> playlist "Lo-fi Focus"
  Lo-fi Focus/Rain.mp3       -> playlist "Lo-fi Focus"
  Podcasts/Ep1/part1.mp3     -> playlist "Podcasts"
  standalone-track.mp3       -> plays under "All songs", no playlist of its own
```

Only one level of grouping counts: a folder inside a playlist folder does not create a nested playlist.

---

## Installing

1. In this repo, open **Releases** and download `moonlight-vX.Y.Z.apk`. (Or open **Actions**, pick the newest green run and download the `moonlight-release-apk` artifact.)
2. Install it. Allow **All files access** (Android 11+) and **notifications** (Android 13+) when asked.
3. Put music in `Novel/Audio`, open the app, and tap **Scan the sky** on Home if it isn't picked up.

**Requirements:** Android 7.0 (API 24) or newer. Builds target `arm64-v8a` and `armeabi-v7a` (real phones); x86 emulators need the ABI filter changed in `app/build.gradle`.

---

## Permissions

| Permission | Why |
| --- | --- |
| `READ_EXTERNAL_STORAGE` (Android 12 and older) / `MANAGE_EXTERNAL_STORAGE` | Read your music and create the folders |
| `WRITE_EXTERNAL_STORAGE` (Android 10 and older) | Create the music folder where "all files access" doesn't exist |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` | Background playback |
| `POST_NOTIFICATIONS` | Show the media notification (Android 13+) |
| `INTERNET` | Song downloads and update checks (nothing else uses the network) |
| `ACCESS_NETWORK_STATE` | Skip automatic update downloads on mobile data |
| `REQUEST_INSTALL_PACKAGES` | Install the updated APK |
| `RECEIVE_BOOT_COMPLETED` | Keep the background update check scheduled after a reboot |

---

## Updating

From v1.00.00 the app checks GitHub Releases when it starts. If a newer version exists it downloads on Wi-Fi, and a bar at the bottom of the **Settings menu** offers **Install**. Android asks you to confirm, and the first time to allow *Install unknown apps* for Moonlight.

From v1.01.00 the app also checks **in the background** about every 6 hours, even when it is closed, and installs the update by itself when Android allows it (otherwise it posts a notification; tap it to install). Android only lets an app skip the confirm screen for updates of an app it installed itself, so **the first update installed through Moonlight may ask once; later ones can be silent** (Android 12 and newer). Turn the **Update automatically** switch off to stop all background checking.

The app never installs by itself while music is playing or a download is running.

---

## Your settings and song lists

Everything lives in one folder, `/storage/emulated/0/Moonlight/`. Copy it to a new phone and the app picks up where it left off.

```
settings.txt    your settings (audio.* lines)
downloads.txt   every song downloaded from a link: date, saved name, playlist, link, file path
favorites.txt   your liked songs: date liked, title, artist, album, playlist, length, file path
recents.txt     your recently played songs (newest first, up to 100), same details
```

All are plain text, one song per line, **tab separated** with a `#` comment header, so they open in any text editor or spreadsheet. The app rewrites `favorites.txt` and `recents.txt` whenever your liked or played songs change, and if the app's own copy is ever empty (a fresh install, cleared data) it **restores your favourites and recents from these files** on the first scan. `downloads.txt` is what powers the "already downloaded" warning.

`settings.txt` can be edited while the app is closed. To move over from Novel Reader, copy its `audio.*` lines from `Novel/settings.txt` into it.

---

## Tech stack

| Part | Technology |
| --- | --- |
| UI | HTML / CSS / JavaScript inside an Android **WebView** (served from `https://appassets.androidplatform.net/` via `WebViewAssetLoader`) |
| Native host | **Kotlin**, Android SDK 34, minSdk 24 |
| Playback | **Media3 ExoPlayer 1.4.1** + **media3-session** (MediaSession, notification, lock screen) |
| Playback engines | WebView `<audio>` and native ExoPlayer, switching mid-song, inaudibly |
| Downloads | **youtubedl-android 0.18.1** (yt-dlp + Python + ffmpeg) |
| Build | Gradle, Java 17, **GitHub Actions** |
| Minification | R8 shrinking (no obfuscation, so crash logs stay readable) |

---

## Project structure

```
moonlight/
├── app/src/main/
│   ├── java/com/scell/moonlight/
│   │   ├── MainActivity.kt        WebView host, permissions, native bridge, library scan
│   │   ├── PlaybackService.kt     ExoPlayer + MediaSession foreground service
│   │   ├── NativeCrossfade.kt     Two-player crossfade
│   │   ├── NativeAudioEffects.kt  Loudness boost for quiet tracks
│   │   ├── ReplayGainReader.kt    Reads ReplayGain tags from files
│   │   ├── SongDownloader.kt      yt-dlp / ffmpeg download jobs
│   │   ├── SongNames.kt           Song and playlist name cleaning
│   │   ├── Id3Title.kt            Writes ID3 title tags
│   │   ├── AppUpdater.kt          In-app GitHub Releases updater
│   │   └── BackgroundUpdater.kt   Background update check (JobScheduler) and install notification
│   ├── assets/
│   │   ├── index.html             The page and its styles
│   │   ├── player-app.js          App glue: insets, tab swipe, back handling, dialogs
│   │   ├── audio-player.js        Queue, engines, library, feature framework
│   │   ├── spotify-ui.js          Home / Songs / Now playing / Download tabs
│   │   ├── song-download.js       Download wizard
│   │   ├── settings-menu.js       Settings drawer: swipe gesture and switches
│   │   ├── song-search.js         Search tab: matching, ranking, results
│   │   ├── song-memory.js         downloads.txt / favorites.txt / recents.txt, duplicate links and names
│   │   ├── app-update.js          Update bar and switch
│   │   ├── settings-file.js       Mirrors settings to settings.txt
│   │   ├── moon-phase.js, moon-theme.js   Moon-phase badge and theme
│   │   ├── version.js             APP_VERSION
│   │   └── fonts/
│   ├── res/                       Icons, colours, themes
│   └── AndroidManifest.xml
├── tests/                         Node and JVM tests
├── .github/workflows/build-apk.yml
├── Agent.md                       Developer / AI-assistant notes
└── README.md
```

For design decisions, the audio feature framework and the structure change log, see [Agent.md](Agent.md).

---

## Building

Builds run on **GitHub Actions** (`.github/workflows/build-apk.yml`). A push builds when:

1. you run the workflow by hand from the **Actions** tab, **or**
2. a commit message contains a version number like `v1.00.01`.

Example: `v1.00.01: fix crossfade`. Other commits are skipped, so no APK is built. A successful signed build publishes a GitHub Release with `moonlight-vX.Y.Z.apk`, which is what the in-app updater reads.

### Signing

Android only lets an APK update an installed app if both are signed with the **same key**. Add four secrets in **Settings → Secrets and variables → Actions**:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Without them the build falls back to the debug key and **publishes no Release**. Never commit a keystore.

---

## Setting up the repo (once)

1. Create the repo. The updater expects `Chirag-S-Reddy/Moonlight`; if you name it differently, change `OWNER_REPO` in `AppUpdater.kt`.
2. Copy the *contents* of the `moonlight/` folder into the repo root and push. **Use `git add -A`.**
3. Add the four signing secrets (see above).
4. Push with a version number in the commit message, or run the workflow manually.

---

## Testing

Run each test from the project root:

```bash
node tests/<name>.test.js
```

The tests cover the audio player, startup and playlist playback, the Spotify-style tabs, home screen and covers, the song-download wizard, the updater, the page's bridge contract (`player-app.test.js`) and Kotlin pure-logic checks on the JVM (`tests/jvm/`). They cannot test real audio or the Android side.

---

## Version numbering

Format: `vMAJOR.MID.MINOR`, kept in one place: `APP_VERSION` in `app/src/main/assets/version.js`.

| Part | Changes when |
| --- | --- |
| MAJOR | You decide |
| MID | A new feature, or after 99 minor fixes (MINOR resets to `00`) |
| MINOR | Each small bug fix |

Failed or redone builds never change the version. This is separate from Android's `versionCode`, which follows the GitHub Actions run number.

---

## Known limitations

- The playback-speed control and per-track resume-at-position were removed. Playback is always 1× and each track starts from 0.
- The native crossfade, loudness boost and Bluetooth auto-start code were written without being run on a device, so test them on your phone.
- The music folder is fixed at `Novel/Audio` (no folder picker yet).
- Downloads depend on yt-dlp working with the site; sites change, and updates to yt-dlp may be needed.
- Some leftover CSS from the Novel Reader app is still in `index.html` (harmless).
- The launcher icon is still the reader's.

---

## Credits

Moonlight stands on other people's work. Each project below keeps its own licence.

**Playback and Android**
- [Media3 / ExoPlayer and Media3 Session](https://developer.android.com/media/media3): audio playback, the media notification and lock-screen controls.
- [AndroidX](https://developer.android.com/jetpack/androidx): Activity, Core, DocumentFile and WebKit.

**Song downloads**
- [yt-dlp](https://github.com/yt-dlp/yt-dlp): the downloader itself. The app keeps its copy on the
  [nightly builds](https://github.com/yt-dlp/yt-dlp-nightly-builds) because YouTube changes faster than the stable releases.
- [youtubedl-android](https://github.com/JunkFood02/youtubedl-android) by JunkFood02, which runs yt-dlp inside an Android app, and the
  [original project](https://github.com/yausername/youtubedl-android) by yausername it grew from. It bundles Python and
  [FFmpeg](https://ffmpeg.org) (mp3 conversion and cover art).

**Typefaces**
- [Lora](https://fonts.google.com/specimen/Lora), [Newsreader](https://fonts.google.com/speRain.mp3       -> playlist "Lo-fi Focus"
  Podcasts/Ep1/part1.mp3     -> playlist "Podcasts"
  standalone-track.mp3       -> plays under "All songs", no playlist of its own
```

Only one level of grouping counts: a folder inside a playlist folder does not create a nested playlist.

---

## Installing

1. In this repo, open **Releases** and download `moonlight-vX.Y.Z.apk`. (Or open **Actions**, pick the newest green run and download the `moonlight-release-apk` artifact.)
2. Install it. Allow **All files access** (Android 11+) and **notifications** (Android 13+) when asked.
3. Put music in `Novel/Audio`, open the app, and tap **Scan the sky** on Home if it isn't picked up.

**Requirements:** Android 7.0 (API 24) or newer. Builds target `arm64-v8a` and `armeabi-v7a` (real phones); x86 emulators need the ABI filter changed in `app/build.gradle`.

---

## Permissions

| Permission | Why |
| --- | --- |
| `READ_EXTERNAL_STORAGE` (Android 12 and older) / `MANAGE_EXTERNAL_STORAGE` | Read your music and create the folders |
| `WRITE_EXTERNAL_STORAGE` (Android 10 and older) | Create the music folder where "all files access" doesn't exist |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` | Background playback |
| `POST_NOTIFICATIONS` | Show the media notification (Android 13+) |
| `INTERNET` | Song downloads and update checks (nothing else uses the network) |
| `ACCESS_NETWORK_STATE` | Skip automatic update downloads on mobile data |
| `REQUEST_INSTALL_PACKAGES` | Install the updated APK |
| `RECEIVE_BOOT_COMPLETED` | Keep the background update check scheduled after a reboot |

---

## Updating

From v1.00.00 the app checks GitHub Releases when it starts. If a newer version exists it downloads on Wi-Fi, and a bar at the bottom of the **Settings menu** offers **Install**. Android asks you to confirm, and the first time to allow *Install unknown apps* for Moonlight.

From v1.01.00 the app also checks **in the background** about every 6 hours, even when it is closed, and installs the update by itself when Android allows it (otherwise it posts a notification; tap it to install). Android only lets an app skip the confirm screen for updates of an app it installed itself, so **the first update installed through Moonlight may ask once; later ones can be silent** (Android 12 and newer). Turn the **Update automatically** switch off to stop all background checking.

The app never installs by itself while music is playing or a download is running.

---

## Your settings and song lists

Everything lives in one folder, `/storage/emulated/0/Moonlight/`. Copy it to a new phone and the app picks up where it left off.

```
settings.txt    your settings (audio.* lines)
downloads.txt   every song downloaded from a link: date, saved name, playlist, link, file path
favorites.txt   your liked songs: date liked, title, artist, album, playlist, length, file path
recents.txt     your recently played songs (newest first, up to 100), same details
```

All are plain text, one song per line, **tab separated** with a `#` comment header, so they open in any text editor or spreadsheet. The app rewrites `favorites.txt` and `recents.txt` whenever your liked or played songs change, and if the app's own copy is ever empty (a fresh install, cleared data) it **restores your favourites and recents from these files** on the first scan. `downloads.txt` is what powers the "already downloaded" warning.

`settings.txt` can be edited while the app is closed. To move over from Novel Reader, copy its `audio.*` lines from `Novel/settings.txt` into it.

---

## Tech stack

| Part | Technology |
| --- | --- |
| UI | HTML / CSS / JavaScript inside an Android **WebView** (served from `https://appassets.androidplatform.net/` via `WebViewAssetLoader`) |
| Native host | **Kotlin**, Android SDK 34, minSdk 24 |
| Playback | **Media3 ExoPlayer 1.4.1** + **media3-session** (MediaSession, notification, lock screen) |
| Playback engines | WebView `<audio>` and native ExoPlayer, switching mid-song, inaudibly |
| Downloads | **youtubedl-android 0.18.1** (yt-dlp + Python + ffmpeg) |
| Build | Gradle, Java 17, **GitHub Actions** |
| Minification | R8 shrinking (no obfuscation, so crash logs stay readable) |

---

## Project structure

```
moonlight/
├── app/src/main/
│   ├── java/com/scell/moonlight/
│   │   ├── MainActivity.kt        WebView host, permissions, native bridge, library scan
│   │   ├── PlaybackService.kt     ExoPlayer + MediaSession foreground service
│   │   ├── NativeCrossfade.kt     Two-player crossfade
│   │   ├── NativeAudioEffects.kt  Loudness boost for quiet tracks
│   │   ├── ReplayGainReader.kt    Reads ReplayGain tags from files
│   │   ├── SongDownloader.kt      yt-dlp / ffmpeg download jobs
│   │   ├── SongNames.kt           Song and playlist name cleaning
│   │   ├── Id3Title.kt            Writes ID3 title tags
│   │   ├── AppUpdater.kt          In-app GitHub Releases updater
│   │   └── BackgroundUpdater.kt   Background update check (JobScheduler) and install notification
│   ├── assets/
│   │   ├── index.html             The page and its styles
│   │   ├── player-app.js          App glue: insets, tab swipe, back handling, dialogs
│   │   ├── audio-player.js        Queue, engines, library, feature framework
│   │   ├── spotify-ui.js          Home / Songs / Now playing / Download tabs
│   │   ├── song-download.js       Download wizard
│   │   ├── settings-menu.js       Settings drawer: swipe gesture and switches
│   │   ├── song-search.js         Search tab: matching, ranking, results
│   │   ├── song-memory.js         downloads.txt / favorites.txt / recents.txt, duplicate links and names
│   │   ├── app-update.js          Update bar and switch
│   │   ├── settings-file.js       Mirrors settings to settings.txt
│   │   ├── moon-phase.js, moon-theme.js   Moon-phase badge and theme
│   │   ├── version.js             APP_VERSION
│   │   └── fonts/
│   ├── res/                       Icons, colours, themes
│   └── AndroidManifest.xml
├── tests/                         Node and JVM tests
├── .github/workflows/build-apk.yml
├── Agent.md                       Developer / AI-assistant notes
└── README.md
```

For design decisions, the audio feature framework and the structure change log, see [Agent.md](Agent.md).

---

## Building

Builds run on **GitHub Actions** (`.github/workflows/build-apk.yml`). A push builds when:

1. you run the workflow by hand from the **Actions** tab, **or**
2. a commit message contains a version number like `v1.00.01`.

Example: `v1.00.01: fix crossfade`. Other commits are skipped, so no APK is built. A successful signed build publishes a GitHub Release with `moonlight-vX.Y.Z.apk`, which is what the in-app updater reads.

### Signing

Android only lets an APK update an installed app if both are signed with the **same key**. Add four secrets in **Settings → Secrets and variables → Actions**:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Without them the build falls back to the debug key and **publishes no Release**. Never commit a keystore.

---

## Setting up the repo (once)

1. Create the repo. The updater expects `Chirag-S-Reddy/Moonlight`; if you name it differently, change `OWNER_REPO` in `AppUpdater.kt`.
2. Copy the *contents* of the `moonlight/` folder into the repo root and push. **Use `git add -A`.**
3. Add the four signing secrets (see above).
4. Push with a version number in the commit message, or run the workflow manually.

---

## Testing

Run each test from the project root:

```bash
node tests/<name>.test.js
```

The tests cover the audio player, startup and playlist playback, the Spotify-style tabs, home screen and covers, the song-download wizard, the updater, the page's bridge contract (`player-app.test.js`) and Kotlin pure-logic checks on the JVM (`tests/jvm/`). They cannot test real audio or the Android side.

---

## Version numbering

Format: `vMAJOR.MID.MINOR`, kept in one place: `APP_VERSION` in `app/src/main/assets/version.js`.

| Part | Changes when |
| --- | --- |
| MAJOR | You decide |
| MID | A new feature, or after 99 minor fixes (MINOR resets to `00`) |
| MINOR | Each small bug fix |

Failed or redone builds never change the version. This is separate from Android's `versionCode`, which follows the GitHub Actions run number.

---

## Known limitations

- The playback-speed control and per-track resume-at-position were removed. Playback is always 1× and each track starts from 0.
- The native crossfade, loudness boost and Bluetooth auto-start code were written without being run on a device, so test them on your phone.
- The music folder is fixed at `Novel/Audio` (no folder picker yet).
- Downloads depend on yt-dlp working with the site; sites change, and updates to yt-dlp may be needed.
- Some leftover CSS from the Novel Reader app is still in `index.html` (harmless).
- The launcher icon is still the reader's.

---

## Credits

Built with [Media3 / ExoPlayer](https://developer.android.com/media/media3), [youtubedl-android](https://github.com/JunkFood02/youtubedl-android) (yt-dlp, ffmpeg) and the Lora, Newsreader, Manrope and Atkinson typefaces.

## If a download says "Sign in to confirm you're not a bot"

That is YouTube's own bot check, not a bug in the app, and it comes and goes with your network. The app keeps its bundled
yt-dlp on the **nightly** channel (checked before the first download of each run, at most every 6 hours, and once more after a
failed download), then retries with player clients that need no sign-in token. If it still fails:

1. In the Download tab, tap **Sign in** next to "YouTube: not signed in" (it also appears under the error). Sign in on
   Google's own page; the app then saves the login cookies in its private storage (no other app can read them) and uses
   them for every download. Cookies expire eventually: sign out and in again. If Google refuses the sign-in inside the app,
   use option 3.
2. Change network (Wi-Fi <-> mobile data) and turn any VPN off. Blocks are mostly about the IP address.
3. Or put a `cookies.txt` exported from your own browser into `/storage/emulated/0/Moonlight/` (Netscape format, for example
   with a "cookies.txt" browser extension, exported while logged in to YouTube). The app uses a copy for each download and
   never changes your file. The in-app sign-in is used first when both exist.

Cookies give access to that YouTube login: the in-app sign-in keeps them private, but a `cookies.txt` in `Moonlight` is readable by other apps with file access. YouTube can also flag accounts
that download heavily, so a spare account is the safer choice.
