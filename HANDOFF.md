# Moonlight Project — Daily Handoff & Session Summary
**Date:** November 19, 2026 (17:05 IST)  
**Current Version:** `v1.16.35`  
**Current Branch:** `Testing`  
**Remote Status:** Ahead by 1 commit (Ready for push pending user approval)

---

## 1. Executive Summary & Today's Accomplishments

Today's session completed both Priority 1 and Priority 2 tasks identified in the previous handoff:

### **v1.16.35 — Shared Playlist Source Links .txt File Import & System Share Sheet Receiver**
1. **Shared Playlist Source Links `.txt` File Import:**
   - **Feature:** Moonlight exports playlist source links into formatted text files (`# Moonlight playlist links`, `# name: <Name>`, and one `https://` link per song). Added direct file upload/import capability in the Downloads tab (`#dl-stage`).
   - **Implementation:**
     - Added an **"Import playlist .txt"** button (`.dl-secondary .dl-big`) alongside the "Click to paste" button.
     - Added a hidden HTML5 file picker `<input type="file" accept=".txt,text/plain">` activated when the button is tapped.
     - Implemented `parsePlaylistLinksText(text, fallbackTitle)` in `song-download.js`: extracts `# name:` as the playlist title, `# description:`, and all valid `https?://` URLs, deduplicating identical links while preserving track order.
     - Also enhanced `takeClipboardText` so pasting text that contains `# name:` or `# Moonlight playlist links` triggers this automatic playlist creation flow directly.
     - Implemented `startCustomPlaylistFlow(title, links)`: immediately opens the Spotify-style playlist confirmation hero card (`pl-confirm`) with track count, title, and "Download all" action, bypassing remote playlist resolving and saving directly into the destination playlist folder.
2. **HTML5 File Picker in WebView (`MainActivity.kt`):**
   - Configured `fileChooserLauncher` using `registerForActivityResult(ActivityResultContracts.StartActivityForResult())`.
   - Overrode `WebChromeClient.onShowFileChooser` to connect WebView `<input type="file">` elements to Android's system file picker, allowing `.txt` files to be selected and read via standard `FileReader`.
3. **System Share Sheet Receiver (Download via YouTube "Share" Button):**
   - **Manifest Intent Filter:** Configured `android.intent.action.SEND` with `mimeType="text/plain"` and `android:launchMode="singleTask"` for `MainActivity` in `AndroidManifest.xml`.
   - **Intent Handling:** Implemented `handleIncomingSendIntent` in `MainActivity.kt` (`onCreate` and `onNewIntent`). Extracted URLs from incoming shared text.
   - **Validation & Filtering:** Explicitly rejects `open.spotify.com` links with a user toast notification (`"Spotify links cannot be downloaded directly"`), while accepting valid media links (YouTube, SoundCloud, browser URLs).
   - **Frontend Routing:** Passed valid incoming links to WebView via `callPage("onIncomingShareLink", JSONObject.quote(url))`. If the app is starting cold, holds `pendingIncomingShareLink` until `onPageFinished`.
   - **Auto-Download Navigation:** In `song-download.js`, `root.onIncomingShareLink(url)` automatically switches to the Downloads tab (`SpotifyUI.setView('download')`) and immediately begins resolving and downloading the song or playlist.

---

## 2. Repository & Workspace State

| Repository | Path | Branch | Local Head | Remote Head | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Main Repo** | `S:\Projects\Moon-light` | `Testing` | `v1.16.35` | `847d8aa` | Clean, ahead by 1 commit |
| **Patches** | `S:\Projects\Moon-light-Patches` | — | Patch 18 | — | Up to date |

### Patches Created
- `18-txt-playlist-import-and-system-share-receiver.patch` (`v1.16.35`)

---

## 3. Key Files Modified Today

- `app/src/main/AndroidManifest.xml` — Added `android.intent.action.SEND` intent filter with `text/plain` and `singleTask`.
- `app/src/main/java/com/scell/moonlight/MainActivity.kt` — Added `onShowFileChooser`, `fileChooserLauncher`, `onNewIntent`, `handleIncomingSendIntent`, and `onIncomingShareLink` page call.
- `app/src/main/assets/song-download.js` — Added "Import playlist .txt" button, `parsePlaylistLinksText`, `startCustomPlaylistFlow`, and `root.onIncomingShareLink`.
- `app/src/main/assets/version.js` — Bumped to `v1.16.35`.
- `Agent.md` — Updated structure change log and implementation notes.
- `README.md` — Updated download features documentation and version badge.
- `tests/song-download.test.js` — Added test suites for playlist link text parsing, manifest/intent receiver wiring, and UI elements.

---

## 4. Test Verification Summary

All automated test suites pass 100%:
- `node tests/song-download.test.js` — **29 / 29 passed**
- `node tests/player-app.test.js` — **8 / 8 passed**
- `node tests/spotify-tabs.test.js` — **9 / 9 passed**
- `node tests/playlist-share.test.js` — **6 / 6 passed**
- `node tests/song-share.test.js` — **5 / 5 passed**
- `node tests/song-share-link.test.js` — **4 / 4 passed**

---

## 5. What Still Needs to Be Done (Pending & Next Steps)

### A. Immediate Verification on Device
1. **Share from YouTube:**
   - Open YouTube app or browser. Tap "Share" on any video.
   - Confirm **Moonlight** appears in the system share sheet.
   - Tap Moonlight: confirm Moonlight opens (or resumes), switches to the Downloads tab, and starts downloading.
2. **Import Playlist `.txt`:**
   - Tap "Import playlist .txt" on the Downloads tab.
   - Confirm Android system file picker opens.
   - Select a `.txt` playlist file (or paste links containing `# name: ...`).
   - Confirm the playlist confirmation card appears with title and songs, and "Download all" downloads into that playlist.

---

### B. Backlog & Future Enhancements (from `Agent.md`)

1. **Music Folder Picker:**
   - Currently, music locations are hardcoded to `/storage/emulated/0/Novel/Audio` and `/storage/emulated/0/Moonlight/Songs`.
   - Planned: Add a folder picker in Settings allowing users to choose custom music directories (e.g. SD card or `/Music/`).
2. **Clean Unused Reader CSS from `index.html`:**
   - `index.html` still contains legacy CSS remnants from the original Novel-reader app that are never used in Moonlight.
   - Planned: Trim unused CSS rules to reduce DOM/CSSOM parsing overhead and decrease `index.html` file size.
3. **Dedicated Moonlight Launcher Icon:**
   - The launcher icon is currently the reader app's icon.
   - Planned: Create a distinct Moonlight launcher icon (matching the new bold crescent moon design) for adaptive, round, and monochrome Android launchers.
4. **Playlist Picker & Editor Enhancements:**
   - **Liked Songs source chip:** quick-filter to pull tracks from Liked Songs when adding songs to a playlist.
   - **Multi-select in Add-songs picker:** allow checking multiple songs and adding them in batch instead of tapping one-by-one.
   - **Unavailable-song indicator:** distinct styling for songs in playlists whose underlying audio files have been deleted from storage.
5. **Night Rule / Sleep Mode:**
   - Night audio lock / wind-down timer integration that gradually fades out volume at scheduled bedtime hours.
