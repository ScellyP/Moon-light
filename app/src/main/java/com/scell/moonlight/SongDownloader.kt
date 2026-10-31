package com.scell.moonlight

import android.os.Handler
import android.os.Looper
import androidx.activity.ComponentActivity
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import java.io.File
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The native half of the "Download songs" wizard (song-download.js). yt-dlp and ffmpeg run inside
 * this app (the youtubedl-android library bundles Python, yt-dlp and ffmpeg), so nothing has to be
 * installed or allowed anywhere else.
 *
 * The page runs two kinds of job, and may have one of each at the same time (the next song
 * downloads while the current one is being named and placed):
 *   - stage: download one link into the staging folder, Audio/.staging/<run>/ (the music scan skips
 *            folders that start with a dot, so nothing shows up in the library yet). The answer's
 *            message is the downloaded file's full path.
 *   - place: give a staged song its final name (file name and title tag) and move it into its
 *            playlist folder, or Audio/ itself. The answer's message is the song's new full path.
 *
 *   page   -> AndroidBridge.stageSong(jobId, url)                       -> [stage]
 *             AndroidBridge.placeSong(jobId, path, name, folder)         -> [place]
 *             AndroidBridge.cancelSongDownload()                          -> [cancel]  (stops every job)
 *   native -> window.onSongDownloadStatus(jobId, "done"|"failed", message)   (via [onStatus])
 *
 * Exactly one done/failed is reported per accepted job.
 *
 * Downloads: yt-dlp is started by the library as a child process (best audio -> mp3, tags and cover
 * art embedded). Stop = the library's destroyProcessById. Placing needs no ffmpeg: the title tag is
 * rewritten by [Id3Title]. yt-dlp breaks now and then when a site changes; the first failure of
 * a session therefore updates yt-dlp from within the app (the library's updater, one request to
 * GitHub) and retries once.
 *
 * Needs the INTERNET permission, and `useLegacyPackaging` for the native libraries (app/build.gradle).
 *
 * Written without being run on a device: test it there.
 */
class SongDownloader(
    private val activity: ComponentActivity,
    /** The shared Songs folder and the playlist files (see SongLibrary.kt). */
    private val library: () -> SongLibrary,
    /** Reports a result to the page. Always called on the main thread. */
    private val onStatus: (jobId: String, status: String, message: String) -> Unit,
) {

    companion object {
        /**
         * Where downloads wait until they are named and placed: a hidden folder inside the shared Songs
         * folder (Moonlight/Songs/.staging). Folders starting with a dot are skipped by the music scan,
         * and the move into Songs/ stays on the same storage, so it is instant.
         */
        const val STAGING_DIR = "/storage/emulated/0/Moonlight/Songs/.staging"

        /**
         * Optional: cookies exported from your own browser (Netscape cookies.txt format) for the days YouTube
         * answers "Sign in to confirm you're not a bot". Kept next to settings.txt in the Moonlight folder.
         * The file is only ever READ: yt-dlp gets a throw-away copy, because it rewrites the cookie file it is given.
         */
        const val COOKIES_FILE = "/storage/emulated/0/Moonlight/cookies.txt"

        /**
         * Player clients tried on a second go after the bot check. "web_embedded" and "android_vr" are the two
         * yt-dlp documents as working without a PO token; "default" stays first so nothing is lost.
         */
        const val FALLBACK_CLIENTS = "youtube:player_client=default,web_embedded,android_vr"

        /** Is this YouTube's "Sign in to confirm you're not a bot" check? */
        fun isBotCheck(message: String?): Boolean {
            val m = (message ?: "").lowercase()
            return m.contains("not a bot") || m.contains("sign in to confirm")
        }

        /** The old music folder (one sub-folder per playlist). Still read, never written to by downloads. */
        const val AUDIO_DIR = "/storage/emulated/0/Novel/Audio"

        /** Is [path] a file inside the staging folder? (Nothing else may be moved or renamed.) */
        fun isStagedPath(path: String?): Boolean {
            if (path.isNullOrBlank()) return false
            return try {
                val file = File(path).canonicalFile
                val root = File(STAGING_DIR).canonicalFile
                file.path.startsWith(root.path + File.separator) && file.isFile
            } catch (e: Exception) {
                false
            }
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private val pool: ExecutorService = Executors.newCachedThreadPool()
    private val lock = Any()
    private val running = HashSet<String>()                         // every accepted, unanswered job
    private val downloading = HashSet<String>()                     // the stage jobs among them
    private val cancelled = Collections.synchronizedSet(HashSet<String>())
    private var engineReady = false
    private val updateTried = AtomicBoolean(false)
    private val nightlyChecked = AtomicBoolean(false)

    /** Gets the bundled Python/yt-dlp/ffmpeg unpacked in the background (a few seconds, once per install). */
    fun warmUp() {
        pool.execute { ensureEngine() }
    }

    fun release() {
        pool.shutdownNow()
    }

    /** True while a job is unanswered (the app must not close itself meanwhile). */
    fun isBusy(): Boolean = synchronized(lock) { running.isNotEmpty() }

    /**
     * Accepts a download job. Returns false only when a job with this id is already running; every
     * other problem is reported to the page as a "failed" result with a message the user can act on.
     * May be called from the WebView's bridge thread.
     */
    fun stage(jobId: String, url: String): Boolean {
        if (!begin(jobId, isDownload = true)) return false
        pool.execute { runStage(jobId, url.trim()) }
        return true
    }

    /** Accepts a placement job: [path] is the staged file, [name] its final name ("" = keep it). */
    fun place(jobId: String, path: String, name: String, folder: String): Boolean {
        if (!begin(jobId, isDownload = false)) return false
        pool.execute { runPlace(jobId, path, SongNames.cleanSongName(name), folder) }
        return true
    }

    /** Stops every running download; each then reports "Stopped" by itself. */
    fun cancel() {
        val ids = synchronized(lock) { downloading.toList() }
        cancelled.addAll(ids)
        for (id in ids) {
            try { YoutubeDL.getInstance().destroyProcessById(id) } catch (e: Exception) { /* already over */ }
        }
    }

    private fun begin(jobId: String, isDownload: Boolean): Boolean = synchronized(lock) {
        val fresh = running.add(jobId)
        if (fresh && isDownload) downloading.add(jobId)
        fresh
    }

    // ---- worker threads from here on ---------------------------------------------------

    /** Unpacks and starts the bundled tools. Returns null when ready, else a message for the user. */
    @Synchronized
    private fun ensureEngine(): String? {
        if (engineReady) return null
        return try {
            val context = activity.applicationContext
            YoutubeDL.getInstance().init(context)
            FFmpeg.getInstance().init(context)
            engineReady = true
            null
        } catch (e: Exception) {
            "Could not start the built-in downloader (${e.message ?: e.cause?.message ?: "unknown error"})."
        }
    }

    private fun runStage(jobId: String, url: String) {
        if (!SongNames.isWebLink(url)) return report(jobId, "failed", "That doesn't look like a web link.")
        ensureEngine()?.let { return report(jobId, "failed", it) }
        if (jobId in cancelled) return report(jobId, "failed", "Stopped")

        val runDir = File(STAGING_DIR, "s_" + UUID.randomUUID().toString().take(8))
        // Half-finished downloads (.webm, .part, thumbnails) go to a cache folder, so the music scan
        // never sees them.
        val tmpDir = File(activity.cacheDir, "song_dl_" + UUID.randomUUID().toString().take(8))
        try {
            if (!runDir.mkdirs() && !runDir.isDirectory) {
                return report(jobId, "failed", "Can't create $STAGING_DIR. Allow \"All files access\" for this app.")
            }
            tmpDir.mkdirs()

            refreshYtDlpIfDue()          // nightly yt-dlp, see above
            var error = download(jobId, url, runDir, tmpDir)
            if (error != null && jobId !in cancelled && updateTried.compareAndSet(false, true)) {
                // yt-dlp goes stale when a site changes: update it once more (nightly), then try again.
                val updated = updateYtDlp() == YoutubeDL.UpdateStatus.DONE
                if (updated) {
                    runDir.listFiles()?.forEach { it.deleteRecursively() }
                    error = download(jobId, url, runDir, tmpDir)
                }
            }

            if (error != null && jobId !in cancelled && isBotCheck(error)) {
                // YouTube's bot check: one more go with player clients that need no PO token. If it fails
                // too, the bot check stays the reason shown (the second failure is usually just a symptom).
                runDir.listFiles()?.forEach { it.deleteRecursively() }
                if (download(jobId, url, runDir, tmpDir, fallbackClients = true) == null) error = null
            }

            if (jobId in cancelled) {
                runDir.deleteRecursively()
                return report(jobId, "failed", "Stopped")
            }
            if (error != null) {
                runDir.deleteRecursively()
                return report(jobId, "failed", explainFailure(error))
            }
            val song = runDir.listFiles { f -> f.isFile && f.extension.equals("mp3", ignoreCase = true) }
                ?.maxByOrNull { it.lastModified() }
            if (song == null) {
                runDir.deleteRecursively()
                return report(jobId, "failed", "The download finished but no song file was made.")
            }
            report(jobId, "done", song.absolutePath)
        } catch (e: Exception) {
            runDir.deleteRecursively()
            report(jobId, "failed", SongNames.failureReason(e.message).ifEmpty { "The download failed." })
        } finally {
            tmpDir.deleteRecursively()
        }
    }

    /** Runs yt-dlp once. Returns null on success, else the message to show. */
    private fun download(jobId: String, url: String, runDir: File, tmpDir: File, fallbackClients: Boolean = false): String? {
        // Same settings as the old script: best audio, converted to mp3 (quality 0), metadata and
        // cover art embedded, one video only.
        val request = YoutubeDLRequest(url)
            .addOption("--no-playlist")
            .addOption("-f", "bestaudio")
            .addOption("-x")
            .addOption("--audio-format", "mp3")
            .addOption("--audio-quality", "0")
            .addOption("--embed-metadata")
            .addOption("--embed-thumbnail")
            .addOption("--convert-thumbnails", "jpg")
            .addOption("--trim-filenames", "180")
            .addOption("-P", "home:" + runDir.absolutePath)
            .addOption("-P", "temp:" + tmpDir.absolutePath)
            .addOption("-o", "%(title)s.%(ext)s")
            .addOption("--no-warnings")
        // Your own cookies, when you put a cookies.txt in the Moonlight folder (a copy is used, see COOKIES_FILE).
        cookiesCopy(tmpDir)?.let { request.addOption("--cookies", it.absolutePath) }
        if (fallbackClients) request.addOption("--extractor-args", FALLBACK_CLIENTS)
        return try {
            YoutubeDL.getInstance().execute(request, jobId, null)
            null
        } catch (e: YoutubeDL.CanceledException) {
            "Stopped"
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            "Stopped"
        } catch (e: Exception) {
            SongNames.failureReason(e.message ?: e.cause?.message).ifEmpty { "The download failed." }
        }
    }

    /**
     * The library's NIGHTLY update channel (yt-dlp's builds made after every change to its master branch, with
     * the newest YouTube fixes). The channel's constant has been spelled differently between library versions
     * (NIGHTLY / _NIGHTLY, enum entry or object), so it is looked up by name: null when it is not found, and the
     * update then simply uses the library's default channel instead of the build failing.
     */
    private fun nightlyChannel(): YoutubeDL.UpdateChannel? {
        return try {
            val cls = YoutubeDL.UpdateChannel::class.java
            val fromEnum = cls.enumConstants?.firstOrNull { c -> ((c as Any) as? Enum<*>)?.name?.trimStart('_') == "NIGHTLY" }
            fromEnum
                ?: listOf("NIGHTLY", "_NIGHTLY").firstNotNullOfOrNull { n ->
                    try { cls.getField(n).get(null) as? YoutubeDL.UpdateChannel } catch (e: Exception) { null }
                }
                ?: cls.declaredClasses.firstOrNull { it.simpleName.trimStart('_') == "NIGHTLY" }?.let { k ->
                    try { k.getField("INSTANCE").get(null) as? YoutubeDL.UpdateChannel } catch (e: Exception) { null }
                }
        } catch (e: Throwable) {
            null
        }
    }

    /** Updates the bundled yt-dlp to the nightly build. The update status, or null when it could not run (offline, ...). */
    private fun updateYtDlp(): YoutubeDL.UpdateStatus? {
        return try {
            val ctx = activity.applicationContext
            val channel = nightlyChannel()
            if (channel != null) YoutubeDL.getInstance().updateYoutubeDL(ctx, channel)
            else YoutubeDL.getInstance().updateYoutubeDL(ctx)
        } catch (e: Throwable) {
            null
        }
    }

    /**
     * YouTube changes faster than yt-dlp's stable releases, so before the first download of an app run (and at
     * most every 6 hours) the bundled yt-dlp is brought up to the latest nightly. A failed check (offline) is
     * not remembered, so the next download tries again; the download itself never waits on more than this.
     */
    private fun refreshYtDlpIfDue() {
        if (!nightlyChecked.compareAndSet(false, true)) return
        val prefs = activity.getSharedPreferences("song_downloader", android.content.Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (now - prefs.getLong("ytdlpCheckedAt", 0L) < 6L * 3600 * 1000) return
        if (updateYtDlp() != null) prefs.edit().putLong("ytdlpCheckedAt", now).apply()
        else nightlyChecked.set(false)
    }

    /**
     * A throw-away copy of the cookies for one yt-dlp run, or null when there are none (or they are unusable).
     * The cookies from "Sign in to YouTube" (private app storage, see YouTubeSignIn.kt) come first, then a
     * cookies.txt you put in the Moonlight folder yourself.
     */
    private fun cookiesCopy(tmpDir: File): File? {
        return try {
            val candidates = listOf(YouTubeSignIn.cookieFile(activity.filesDir), File(COOKIES_FILE))
            val src = candidates.firstOrNull { it.isFile && it.length() > 0L && it.length() <= 2_000_000L } ?: return null
            val copy = File(tmpDir, "cookies.txt")
            src.copyTo(copy, overwrite = true)
            copy
        } catch (e: Exception) {
            null
        }
    }

    /** The message the page shows for a failed download: the bot check gets steps to follow, the rest stays as yt-dlp said it. */
    private fun explainFailure(error: String): String {
        if (!isBotCheck(error)) return error
        val usedCookies = YouTubeSignIn.cookieFile(activity.filesDir).isFile || File(COOKIES_FILE).isFile
        return if (usedCookies) {
            "YouTube still says \u201cSign in to confirm you\u2019re not a bot\u201d even with your sign-in. " +
                "It may have expired: sign out and sign in to YouTube again, or try another network (VPN off), then retry."
        } else {
            "YouTube says \u201cSign in to confirm you\u2019re not a bot\u201d and refused this download. " +
                "Tap \u201cSign in\u201d below to sign in to YouTube once, or try another network (switch Wi\u2011Fi / mobile data, VPN off), then retry."
        }
    }

    private fun runPlace(jobId: String, path: String, name: String, folder: String) {
        val cleanedFolder = SongNames.cleanFolder(folder)
        if (!isStagedPath(path)) return report(jobId, "failed", "That song is no longer there. Download it again.")
        if (folder.isNotBlank() && cleanedFolder.isEmpty()) {
            return report(jobId, "failed", "That playlist name has no usable letters or numbers.")
        }

        // Every song lands in the one shared Songs folder. The playlist the user chose only gets a
        // REFERENCE to it (a line in the playlist's file), never a folder or a second copy.
        val lib = library()
        val staged = File(path)
        val stem = name.ifEmpty { staged.nameWithoutExtension }
        if (!lib.ensureSongsDir()) {
            return report(jobId, "failed", "Can't create ${lib.songsDir.path}. Allow \"All files access\" for this app.")
        }
        val target = File(lib.songsDir, stem + "." + staged.extension)
        if (target.exists()) {
            return report(jobId, "failed",
                "A song called \u201c$stem\u201d is already in your Songs. Change the name.")
        }

        // With a name, the title tag is rewritten into a second file first, so a failure leaves the
        // staged song untouched. ".part" is not an audio extension, so the music scan ignores it.
        var source = staged
        var copy: File? = null
        if (name.isNotEmpty()) {
            copy = File(staged.parentFile, ".retag_" + UUID.randomUUID().toString().take(8) + ".part")
            try {
                Id3Title.copyWithTitle(staged, copy, name)
                source = copy
            } catch (e: Exception) {
                copy.delete()
                return report(jobId, "failed", "Could not change the song's title (${e.message ?: "unknown error"}).")
            }
        }

        val moved = source.renameTo(target) || try {         // renameTo is an instant move on the same storage
            source.copyTo(target, overwrite = false)
            true
        } catch (e: Exception) {
            target.delete()
            false
        }
        copy?.let { if (it.exists()) it.delete() }
        if (!moved) return report(jobId, "failed", "Could not move the song into Songs.")

        // Register the song with the playlist. If that fails, undo the move so the staged song is back
        // and "Try again" works (a leftover copy in Songs would make the retry say "already there").
        if (cleanedFolder.isNotEmpty()) {
            val ref = lib.refFor(target)
            val added = try {
                lib.migrateFolder(cleanedFolder)              // an old folder playlist keeps its songs
                ref != null && lib.addSong(cleanedFolder, ref, stem)
            } catch (e: Exception) {
                false
            }
            if (!added) {
                if (!staged.exists()) {
                    if (!target.renameTo(staged)) {
                        try { target.copyTo(staged, overwrite = false); target.delete() } catch (e: Exception) { /* the song stays in Songs */ }
                    }
                } else {
                    target.delete()
                }
                return report(jobId, "failed", "Could not add the song to \u201c$cleanedFolder\u201d. Try again.")
            }
        }

        staged.delete()
        staged.parentFile?.delete()                           // the song's own now-empty staging folder (only if empty)
        report(jobId, "done", target.absolutePath)
    }

    /** Hands a result to the main thread; the page hears about it there. */
    private fun report(jobId: String, status: String, message: String) {
        main.post { finish(jobId, status, message) }
    }

    private fun finish(jobId: String, status: String, message: String) {
        val mine = synchronized(lock) {
            downloading.remove(jobId)
            running.remove(jobId)
        }
        cancelled.remove(jobId)
        if (!mine) return                    // a late or repeated answer changes nothing
        onStatus(jobId, status, message)
    }
}
