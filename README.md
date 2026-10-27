# Moonlight

A music player for Android with a Spotify-style look and a moon-and-stars theme. It was the music panel of the Novel Reader
app; this is the same player as an app of its own.

## What it does

- Plays your music from `/storage/emulated/0/Novel/Audio` (mp3, m4a/aac, flac, ogg, opus, wav). Each sub-folder is a playlist.
- Four tabs: **Home**, **Songs**, **Now playing**, **Download** (swipe sideways, or use the bar at the bottom).
- Background playback with notification and lock-screen controls, Bluetooth/headset buttons, audio focus.
- Shuffle, repeat, a visible queue, likes, curated playlists, recently played, A-B repeat, sleep timer.
- Crossfade (1-12 s) and volume normalisation from ReplayGain tags.
- Download songs from a link (yt-dlp is bundled) and file them into playlists.
- Remembers the last song; can start by itself when Bluetooth audio connects.

## Installing

1. In the repo, open **Actions**, pick the newest green run and download the `moonlight-release-apk` artifact,
   or (later builds) open **Releases** and download `moonlight-vX.Y.Z.apk`.
2. Install it; allow storage access when asked ("all files access" on Android 11+), and notifications on Android 13+.
3. Put music in `Novel/Audio` (created on first launch). Open the app, tap **Scan the sky** on Home if it is not picked up.

## Updating

From v1.00.00 the app checks this repo's GitHub Releases when it starts (at most every 6 hours). If there is a newer version
it downloads it on Wi-Fi and a bar at the bottom of **Home** offers **Install**. Tap the version number at the bottom of Home to
check right now; the bar has an **Update automatically** switch. Android asks you to confirm the install (and, the first time, to
allow *Install unknown apps* for Moonlight).

## Your settings

Saved in `/storage/emulated/0/Moonlight/settings.txt` (`audio.*` lines), a plain text file you can edit while the app is closed.
Moving from the reader app: copy its `audio.*` lines from `Novel/settings.txt` into this file.

## Setting up this repo (once)

1. Create the repo (the updater expects `Chirag-S-Reddy/Moonlight`; if you name it differently, change `OWNER_REPO` in
   `AppUpdater.kt`).
2. Copy the contents of the `moonlight/` folder into the repo root and push. **Use `git add -A`.**
3. Add the four signing secrets (repo Settings -> Secrets and variables -> Actions): `ANDROID_KEYSTORE_BASE64`,
   `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. The reader app's keystore can be reused.
4. A push builds when a commit message contains a version like `v1.00.00`; or run the workflow by hand from the Actions tab.

## Building and tests

CI does the build (see `.github/workflows/build-apk.yml`). Tests: `node tests/<name>.test.js` for each file in `tests/`.

For developers and AI assistants: see [Agent.md](Agent.md).
