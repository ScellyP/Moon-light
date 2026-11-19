# Moonlight Project — Daily Handoff & Session Summary
**Date:** November 19, 2026 (19:30 IST)  
**Current Version:** `v1.17.00`  
**Current Branch:** `Testing`  
**Remote Status:** Commits ready for patch and sync

---

## 1. Executive Summary & Today's Accomplishments

Today's session completed: **Multi-select playlist picker checkboxes & dead novel reader code trim (`v1.17.00`)**, following **AnonDrop anonymous playlist sharing & streaming large-package architecture (`v1.16.38`)** and **Real-time per-song download progress (`v1.16.37`)**:

### **v1.17.00 — Multi-Select Playlist Picker Checkboxes & Novel Reader Code Trim**
1. **Interactive Multi-Select Playlist Picker (`playlist-picker.js`):**
   - **Multi-Select Mode:** Activated via the `Select` pill in `.pp-selectbar`. Toggles `#pp-layer.selecting` state, revealing `.pp-check-box` circular checkboxes on all song rows while hiding single-add buttons.
   - **Batch Add ("Add N songs"):** Dynamically updates button text with the selected count (`Add (N)`) and adds references for all picked tracks in batch, updating playlist states, queueing writes via `kick()`/`step()`, and providing clear toast feedback.
   - **Select All / Deselect All:** Toggles selection of all unadded songs currently in view. If all selectable songs are picked, button dynamically flips to `Deselect all`.
   - **Row Checkboxes & Interaction:** Clicking anywhere on an unadded row (or its checkbox) toggles its picked state. Songs already in the playlist are marked with `.in-list` (`opacity: .55`) with disabled check indicators and cannot be selected twice.
   - **Preserved Single-Tap Functionality:** When not in selecting mode, single-tap `+` / check button functionality is 100% preserved. `e.stopPropagation()` ensures backwards compatibility.
   - **Filter Chips Bar:** Added `.pp-chips` with `All songs` and `Liked songs` chips. Tapping `Liked songs` narrows the visible list to user's favorited tracks (`NovelAudio.isLiked(id)`), enabling rapid batch addition of favorite tracks into any playlist.
   - **Back Button & Cancellation:** Tapping `Cancel` or the Android/header Back button while in selecting mode exits selection mode first without modifying the playlist.
2. **Dead Novel Reader Code Trimming (`index.html`):**
   - Cleaned up all obsolete Novel Reader legacy styles, selectors, and dead rules:
     - `#novel-select`, `#library-btn`, `#open-chapters-btn`, `#chapters-folder-status`
     - `#chapter-search`, `.search-wrap`, `#chapter-list`, `.chapter-item-label`
     - `#bookmark-chapter-btn`, `#bookmarks-panel`, `#bookmarks-list`, `.paragraph-bookmarked`
     - `#reader-scroll`, `#reader`, `@keyframes pageFlipNext/Prev`, `#chapter-title`, `#chapter-text`
     - `#welcome`, `#bottom-nav`, `#delete-chapters-btn`
     - `#novel-picker`, `.novel-card`, `.novel-cover`, `.novel-name`, `.novel-last`
     - `#night-lock-puzzle`, `.pz-*`, `#font-family-select`
   - Shaved off hundreds of lines of dead CSS, reducing DOM/CSSOM parsing overhead and file size.
3. **Automated Testing:**
   - Expanded `tests/playlist-picker.test.js` from 16 to 23 tests verifying filter chips, selecting mode, row check boxes, select-all/deselect-all, batch addition, cancellation, and back-button dismissal (23/23 checks passing).
   - All 9 core test suites pass 100%.

---

### **v1.16.38 — AnonDrop Anonymous Playlist Sharing & Large-Package Streaming Architecture**
1. **Large-Package RAM Exhaustion Protection (1–2 GB Archives):**
   - **Problem:** Previously, playlist ZIP archives and AES-256-GCM encryption/decryption were buffered entirely in memory via `ByteArrayOutputStream` and `readBytes()`, leading to heap exhaustion and Out-Of-Memory crashes on multi-hundred-megabyte or 1–2 GB packages.
   - **Solution in `PlaylistShare.kt`:**
     - **Disk-Streamed ZIP Creation:** Unencrypted ZIP archive is written directly to disk via `FileOutputStream(zipOutFile).buffered()` using 64 KB streaming buffers.
     - **Streaming AES-256-GCM Encryption:** Implemented `encryptFileAes256Gcm(srcFile, destFile, password)` using `Cipher.update()` blocks and `Cipher.doFinal()`, writing directly to the destination package on disk. Maintains 100% binary format compatibility with existing `.moonlight` packages (4-byte `MLPK` magic header + 16-byte PBKDF2 salt + 12-byte IV + GCM ciphertext + 16-byte authentication tag).
     - **Streaming Decryption & Safe Cleanup:** Implemented `decryptFileAes256Gcm(srcFile, destFile, password)` streaming directly to a temporary decrypted file. If password is incorrect or authentication tag verification fails (`AEADBadTagException`), the temporary decrypted file is immediately deleted from disk.
     - **Disk-Streamed Import:** `importPackage(packageFile, password)` detects encryption by reading only the first 4 magic bytes, decrypts to a temporary disk file if encrypted, and parses entries directly from `ZipInputStream(FileInputStream(...).buffered())` without loading entries into memory. Temporary files are safely cleaned up in `finally`.
2. **AnonDrop Primary Cloud Integration:**
   - **Zero User Registration / Anonymous:** Implemented anonymous chunked upload and direct download via `anondrop.net` REST API without requiring accounts, emails, or personal details.
   - **Upload Flow:**
     - Fetches or generates anonymous key via `getOrRegisterAnonDropKey()`.
     - Initiates upload session (`GET /initiateupload?filename=...&key=...`).
     - Streams 9 MB chunks via `POST /uploadchunk?session_hash=...&chunk_index=...&size=...` with `application/octet-stream` body.
     - Finalizes upload (`GET /endupload?session_hash=...&size=...`) and parses public share link: `https://anondrop.net/{id}`.
   - **Direct Download Flow:**
     - Streams packages directly from `https://anondrop.net/{id}/download` without requiring recipient login or cookies.
3. **Backward-Compatible Filebin Fallback:**
   - Retained Filebin upload and download functions as fallbacks. Added `isRecognizedShareUrl(url)` recognizing both AnonDrop and Filebin URLs.
4. **Android Native Bridge & Live Notifications (`MainActivity.kt`):**
   - Updated `sharePlaylistPackage` to upload to AnonDrop when `method == "anondrop"` or `"cloud"`.
   - Updated `importSharedPlaylist` to detect AnonDrop URLs and stream-download directly.
   - Added `@JavascriptInterface fun isPlaylistShareAnonDropUrl(url: String): Boolean`.
   - Added `@JavascriptInterface fun isPlaylistShareUrl(url: String): Boolean`.
   - Updated notifications to display provider names ("AnonDrop") and live byte/percentage progress.
5. **Frontend UI & Settings Integration:**
   - Updated `playlist-share.js` to prefer AnonDrop for cloud links, with toasts and recipient no-login notices.
   - Updated `song-download.js` to intercept AnonDrop links automatically from clipboard and text input.
   - Updated Settings menu switch to `#set-anondrop`: "AnonDrop cloud links" in `index.html` and `settings-menu.js`.
   - Updated `audio-player.js` defaults with `anonDropSharing: true`.
6. **Automated Tests:**
   - Updated `tests/playlist-share.test.js` covering AnonDrop regex, chunked upload/download bridge contracts, streaming packaging, settings gating, and Downloads tab interception (6/6 passing).

---

### **v1.16.37 — Real-Time Per-Song Download Progress in Downloads UI**
1. **Downloader Metrics Capture:**
   - Added `ProgressMetrics` data class and `parseYtDlpLine` regex parser in `SongDownloader.kt` to extract percentage complete, download speed (`at XX MiB/s`), downloaded/total sizes (`XX.XXMiB of XX.XXMiB`), and ETA from stdout.
   - Throttled native updates to 120ms to prevent bridge flooding, forwarding to `onPage("onSongDownloadProgress", ...)`.
2. **UI Real-Time Rendering:**
   - In `song-download.js`, updated single-song wizard to display determinate progress fill bar (`.dl-bar.dl-determinate`), real percentage in title, and speed/ETA meta.
   - Updated playlist download grid (`buildPlDownloading`) to render individual progress bars (`.dl-sp-item-bar`), percentage labels, speed/ETA metadata, and state tags (`queued`, `completed`, `failed`).
   - Added per-song inline Retry button to re-queue failed songs without restarting other downloads.
3. **Automated Tests:**
   - Updated `tests/song-download.test.js` to 32/32 passing tests verifying `formatEta`, multi-song independent progress tracking, native wiring, and UI CSS agreement.

---

## 2. Repository & Workspace State

| Repository | Path | Branch | Local Head | Remote Head | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Main Repo** | `S:\Projects\Moon-light` | `Testing` | `v1.16.38` | `847d8aa` | Ready to commit |
| **Test Repo** | `S:\Projects\Moon-light-Test` | `Testing` | `v1.16.37` | `847d8aa` | Ready to sync |
| **Patches** | `S:\Projects\Moon-light-Patches` | — | Patch 21 | — | Up to date |

### Patches Created
- `20-per-song-download-progress.patch` (`v1.16.37`)
- `21-anondrop-integration-and-streaming-packages.patch` (`v1.16.38`)

---

## 3. Key Files Modified in v1.16.38

- `app/src/main/java/com/scell/moonlight/PlaylistShare.kt` — Disk-backed streaming ZIP creation, streaming AES-256-GCM encryption/decryption, AnonDrop chunked upload and direct download, Filebin fallback.
- `app/src/main/java/com/scell/moonlight/MainActivity.kt` — Bridge routing for AnonDrop uploads/downloads, `isPlaylistShareAnonDropUrl`, `isPlaylistShareUrl`, provider-neutral notifications.
- `app/src/main/assets/playlist-share.js` — AnonDrop URL regex, prompt routing, completion handling, and export helpers.
- `app/src/main/assets/song-download.js` — AnonDrop link detection and automatic import routing.
- `app/src/main/assets/settings-menu.js` — Bound `#set-anondrop` to `anonDropSharing`.
- `app/src/main/assets/audio-player.js` — Added `anonDropSharing: true` to defaults.
- `app/src/main/assets/index.html` — Updated settings switch to `#set-anondrop`.
- `app/src/main/assets/version.js` — Bumped to `v1.16.38`.
- `Agent.md` — Updated structure change log for `v1.16.38`.
- `README.md` — Updated version badge and playlist sharing feature description.
- `tests/playlist-share.test.js` — Updated static and functional test assertions for AnonDrop & streaming.

---

## 4. Test Verification Summary

All 8 core automated test suites pass 100%:
- `node tests/duplicates-confirmation.test.js` — **4 / 4 passed**
- `node tests/song-download.test.js` — **32 / 32 passed**
- `node tests/player-app.test.js` — **8 / 8 passed**
- `node tests/spotify-tabs.test.js` — **9 / 9 passed**
- `node tests/playlist-share.test.js` — **6 / 6 passed**
- `node tests/song-share.test.js` — **5 / 5 passed**
- `node tests/song-share-link.test.js` — **4 / 4 passed**
- `node tests/index-html.test.js` — **4 / 4 passed**
**Total: 72 / 72 tests passed (100% pass rate).**

---

## 5. What Still Needs to Be Done (Pending & Next Steps)

### A. Immediate Verification on Device
1. **AnonDrop Playlist Upload & Download:**
   - Tap "Share" on any playlist in Moonlight.
   - Choose AnonDrop cloud link.
   - Verify upload progress notification updates smoothly with byte and percentage stats.
   - Copy generated `https://anondrop.net/...` link.
   - Test recipient download: paste into Moonlight Downloads tab on another device; verify package downloads and imports automatically without login.
2. **Password-Protected Package:**
   - Share a playlist with a password.
   - Verify recipient Moonlight prompts for password and decrypts smoothly.
3. **Large Package (1–2 GB):**
   - Test packaging and sharing a large multi-song playlist (100+ songs, ~1 GB).
   - Verify memory usage remains low without OOM.

---

### B. Backlog & Future Enhancements (from `Agent.md`)
1. **Music Folder Picker:**
   - Add a folder picker in Settings allowing users to choose custom music directories (e.g. SD card or `/Music/`).
2. **Clean Unused Reader CSS from `index.html`:**
   - Trim legacy CSS remnants from the original Novel-reader app.
3. **Dedicated Moonlight Launcher Icon:**
   - Create a distinct Moonlight launcher icon matching the tilted crescent moon design.
4. **Playlist Picker & Editor Enhancements:**
   - Liked Songs source chip, multi-select in Add-songs picker, and unavailable-song indicator.
5. **Night Rule / Sleep Mode:**
   - Configurable sleep timer with gradual audio fade-out.
