package com.scell.moonlight

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.ConnectivityManager
import android.os.Build
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Updates the app while it is closed, with no server of our own and no Firebase.
 *
 * Android's JobScheduler wakes [UpdateJobService] about every 6 hours (only on an unmetered network,
 * not when the battery is low, and again after a reboot). The job asks GitHub Releases for the latest
 * version, the same way [AppUpdater] does; when it is newer, it downloads the APK (size and sha256
 * checked) and then tries to install it:
 *
 *   - Android 12+ can update an app it installed before WITHOUT a confirm screen (we ask for that
 *     with USER_ACTION_NOT_REQUIRED). When Android allows it, the update simply happens.
 *   - When Android wants a confirm tap, [UpdateInstallReceiver] shows a notification ("Moonlight vX
 *     is ready to install"); tapping it opens the system install screen. Android does not allow an app
 *     to open that screen by itself from the background, so this notification is as automatic as it
 *     gets without root.
 *
 * The install is held back (and tried again 30 minutes later) while music is playing or a song
 * download is running: the install restarts the app and would cut both. While the app is open the
 * in-app [AppUpdater] does the work and this job stays out of the way.
 *
 * It obeys the "Update automatically" switch (the same preference [AppUpdater] uses): switched off, the
 * job is cancelled.
 *
 * Written without being run on a device: test it there.
 */
class BackgroundUpdater(
    private val context: Context,
    private val isCancelled: () -> Boolean,
) {
    companion object {
        const val JOB_PERIODIC = 7101
        const val JOB_RETRY = 7102
        const val RESULT_ACTION = "com.scell.moonlight.BG_UPDATE_RESULT"
        const val EXTRA_TAG = "tag"
        const val CHANNEL_ID = "updates"
        const val NOTIFICATION_ID = 7103

        private const val PERIOD_MS = 6L * 60 * 60 * 1000
        private const val FLEX_MS = 60L * 60 * 1000
        private const val RETRY_MS = 30L * 60 * 1000
        private const val FILE_PREFIX = "moonlight-"
        private const val LATEST_URL = "https://api.github.com/repos/${AppUpdater.OWNER_REPO}/releases/latest"

        /** The "Update automatically" switch (shared with AppUpdater: file "updater", key "auto"). */
        fun autoEnabled(context: Context): Boolean =
            context.getSharedPreferences("updater", Context.MODE_PRIVATE).getBoolean("auto", true)

        /**
         * Makes sure the periodic job exists (or is gone, when automatic updates are off). Safe to call
         * on every launch: an existing job is left alone, so its schedule is not pushed back each time.
         */
        fun schedule(context: Context) {
            val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler ?: return
            try {
                if (!autoEnabled(context)) {
                    scheduler.cancel(JOB_PERIODIC)
                    scheduler.cancel(JOB_RETRY)
                    return
                }
                if (scheduler.getPendingJob(JOB_PERIODIC) != null) return
                val builder = JobInfo.Builder(JOB_PERIODIC, ComponentName(context, UpdateJobService::class.java))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED)
                    .setPeriodic(PERIOD_MS, FLEX_MS)
                    .setPersisted(true)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) builder.setRequiresBatteryNotLow(true)
                scheduler.schedule(builder.build())
            } catch (e: Exception) {
                // Scheduling is a convenience; the in-app updater still works.
            }
        }

        /** One more try in 30 minutes (music was playing, or a download was running). */
        fun scheduleRetry(context: Context) {
            val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler ?: return
            try {
                val info = JobInfo.Builder(JOB_RETRY, ComponentName(context, UpdateJobService::class.java))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED)
                    .setMinimumLatency(RETRY_MS)
                    .build()
                scheduler.schedule(info)
            } catch (e: Exception) {
                // The periodic job will try again anyway.
            }
        }

        fun notifyUpdate(context: Context, title: String, text: String, tap: PendingIntent?) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                manager.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "App updates", NotificationManager.IMPORTANCE_DEFAULT)
                )
            }
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                android.app.Notification.Builder(context, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION") android.app.Notification.Builder(context)
            }
            builder.setSmallIcon(R.drawable.ic_stat_music)
                .setContentTitle(title)
                .setContentText(text)
                .setAutoCancel(true)
            if (tap != null) builder.setContentIntent(tap)
            try {
                manager.notify(NOTIFICATION_ID, builder.build())
            } catch (e: Exception) {
                // No notification permission: nothing to do.
            }
        }
    }

    private val updatesDir by lazy { File(context.cacheDir, "updates") }

    /** One background check. Runs on a worker thread (see [UpdateJobService]). */
    fun run() {
        if (!autoEnabled(context)) return
        // The app is open: the in-app updater owns the job (and avoids two downloads at once).
        if (MainActivity.inForeground) return

        val installed = try {
            AppUpdater.versionFromScript(context.assets.open("version.js").bufferedReader().use { it.readText() })
        } catch (e: Exception) {
            ""
        }

        val release = fetchLatest() ?: return
        if (!AppUpdater.isNewer(release.tag, installed)) return
        if (isCancelled()) return

        val file = downloaded(release) ?: return
        if (isCancelled()) return

        // Hold the install back while it would hurt: it restarts the app.
        if (PlaybackService.playingNow || MainActivity.busyCheck?.invoke() == true || MainActivity.inForeground) {
            scheduleRetry(context)
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            // Needs the one-time "Install unknown apps" permission, which only the app can ask for.
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            val tap = launch?.let {
                PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            }
            notifyUpdate(context, "Moonlight ${release.tag} is ready", "Open the app once to allow installing the update.", tap)
            return
        }
        install(file, release.tag)
    }

    private class Release(val tag: String, val url: String, val size: Long, val sha256: String?)

    private fun fetchLatest(): Release? = try {
        val conn = open(LATEST_URL)
        conn.setRequestProperty("Accept", "application/vnd.github+json")
        if (conn.responseCode != 200) {
            conn.disconnect()
            null
        } else {
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()
            val json = JSONObject(body)
            val tag = json.optString("tag_name", "")
            val assets = json.optJSONArray("assets")
            var found: JSONObject? = null
            if (assets != null) {
                for (i in 0 until assets.length()) {
                    val a = assets.optJSONObject(i) ?: continue
                    if (a.optString("name", "").endsWith(".apk", ignoreCase = true)) {
                        found = a
                        break
                    }
                }
            }
            if (found == null || tag.isEmpty()) {
                null
            } else {
                val digest = found.optString("digest", "")
                Release(
                    tag,
                    found.optString("browser_download_url", ""),
                    found.optLong("size", 0L),
                    if (digest.startsWith("sha256:")) digest.substring(7).lowercase() else null,
                )
            }
        }
    } catch (e: Exception) {
        null
    }

    /** The APK of [release] on disk and verified, downloading it first if needed. Null on any problem. */
    private fun downloaded(release: Release): File? {
        if (release.url.isEmpty()) return null
        updatesDir.mkdirs()
        val name = FILE_PREFIX + release.tag + ".apk"
        val done = File(updatesDir, name)
        // Already there (the in-app updater or an earlier run got it).
        if (done.isFile && (release.size <= 0 || done.length() == release.size)) return done

        if (isMetered()) return null          // the APK is big: unmetered networks only
        val part = File(updatesDir, "$name.bg")
        return try {
            val conn = open(release.url)
            conn.readTimeout = 30000
            if (conn.responseCode != 200) {
                conn.disconnect()
                return null
            }
            val digest = MessageDigest.getInstance("SHA-256")
            var written = 0L
            conn.inputStream.use { input ->
                part.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        if (isCancelled()) {
                            part.delete()
                            return null
                        }
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        digest.update(buf, 0, n)
                        written += n
                    }
                }
            }
            conn.disconnect()
            if (release.size > 0 && written != release.size) {
                part.delete()
                return null
            }
            val expected = release.sha256
            if (expected != null) {
                val got = digest.digest().joinToString("") { "%02x".format(it) }
                if (got != expected) {
                    part.delete()
                    return null
                }
            }
            done.delete()
            if (part.renameTo(done)) done else null
        } catch (e: Exception) {
            part.delete()
            null
        }
    }

    private fun install(file: File, tag: String) {
        try {
            val installer = context.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            params.setAppPackageName(context.packageName)
            params.setSize(file.length())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
            val id = installer.createSession(params)
            val session = installer.openSession(id)
            try {
                FileInputStream(file).use { input ->
                    session.openWrite("moonlight.apk", 0, file.length()).use { out ->
                        input.copyTo(out)
                        session.fsync(out)
                    }
                }
                // Explicit (class set) and mutable: the installer fills in the result.
                val intent = Intent(RESULT_ACTION)
                    .setClass(context, UpdateInstallReceiver::class.java)
                    .putExtra(EXTRA_TAG, tag)
                var flags = PendingIntent.FLAG_UPDATE_CURRENT
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
                val pending = PendingIntent.getBroadcast(context, id, intent, flags)
                session.commit(pending.intentSender)
            } finally {
                session.close()
            }
        } catch (e: Exception) {
            notifyUpdate(context, "Moonlight $tag is ready", "Open the app to install the update.", launchTap())
        }
    }

    private fun launchTap(): PendingIntent? {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
        return PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun isMetered(): Boolean = try {
        (context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).isActiveNetworkMetered
    } catch (e: Exception) {
        true
    }

    private fun open(url: String): HttpURLConnection {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15000
        conn.readTimeout = 20000
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("User-Agent", "Moonlight-BackgroundUpdater")
        return conn
    }
}

/** The system wakes this for the scheduled job; the real work is in [BackgroundUpdater]. */
class UpdateJobService : JobService() {
    @Volatile private var cancelled = false

    override fun onStartJob(params: JobParameters): Boolean {
        cancelled = false
        Thread {
            try {
                BackgroundUpdater(applicationContext) { cancelled }.run()
            } catch (e: Exception) {
                // A failed check is not worth a crash; the next run tries again.
            }
            jobFinished(params, false)
        }.start()
        return true   // work continues on the thread above
    }

    override fun onStopJob(params: JobParameters): Boolean {
        cancelled = true
        return false  // the periodic schedule brings the next run
    }
}

/**
 * Receives the installer's answer for an install started by [BackgroundUpdater]. When Android needs
 * the user to confirm, the confirm screen is offered as a notification (an app may not open it from
 * the background).
 */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status != PackageInstaller.STATUS_PENDING_USER_ACTION) return   // success: the app was replaced
        val tag = intent.getStringExtra(BackgroundUpdater.EXTRA_TAG) ?: "update"
        @Suppress("DEPRECATION")
        val confirm: Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }
        val tap = confirm?.let {
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            PendingIntent.getActivity(context, 1, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        BackgroundUpdater.notifyUpdate(context, "Moonlight $tag is ready", "Tap to install the update.", tap)
    }
}
