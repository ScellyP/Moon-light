# Agent.md — Developer / AI Notes

This file is for AI agents and developers working on **Moonlight**, the music player that was carved out of the
Novel Reader app (the "Spotify mimic" part). User/install/usage docs are in [README.md](README.md).

## Where this came from

Until v1.15.01 the music player lived inside the reader app (`Chirag-S-Reddy/Reader-Android`) as a panel opened over the
chapters. It is now its own app, in its own repo, with its own `applicationId` (`com.scell.moonlight`) and its own
signed APKs and updates. **The reader app still contains its copy of the player until the owner removes it there; the two
do not share code, only the music folder.**

## Project map

- `app/src/main/assets/index.html` — the page: the music panel (`#audio-panel`, always open, fills the screen) plus the
  Lamplight/moon CSS inherited from the reader (many rules there match nothing now; harmless, a cleanup candidate).
- `app/src/main/assets/player-app.js` — **new glue**, replaces what `reader.js` did for the panel: `NovelAudio.init()`,
  the inset variables (`onStatusBarInset` / `onNavBarInset`), the sideways tab swipe, `window.handleBack`
  (dialog → "..." sheet → back to Home → leave), the message dialog and `window.onFolderPickError`.
- `app/src/main/assets/audio-player.js` — queue, engines (WebView `<audio>` + native Media3), library, audio feature framework.
- `app/src/main/assets/spotify-ui.js` — the four tabs (Home / Songs / Now playing / Download), mini player, "..." sheet, cover tint.
- `app/src/main/assets/song-download.js` + `SongDownloader.kt` — the Download tab (bundled yt-dlp + ffmpeg).
- `app/src/main/assets/moon-phase.js` + `moon-theme.js` — the moon badge on Home. `moon-phase.js` is just the two maths
  functions copied out of the reader's `moon-lock.js` (the night lock itself is not part of this app).
- `app/src/main/assets/settings-file.js` — mirrors the audio settings to `/storage/emulated/0/Moonlight/settings.txt`.
- `app/src/main/assets/app-update.js` + `AppUpdater.kt` — in-app updates from this repo's GitHub Releases.
- `app/src/main/assets/version.js` — `APP_VERSION`.
- `app/src/main/java/com/scell/moonlight/MainActivity.kt` — Android host: WebView, storage + notification permissions,
  `connectNativePlayer()`, the bridge, `runAudioScan()`, `serveAudio()`. Music folder `Novel/Audio` (`audioRoot`, kept so the
  existing library works), own folder `Moonlight/` (`playerRoot`, settings only).
- `PlaybackService.kt`, `NativeCrossfade.kt`, `NativeAudioEffects.kt`, `ReplayGainReader.kt`, `Id3Title.kt`, `SongNames.kt` — unchanged
  from the reader app apart from the package name.
- `tests/` — `node tests/<name>.test.js`; `player-app.test.js` guards the carve-out (nothing of the reader left, page and
  `MainActivity` agree on every bridge/callback name).

## What was removed from the reader's code, and why

Done mechanically from the reader app at v1.15.01 (see the Structure change log). Left out on purpose:
`reader.js`, `chapter-swipe.js`, `color-wheel.js`, `peek-mode.js`, `moon-lock.js` / `moon-puzzles.js` / `shatter-glass.js`
(the night lock and its puzzles), `ChapterTools.kt` + `assets/scripts/*.py` (Termux chapter tools), `AdaptiveBrightness.kt`,
`MoonUnlockStore.kt`, and from `MainActivity.kt` everything about novels (`listNovels`, `loadNovelChapters`, covers), the
moon unlock bridge, the night-lock timer, the volume-key *scrolling* (the volume keys now always change the media volume),
`setThemeColors`, `setMenuOpen`, `setAdaptiveBrightness`. The Termux permission and `queries` entry are gone from the manifest.

**Open question for the owner:** the reader's Moonlit Lock (12 AM–6 AM) also paused the music at night. It is *not*
carried over. Say if the player should have its own night rule.

## Version number

> **For any AI assistant / future chat working on this project:** bumping
> the version is part of every bug fix or feature. Do it automatically in
> the same change, without being asked, and state the new version in your
> reply.

The current version is shown at the bottom of the side menu (e.g. `v1.00.00`).
It lives in one place only: `APP_VERSION` in `app/src/main/assets/version.js`,
and you change it by hand — nothing bumps it automatically.

Format: `v MAJOR . MID . MINOR`

| Part | When it changes |
| --- | --- |
| **MAJOR** (the `1`) | Stays the same until *you* decide to change it |
| **MID** (middle) | +1 for a major update (e.g. a new feature), **or** when minor bug fixes pass 99. MINOR resets to `00` |
| **MINOR** (last) | +1 for every minor bug fix |

Examples: `v1.00.00` first tracked version → `v1.00.01` one small fix →
`v1.01.00` a new feature → `v1.01.99` then one more fix rolls over to
`v1.02.00`.

**Broken builds never change the version.** If a build fails or has to be
redone, the number stays as it is; only a real shipped fix or feature bumps
it. This is separate from Android's `versionCode`/`versionName` in
`app/build.gradle`, which follows the GitHub Actions run number so each APK
installs over the last one.

Start of this app's own numbering: `v1.00.00`.

## Build trigger (GitHub Actions)

`.github/workflows/build-apk.yml` has two jobs. `check` runs on every push to
`main`/`master` and decides; `build` only runs when `check` outputs
`should_build=true`. A push builds when **either** holds:

1. it is a manual run (`workflow_dispatch`), or
2. a version number matching `v<digits>.<digits>.<digits>` appears in any pushed
   commit message (e.g. `v1.04.02: fix volume keys`).

Nothing else builds: there is no `[build]` / `[skip build]` switch and tags do not
trigger it (GitHub's own `[skip ci]` still skips the whole workflow). Commit
messages are passed to the script through environment variables, never
interpolated into the shell, so keep it that way. `versionCode` is
`GITHUB_RUN_NUMBER`; skipped pushes use up numbers, which only leaves gaps.

When you give the owner a change, suggest a commit message that starts with the
new `APP_VERSION` number (e.g. `v1.04.02`) so the push builds; for docs-only or
CI-only changes, suggest a message without a version number.

## Auto-updater (in-app updates from GitHub Releases)

**Status: copied from the reader app (where it is written but not yet run on a device). Same code, repo name changed.**

**Goal:** the app finds out by itself that a newer build exists on GitHub, downloads it, and installs it over
the running copy, without the owner going to the Actions tab and hunting for an artifact.

**Why GitHub Releases and not Actions artifacts:** an Actions artifact needs a logged-in GitHub session to
download, so an app cannot fetch it. A Release asset has a public URL, and `api.github.com/repos/<owner>/<repo>/releases/latest`
answers without a token (the repo is public). So the workflow has to *publish a Release* for every real build.

### How it fits together

```
push with vX.Y.Z in the commit message
  -> build-apk.yml (check -> build) builds the signed release APK
  -> new last step "Publish GitHub Release": tag = APP_VERSION from version.js, asset = moonlight-vX.Y.Z.apk
       (only when the real signing key was used, see "Decisions" below)

app (AppUpdater.kt, on a worker thread)
  check     GET releases/latest -> tag_name + the .apk asset (url, size, sha256 digest if given)
            newer than the installed APP_VERSION?  (numeric compare of MAJOR.MID.MINOR, never string compare)
  download  asset -> cacheDir/updates/<name>.part -> checked (size, and sha256 when GitHub gives one) -> .apk
  install   PackageInstaller session (no FileProvider needed) -> Android's own confirm screen
page (app-update.js)  shows a bar in the side menu: available / downloading % / ready / failed, plus the
                      "Update automatically" switch
```

### Contract between page and native

- Bridge (all in `MainActivity.kt`'s `AndroidBridge`, each a one-line forward to `appUpdater`):
  `checkForUpdate()` (a manual check: always answers, even "up to date"), `downloadUpdate()`, `installUpdate()`,
  `updateState(): String` (latest state JSON, `""` before the first), `getAutoUpdate(): Boolean`, `setAutoUpdate(on)`.
- Native -> page: `window.onUpdateState(json)`, `json = {"status","current","version","percent","message","manual"}`;
  `status` is one of `checking | uptodate | available | downloading | ready | needpermission | installing | failed`.
  `current` = installed version, `version` = the newer one (empty unless one exists), `percent` 0-100 while downloading.
- Auto behaviour (when `getAutoUpdate()` is on, default on): a check at app start at most every 6 h; if a newer
  build exists it is downloaded in the background **only on an unmetered network** (the APK is large because of the
  bundled yt-dlp/ffmpeg); the install itself always needs one tap, because Android requires the user to confirm
  an install made by a normal app (Android 12+ may skip the confirm screen for later updates, we ask for that with
  `USER_ACTION_NOT_REQUIRED` but cannot rely on it).
- Never installs while music plays or a song/chapter job is running: the page only offers "Install" and the
  owner decides; `isBusy()` (checking/downloading/installing) also keeps `closeRunnable` from closing the app.
- "Install unknown apps" must be allowed for this app once (`canRequestPackageInstalls()`); if not, status
  `needpermission` and `installUpdate()` opens the system settings page for it; coming back continues the install.

### Decisions and reasons

- **Compare by `APP_VERSION` (`vMAJOR.MID.MINOR`), not by `versionCode`.** That number is the one the owner sees and
  it already lives in one place (`version.js`); native code reads it from the asset, so there is no second copy to forget.
  Consequence: a *redone* build with the same number is not offered as an update (the version rules already say a
  redone build keeps its number). To force one, bump the minor number.
- **Release tag = `APP_VERSION`.** A redone build of the same version updates the existing release's asset
  (`gh release upload --clobber`) instead of failing on a duplicate tag.
- **Only publish a Release when the build was signed with the real key.** Android refuses an update signed with a
  different key; a debug-signed Release would be offered to every phone and then fail to install.
- **PackageInstaller instead of an `ACTION_VIEW` intent + FileProvider.** No extra manifest provider or xml file,
  works with the same permission, and reports success/failure back to us.
- **Plain `HttpURLConnection`, no new library.** Two GET requests do not justify a dependency (and every new
  library has cost a build in this project before: see the media3 note in `app/build.gradle`).
- **Release APK only** (not the debug one): it is what the owner installs, and `minifyEnabled` keeps it smaller.

## Signing

Same four GitHub secrets as the reader app (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`), set in **this** repo's Settings → Secrets and variables → Actions. The same keystore may be reused:
the apps have different `applicationId`s, so they do not conflict. Without the secrets the build falls back to the debug
key and **publishes no Release** (such an APK could not update anything).

## Audio player architecture (inherited from the reader app)

> **NOTE (carved-out app):** this section was written in the reader app. Rows that mention `reader.js`, the chapter
> switcher, the library ("Switch novel") or reading breaks describe reader-only behaviour that does **not exist here**.
> The player itself (engines, queue, library, Home, Download, crossfade, replay gain) is unchanged.
>
> **NOTE:** the feature list below was **proposed, not specified.** This
> README originally said only "music player removed entirely" and
> contained no feature list, so this is a starting point to be edited
> rather than a requirement that came from anywhere. Change it freely.

The goal is a hybrid: **VLC's playback reliability with Spotify's user
experience.** Two playback engines share one UI/queue: a WebView `<audio>`
element (works everywhere, including outside the Android app) and a real
ExoPlayer instance running in a Media3 foreground service (true background
playback, lock-screen/notification controls). The app starts on the
former and switches to the latter automatically the moment it's ready —
mid-playback, at the same position, inaudibly. See `audio-player.js`'s
top-of-file comment for the architecture, and `PlaybackService.kt` /
`MainActivity.kt`'s `connectNativePlayer()` for the native half.

### Audio player feature status

**From VLC — playback that just works**

| Feature | Status |
| --- | --- |
| Broad format support (mp3, m4a/aac, flac, ogg, opus, wav) | **Working** |
| Near-gapless playback (next track pre-buffered) | **Working**¹ |
| Playback speed with pitch preservation | Removed — the speed control is gone; playback is always 1× |
| Volume normalisation (replay gain) | **Working**⁴ — off / track / album, from the ReplayGain tags in your files |
| Resume-at-position per track | Removed — every track starts at 0 (only a live engine hand-off keeps its position) |
| Remember the last song | **Working**⁶ — saved as `lastTrackId` in the audio prefs (so in `settings.txt`) every time a track starts; the next launch's first scan (`MediaLibrary.onScanned`) makes it the current song, not started, from 0. Dropped back to "All songs" if it is outside the saved playlist; ignored if the file is gone |
| Start by itself over Bluetooth | **Working**⁶ — `StartupPlayback` in `audio-player.js` waits for the first library scan *and* the native player, then, if `AndroidBridge.isBluetoothAudioConnected()` is true, plays the current song (or the first in the queue). Once per page load; skipped for an empty library or if something is already playing |
| A-B repeat | **Working** — A / B buttons under the seek bar |
| Graceful handling of unplayable files (skip, don't stall) | **Working** |

**From Spotify — how it feels to use**

| Feature | Status |
| --- | --- |
| Library scan (native folder scan + tags) | **Working** |
| Playlists via folders (a subfolder in Audio/ = a playlist) | **Working** |
| Curated playlists (hand-picked, not tied to a folder) | **Working** — "New playlist" in the Library, plus add-to-playlist |
| Visible "up next" queue | **Working** |
| Shuffle (real Fisher-Yates) + repeat (off / all / one) | **Working** — tapping shuffle (either shuffle button) while nothing plays turns it on *and* starts a random song (`setShuffle(true, false)` so a paused/remembered song is not pinned first); while playing it only reshuffles; turning it off never starts anything |
| Shuffle rounds (v1.00.01) | **Working** — shuffle plays every song once per "round" before any repeats. `PlaybackQueue` keeps `[songs played this round] + [unplayed, shuffled]`; the played list (short hashes of the song ids, per playlist) is kept in its own localStorage key `moonlight_shuffleRound`, deliberately NOT in the audio prefs: those are mirrored to settings.txt and `settings-file.js` rejects a `features` blob over 8192 characters. A small `shuffleRound` feature module only forwards `trackStart` to `PlaybackQueue.noteStarted`. A shuffled launch does not restore the last song (it picks an unplayed one, ready not started). Repeat all starts a fresh random round whose first song is not the one that just ended (`_pendingRound`, so preload and advance agree). Picking a song ahead moves it to "next" so skipped songs stay in the round. `tests/shuffle-round.test.js` |
| Double-tap to like | **Working** — `reader.js` (touchend handler): two taps within 280 ms and 48 px in the middle 40% × 40% of the reading pane call `NovelAudio.likeCurrent()` (add-only) and show the `#like-pop` heart. The first tap there is held back 280 ms so the double tap doesn't also scroll the page; this delay applies only while a song is current (`hasCurrentTrack()`). **The gesture wiring in `reader.js` is not covered by a test** (only the player half is); try it on a device |
| Swipe up on the chapter switcher | **Working** — `chapter-swipe.js` (attached by `reader.js`, loaded before it): listens on the whole document; a touch that starts on `#bottom-nav` (the Previous / Next bar), or within 16 px of it, and travels up at least 30 px steeper than 50° from horizontal opens the music panel, but only while no menu is open. Judged from the last position seen, so it still works when the browser takes over the drag and cancels the touch. Covered by `tests/chapter-swipe.test.js`; the wiring in `reader.js` is not, so try it on a device |
| Swipe up on the library ("Switch novel" screen) | **Working** — the same `chapter-swipe.js`, attached a second time by `reader.js` to `#novel-picker-player-hint`, a transparent handle fixed to the bottom of the library (it only shows while the library is open). A swipe up that starts on it, or within 16 px, opens the music panel *on top of* the library: while the library is open `body.picker-open` lifts `#audio-panel` above it (z 160 vs 150). Back, the ✕ or the ✕ or Back closes the player and returns to the library (`handleBack` closes the panel before the library; a sideways swipe no longer closes it, it switches tabs). Both swipe-up openings (this one and the chapter bar) make the panel rise from the bottom: `reader.js` `setAudioEntrance(true)` adds `.from-bottom` (translateY instead of the usual translateX from the right) while the panel is still hidden; the 🎧 buttons remove it so they still slide in from the right. The chapter-bar swipe is switched off while the library is open so the two never both fire. **The wiring in `reader.js` is not covered by a test**; try it on a device |
| Now-playing bar with artwork, seek scrubber | **Working** |
| Crossfade between tracks | **Working**⁵ — 🎧 panel → Crossfade slider, 1–12 s (native engine: built, see footnote) |
| Recently played / liked tracks | **Working** — heart button on the now-playing card; "Recently played" and "Liked" in the Library |

**Reader-specific / background playback**

| Feature | Status |
| --- | --- |
| Sleep timer (fixed minutes, or end-of-track), with a fade-out | **Working** |
| Auto-pause when a reading-break reminder appears, and resume on dismiss | **Working** |
| True background playback (screen off, app switched away) | **Working** |
| System media notification (artwork, title/artist, play/pause) | **Working** |
| Notification Next/Previous buttons | **Working**³ |
| Lock-screen transport controls, Bluetooth/headset buttons | **Working** |
| Audio-focus handling (ducks/pauses for calls, other apps) | **Working** |
| Pauses automatically when headphones/Bluetooth disconnect | **Working** |

Audio files are expected in `/storage/emulated/0/Novel/Audio` (created
automatically on first scan if it doesn't exist). Tap 🎧 → "Scan the sky" to load it.

**Playlists** are just subfolders of `Audio/` — no separate playlist
file or in-app "create playlist" step. A folder's name becomes the
playlist name shown in the picker, and every audio file inside it
(nested subfolders included) belongs to that playlist:

```text
Novel/Audio/
  Lo-fi Focus/2AM.mp3        -> playlist "Lo-fi Focus"
  Lo-fi Focus/Rain.mp3       -> playlist "Lo-fi Focus"
  Podcasts/Ep1/part1.mp3     -> playlist "Podcasts" (still one level of
                                 grouping — a folder inside a playlist
                                 folder doesn't create a nested playlist)
  standalone-track.mp3       -> not in a playlist
```

The 🎧 panel's "Playlist" dropdown (hidden entirely when your library
has no subfolders, so it isn't clutter for a flat collection) switches
between "All songs" and each folder found — picking one rebuilds the
queue from just those tracks, so shuffle, repeat, and next/previous all
stay within it. A file sitting directly in `Audio/` (not in any
subfolder) still plays fine under "All songs", it just has no playlist
of its own to filter down to. While viewing "All songs" with more than
one playlist present, each row in the queue shows a small tag (shown in
capitals) naming which playlist it came from.

¹ "Near"-gapless: the next track's file is pre-buffered while the
current one plays, which removes the network/disk delay that causes
most audible gaps, but the transition is still a normal src-swap rather
than a sample-accurate crossfade-capable handoff.

² The native engine turns quiet tracks up with Android's `LoudnessEnhancer` on
ExoPlayer's audio session (`NativeAudioEffects.kt`); the WebView engine can
only turn a track down. **That native half was written without being compiled
or run** — test it on a device before relying on it.

³ ExoPlayer only ever holds one track at a time (JS owns the queue —
see `audio-player.js`'s architecture note), so it normally has no
"next item" to report and the standard notification omits those
buttons entirely. `PlaybackService.kt`'s `QueueAwarePlayer` — a
`ForwardingPlayer` that always reports Next/Previous as available and
routes taps back into the JS queue — is what makes them show up and
work despite that.

⁴ **Volume normalisation.** 🎧 panel → **Normalise**: Off / Track / Album. It
reads the ReplayGain tags already in your files (it does not analyse audio):
MP3/AAC with ID3v2 (`TXXX`) or APEv2 tags, FLAC and Ogg Vorbis/Opus comments
(Opus `R128_*_GAIN` too), and iTunes-style M4A atoms. The number next to the
selector is what is being applied to the current track; "no tag" means the file
has none and plays unchanged. Louder-than-normal tracks are turned down; a
quieter track is turned *up* only by the background (native) player, and never
past the point where its tagged peak would clip. Tag your files with a tool such
as foobar2000, MP3Gain, rsgain or beets. Tags are read when you tap **Rescan**.
`tests/replaygain.test.js` checks the gain maths; `tests/replaygain-reader/run.sh`
checks the tag reader against real files made with ffmpeg.

⁵ **Crossfade.** 🎧 panel → **Crossfade** slider: Off, or 1–12 s. The end of a
track overlaps the start of the next on an equal-power curve (loudness stays
steady through the overlap), and each track keeps its own replay-gain level. It
is skipped for repeat-one, the "stop at end of track" sleep mode, an A-B loop,
or a timed sleep that ends inside the overlap; a track shorter than twice the
setting crossfades over half its length. Pausing, seeking or choosing another
track ends the overlap at once. WebView engine: a second `<audio>` element and
two timed volume ramps. Native engine: a second ExoPlayer in `PlaybackService`
(`NativeCrossfade.kt`) that takes over the media session the moment the overlap
starts, sharing the audio session so the loudness boost covers both players. **The
Kotlin half was written without being compiled or run** — test it on a device
before relying on it.
`tests/crossfade.test.js` checks the JS side.

⁶ `isBluetoothAudioConnected()` (MainActivity.kt) looks for a Bluetooth music output in
`AudioManager.getDevices()` (A2DP, hearing aid, BLE headset/speaker; not the phone-call SCO link),
which needs no permission. **That Kotlin half was written without being compiled or run** — test
it on a device with a real Bluetooth device before relying on it.

## Audio feature framework

The optional audio features all hang off one small framework in
`audio-player.js` (section **7b. AUDIO FEATURES FRAMEWORK**), so adding or
finishing one doesn't mean threading changes through both engines.

**How it works.** The engines and queue stay feature-agnostic; they only
announce what happened, and feature *modules* react. Each module is a plain
object passed to `AudioFeatures.register()`:

```js
{
  id: 'abRepeat', label: 'A-B repeat', status: 'logic-ready',
  defaults: { a: null, b: null },   // per-feature state -> state.features[id]
  persistKeys: [],                  // optional; omit = save all, [] = save none
  trackStart(track) {}  trackEnd(track) {}  progress({positionSec, durationSec}) {}
  engineChanged(engine) {}  libraryChanged() {}
  outputGain(track) {}              // linear multiplier <= 1, folded into gain()
}
```

Every hook is optional and wrapped in try/catch, so a broken feature can
never stall playback. Per-feature state is saved inside the existing audio
prefs blob (so it is mirrored to `settings.txt` for free) and restored by
`Prefs.load()`; restore only accepts keys the module declares, with the same
type as the default. Modules are reachable as `NovelAudio.features.<id>`, and
`NovelAudio.features.describe()` lists them with their status.

**Where the hooks fire** (all one-liners in the core): `trackStart` — in each
engine's `play()` when a new track loads; `progress` — the WebView
`timeupdate` event (~4 Hz) and the native progress callback (~2 Hz, every 500 ms);
`trackEnd` — `handleTrackEnded()`; `engineChanged` — `_switchToNative()`;
`libraryChanged` — after a scan.

**Status vocabulary** — `working` (behaviour + UI), `logic-ready` (works
through the JS API, no control yet), `framework` (plumbing in place, needs
data or native support), `stub` (stores a value, nothing consumes it),
`planned` (hook exists, behaviour not written).

| Module (`NovelAudio.features.…`) | Status | What exists | Next step |
| --- | --- | --- | --- |
| `abRepeat` | working | `setA()`, `setB()`, `clear()`, `get()`; loops via `AudioEngine.seek()`; cleared on every new track; never persisted. Loop can overshoot B by up to ~0.5 s (progress rate) | A/B buttons are in place under the seek bar. Possible later: a marker on the seek bar. Frame-accurate looping would need a native `ClippingMediaSource` |
| `replayGain` | working | `setMode('off'/'track'/'album')`, `describe(track)` for the UI. Cuts go through `gain()`; boosts go to the native `LoudnessEnhancer`; honours the track/album peak so it never clips. Tags are read natively by `ReplayGainReader.kt` and added to each scanned track as `replayGainTrackDb` / `replayGainAlbumDb` / `replayGainPeak` / `replayGainAlbumPeak` | Test on a device (see footnote ⁴). Possible later: pre-amp for untagged tracks, an in-app scanner that computes gain for files with no tags |
| `crossfade` | working | `setSeconds()` (0–12, whole seconds), persisted; `curve(t)` = equal-power fade. When the track is within `seconds + 0.5 s` of its end it calls `AudioEngine.beginCrossfade(nextId, seconds)`; the engine returns `false` to be asked again next tick. On success the queue/state move to the next track immediately and the engine fades the old one out underneath. WebView: second `<audio>` + timed ramps. Native: second ExoPlayer (`NativeCrossfade.kt`) | Test the native half on a device (see footnote ⁵). Possible later: per-track fade-out points, a gapless (no-fade) mode |
| `history` | working | Newest-first, deduped, capped at 100, persisted; virtual playlist `@recent` | Done: "Recently played" appears in the Library |
| `likes` | working | `toggle(id?)`, `isLiked()`, `getIds()`; virtual playlist `@liked` | Done: heart button on the now-playing card |
| `customPlaylists` | working | `create/remove/addTracks/removeTrack/list`; virtual playlist `@list:<id>` | Done: "New playlist" editor and picker entries. Possible later: drag to reorder |
| `nativeEffects` | framework | Pushes the replay-gain boost to the native side on engine switch and track start | Verify on a device (see footnote ²) |

**Virtual playlists.** `state.activePlaylist` may be `'all'`, a folder name,
or `'@recent'`, `'@liked'`, `'@list:<id>'`. `MediaLibrary.currentSelectionIds()`
resolves the virtual ones through `AudioFeatures.selectionFor()`, dropping any
track no longer in the library, so shuffle/repeat/next/previous work on them
unchanged.

**Native bridge added for this** (Kotlin side in `NativeAudioEffects.kt`,
created and released by `PlaybackService`): `nativeAudioSetBoostDb(db)`.
`NativeAudioEffects` keeps the last boost and re-applies it if the audio
session changes or the service restarts.

**Native bridge for crossfade:** `nativeAudioCrossfade(path, title, artist, album,
seconds, outGain, inGain)` always ends with the new track playing (it just switches
if it cannot overlap) and starts playback itself. `PlaybackService.crossfade`
(`NativeCrossfade`) owns two ExoPlayers that share one audio session; only the
active one handles audio focus and sits in the `MediaSession`. During an overlap
`nativeAudioSetVolume` only updates the incoming track's target level. The progress
poll in `MainActivity` runs every 500 ms (it was 1000 ms) so the trigger is timely.

**Adding a feature:** register a module (copy `likes` for plain data, or
`abRepeat` for something that reacts to playback), list it in the table above
with an honest status, and add checks to `tests/audio-features.test.js`.

**Crossfade checks.** `tests/crossfade.test.js` covers the trigger rules, the equal-power curve, the WebView engine's two-element ramp (with a fake clock), the native bridge call, and the guards against stale progress/ended reports from the old track. Run it from the project root: `node tests/crossfade.test.js`.

**Tests.** `tests/audio-features.test.js` loads `audio-player.js` under Node
with stubbed browser globals and checks the framework (registry, persistence,
A-B loop, replay-gain maths, virtual playlists, crossfade trigger). Run it from the project root: `node tests/audio-features.test.js`.
It cannot exercise the Kotlin side or real audio.

**Colour wheel.** The Page and Text colour swatches in the Reading panel open a
colour wheel (`color-wheel.js`: hue/saturation wheel, brightness slider, hex field)
instead of the system colour dialog. The native colour inputs stay in the page as
the source of truth, so saving, recent colours and presets work as before.

## Packaging rule for generated packages

Every zip generated for this app has **one top-level folder named `moonlight`** with the whole project inside it (`app/`,
`.github/`, `README.md`, ...). When uploading to GitHub, copy the *contents* of `moonlight/` into the repo root so that
`app/src/main/assets/index.html` and `.github/workflows/` sit at the top level. (The reader app's own rule names its folder
`novelreader`; that rule is for that project.)

## To be done

Nothing requested yet for this app. Ideas that came up while carving it out, **not started**: remove the unused reader CSS from
`index.html`; a picker for the music folder instead of the fixed `Novel/Audio`; a distinct launcher icon (it is still the
reader's); a night rule (see the open question above).

## Structure change log

- **v1.00.02 — Speed pass.** `MediaLibrary.getTrack` is now an indexed Map look-up (it was a linear search, and `AudioUI.render()` called it once per queued song, so every render was O(songs squared): 20 renders of a 5000-song library took ~3.7 s, now ~60 ms). CSS: `content-visibility: auto` on song rows, entrance animations only on the first rows, `.sky` star layers contained, the five `#audio-panel:has(#audio-play-btn.is-playing)` selectors replaced by the `.sp-playing` class that `spotify-ui.js` already sets, the Home mini progress bar moved to `transform: scaleX()`. Shuffle round storage moved out of the prefs (see the shuffle row above). `tests/audio-harness.js` `launch()` takes `extraStore` to carry other localStorage keys between launches.

**Rule for every AI assistant / chat working here:** whenever you change the *structure* of the project (a new or removed file,
a renamed class, a new bridge method, a moved responsibility, a new workflow step, a changed contract between page and native),
add a line here in the same change: **date, what changed, and why**. Newest first. Behaviour-only fixes do not need a line.

- **v1.00.00 (2026-10-27) — Named Moonlight (before the first install).** The app was first called "Moon Player"; the owner chose
  **Moonlight**. Display name, package/`applicationId` `com.scell.moonlight` (can't be changed after release without becoming a different
  app, so it was changed now), data folder `/storage/emulated/0/Moonlight/`, repo name, APK/artifact names (`moonlight-vX.Y.Z.apk`) all follow.
- **v1.00.00 (2026-10-27) — Moonlight created from the reader app (v1.15.01).**
  - NEW app/repo, `applicationId` `com.scell.moonlight`, package `com.scell.moonlight`. *Why:* the owner asked for the Spotify-mimic
    part as a separate app in a different repo.
  - NEW `player-app.js`. *Why:* `reader.js` used to open the panel and call `NovelAudio.init()`; without it something has to.
  - NEW `moon-phase.js`. *Why:* `moon-theme.js` needs `NovelMoonLock.moonPhaseInfo`, which lived in `moon-lock.js` (the night lock, left behind).
  - NEW `MainActivity.kt` is the reader's with the novel/chapter/night-lock/moon-unlock/brightness parts cut out; new
    `onStorageReady()` and `ensureFolders()` replace `listNovels()` / `ensureNovelFolders()`. *Why:* storage access now only has to
    make the folders and start the music scan.
  - CHANGED settings file: `Moonlight/settings.txt` (was `Novel/settings.txt`), only `audio.*` lines. *Why:* two apps rewriting one
    file would overwrite each other's settings.
  - CHANGED updater: `OWNER_REPO` = this repo, files `moonlight-vX.Y.Z.apk`. *Why:* one Release feed per app.

## AI assistant instructions

- **Bump the version automatically** in the same change for every real bug fix or feature. State the new version in your reply.
  Follow `Agent.md#version-number`. Broken builds never change it.
- **Update `README.md`** for user-facing changes and **`Agent.md`** for internal ones.
- **Keep tests updated** (`tests/`). `player-app.test.js` must keep passing: it is what stops reader code creeping back in.
- **Log structure changes** with the reason in `Agent.md#structure-change-log`, same change.
- **Always `git add -A`** (a plain `git commit -am` leaves new files out, which has broken a build before).
- **Suggest a commit message** starting with the new version (e.g. `v1.00.01: fix crossfade`) so the push builds; docs/CI-only
  changes get a message without a version number.
- **Do not commit keystores.**
