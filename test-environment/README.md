# Moonlight — PC Virtual Test Environment

This directory contains a complete virtual environment and testing harness to run, test, and interactively develop the **Moonlight** music player web interface directly on PC in any standard desktop browser (Chrome, Edge, Firefox), without requiring an Android device or emulator.

---

## Quick Start

### 1. Launch the Test Environment Server
Double-click:
```bat
test-environment\start-test-env.bat
```
Or run via PowerShell / Terminal:
```bash
node test-environment/server.js
```
The server will start on **`http://localhost:8080`** and open your default web browser automatically.

### 2. Available Views
- **Virtual Device Dashboard**: `http://localhost:8080/` (includes mobile device bezel, hardware navigation buttons, and Dev Tools panel).
- **Standalone App View**: `http://localhost:8080/app/` (full-window application view with mock bridge attached).

---

## How It Works

### Live Source Access (No Code Duplication)
The server serves files directly from `app/src/main/assets/` on disk:
- When you edit any file in `app/src/main/assets/` (e.g. `song-download.js`, `audio-player.js`, `index.html`, `spotify-ui.js`), your modifications are served live immediately.
- Simply click **"Reload UI"** or press `F5` to see your changes.

### Complete Android Bridge Virtualization (`mock-android-bridge.js`)
All native Kotlin `@JavascriptInterface` methods in `MainActivity.kt` are emulated in JavaScript:
1. **Real Audio Playback via Web Audio API**:
   - Web Audio synthesizer plays audio tones and chords when songs play, allowing real progress bars to move, seek bars to scrub, and playback end handlers to fire.
   - Volume control, crossfade, and Bluetooth status emulation.
2. **Virtual Media Library & Playlists**:
   - Pre-populated with realistic tracks, artwork (SVG Data URIs), and playlists.
   - Realistic "Scan the sky" library scanner with persistence in browser `localStorage`.
   - Playlist creation, deletion, reordering, and link sharing emulation.
3. **Download Wizard & Chapter Extraction (Features B, C, D, E)**:
   - Simulates video metadata fetching with chapters (official chapters & description timestamps).
   - Simulates downloading, thumbnail cropping, and placement into library folders.
4. **Hardware & Safe Area Insets**:
   - Test status bar height, navigation bar height, and IME keyboard height toggling.
   - Android hardware Back button emulation (`window.handleBack()`).
5. **Live Bridge Traffic Console**:
   - Every call to `AndroidBridge` is logged with timestamps, arguments, and return values in the Dev Panel.

---

## Running Automated Tests

### Option A: From the Browser Dashboard
Navigate to the **"Tests"** tab in the sidebar and click **"Run All Tests"**.

### Option B: From Command Line or Batch
Run:
```bat
test-environment\run-tests.bat
```
Or:
```bash
node test-environment/run-tests.js
```
This runs all Node.js unit tests (`tests/*.test.js`) and reports pass/fail summaries.
