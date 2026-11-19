# Moonlight Project — Daily Handoff & Session Summary
**Date:** November 19, 2026 (17:35 IST)  
**Current Version:** `v1.16.36`  
**Current Branch:** `Testing`  
**Remote Status:** Ahead by 2 commits (Ready for push pending user approval)

---

## 1. Executive Summary & Today's Accomplishments

Today's session completed the shared playlist import, system share sheet receiver, and interactive duplicate confirmation prompts:

### **v1.16.36 — Interactive Duplicate Confirmation Before Moving Audio Files**
1. **Interactive Prompt for Duplicate Audio Clean-up:**
   - **Feature:** Previously, when library scans detected duplicate songs (matching title and artist, or identical source link), extra copies were silently and automatically moved in batch to `Moonlight/Duplicates`. The user requested an interactive confirmation prompt asking whether the song is a duplicate instead of moving them all automatically.
   - **User Interface (`#dupe-dialog-layer` in `index.html`):**
     - Designed a Spotify-themed modal dialog with dynamic colors (`dyn-colours`).
     - Shows a warning icon, track title, and artist.
     - Displays a comparison card contrasting the **Keep file** (original path) and the **Duplicate file** (path that would be moved).
     - Prompts: *"Is this song a duplicate? Extra files are moved to Moonlight/Duplicates (never deleted)."*
     - Provides action buttons:
       - **Keep both** (`#dupe-keep-btn`): Retains both files in the library without moving anything.
       - **Move duplicate** (`#dupe-move-btn`): Moves only the duplicate file to `Moonlight/Duplicates` and merges metadata.
       - **Keep all remaining** (`#dupe-keep-all-btn`): Closes the dialog and skips moving all remaining duplicate pairs.
       - **Move all remaining** (`#dupe-move-all-btn`): Moves all remaining detected duplicates in batch.
   - **Queue & Decision Architecture (`audio-player.js`):**
     - Replaced automatic batch moving in `MediaLibrary.removeDuplicates(opts)` with `promptDuplicates(pairs, onComplete)`.
     - Maintains duplicate queue state (`_dupeQueue`, `_dupeIndex`, `_dupeMovedCount`).
     - `_showCurrentDuplicate()` populates the UI with track details and location comparison.
     - `_handleDuplicateChoice(moveCurrent, moveAllRemaining)` manages per-pair vs batch moves, calls `AndroidBridge.songsMergeDuplicates` on `[{ keep, drop }]`, merges song library records via `mergeInto`, and advances the queue.
     - Exposed `promptDuplicates`, `isDuplicateDialogOpen`, and `closeDuplicateDialog` on `NovelAudio`.
   - **Back Press & Keyboard Dismissal (`player-app.js`):**
     - Updated Android system back-press handler (`window.handleBack`) and desktop `Escape` key listener to dismiss the duplicate dialog safely and retain remaining files.
   - **Automated Tests (`tests/duplicates-confirmation.test.js`):**
     - Dedicated test suite validating DOM structure, dynamic colors, queue stepping, per-song keep vs move decisions, bulk actions, and back/escape dismissal. (4/4 passing).

---

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
| **Main Repo** | `S:\Projects\Moon-light` | `Testing` | `v1.16.36` | `847d8aa` | Ready to commit |
| **Patches** | `S:\Projects\Moon-light-Patches` | — | Patch 19 | — | Up to date |

### Patches Created
- `18-txt-playlist-import-and-system-share-receiver.patch` (`v1.16.35`)
- `19-duplicate-confirmation-prompt.patch` (`v1.16.36`)

---

## 3. Key Files Modified Today

- `app/src/main/AndroidManifest.xml` — Added `android.intent.action.SEND` intent filter with `text/plain` and `singleTask`.
- `app/src/main/java/com/scell/moonlight/MainActivity.kt` — Added `onShowFileChooser`, `fileChooserLauncher`, `onNewIntent`, `handleIncomingSendIntent`, and `onIncomingShareLink` page call.
- `app/src/main/assets/song-download.js` — Added "Import playlist .txt" button, `parsePlaylistLinksText`, `startCustomPlaylistFlow`, and `root.onIncomingShareLink`.
- `app/src/main/assets/index.html` — Added `#dupe-dialog-layer` modal markup and Spotify-themed dynamic styling.
- `app/src/main/assets/audio-player.js` — Added interactive duplicate queue prompt, choice handlers, and dialog methods.
- `app/src/main/assets/player-app.js` — Updated back-press and Escape handlers to close the duplicate dialog and preserve files.
- `app/src/main/assets/version.js` — Bumped to `v1.16.36`.
- `Agent.md` — Updated structure change log and duplicate confirmation details.
- `README.md` — Updated duplicate clean-up description and version badge (`v1.16.36`).
- `tests/duplicates-confirmation.test.js` — New test suite for interactive duplicate confirmation (4/4 passed).
- `tests/song-download.test.js` — Added test suites for playlist link text parsing, manifest/intent receiver wiring, and UI elements.

---

## 4. Test Verification Summary

All 8 automated test suites pass 100%:
- `node tests/duplicates-confirmation.test.js` — **4 / 4 passed**
- `node tests/song-download.test.js` — **29 / 29 passed**
- `node tests/player-app.test.js` — **8 / 8 passed**
- `node tests/spotify-tabs.test.js` — **9 / 9 passed**
- `node tests/playlist-share.test.js` — **6 / 6 passed**
- `node tests/song-share.test.js` — **5 / 5 passed**
- `node tests/song-share-link.test.js` — **4 / 4 passed**
- `node tests/index-html.test.js` — **4 / 4 passed**

---

## 5. What Still Needs to Be Done (Pending & Next Steps)

### A. Immediate Verification on Device
1. **Interactive Duplicate Prompt:**
   - Place duplicate audio files in `/storage/emulated/0/Moonlight/Songs` or scan library with duplicates.
   - Confirm `#dupe-dialog-layer` opens showing both file paths.
   - Test "Keep both": verify neither file is moved.
   - Test "Move duplicate": verify extra copy is moved to `Moonlight/Duplicates`.
   - Test "Keep all remaining" and "Move all remaining".
   - Test back button dismissal.
2. **Share from YouTube:**
   - Open YouTube app or browser. Tap "Share" on any video.
   - Confirm **Moonlight** appears in the system share sheet.
   - Tap Moonlight: confirm Moonlight opens (or resumes), switches to the Downloads tab, and starts downloading.
3. **Import Playlist `.txt`:**
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
   - Configurable sleep timer with gradual audio fade-out.
