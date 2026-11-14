package com.scell.moonlight

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * A foreground Service that keeps the download process alive when the user switches away from
 * the app. Android kills background Activities, but a started foreground Service (with its
 * persistent notification) is allowed to continue work in the background.
 *
 * Lifecycle:
 *   startDownloadService(context)  — called by SongDownloader when the first download begins.
 *   stopDownloadService(context)   — called by SongDownloader when all downloads finish/fail.
 *
 * While running it posts a low-priority "Downloading…" notification on the DOWNLOAD channel.
 * Individual per-song notifications (progress, done, failed) are posted by SongDownloader itself
 * on a separate SONG_DL channel and auto-cancel after a few seconds.
 */
class DownloadForegroundService : Service() {

    inner class LocalBinder : Binder() {
        fun getService(): DownloadForegroundService = this@DownloadForegroundService
    }

    private val binder = LocalBinder()

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureChannels()
        startForeground(NOTIF_ID_FG, buildForegroundNotification())
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    // ---- notification builders -----------------------------------------------------------------

    private fun buildForegroundNotification(): Notification {
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val tap = PendingIntent.getActivity(
            this, 0, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_FG)
            .setSmallIcon(R.drawable.ic_stat_music)
            .setContentTitle("Moonlight download running")
            .setContentText("Songs are downloading in the background.")
            .setContentIntent(tap)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        if (nm.getNotificationChannel(CHANNEL_FG) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_FG, "Background download",
                    NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while songs are downloading in the background."
                }
            )
        }
        if (nm.getNotificationChannel(CHANNEL_SONG) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_SONG, "Song download updates",
                    NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Each song's download result."
                    setSound(null, null)
                }
            )
        }
    }

    companion object {
        const val CHANNEL_FG   = "moonlight_dl_fg"
        const val CHANNEL_SONG = "moonlight_dl_song"
        const val NOTIF_ID_FG  = 2010

        fun start(context: Context) {
            val intent = Intent(context, DownloadForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, DownloadForegroundService::class.java))
        }
    }
}
