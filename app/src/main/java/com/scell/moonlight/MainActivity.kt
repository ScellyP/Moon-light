package com.scell.moonlight

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FilterInputStream
import java.io.InputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64

class MainActivity : ComponentActivity() {

    // Built once in setupImmersiveMode() and reused by
    // applySystemBarsForMenuState() so toggling the nav bar on/off (see
    // setMenuOpen() in the bridge below) doesn't need to rebuild it.
    private var insetsController: WindowInsetsControllerCompat? = null

    private lateinit var webView: WebView
    private var hasLoadedOnce = false

    // Keeps the screen awake while the user is active, then lets it time
    // out normally once there has been no touch input for 15 minutes.
    private val screenHandler = Handler(Looper.getMainLooper())
    private val screenTimeoutMs = 15 * 60 * 1000L
    private val releaseScreenRunnable = Runnable {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    // Closes the app after 10 minutes with no touch/key input, unless music
    // is active (then it keeps going and re-checks later). "Active" covers
    // BOTH engines: the native Media3 player (including the moments when it
    // is READY/BUFFERING with play requested but not yet reporting
    // isPlaying), and the WebView <audio> fallback engine, which the native
    // controller knows nothing about.
    private val inactivityCloseMs = 10 * 60 * 1000L
    // Set after the first "nothing is playing" reading; the app only closes if
    // a second reading a few seconds later agrees (see closeRunnable).
    private var closeRecheckPending = false

    private fun logAutoClose(reason: String) {
        try {
            val f = File(getExternalFilesDir(null) ?: filesDir, "autoclose_log.txt")
            f.appendText("${java.util.Date()} auto-close: $reason\n")
        } catch (e: Exception) {
            // Logging only; never block closing on it.
        }
    }

    private val closeRunnable = object : Runnable {
        override fun run() {
            val c = mediaController
            val nativeActive = c != null && (c.isPlaying ||
                (c.playWhenReady && (c.playbackState == Player.STATE_BUFFERING ||
                    c.playbackState == Player.STATE_READY)))
            // A pause caused by muting the phone (see handleMuteChange) is not "idle": the music is
            // waiting for the volume to come back, so the app must not close itself meanwhile.
            if (nativeActive || PlaybackService.heldByMute() || songDownloader.isBusy() || appUpdater.isBusy()) {
                closeRecheckPending = false
                screenHandler.postDelayed(this, inactivityCloseMs)
                return
            }
            // A single reading can land in the gap between two tracks, a
            // crossfade hand-over or a short audio-focus blip. Look again
            // a few seconds later before closing anything.
            if (!closeRecheckPending) {
                closeRecheckPending = true
                screenHandler.postDelayed(this, 5_000L)
                return
            }
            closeRecheckPending = false
            if (!::webView.isInitialized) {
                logAutoClose("no webview")
                finishAndRemoveTask()
                return
            }
            webView.evaluateJavascript(
                "!!(window.NovelAudio && window.NovelAudio.isPlaying && window.NovelAudio.isPlaying())"
            ) { result ->
                // Only an explicit "false" closes. A null/failed answer (e.g. a
                // paused WebView that can't run the script) is not proof that
                // nothing is playing.
                if (result == "false") {
                    logAutoClose("idle for 10 min, native=${c?.playbackState}/${c?.playWhenReady}, js=false")
                    finishAndRemoveTask()
                } else {
                    screenHandler.postDelayed(this, inactivityCloseMs)
                }
            }
        }
    }


    // Upper limit for settings.txt (read and write); see readSettingsFile().
    private val MAX_SETTINGS_BYTES = 256 * 1024
    // The permanent song lists (downloads.txt, favorites.txt, recents.txt): the only names the page may read/write.
    private val DATA_FILES = setOf("downloads.txt", "favorites.txt", "recents.txt")
    private val MAX_DATA_BYTES = 1024 * 1024


    private fun keepScreenAwake() {
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        screenHandler.removeCallbacks(releaseScreenRunnable)
        screenHandler.postDelayed(releaseScreenRunnable, screenTimeoutMs)
        screenHandler.removeCallbacks(closeRunnable)
        screenHandler.postDelayed(closeRunnable, inactivityCloseMs)
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.actionMasked == MotionEvent.ACTION_DOWN) keepScreenAwake()
        return super.dispatchTouchEvent(ev)
    }

    private val settingsFile get() = File(playerRoot, "settings.txt")

    // The native audio engine (audio-player.js's NativeAudioEngine) talks
    // to PlaybackService's real ExoPlayer through this controller — see
    // connectNativePlayer(). Null until that async connection completes,
    // during which the web page keeps using its WebView <audio> fallback.
    private var mediaController: MediaController? = null
    private var mediaControllerFuture: ListenableFuture<MediaController>? = null

    // Polls mediaController.currentPosition while playing and reports it
    // to JS — MediaController has no built-in "position changed" event,
    // unlike the WebView <audio> element's 'timeupdate'.
    private val progressHandler = Handler(Looper.getMainLooper())
    private var progressRunnable: Runnable? = null

    // True once the page has finished loading. Permission answers that arrive
    // earlier leave the novel listing to onPageFinished().
    private var pageLoaded = false

    // Set once the WebView's renderer process has died and the view has been
    // thrown away (see onRenderProcessGone); the activity is then rebuilt.
    private var webViewGone = false
    // True between onResume and onPause; the progress poll slows down when false.
    @Volatile private var appInForeground = false

    companion object {
        /** Same as appInForeground, readable by BackgroundUpdater (another thread, no activity needed). */
        @Volatile var inForeground = false

        /** True while a song download or an update is running; the background updater waits then. */
        @Volatile var busyCheck: (() -> Boolean)? = null
    }
    private var lastBackPressMs = 0L
    private var permissionFlowActive = false
    private var permissionFlowStarted = false

    // Android 13+ requires notification access for the media notification to
    // display; requested once at startup. If the user declines, playback and
    // the in-app UI still work fine — they just won't see the system
    // notification or its transport controls. Startup asks for notifications
    // first, then (when that dialog is answered) folder access, so both
    // prompts appear back-to-back on first launch. The second step is chained
    // here because Android can't show two permission screens at once.
    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {
        // Granted or not, move on to folder access.
        if (!hasStoragePermission()) {
            requestPermissionIfNeededThenLoad()
        } else {
            permissionFlowActive = false
            if (pageLoaded) onStorageReady()
        }
    }

    // Runs the "Download songs" jobs with the yt-dlp that is bundled in this app (see SongDownloader.kt
    // and song-download.js).
    private val songDownloader = SongDownloader(
        activity = this,
        library = { songLibrary },
        onStatus = { jobId, status, message ->
            callPage(
                "onSongDownloadStatus",
                JSONObject.quote(jobId) + ", " + JSONObject.quote(status) + ", " + JSONObject.quote(message)
            )
        },
    )

    // "Sign in to YouTube" for downloads that YouTube blocks with its bot check (see YouTubeSignIn.kt).
    private val youTubeSignIn = YouTubeSignIn(this) { status, message ->
        callPage("onYouTubeSignIn", JSONObject.quote(status) + ", " + JSONObject.quote(message))
    }

    /** Asks for notification access and folder access in one go, once per
     * launch. Called from onCreate and (if the page asks before then)
     * from tryAutoReconnect(). */
    private fun requestStartupPermissions() {
        if (permissionFlowStarted) return
        permissionFlowStarted = true
        permissionFlowActive = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        } else if (!hasStoragePermission()) {
            requestPermissionIfNeededThenLoad()
        } else {
            permissionFlowActive = false
        }
    }

    // This app's own folder: settings.txt lives here, not next to the music, so it never mixes with
    // another app's settings file.
    private val playerRoot = File("/storage/emulated/0/Moonlight")

    // Where audio-player.js's MediaLibrary.scan() expects to find music —
    // documented in the README's "Audio player" section.
    private val audioRoot = File("/storage/emulated/0/Novel/Audio")

    // The shared Songs folder, in this app's own folder next to settings.txt and the playlist files
    // (Moonlight/playlists/): see SongLibrary.kt. New downloads go here; Novel/Audio is still read.
    private val songsRoot = File(playerRoot, "Songs")

    // `lazy`, because songDownloader (declared above) needs it only when a job runs.
    private val songLibrary: SongLibrary by lazy { SongLibrary(audioRoot, songsRoot, File(playerRoot, "playlists")) }



    // The in-app updater (GitHub Releases -> download -> PackageInstaller): see AppUpdater.kt and the
    // update bar in app-update.js. Its state reaches the page through window.onUpdateState(json).
    private val appUpdater: AppUpdater = AppUpdater(
        activity = this,
        onState = { json -> callPage("onUpdateState", JSONObject.quote(json)) },
    )
    private val audioExtensions = setOf("mp3", "m4a", "aac", "flac", "ogg", "opus", "wav")

    /**
     * The only way a path coming from the page (the JavaScript bridge) may
     * turn into a File. The page is not trusted: it must not be able to make
     * the app read, decode or play arbitrary files, and this app holds
     * all-files access. A path is accepted only when it is a file:// URI (or
     * a plain absolute path), the real file after resolving "..", symlinks and
     * percent-encoding lies inside the Audio folder, it exists, and it has a
     * recognised audio extension. "Inside the Audio folder" means inside Novel/Audio or inside the
     * shared Moonlight/Songs folder. Returns the resolved File, or null.
     */
    private fun resolveAudioFile(path: String?): File? {
        return try {
            if (path.isNullOrBlank()) return null
            val uri = Uri.parse(path)
            val scheme = uri.scheme
            if (scheme != null && !scheme.equals("file", ignoreCase = true)) return null
            val raw = (if (scheme == null) path else uri.path) ?: return null
            val file = File(raw).canonicalFile
            val inAudio = file.path.startsWith(audioRoot.canonicalFile.path + File.separator)
            val inSongs = file.path.startsWith(songsRoot.canonicalFile.path + File.separator)
            if (!inAudio && !inSongs) return null
            if (!file.isFile) return null
            if (!audioExtensions.contains(file.extension.lowercase())) return null
            file
        } catch (e: Exception) {
            null
        }
    }

    /**
     * The crash log lives in this app's own folder,
     * /storage/emulated/0/Android/data/<package>/files/crash_log.txt, not in the
     * shared Novel/ folder: other apps can't read it there, yet a file manager
     * can often still open it. Falls back to the private files dir if the
     * external one isn't available.
     */
    private fun crashLogFile(): File =
        File(getExternalFilesDir(null) ?: filesDir, "crash_log.txt")

    /**
     * Writes any uncaught crash to a plain text file that can be opened
     * with any file manager (no logcat/adb needed) — useful for
     * diagnosing crashes on locked-down OEM Android builds (e.g. MIUI)
     * that restrict logcat access for non-debuggable apps.
     */
    private fun installCrashLogger() {
        // Older versions wrote the log into the shared Novel/ folder, where
        // other apps could read it. Remove that copy (best effort).
        try {
            val old = File("/storage/emulated/0/Novel/crash_log.txt")
            if (old.exists()) old.delete()
        } catch (e: Exception) {
            // No storage access yet: nothing to remove.
        }
        val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val crashFile = crashLogFile()
                crashFile.parentFile?.mkdirs()
                crashFile.writeText(
                    "Crash at ${java.util.Date()}\n" +
                        throwable.stackTraceToString()
                )
            } catch (e: Exception) {
                // If we can't even write the crash log, there's nothing more
                // we can do here — fall through to the default handler.
            }
            defaultHandler?.uncaughtException(thread, throwable)
        }
    }

    // The page is served from this https origin (not file://), so the WebView
    // needs no file access at all. The app's own files come from assets/ via
    // WebViewAssetLoader; local music is served by serveAudio() below.
    private val appHost = "appassets.androidplatform.net"
    private val appUrl = "https://$appHost/assets/index.html"
    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .setDomain(appHost)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    private val manageStorageLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        // Whether granted or not, try loading — onStorageReady() will report
        // an error to the JS side if permission is still missing. If the
        // page hasn't finished loading yet, onPageFinished() does this.
        permissionFlowActive = false
        // Create the Novel folder the moment access is granted, even if the
        // page is still loading, so it exists on the very first launch.
        if (hasStoragePermission()) ensureFolders()
        if (pageLoaded) onStorageReady()
    }

    private val legacyPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        permissionFlowActive = false
        val granted = results.isNotEmpty() && results.values.all { it }
        // Create the Novel folder the moment access is granted, even if the
        // page is still loading, so it exists on the very first launch.
        if (granted) ensureFolders()
        if (pageLoaded) {
            if (granted) onStorageReady() else notifyError("Storage permission was not granted.")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        installCrashLogger()
        registerVolumeReceiver()
        songDownloader.warmUp()
        appUpdater.start()
        busyCheck = { songDownloader.isBusy() || appUpdater.isBusy() }
        // Keeps updating the app while it is closed (see BackgroundUpdater.kt).
        BackgroundUpdater.schedule(applicationContext)
        // A few seconds after launch, so the check does not compete with the splash and the library scan.
        screenHandler.postDelayed({ appUpdater.checkOnStart() }, 6000L)
        // If access was already granted, make sure the folders exist right away.
        if (hasStoragePermission()) Thread { ensureFolders() }.start()

        // Start reading the music library right away, in parallel with the page
        // and the chapter loading. (Without storage access yet, it starts from
        // onStorageReady() once access is granted.)
        if (hasStoragePermission()) runAudioScan()

        webView = WebView(this)
        webView.setBackgroundColor(android.graphics.Color.parseColor("#0b0d12"))
        setContentView(webView)

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        // Lock the WebView down. The page comes from the https origin above, so
        // it never needs file:// or content:// access, and nothing it loads
        // may be mixed (http) content. Local music is not read from file://
        // by the page; it is requested from this same origin under /audio/
        // and served by serveAudio(), which only hands out real audio files
        // inside Novel/Audio.
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        @Suppress("DEPRECATION")
        webView.settings.allowFileAccessFromFileURLs = false
        @Suppress("DEPRECATION")
        webView.settings.allowUniversalAccessFromFileURLs = false
        webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        // mediaPlaybackRequiresUserGesture is turned off so that programmatic
        // calls to play() (next/prev, auto-advance to the following track,
        // resuming after a reading break) aren't silently blocked for not
        // originating from a fresh tap — the *first* play always does come
        // from a genuine tap on the play button.
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.webViewClient = object : WebViewClient() {
            // The only page this WebView may show is the app itself. A link
            // the user taps that points at http/https goes to the external
            // browser; every other navigation (and anything a script starts
            // without a tap) is dropped.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val target = request.url
                if (isAppUrl(target)) return false
                val scheme = target.scheme
                if (request.hasGesture() && (scheme == "https" || scheme == "http")) {
                    openInExternalBrowser(target)
                }
                return true
            }

            // Everything the page requests is answered here: its own assets
            // through the asset loader, music through serveAudio(), and every
            // other host or path is refused (no network from the page).
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val target = request.url
                if (target.scheme != "https" || target.host != appHost) return plainResponse(403)
                if (request.method != "GET") return plainResponse(405)
                val path = target.path ?: return plainResponse(404)
                if (path.startsWith("/songs/")) {
                    return serveAudio(path.removePrefix("/songs/"), request.requestHeaders, songsRoot)
                }
                if (path.startsWith("/audio/")) {
                    return serveAudio(path.removePrefix("/audio/"), request.requestHeaders)
                }
                if (!path.startsWith("/assets/")) return plainResponse(404)
                val response = assetLoader.shouldInterceptRequest(target) ?: return plainResponse(404)
                return if (path.endsWith(".woff2")) {
                    WebResourceResponse("font/woff2", null, response.data)
                } else {
                    response
                }
            }

            // Android can kill the WebView's separate renderer process while the
            // app is in the background (typically after the phone has been locked
            // for a while and memory is needed elsewhere), and a renderer can also
            // crash. If the app does not handle that, the whole app is shut down
            // the next time it is opened. Handle it: drop the dead WebView and
            // rebuild the screen; saved settings are re-read on startup.
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (webViewGone) return true
                webViewGone = true
                pageLoaded = false
                try {
                    (view.parent as? ViewGroup)?.removeView(view)
                    view.destroy()
                } catch (e: Exception) {
                    // Already gone; nothing to clean up.
                }
                val now = System.currentTimeMillis()
                if (now - lastRendererGoneAt < 5_000L) {
                    // Died again right after a rebuild: stop instead of looping.
                    finish()
                } else {
                    lastRendererGoneAt = now
                    recreate()
                }
                return true
            }

            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                // The page (and reader.js, which defines window.onFolderPicked
                // and window.onStatusBarInset) is now fully loaded, so re-send
                // the current status bar height in case it loaded before this
                // fired, and auto-load novels if we already have permission.
                setupImmersiveMode()
                pageLoaded = true
                if (hasStoragePermission()) {
                    onStorageReady()
                } else if (!permissionFlowActive) {
                    // Permission was refused (or never needed asking) and
                    // nothing is pending: show the setup guide rather than
                    // leaving the launch screen up.
                    notifyError("Storage access hasn't been allowed yet.")
                }
                // The MediaController may have connected before this page
                // finished loading, in which case the original ready
                // callback hit a page that had no handler yet and was
                // silently dropped (leaving the player on the WebView
                // fallback engine). Re-announce it now.
                if (mediaController != null) callPage("onNativeAudioReady")
            }
        }
        webView.addJavascriptInterface(AndroidBridge(), "AndroidBridge")

        webView.webChromeClient = object : WebChromeClient() {
            override fun onJsAlert(
                view: WebView,
                url: String?,
                message: String?,
                result: JsResult
            ): Boolean {
                try {
                    AlertDialog.Builder(this@MainActivity)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                        .setOnCancelListener { result.cancel() }
                        .setCancelable(false)
                        .show()
                } catch (e: Exception) {
                    result.confirm()
                }
                return true
            }

            override fun onJsConfirm(
                view: WebView,
                url: String?,
                message: String?,
                result: JsResult
            ): Boolean {
                try {
                    AlertDialog.Builder(this@MainActivity)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                        .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                        .setOnCancelListener { result.cancel() }
                        .setCancelable(false)
                        .show()
                } catch (e: Exception) {
                    result.cancel()
                }
                return true
            }
        }

        webView.loadUrl(appUrl)

        setupImmersiveMode()

        // Back closes whatever is open (dialog, library, panel, menu) before
        // it is allowed to leave the app. The page decides; see
        // window.handleBack in reader.js.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    "(function(){return !!(window.handleBack && window.handleBack());})()"
                ) { result ->
                    if (result != "true") {
                        // Nothing left to close: leaving needs a second back
                        // press within 2 seconds, so a stray tap or gesture
                        // doesn't drop you out of the app.
                        val now = System.currentTimeMillis()
                        if (now - lastBackPressMs < 2000L) {
                            finish()
                        } else {
                            lastBackPressMs = now
                            android.widget.Toast.makeText(
                                this@MainActivity, "Press back again to exit",
                                android.widget.Toast.LENGTH_SHORT
                            ).show()
                        }
                    }
                }
            }
        })

        requestStartupPermissions()

        connectNativePlayer()
    }

    /**
     * Connects a MediaController to PlaybackService's MediaSession. This
     * is the other half of NativeAudioEngine in audio-player.js: once
     * this succeeds, window.onNativeAudioReady() fires and the web page
     * switches from its WebView <audio> fallback to real background
     * playback through this controller.
     *
     * Building a MediaController is asynchronous (it may need to start
     * and bind to PlaybackService first) — the future's listener is what
     * runs once that's done, on the main executor since everything here
     * (mediaController itself, the listener, evaluateJavascript) must
     * stay on the UI thread.
     */
    private fun connectNativePlayer() {
        val sessionToken = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        val future = MediaController.Builder(this, sessionToken).buildAsync()
        mediaControllerFuture = future
        future.addListener({
            try {
                val controller = future.get()
                mediaController = controller
                controller.addListener(nativePlayerListener)

                // MainActivity is how PlaybackService's QueueAwarePlayer
                // reaches the JS queue for Next/Previous notification
                // taps — see PlaybackService.kt. Set here (not in
                // connectNativePlayer's caller) so it's only live once we
                // actually have a working controller/session to react
                // through.
                PlaybackService.queueNavigationListener = object : PlaybackService.QueueNavigationListener {
                    override fun onSkipToNext() {
                        webView.post { callPage("onNativeAudioSkipNext") }
                    }
                    override fun onSkipToPrevious() {
                        webView.post { callPage("onNativeAudioSkipPrevious") }
                    }
                }

                callPage("onNativeAudioReady")
            } catch (e: Exception) {
                // Native engine unavailable (e.g. the service failed to
                // bind) — audio-player.js's LocalAudioEngine keeps
                // working as the fallback, so there's nothing further to
                // do here; deliberately not surfaced as a user-facing
                // error since local playback still works fine.
            }
        }, MoreExecutors.directExecutor())
    }

    /**
     * Forwards ExoPlayer/MediaSession state to JS. Covers both state
     * changes WE caused (a bridge play()/pause() call) and ones we
     * didn't — the system notification's own buttons, a Bluetooth
     * remote, or audio focus lost to another app all land here too,
     * which is exactly why audio-player.js's NativeAudioEngine treats
     * these callbacks as the source of truth rather than only trusting
     * its own bridge calls.
     */
    private val nativePlayerListener = object : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            reportPlaying(isPlaying)
            if (isPlaying) startProgressUpdates() else stopProgressUpdates()
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
            when (playbackState) {
                Player.STATE_READY -> {
                    val durationMs = mediaController?.duration ?: C.TIME_UNSET
                    val durationSec = if (durationMs != C.TIME_UNSET) durationMs / 1000.0 else 0.0
                    callPage("onNativeAudioLoaded", durationSec.toString())
                }
                Player.STATE_ENDED -> callPage("onNativeAudioEnded")
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            callPage("onNativeAudioError", JSONObject.quote(error.message ?: "Playback error"))
        }
    }

    /** Polls playback position roughly twice a second while playing —
     * MediaController has no push-based position-changed callback, so
     * this is the standard Media3 pattern for a live seek bar. Stops
     * itself the moment playback pauses, so it's not silently running
     * (and evaluating JS) in the background doing nothing useful. */
    private fun startProgressUpdates() {
        stopProgressUpdates()
        val runnable = object : Runnable {
            override fun run() {
                val controller = mediaController
                if (controller != null) {
                    val posSec = controller.currentPosition / 1000.0
                    val durMs = controller.duration
                    val durSec = if (durMs != C.TIME_UNSET && durMs > 0) durMs / 1000.0 else 0.0
                    callPage("onNativeAudioProgress", "$posSec, $durSec")
                }
                // Screen visible: 500 ms keeps the seek bar smooth. App in the
                // background / screen off: nobody sees the bar, so tick slowly
                // mid-track and only go back to 500 ms near the end of a
                // track, where crossfade (needs ~0.5 s precision) and the
                // 20 s sleep-timer fade do their work.
                val remainingSec = if (controller != null && controller.duration != C.TIME_UNSET && controller.duration > 0)
                    (controller.duration - controller.currentPosition) / 1000.0 else 0.0
                val delay = if (appInForeground || remainingSec <= 35.0) 500L else 2000L
                progressHandler.postDelayed(this, delay)
            }
        }
        progressRunnable = runnable
        progressHandler.post(runnable)
    }

    private fun stopProgressUpdates() {
        progressRunnable?.let { progressHandler.removeCallbacks(it) }
        progressRunnable = null
    }

    /**
     * Makes the navigation bar (bottom) transparent, same as before, and
     * hides the status bar (top) entirely — the notification bar itself
     * is not drawn at all, though swiping down from the top briefly
     * reveals it again (standard Android behavior).
     *
     * Hiding it doesn't remove the physical camera cutout though, so we
     * still measure exactly how much space the cutout needs (via the
     * displayCutout inset, not the status bar inset, since the status
     * bar is hidden and no longer reports a height) and hand that to the
     * web page as window.onStatusBarInset(heightInCssPx). reader.js uses
     * that to reserve precisely that much space as a permanent gap above
     * its own top bar — with a clock drawn in it — so nothing is ever
     * drawn underneath the camera hole.
     */
    private fun setupImmersiveMode() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.navigationBarColor = android.graphics.Color.TRANSPARENT
        window.statusBarColor = android.graphics.Color.TRANSPARENT

        // Let content draw into the cutout area in any orientation, so we
        // can measure it ourselves and reserve exactly that much space
        // rather than leaving a system-decided gap behind.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val params = window.attributes
            params.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            window.attributes = params
        }

        val controller = WindowInsetsControllerCompat(window, webView)
        controller.isAppearanceLightNavigationBars = false
        controller.isAppearanceLightStatusBars = false
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        insetsController = controller

        // Default/"reading" state: status bar hidden, navigation bar
        // shown but transparent (see window.navigationBarColor above) —
        // this is the look while a chapter is open and is left exactly
        // as it was. It only changes to fully hidden while the sidebar
        // drawer is open; see applySystemBarsForMenuState() and the
        // setMenuOpen() bridge method below, called live from
        // reader.js's syncScrim() every time the drawer opens/closes.
        applySystemBarsForMenuState(open = false)

        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            view.setPadding(0, 0, 0, insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom)
            reportInsets(insets)
            insets
        }
        ViewCompat.requestApplyInsets(webView)

        val currentInsets = ViewCompat.getRootWindowInsets(webView)
        if (currentInsets != null) {
            webView.setPadding(0, 0, 0, currentInsets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom)
            reportInsets(currentInsets)
        }
    }

    /**
     * Switches between the two system-bar states the app ever uses:
     *
     *   open = false ("reading"): status bar hidden, navigation bar
     *     shown but transparent — the existing look while a chapter is
     *     on screen, left untouched.
     *
     *   open = true ("menu"): both bars fully hidden. The sidebar drawer
     *     is a full-height panel; a transparent-but-visible nav bar sitting
     *     on top of it let the reading text (or the drawer's own bottom
     *     edge, which is deliberately inset by exactly the nav bar's
     *     height — see --nav-bar-height in index.html) show straight
     *     through the icons. Hiding it outright while the drawer is open
     *     removes that overlap, and also lets the drawer's CSS
     *     bottom:var(--nav-bar-height) collapse to 0 on its own, since
     *     the live inset reported to reportNavBarInset() below drops to 0
     *     the moment the bar is actually hidden — so the drawer reaching
     *     the true bottom edge falls out of this automatically rather
     *     than needing a second, separate fix.
     *
     * Driven live from reader.js's syncScrim() via the setMenuOpen()
     * bridge method, every time the drawer opens or closes.
     */
    private fun applySystemBarsForMenuState(open: Boolean) {
        val controller = insetsController ?: return
        if (open) {
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.hide(WindowInsetsCompat.Type.statusBars())
            controller.show(WindowInsetsCompat.Type.navigationBars())
        }
    }

    /**
     * Tells the page an inset height in CSS px (not raw device px) through
     * window.[handler]. Two are reported: the front-camera cutout gap
     * (onStatusBarInset) and the transparent navigation bar (onNavBarInset).
     * reader.js uses the latter to keep fixed-position elements, like the
     * sidebar, from extending underneath the back/home/recents icons.
     */
    private fun reportInset(handler: String, px: Int) {
        val density = resources.displayMetrics.density
        callPage(handler, (if (density > 0f) px / density else px.toFloat()).toString())
    }

    private fun reportInsets(insets: WindowInsetsCompat) {
        reportInset("onStatusBarInset", insets.getInsets(WindowInsetsCompat.Type.displayCutout()).top)
        reportInset("onNavBarInset", insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && ::webView.isInitialized) {
            setupImmersiveMode()
        }
    }

    // Muting the media volume (by any means: volume keys, the system volume
    // panel, the in-app slider) pauses the music; raising it again resumes
    // it. Only a pause caused by muting is undone. Handled here, natively, so
    // it also works with the screen off or the app in the background.
    private var mutePaused = false

    private val volumeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val stream = intent?.getIntExtra("android.media.EXTRA_VOLUME_STREAM_TYPE", -1)
            if (stream == AudioManager.STREAM_MUSIC) handleMuteChange()
        }
    }

    private fun handleMuteChange() {
        try {
            val am = getSystemService(AudioManager::class.java) ?: return
            val controller = mediaController
            val muted = am.getStreamVolume(AudioManager.STREAM_MUSIC) <= 0
            if (muted) {
                if (controller != null && controller.isPlaying) {
                    mutePaused = true
                    // Before the pause, so the service's idle timer already sees the hold.
                    PlaybackService.muteHeldSince = System.currentTimeMillis()
                    controller.pause()
                }
            } else if (mutePaused) {
                mutePaused = false
                PlaybackService.muteHeldSince = 0L
                controller?.play()
            }
        } catch (e: Exception) {
            // Not permitted right now — ignore.
        }
        syncPageVolume()
    }

    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    private fun registerVolumeReceiver() {
        val filter = IntentFilter("android.media.VOLUME_CHANGED_ACTION")
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(volumeReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                registerReceiver(volumeReceiver, filter)
            }
        } catch (e: Exception) {
            // Without it, muting still works from the slider and volume keys.
        }
    }

    // Raises/lowers the real media volume (shows the system volume UI) and
    // refreshes the slider in the audio panel.
    private fun adjustMediaVolume(raise: Boolean) {
        try {
            val am = getSystemService(AudioManager::class.java)
            am?.adjustStreamVolume(
                AudioManager.STREAM_MUSIC,
                if (raise) AudioManager.ADJUST_RAISE else AudioManager.ADJUST_LOWER,
                AudioManager.FLAG_SHOW_UI
            )
        } catch (e: Exception) {
            // Not permitted in the current device state (e.g. Do Not Disturb) — ignore.
        }
        syncPageVolume()
    }

    // True while any in-app menu/panel is open; set from reader.js via
    // AndroidBridge.setVolumeKeysFree(). Read in handleVolumeKey().
    // Whether the volume buttons scroll the page while reading. Mirrors the
    // "Volume button scroll" switch in the theme panel (reader.js reports it
    // through AndroidBridge.setVolumeScrollEnabled()). On by default.
    /**
     * Handles the hardware volume buttons. Overriding dispatchKeyEvent (not
     * onKeyDown) means this runs BEFORE the WebView sees the key, so
     * nothing inside the page can swallow it.
     *
     * Normally the buttons scroll the page (Volume Up = scroll up, Volume
     * Down = scroll down). They change the real media volume instead while
     * a menu/panel is open (e.g. the audio player) or when volume scrolling
     * is switched off in the settings. Both key-down and key-up are
     * consumed, which stops Android's own volume UI from also firing.
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val code = event.keyCode
        if ((code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN) &&
            ::webView.isInitialized
        ) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                keepScreenAwake()
                handleVolumeKey(code == KeyEvent.KEYCODE_VOLUME_DOWN)
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun handleVolumeKey(down: Boolean) {
        // A music player: the hardware buttons always change the real media volume.
        adjustMediaVolume(!down)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        keepScreenAwake()
        return super.onKeyDown(keyCode, event)
    }

    /**
     * Releases the MediaController connection and stops polling — NOT
     * the same as stopping playback: PlaybackService and its ExoPlayer
     * instance are a separate component and keep running/playing
     * regardless of what happens to this Activity (that's the entire
     * point of the Service architecture — see PlaybackService.kt).
     * Clearing the static queueNavigationListener here matters because
     * it would otherwise hold a reference to this Activity (via the
     * webView it closes over) past the Activity's own lifetime — a
     * classic static-reference leak.
     */
    override fun onDestroy() {
        super.onDestroy()
        try { unregisterReceiver(volumeReceiver) } catch (e: Exception) { /* not registered */ }
        songDownloader.release()
        appUpdater.release()
        busyCheck = null
        screenHandler.removeCallbacks(releaseScreenRunnable)
        screenHandler.removeCallbacks(closeRunnable)
        stopProgressUpdates()
        mediaControllerFuture?.let { MediaController.releaseFuture(it) }
        mediaController = null
        if (PlaybackService.queueNavigationListener != null) {
            PlaybackService.queueNavigationListener = null
        }
    }

    override fun onPause() {
        super.onPause()
        appInForeground = false
        inForeground = false
        screenHandler.removeCallbacks(releaseScreenRunnable)
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (::webView.isInitialized && !webViewGone) {
            webView.onPause()
        }
    }

    override fun onResume() {
        super.onResume()
        appInForeground = true
        inForeground = true
        appUpdater.onResume()
        // Push the current position right away (the poll may have been in slow mode).
        if (mediaController?.isPlaying == true) startProgressUpdates()
        keepScreenAwake()
        if (::webView.isInitialized && !webViewGone) {
            webView.onResume()
        }
        // Only (re)load novels on resume if we haven't successfully loaded
        // yet this session — e.g. the user just granted storage permission
        // in system Settings and is coming back. If we've already loaded
        // once, ordinary app-switching (checking a notification, etc.)
        // shouldn't re-scan the whole folder and rebuild the chapter list
        // every time; reader.js keeps its own state and scroll position
        // intact across a simple resume.
        if (::webView.isInitialized && !webViewGone && webView.progress == 100 && hasStoragePermission() && !hasLoadedOnce) {
            onStorageReady()
        }
    }

    inner class AndroidBridge {






        // In-app updates (AppUpdater.kt, app-update.js). All answers arrive as window.onUpdateState(json).
        // checkForUpdate: a manual check (always answers, even "up to date"); downloadUpdate and
        // installUpdate act on what the last check found; updateState is the latest state JSON ("" before
        // the first); the auto switch decides whether the app checks and downloads by itself.
        @JavascriptInterface
        fun checkForUpdate() { appUpdater.check(manual = true) }

        @JavascriptInterface
        fun downloadUpdate() { appUpdater.download() }

        @JavascriptInterface
        fun installUpdate() { runOnUiThread { appUpdater.install() } }

        @JavascriptInterface
        fun updateState(): String = appUpdater.stateJson()

        @JavascriptInterface
        fun getAutoUpdate(): Boolean = appUpdater.autoEnabled()

        @JavascriptInterface
        fun setAutoUpdate(on: Boolean) {
            appUpdater.setAutoEnabled(on)
            BackgroundUpdater.schedule(applicationContext)   // creates or cancels the background job
        }


        // "Download songs" wizard (song-download.js). A job is answered through
        // window.onSongDownloadStatus(jobId, "done"|"failed", message), exactly once; both methods
        // return false only when a job with that id is already running. Two jobs may run at once
        // (the next song downloads while the current one is placed). See SongDownloader.kt.
        //
        // stageSong: downloads one link into Audio/.staging/ (invisible to the music scan). The
        // "done" message is the downloaded file's full path.
        @JavascriptInterface
        fun stageSong(jobId: String, url: String): Boolean =
            songDownloader.stage(jobId, url)

        // placeSong: names a staged song [name] ("" = keep) and moves it into the playlist folder
        // [folder] ("" = Audio/ itself). The "done" message is the song's new full path.
        @JavascriptInterface
        fun placeSong(jobId: String, path: String, name: String, folder: String): Boolean =
            songDownloader.place(jobId, path, name, folder)

        // Stops every running download/placement (the user left the tab).
        @JavascriptInterface
        fun cancelSongDownload() {
            songDownloader.cancel()
        }

        // Deletes everything in the staging folder: songs that were downloaded but never placed.
        @JavascriptInterface
        fun discardStagedSongs() {
            try { File(SongDownloader.STAGING_DIR).deleteRecursively() } catch (e: Exception) { /* nothing to delete */ }
        }

        // Deletes ONE downloaded-but-not-placed song (and its own staging folder): used when the
        // user decides not to keep a song that turned out to be a duplicate. Other staged songs
        // (the next one downloading in the background) are left alone. Only staged files qualify.
        @JavascriptInterface
        fun discardStagedSong(path: String): Boolean {
            if (!SongDownloader.isStagedPath(path)) return false
            return try {
                val file = File(path).canonicalFile
                val root = File(SongDownloader.STAGING_DIR).canonicalFile
                val folder = file.parentFile
                file.delete()
                if (folder != null && folder != root && folder.path.startsWith(root.path + File.separator)) {
                    folder.deleteRecursively()   // the song's own folder only
                }
                true
            } catch (e: Exception) {
                false
            }
        }

        // The text on the clipboard ("" if none), for the "Click to paste" button. Android only lets
        // an app read the clipboard while it is in the foreground, which it is when the button is tapped.
        @JavascriptInterface
        fun readClipboard(): String {
            return try {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this@MainActivity)?.toString() ?: ""
            } catch (e: Exception) {
                ""
            }
        }

        // Settings file: /storage/emulated/0/Moonlight/settings.txt. Returns null when storage isn't accessible yet, ""
        // when the file doesn't exist, otherwise its text. See settings-file.js
        // for the format.
        @JavascriptInterface
        fun readSettingsFile(): String? {
            if (!hasStoragePermission()) return null
            return try {
                // A real settings file is about a kilobyte. Anything far larger
                // is not ours (or was tampered with): ignore it and let it be
                // rewritten from the app's current settings.
                if (settingsFile.exists() && settingsFile.length() <= MAX_SETTINGS_BYTES) {
                    settingsFile.readText()
                } else {
                    ""
                }
            } catch (e: Exception) {
                null
            }
        }

        @JavascriptInterface
        fun writeSettingsFile(text: String): Boolean {
            if (!hasStoragePermission()) return false
            if (text.length > MAX_SETTINGS_BYTES) return false
            return try {
                playerRoot.mkdirs()
                settingsFile.writeText(text)
                true
            } catch (e: Exception) {
                false
            }
        }

        // The permanent song lists, next to settings.txt in /storage/emulated/0/Moonlight/:
        //   downloads.txt  every song downloaded from a link (link, name it was saved as, playlist, path)
        //   favorites.txt  the liked songs, with their details
        //   recents.txt    the recently played songs, with their details
        // Only these names are accepted (the page can never read or write any other file). Same
        // contract as the settings file: null = storage not accessible yet, "" = no such file yet.
        // See song-memory.js for the formats.
        @JavascriptInterface
        fun readDataFile(name: String): String? {
            if (name !in DATA_FILES) return null
            if (!hasStoragePermission()) return null
            return try {
                val f = File(playerRoot, name)
                if (f.exists() && f.length() <= MAX_DATA_BYTES) f.readText() else ""
            } catch (e: Exception) {
                null
            }
        }

        @JavascriptInterface
        fun writeDataFile(name: String, text: String): Boolean {
            if (name !in DATA_FILES) return false
            if (!hasStoragePermission()) return false
            if (text.length > MAX_DATA_BYTES) return false
            return try {
                playerRoot.mkdirs()
                // Write next to it and rename, so a crash half-way never leaves a broken list.
                val tmp = File(playerRoot, "$name.tmp")
                tmp.writeText(text)
                val target = File(playerRoot, name)
                if (!tmp.renameTo(target)) {
                    target.writeText(text)
                    tmp.delete()
                }
                true
            } catch (e: Exception) {
                false
            }
        }






        // YouTube sign-in for the downloader. youtubeSignInStatus: "signed-in" | "signed-out".
        // youtubeSignIn opens the sign-in page; the result arrives as window.onYouTubeSignIn(status, message).
        @JavascriptInterface
        fun youtubeSignInStatus(): String = youTubeSignIn.status()

        @JavascriptInterface
        fun youtubeSignIn() {
            runOnUiThread { youTubeSignIn.start() }
        }

        @JavascriptInterface
        fun youtubeSignOut(): Boolean = youTubeSignIn.signOut()

        // The playlist files in /storage/emulated/0/Moonlight/playlists/ (see SongLibrary.kt).
        // listPlaylists: every readable playlist as a JSON array; each song has `available` (its file
        // exists), so a missing song is shown as unavailable and never silently dropped. "[]" = none yet,
        // null = storage not accessible yet.
        @JavascriptInterface
        fun listPlaylists(): String? {
            if (!hasStoragePermission()) return null
            return try { songLibrary.listJson() } catch (e: Exception) { null }
        }

        // savePlaylist: writes one playlist file (checked and cleaned first: the page is not trusted).
        // overwrite = false never replaces an existing playlist, so a repeated migration is harmless.
        @JavascriptInterface
        fun savePlaylist(json: String, overwrite: Boolean): Boolean {
            if (!hasStoragePermission()) return false
            if (json.length > 2_000_000) return false
            return try { songLibrary.save(JSONObject(json), overwrite) } catch (e: Exception) { false }
        }

        // Rescan button / explicit scan: always walk the folder again and
        // report the result to audio-player.js's MediaLibrary (see runAudioScan()).
        @JavascriptInterface
        fun scanAudio() {
            runOnUiThread {
                jsWantsAudio = true
                runAudioScan()
            }
        }

        // Called once by the page at start-up: hands over the scan that was
        // already started in onCreate instead of starting another.
        @JavascriptInterface
        fun scanAudioStartup() {
            runOnUiThread { requestAudioListAtStartup() }
        }


        // Cover art as a data: URI for the in-app player, or "" if none.
        @JavascriptInterface
        fun getArtwork(path: String): String {
            val bytes = loadArtworkBytes(path) ?: return ""
            return "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
        }

        /**
         * Resolves [path] (it must be a real audio file inside Audio/), pulls its
         * cover art, and builds the MediaItem. If the file can't be used, tells
         * the page — the same way a decoder error does, so the player skips the
         * track — and returns null. Runs on the bridge thread (not the UI
         * thread) because extracting artwork can take a moment.
         */
        private fun buildAudioItem(path: String, title: String, artist: String, album: String): MediaItem? {
            val audioFile = resolveAudioFile(path) ?: run {
                runOnUiThread { callPage("onNativeAudioError", JSONObject.quote("That file can't be played.")) }
                return null
            }
            // Cover art, so the notification and lock screen can show it.
            val art = loadArtworkBytes(path)
            val metadata = MediaMetadata.Builder()
                .setTitle(title.ifBlank { null })
                .setArtist(artist.ifBlank { null })
                .setAlbumTitle(album.ifBlank { null })
                .apply {
                    if (art != null) setArtworkData(art, MediaMetadata.PICTURE_TYPE_FRONT_COVER)
                }
                .build()
            return MediaItem.Builder()
                .setUri(Uri.fromFile(audioFile))
                .setMediaId(path)
                .setMediaMetadata(metadata)
                .build()
        }

        // The nativeAudio* calls are what audio-player.js's NativeAudioEngine
        // runs on: each forwards to the MediaController connected in
        // connectNativePlayer(). They are no-ops until that connection has
        // completed (mediaController is still null), which matches
        // NativeAudioEngine only being reachable from JS after
        // window.onNativeAudioReady has fired.
        @JavascriptInterface
        fun nativeAudioLoad(path: String, title: String, artist: String, album: String) {
            val item = buildAudioItem(path, title, artist, album) ?: return
            runOnUiThread {
                // Loading something else ends any crossfade still running.
                PlaybackService.crossfade?.cancel()
                mediaController?.setMediaItem(item)
                mediaController?.prepare()
            }
        }

        /**
         * Starts [path] from its beginning, crossfading from the track that is
         * playing over [seconds] (see NativeCrossfade.kt). [outGain] / [inGain]
         * are the linear volume levels (0..1) of the old and the new track.
         * Unlike nativeAudioLoad() this also starts playback — the page makes no
         * separate play call — and it ALWAYS ends with the new track playing: if
         * it can't overlap it simply switches. The page has already moved its
         * queue on before calling this.
         */
        @JavascriptInterface
        fun nativeAudioCrossfade(
            path: String, title: String, artist: String, album: String,
            seconds: Double, outGain: Double, inGain: Double
        ) {
            val item = buildAudioItem(path, title, artist, album) ?: return
            runOnUiThread {
                val xf = PlaybackService.crossfade
                if (xf != null) {
                    xf.start(item, seconds, outGain, inGain)
                } else {
                    // Service not reachable: play it the ordinary way.
                    mediaController?.setMediaItem(item)
                    mediaController?.prepare()
                    mediaController?.play()
                }
            }
        }

        // Reports what the native player is really doing, so the web UI
        // can correct itself if an earlier state callback was missed.
        @JavascriptInterface
        fun nativeAudioSyncState() {
            runOnUiThread {
                val c = mediaController
                reportPlaying(
                    c != null && c.playWhenReady &&
                        (c.playbackState == Player.STATE_READY || c.playbackState == Player.STATE_BUFFERING)
                )
            }
        }

        @JavascriptInterface
        fun nativeAudioPlay() {
            runOnUiThread { mediaController?.play() }
        }

        @JavascriptInterface
        fun nativeAudioPause() {
            runOnUiThread { mediaController?.pause() }
        }

        @JavascriptInterface
        fun nativeAudioSeek(seconds: Double) {
            runOnUiThread { mediaController?.seekTo((seconds * 1000).toLong()) }
        }

        // The volume slider's real effect: sets the phone's media volume
        // (the stream both ExoPlayer and the WebView play on).
        @JavascriptInterface
        fun setSystemVolume(volume: Double) {
            try {
                val am = getSystemService(AudioManager::class.java) ?: return
                val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
                val level = Math.round(volume.coerceIn(0.0, 1.0) * max).toInt()
                am.setStreamVolume(AudioManager.STREAM_MUSIC, level, 0)
            } catch (e: Exception) {
                // Not permitted in the current device state — ignore.
            }
        }


        // True when a Bluetooth audio device (headphones, speaker, car, hearing
        // aid) is connected as an output. audio-player.js asks once at start-up
        // to decide whether the music should start by itself. Needs no
        // permission: AudioManager only lists the devices.
        @JavascriptInterface
        fun isBluetoothAudioConnected(): Boolean {
            val am = getSystemService(AudioManager::class.java) ?: return false
            return am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { isBluetoothMusicOutput(it.type) }
        }



        @JavascriptInterface
        fun getSystemVolume(): Double {
            return try {
                val am = getSystemService(AudioManager::class.java) ?: return 0.8
                val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
                if (max <= 0) 0.8 else am.getStreamVolume(AudioManager.STREAM_MUSIC).toDouble() / max
            } catch (e: Exception) {
                0.8
            }
        }

        @JavascriptInterface
        fun nativeAudioSetVolume(volume: Double) {
            runOnUiThread {
                // During a crossfade the ramp owns the players' volume; the new
                // level is only the target the incoming track fades up to.
                val xf = PlaybackService.crossfade
                if (xf != null && xf.isActive()) {
                    xf.setInGain(volume.toFloat())
                } else {
                    mediaController?.volume = volume.toFloat().coerceIn(0f, 1f)
                }
            }
        }

        // Replay-gain boost for quiet tracks (see NativeAudioEffects.kt).
        @JavascriptInterface
        fun nativeAudioSetBoostDb(db: Double) {
            runOnUiThread {
                PlaybackService.effects?.setBoostDb(db.toFloat())
            }
        }
    }

    private fun hasStoragePermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            // Read AND write: without write the Novel folder can't be created.
            ContextCompat.checkSelfPermission(
                this,
                android.Manifest.permission.READ_EXTERNAL_STORAGE
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED &&
                ContextCompat.checkSelfPermission(
                    this,
                    android.Manifest.permission.WRITE_EXTERNAL_STORAGE
                ) == android.content.pm.PackageManager.PERMISSION_GRANTED
        }
    }


    /** Creates this app's folders (the music folder and the settings folder). */
    private fun ensureFolders(): Boolean {
        return try {
            if (!audioRoot.exists()) audioRoot.mkdirs()
            if (!playerRoot.exists()) playerRoot.mkdirs()
            if (!songsRoot.exists()) songsRoot.mkdirs()
            audioRoot.isDirectory
        } catch (e: Exception) {
            false
        }
    }

    /** Storage access is there: make sure the folders exist, then read the music library. */
    private fun onStorageReady() {
        Thread {
            ensureFolders()
            runAudioScan()
            runOnUiThread { hasLoadedOnce = true }
        }.start()
    }

    private fun requestPermissionIfNeededThenLoad() {
        if (hasStoragePermission()) {
            onStorageReady()
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
                intent.data = Uri.parse("package:$packageName")
                manageStorageLauncher.launch(intent)
            } catch (e: Exception) {
                // Some devices don't support the app-specific screen; fall back
                // to the general "All files access" settings list.
                val intent = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                manageStorageLauncher.launch(intent)
            }
        } else {
            legacyPermissionLauncher.launch(
                arrayOf(
                    android.Manifest.permission.READ_EXTERNAL_STORAGE,
                    android.Manifest.permission.WRITE_EXTERNAL_STORAGE
                )
            )
        }
    }



    // ---- Audio library scan: starts at launch, runs in parallel, caches tags ----
    // The scan used to start only when the page asked for it and read every
    // file's tags one after another. Now it starts in onCreate (alongside the
    // chapter loading), reads tags on several threads, and remembers each
    // file's tags (keyed by path + size + modified time) so unchanged files
    // are not parsed again on the next launch.
    @Volatile private var audioScanRunning = false
    @Volatile private var jsWantsAudio = false
    @Volatile private var audioScanJson: String? = null
    @Volatile private var audioScanAt = 0L

    private fun deliverAudioList(tracksJson: String) {
        callPage("onAudioListed", JSONObject.quote(tracksJson))
    }

    /** Page start-up request: reuse a fresh early scan, or wait for the one in flight. */
    private fun requestAudioListAtStartup() {
        jsWantsAudio = true
        val ready = audioScanJson
        if (ready != null && System.currentTimeMillis() - audioScanAt < 120_000L) {
            deliverAudioList(ready)
        } else if (!audioScanRunning) {
            runAudioScan()
        } // else: a scan is running and delivers to the page when it finishes
    }

    private fun tagCacheFile() = File(cacheDir, "audio_tags.json")

    private fun loadTagCache(): java.util.concurrent.ConcurrentHashMap<String, JSONObject> {
        val map = java.util.concurrent.ConcurrentHashMap<String, JSONObject>()
        try {
            val f = tagCacheFile()
            if (f.exists()) {
                val root = JSONObject(f.readText())
                for (k in root.keys()) map[k] = root.getJSONObject(k)
            }
        } catch (e: Exception) {
            // Unreadable cache: just rebuild it.
        }
        return map
    }

    private fun saveTagCache(cache: Map<String, JSONObject>, livePaths: Set<String>) {
        try {
            val root = JSONObject()
            for ((k, v) in cache) if (livePaths.contains(k)) root.put(k, v)
            tagCacheFile().writeText(root.toString())
        } catch (e: Exception) {
            // Cache is an optimisation only.
        }
    }

    /**
     * Recursively scans audioRoot for files with a recognised extension,
     * reads title/artist/album/duration tags off each with
     * MediaMetadataRetriever, and sends the result to
     * window.onAudioListed() as a JSON array — the contract
     * audio-player.js's MediaLibrary.onScanned() expects: each entry has
     * id, path (a file:// URI), title, artist, album, durationSec, playlist.
     *
     * Runs on a background thread, same reasoning as onStorageReady()/
     * the old chapter loading: MediaMetadataRetriever is slow enough per file
     * (opening and parsing the container) that a few hundred tracks would
     * visibly freeze the UI thread otherwise.
     *
     * Every retriever call is individually try/caught with its own
     * fallback (filename as title, empty artist/album, zero duration) so
     * that one malformed or DRM'd file can't abort the whole scan — this
     * is the "VLC-style robustness" half of the brief: a library scan
     * should degrade gracefully per file, never fail wholesale.
     *
     * PLAYLISTS: subfolders directly under Audio/ become playlists named
     * after the folder, and everything inside them (however deep) belongs
     * to that playlist; files sitting directly in Audio/ itself are
     * reported with no playlist (audio-player.js's MediaLibrary treats
     * that as "not in a playlist" rather than an error). Example:
     *   Audio/
     *     Lo-fi Focus/2AM.mp3       -> playlist "Lo-fi Focus"
     *     Lo-fi Focus/Rain.mp3      -> playlist "Lo-fi Focus"
     *     Podcasts/Ep1/part1.mp3    -> playlist "Podcasts" (nested folders
     *                                  inside a playlist still count as
     *                                  that same playlist — there's only
     *                                  one level of grouping)
     *     standalone-track.mp3      -> no playlist
     */
    private fun runAudioScan() {
        if (audioScanRunning) return
        audioScanRunning = true
        Thread {
            try {
                if (!hasStoragePermission()) {
                    audioScanRunning = false
                    if (jsWantsAudio) runOnUiThread {
                        notifyError("Storage permission is needed to read /storage/emulated/0/Novel/Audio.")
                    }
                    return@Thread
                }

                if (!audioRoot.exists()) {
                    audioRoot.mkdirs()
                }

                // Sorted by path-relative-to-Audio/ (not just filename) so
                // tracks in the same playlist folder stay grouped together.
                // Folders starting with a dot are skipped: Audio/.staging/ holds songs of the Download
                // tab that are not named or placed yet.
                // Two places are read: the old music folder (Novel/Audio, one sub-folder per playlist,
                // listed first as before) and the shared Moonlight/Songs folder where downloads go.
                fun walk(root: File): List<File> = if (!root.isDirectory) emptyList() else root.walkTopDown()
                    .filter { it.isFile && audioExtensions.contains(it.extension.lowercase()) }
                    .filter { f -> f.toRelativeString(root).split(File.separatorChar).none { it.startsWith(".") } }
                    .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.toRelativeString(root) })
                    .toList()
                val audioFiles = (walk(audioRoot) + walk(songsRoot))
                    // One record per real file: a file reachable twice (a symlink or a copy of the
                    // folder layout) is indexed once, under the first path in scan order.
                    .distinctBy { try { it.canonicalPath } catch (e: Exception) { it.absolutePath } }

                // Shared Songs folder + old folder playlists -> playlist files. Never touches a
                // music file, never overwrites a playlist file, safe to run on every scan.
                try {
                    songLibrary.ensureSongsDir()
                    songLibrary.migrateFolders(audioFiles)
                } catch (e: Exception) {
                    // Playlist files are an addition: the scan must work without them.
                }
                val membership = try { songLibrary.membership() } catch (e: Exception) { emptyMap() }

                val cache = loadTagCache()
                val results = arrayOfNulls<JSONObject>(audioFiles.size)
                val pool = java.util.concurrent.Executors.newFixedThreadPool(4)
                audioFiles.forEachIndexed { i, f ->
                    pool.execute {
                        results[i] = try { buildTrackJson(f, cache, membership) } catch (e: Exception) { null }
                    }
                }
                pool.shutdown()
                pool.awaitTermination(15, java.util.concurrent.TimeUnit.MINUTES)

                val tracksArray = JSONArray()
                for (r in results) if (r != null) tracksArray.put(r)
                saveTagCache(cache, audioFiles.map { it.absolutePath }.toSet())

                val json = tracksArray.toString()
                audioScanJson = json
                audioScanAt = System.currentTimeMillis()
                audioScanRunning = false

                runOnUiThread { if (jsWantsAudio) deliverAudioList(json) }
            } catch (e: Exception) {
                audioScanRunning = false
                if (jsWantsAudio) runOnUiThread { notifyError("Could not scan /storage/emulated/0/Novel/Audio: ${e.message}") }
            }
        }.start()
    }

    private fun buildTrackJson(
        f: File,
        cache: java.util.concurrent.ConcurrentHashMap<String, JSONObject>,
        membership: Map<String, List<String>> = emptyMap(),
    ): JSONObject {
        val obj = JSONObject()
        obj.put("id", f.absolutePath)
        obj.put("path", Uri.fromFile(f).toString()) // percent-encodes spaces etc. correctly
        val inSongs = f.absolutePath.startsWith(songsRoot.absolutePath + File.separator)
        val root = if (inSongs) songsRoot else audioRoot
        val relativePath = f.toRelativeString(root).replace(File.separatorChar, '/')
        // The canonical local reference: what playlist files store ("Songs/a.mp3", "Audio/Folder/a.mp3";
        // see SongLibrary.kt).
        val ref = songLibrary.refFor(f) ?: ((if (inSongs) "Songs/" else "Audio/") + relativePath)
        obj.put("ref", ref)
        obj.put("artworkRef", Uri.fromFile(f).toString())   // cover art is loaded lazily from this file
        // Address the page's <audio> element uses (see serveAudio()).
        obj.put("webUrl", "https://$appHost/" + (if (inSongs) "songs/" else "audio/") + Uri.encode(relativePath, "/"))
        // Old folder layout: the first path segment under Novel/Audio is the playlist; a file directly
        // in Audio/ has none. Moonlight/Songs is the shared store, not a playlist.
        val slashIndex = relativePath.indexOf('/')
        val legacyPlaylist = if (!inSongs && slashIndex > 0) relativePath.substring(0, slashIndex) else null
        if (legacyPlaylist != null) obj.put("playlist", legacyPlaylist) else obj.put("playlist", JSONObject.NULL)
        obj.put("inSongs", inSongs)

        // Every playlist the song belongs to: its old folder plus the playlist files that list it.
        // `playlist` (single) stays for older screens; the first one is used when only a file lists it.
        val names = LinkedHashSet<String>()
        if (legacyPlaylist != null) names.add(legacyPlaylist)
        membership[ref]?.let { names.addAll(it) }
        if (legacyPlaylist == null && names.isNotEmpty()) obj.put("playlist", names.first())
        obj.put("playlists", JSONArray(names.toList()))

        val size = f.length()
        val modified = f.lastModified()
        val hit = cache[f.absolutePath]
        val tags: JSONObject
        // Entries cached before the genre/album-artist fields existed are read again once.
        if (hit != null && hit.optLong("s", -1L) == size && hit.optLong("m", -1L) == modified &&
            hit.getJSONObject("t").has("tagsV")) {
            tags = hit.getJSONObject("t")
        } else {
            tags = JSONObject()
            readAudioTags(f, tags)
            cache[f.absolutePath] = JSONObject().put("s", size).put("m", modified).put("t", tags)
        }
        for (k in tags.keys()) obj.put(k, tags.get(k))
        return obj
    }

    /**
     * Cover art for the track at `path` (a file:// URI), as a JPEG scaled
     * to at most 512px so it is cheap to hand to the notification and the
     * WebView. Looks for embedded art first, then a cover/folder image in
     * the same folder. Results are cached in cacheDir/art so each file is
     * only decoded once. Returns null when there is no art.
     */
    private fun loadArtworkBytes(path: String): ByteArray? {
        return try {
            val file = resolveAudioFile(path) ?: return null
            val dir = File(cacheDir, "art").apply { mkdirs() }
            val key = (file.absolutePath + file.lastModified()).hashCode().toString()
            val cached = File(dir, "$key.jpg")
            val none = File(dir, "$key.none")
            if (cached.exists()) return cached.readBytes()
            if (none.exists()) return null

            var raw: ByteArray? = null
            var tagsUnreadable = false   // reading the tags failed: could be passing (file busy), so don't remember "no art"
            val retriever = MediaMetadataRetriever()
            try {
                retriever.setDataSource(file.absolutePath)
                raw = retriever.embeddedPicture
            } catch (e: Exception) {
                tagsUnreadable = true
                // fall through to folder images
            } finally {
                try { retriever.release() } catch (e: Exception) { }
            }
            if (raw == null) {
                val names = listOf("cover", "folder", "front", "album", "albumart", "artwork")
                val exts = listOf("jpg", "jpeg", "png", "webp")
                val siblings = file.parentFile?.listFiles()
                val match = siblings?.firstOrNull { f ->
                    f.isFile && names.contains(f.nameWithoutExtension.lowercase()) &&
                        exts.contains(f.extension.lowercase())
                }
                raw = match?.readBytes()
            }
            if (raw == null) {
                // Only a song that was read fine and has no picture is remembered as having none.
                if (!tagsUnreadable) none.createNewFile()
                return null
            }
            val scaled = scaleToJpeg(raw, 512)
            if (scaled == null) {
                none.createNewFile()
                return null
            }
            cached.writeBytes(scaled)
            scaled
        } catch (e: Exception) {
            null
        }
    }


    private fun scaleToJpeg(raw: ByteArray, maxSide: Int): ByteArray? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= maxSide && bounds.outHeight / (sample * 2) >= maxSide) sample *= 2
        val bmp = BitmapFactory.decodeByteArray(
            raw, 0, raw.size, BitmapFactory.Options().apply { inSampleSize = sample }
        ) ?: return null
        val longest = maxOf(bmp.width, bmp.height)
        val out = if (longest > maxSide) {
            val f = maxSide.toFloat() / longest
            Bitmap.createScaledBitmap(bmp, (bmp.width * f).toInt().coerceAtLeast(1), (bmp.height * f).toInt().coerceAtLeast(1), true)
        } else bmp
        val baos = ByteArrayOutputStream()
        out.compress(Bitmap.CompressFormat.JPEG, 85, baos)
        return baos.toByteArray()
    }

    /**
     * Reads title/artist/album/duration off one file into `obj`, falling
     * back to sensible defaults (filename as title, 0 duration) on any
     * failure. Always releases the retriever, even on exception — a leaked
     * MediaMetadataRetriever is a real native-memory leak, not just a
     * dangling Java object, so this can't be left to the garbage collector.
     */
    /**
     * The distinct artist names of a song from its artist and album-artist tags. A tag may hold several
     * names separated by ";" or a line break (not "/" or "&": "AC/DC" and "Simon & Garfunkel" are one
     * name). Names are compared case-insensitively and ignoring accents, and the first spelling wins.
     */
    private fun distinctArtists(vararg tags: String): List<String> {
        val seen = LinkedHashMap<String, String>()
        for (t in tags) for (part in t.split(';', '\n', '\u0000')) {
            val name = part.trim()
            if (name.isEmpty()) continue
            val key = java.text.Normalizer.normalize(name, java.text.Normalizer.Form.NFD)
                .replace(Regex("\\p{M}+"), "").lowercase(java.util.Locale.ROOT)
            if (!seen.containsKey(key)) seen[key] = name
        }
        return seen.values.toList()
    }

    private fun readAudioTags(f: File, obj: JSONObject) {
        val retriever = MediaMetadataRetriever()
        obj.put("tagsV", 2)
        // Fields a file does not carry stay empty: nothing is made up. Only the title falls back to the
        // file name, and `titleFromTag` says which of the two it is.
        try {
            retriever.setDataSource(f.absolutePath)
            fun tag(key: Int): String = retriever.extractMetadata(key)?.trim() ?: ""
            val tagTitle = tag(MediaMetadataRetriever.METADATA_KEY_TITLE)
            val artist = tag(MediaMetadataRetriever.METADATA_KEY_ARTIST)
            val albumArtist = tag(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST)
            val album = tag(MediaMetadataRetriever.METADATA_KEY_ALBUM)
            val genre = tag(MediaMetadataRetriever.METADATA_KEY_GENRE)
            val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull() ?: 0L
            val hasVideo = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO) == "yes"

            obj.put("title", tagTitle.ifEmpty { f.nameWithoutExtension })
            obj.put("titleFromTag", tagTitle.isNotEmpty())
            obj.put("artist", artist)
            obj.put("albumArtist", albumArtist)
            // One entry per distinct person even when artist and album artist repeat each other
            // ("A; A", "A" + "a"): a song stays ONE row, and each artist is listed once.
            obj.put("artists", JSONArray(distinctArtists(artist, albumArtist)))
            obj.put("album", album)
            obj.put("genre", genre)
            obj.put("mediaType", if (hasVideo) "video" else "audio")
            obj.put("durationSec", durationMs / 1000.0)
        } catch (e: Exception) {
            // Malformed tags, unsupported codec for tag-reading, etc. —
            // the file may still be playable even though we couldn't read
            // its tags, so it stays in the list with filename-based
            // fallbacks rather than being dropped.
            obj.put("title", f.nameWithoutExtension)
            obj.put("titleFromTag", false)
            obj.put("artist", "")
            obj.put("albumArtist", "")
            obj.put("artists", JSONArray())
            obj.put("album", "")
            obj.put("genre", "")
            obj.put("mediaType", "audio")
            obj.put("durationSec", 0.0)
        } finally {
            try {
                retriever.release()
            } catch (e: Exception) {
                // Nothing more we can do if release() itself fails.
            }
        }
        addReplayGain(f, obj)
    }

    /**
     * Adds the file's ReplayGain tags (read by ReplayGainReader, since
     * MediaMetadataRetriever cannot) as replayGainTrackDb / replayGainAlbumDb /
     * replayGainPeak / replayGainAlbumPeak. Tags that are missing are simply
     * not added, so audio-player.js leaves that track's volume alone. Runs
     * even when the retriever failed above - the file may still have tags.
     */
    private fun addReplayGain(f: File, obj: JSONObject) {
        val rg = ReplayGainReader.read(f) ?: return
        rg.trackDb?.let { obj.put("replayGainTrackDb", it) }
        rg.albumDb?.let { obj.put("replayGainAlbumDb", it) }
        rg.trackPeak?.let { obj.put("replayGainPeak", it) }
        rg.albumPeak?.let { obj.put("replayGainAlbumPeak", it) }
    }

    private fun isAppUrl(u: Uri): Boolean =
        u.scheme == "https" && u.host == appHost && (u.path ?: "").startsWith("/assets/")

    private fun openInExternalBrowser(u: Uri) {
        try {
            startActivity(
                Intent(Intent.ACTION_VIEW, u)
                    .addCategory(Intent.CATEGORY_BROWSABLE)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (e: Exception) {
            // No browser installed: nothing to open.
        }
    }

    private fun plainResponse(code: Int): WebResourceResponse {
        val reason = when (code) {
            403 -> "Forbidden"
            404 -> "Not Found"
            405 -> "Method Not Allowed"
            416 -> "Range Not Satisfiable"
            else -> "Error"
        }
        return WebResourceResponse(
            "text/plain", "utf-8", code, reason, emptyMap(), ByteArrayInputStream(ByteArray(0))
        )
    }

    private fun audioMimeType(ext: String): String = when (ext.lowercase()) {
        "mp3" -> "audio/mpeg"
        "m4a" -> "audio/mp4"
        "aac" -> "audio/aac"
        "flac" -> "audio/flac"
        "ogg" -> "audio/ogg"
        "opus" -> "audio/ogg"
        "wav" -> "audio/wav"
        else -> "application/octet-stream"
    }

    /**
     * Serves one music file to the page's <audio> element from
     * https://appassets.androidplatform.net/audio/<path relative to Audio/>.
     * Goes through resolveAudioFile(), so only existing audio files that really
     * lie inside Novel/Audio can be read. Supports HTTP Range requests, which
     * the WebView's media player needs for seeking. Runs on a WebView
     * background thread.
     */
    private fun serveAudio(relativePath: String, headers: Map<String, String>, root: File = audioRoot): WebResourceResponse {
        val file = resolveAudioFile(File(root, relativePath).path) ?: return plainResponse(404)
        return try {
            val length = file.length()
            var start = 0L
            var end = length - 1
            var status = 200
            val rangeHeader = headers.entries.firstOrNull { it.key.equals("Range", ignoreCase = true) }?.value
            val match = rangeHeader?.let { Regex("^bytes=(\\d*)-(\\d*)$").matchEntire(it.trim()) }
            if (match != null && length > 0) {
                val first = match.groupValues[1]
                val last = match.groupValues[2]
                if (first.isNotEmpty() || last.isNotEmpty()) {
                    try {
                        if (first.isEmpty()) {
                            start = maxOf(0L, length - last.toLong())      // "last N bytes"
                        } else {
                            start = first.toLong()
                            if (last.isNotEmpty()) end = minOf(last.toLong(), length - 1)
                        }
                    } catch (e: NumberFormatException) {
                        return plainResponse(416)
                    }
                    if (start >= length || start > end) return plainResponse(416)
                    status = 206
                }
            }
            val count = if (length == 0L) 0L else end - start + 1
            val input = FileInputStream(file)
            input.channel.position(start)
            val responseHeaders = mutableMapOf(
                "Accept-Ranges" to "bytes",
                "Content-Length" to count.toString()
            )
            if (status == 206) responseHeaders["Content-Range"] = "bytes $start-$end/$length"
            WebResourceResponse(
                audioMimeType(file.extension), null, status,
                if (status == 206) "Partial Content" else "OK",
                responseHeaders, LimitedInputStream(input, count)
            )
        } catch (e: Exception) {
            plainResponse(404)
        }
    }

    private fun notifyError(message: String) {
        callPage("onFolderPickError", JSONObject.quote(message))
    }

    /**
     * Calls window.[fn]([args]) in the page, if the page has defined it yet.
     * [args] must already be valid JavaScript: numbers as they are, strings
     * through JSONObject.quote().
     */
    private fun callPage(fn: String, args: String = "") {
        if (!::webView.isInitialized) return
        webView.evaluateJavascript("window.$fn && window.$fn($args);", null)
    }

    /**
     * Bluetooth outputs that carry music. The phone-call link (SCO) is left out on purpose: it
     * shows up for a headset during calls, not for listening.
     */
    private fun isBluetoothMusicOutput(type: Int): Boolean = when (type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> true
        AudioDeviceInfo.TYPE_HEARING_AID -> Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
        AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER -> Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
        else -> false
    }

    /** Tells the page whether the native player is playing (window.onNativeAudioState). */
    private fun reportPlaying(playing: Boolean) {
        callPage("onNativeAudioState", JSONObject.quote(JSONObject().put("playing", playing).toString()))
    }

    /** Asks the audio panel to re-read the phone's media volume. */
    private fun syncPageVolume() {
        if (!::webView.isInitialized) return
        webView.evaluateJavascript(
            "window.NovelAudio && window.NovelAudio.syncVolume && window.NovelAudio.syncVolume();", null
        )
    }
}

/** Reads at most [remaining] bytes of [source] (used for HTTP Range responses). */
private class LimitedInputStream(source: InputStream, private var remaining: Long) : FilterInputStream(source) {
    override fun read(): Int {
        if (remaining <= 0) return -1
        val b = super.read()
        if (b >= 0) remaining--
        return b
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (remaining <= 0) return -1
        val n = super.read(b, off, minOf(len.toLong(), remaining).toInt())
        if (n > 0) remaining -= n
        return n
    }

    override fun available(): Int = minOf(super.available().toLong(), remaining).toInt()
}

/** When a WebView renderer last died; survives recreate() so a crash loop can be stopped. */
private var lastRendererGoneAt = 0L
