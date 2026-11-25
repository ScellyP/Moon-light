package com.scell.moonlight

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.View
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Snapshot of active download progress rendered into Moonlight's custom download notification.
 */
data class DownloadNotifState(
    val active: Boolean = false,
    val isPlaylist: Boolean = false,
    val playlistTitle: String = "",
    val doneCount: Int = 0,
    val totalCount: Int = 0,
    val activeCount: Int = 0,
    val activeFractionSum: Double = 0.0,
    val percent: Int = -1,
    val speed: String = "",
    val etaSeconds: Long = -1L,
    val downloaded: String = "",
    val totalSize: String = "",
)

/**
 * Foreground Service that keeps active song/playlist downloads alive when the user switches away
 * from the app, and renders Moonlight's unified custom download notification.
 *
 * Unlike the old system (which used START_STICKY and multiple uncoordinated notifications), this
 * service:
 *   - Uses START_NOT_STICKY so Android never revives a phantom "downloading" notification.
 *   - Verifies [isActiveCheck] on every start command; if no download is actually active, it
 *     immediately removes its notification and stops itself.
 *   - Renders a single custom Moonlight-styled notification (for both single songs and playlists)
 *     with live progress, speed/ETA, and a Cancel action.
 */
class DownloadForegroundService : Service() {

    inner class LocalBinder : Binder() {
        fun getService(): DownloadForegroundService = this@DownloadForegroundService
    }

    private val binder = LocalBinder()

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startPending = false
        ensureChannels(this)
        if (intent?.action == ACTION_CANCEL) {
            isServiceRunning = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForeground(NOTIF_ID_FG, buildForegroundNotification(this, currentState))
            }
            cancelHandler?.invoke()
            dismissForegroundNotification(this)
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        val active = isActiveCheck?.invoke() == true
        if (!active) {
            isServiceRunning = false
            // Satisfy startForegroundService() contract if called right as a download ended,
            // then immediately clear the notification and stop.
            startForeground(NOTIF_ID_FG, buildForegroundNotification(this, currentState))
            dismissForegroundNotification(this)
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        isServiceRunning = true
        fgNotificationShowing = true
        startForeground(NOTIF_ID_FG, buildForegroundNotification(this, currentState))
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        startPending = false
        isServiceRunning = false
        fgNotificationShowing = false
        super.onDestroy()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    }

    companion object {
        const val CHANNEL_FG = "moonlight_dl_fg"
        const val CHANNEL_SONG = "moonlight_dl_song"
        const val NOTIF_ID_FG = 2010
        const val NOTIF_ID_RESULT = 2011
        private const val LEGACY_PLAYLIST_NOTIF_ID = 2001
        const val ACTION_CANCEL = "com.scell.moonlight.action.CANCEL_DOWNLOAD"
        private const val PREFS_ACCENT = "moonlight_notif_accent"
        private const val KEY_ACCENT = "accent"
        private const val KEY_ACCENT_STRONG = "accent_strong"
        private const val DEFAULT_ACCENT_COLOR = 0xFFBC44DD.toInt()
        private const val DEFAULT_ACCENT_STRONG_COLOR = 0xFFCB6FE5.toInt()
        private const val ERROR_COLOR = 0xFFEF5350.toInt()

        var cancelHandler: (() -> Unit)? = null
        var isActiveCheck: (() -> Boolean)? = null

        @Volatile
        private var isServiceRunning = false

        @Volatile
        private var fgNotificationShowing = false

        @Volatile
        private var startPending = false

        @Volatile
        private var cachedAccent: Int? = null

        @Volatile
        private var cachedAccentStrong: Int? = null

        @Volatile
        private var currentState = DownloadNotifState()

        private val mainHandler = Handler(Looper.getMainLooper())
        private var pendingResultDismiss: Runnable? = null

        fun getAccentColor(context: Context): Int {
            cachedAccent?.let { return it }
            val color = context.getSharedPreferences(PREFS_ACCENT, Context.MODE_PRIVATE)
                .getInt(KEY_ACCENT, DEFAULT_ACCENT_COLOR)
            cachedAccent = color
            return color
        }

        fun getAccentStrongColor(context: Context): Int {
            cachedAccentStrong?.let { return it }
            val color = context.getSharedPreferences(PREFS_ACCENT, Context.MODE_PRIVATE)
                .getInt(KEY_ACCENT_STRONG, DEFAULT_ACCENT_STRONG_COLOR)
            cachedAccentStrong = color
            return color
        }

        fun setNotificationAccent(context: Context, accentHex: String, accentStrongHex: String) {
            val prevAccent = getAccentColor(context)
            val prevStrong = getAccentStrongColor(context)
            val accent = parseColor(accentHex, DEFAULT_ACCENT_COLOR)
            val strong = parseColor(accentStrongHex, accent)
            if (prevAccent == accent && prevStrong == strong) return
            cachedAccent = accent
            cachedAccentStrong = strong
            context.getSharedPreferences(PREFS_ACCENT, Context.MODE_PRIVATE)
                .edit()
                .putInt(KEY_ACCENT, accent)
                .putInt(KEY_ACCENT_STRONG, strong)
                .apply()
            refreshActiveNotification(context)
        }

        fun refreshActiveNotification(context: Context) {
            val state = currentState
            if (!fgNotificationShowing || !state.active || isActiveCheck?.invoke() != true) return
            ensureChannels(context)
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
            nm.notify(NOTIF_ID_FG, buildForegroundNotification(context, state))
        }

        private fun parseColor(raw: String?, fallback: Int): Int {
            val s = raw?.trim().orEmpty()
            if (s.isEmpty()) return fallback
            return try {
                if (s.startsWith("#")) {
                    val hex = s.substring(1)
                    val full = when (hex.length) {
                        3 -> "FF${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}"
                        6 -> "FF$hex"
                        8 -> hex
                        else -> return fallback
                    }
                    full.toLong(16).toInt()
                } else if (s.startsWith("rgb", ignoreCase = true)) {
                    val nums = Regex("""[\d.]+""").findAll(s).mapNotNull { it.value.toFloatOrNull() }.toList()
                    if (nums.size >= 3) {
                        Color.rgb(
                            nums[0].toInt().coerceIn(0, 255),
                            nums[1].toInt().coerceIn(0, 255),
                            nums[2].toInt().coerceIn(0, 255)
                        )
                    } else {
                        fallback
                    }
                } else {
                    Color.parseColor(s)
                }
            } catch (_: Exception) {
                fallback
            }
        }

        fun start(context: Context, state: DownloadNotifState = currentState) {
            currentState = state
            if (!state.active || isActiveCheck?.invoke() != true) return
            ensureChannels(context)
            val intent = Intent(context, DownloadForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startPending = true
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            isServiceRunning = false
            currentState = DownloadNotifState(active = false)
            dismissForegroundNotification(context)
            if (!startPending) {
                context.stopService(Intent(context, DownloadForegroundService::class.java))
            }
        }

        fun updateProgress(context: Context, state: DownloadNotifState, showInShade: Boolean) {
            currentState = state
            if (!state.active || isActiveCheck?.invoke() != true) {
                stop(context)
                return
            }
            if (!showInShade && !isServiceRunning) return
            ensureChannels(context)
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
            fgNotificationShowing = true
            nm.notify(NOTIF_ID_FG, buildForegroundNotification(context, state))
        }

        fun postResultNotification(
            context: Context,
            title: String,
            body: String,
            isError: Boolean = false,
            autoCancelMs: Long = 6_000L,
        ) {
            ensureChannels(context)
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return

            pendingResultDismiss?.let { mainHandler.removeCallbacks(it) }

            val tapIntent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val tap = PendingIntent.getActivity(
                context, 2, tapIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val accentColor = getAccentColor(context)
            val customView = RemoteViews(context.packageName, R.layout.notification_download_result).apply {
                setTextViewText(R.id.notif_res_title, title)
                setTextViewText(R.id.notif_res_body, body)
                setTextViewText(R.id.notif_res_tag, if (isError) "Failed" else "Done")
                setTextColor(R.id.notif_res_tag, if (isError) ERROR_COLOR else accentColor)
            }

            val notif = NotificationCompat.Builder(context, CHANNEL_SONG)
                .setSmallIcon(R.drawable.ic_stat_music)
                .setColor(if (isError) ERROR_COLOR else accentColor)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.DecoratedCustomViewStyle())
                .setCustomContentView(customView)
                .setCustomBigContentView(customView)
                .setContentIntent(tap)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .build()

            nm.notify(NOTIF_ID_RESULT, notif)
            if (autoCancelMs > 0L) {
                val dismiss = Runnable { nm.cancel(NOTIF_ID_RESULT) }
                pendingResultDismiss = dismiss
                mainHandler.postDelayed(dismiss, autoCancelMs)
            }
        }

        fun clearResultNotification(context: Context) {
            pendingResultDismiss?.let { mainHandler.removeCallbacks(it) }
            pendingResultDismiss = null
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
            nm.cancel(NOTIF_ID_RESULT)
        }

        fun dismissForegroundNotification(context: Context) {
            fgNotificationShowing = false
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
            nm.cancel(NOTIF_ID_FG)
            nm.cancel(LEGACY_PLAYLIST_NOTIF_ID)
        }

        fun cancelAllDownloadNotifications(context: Context) {
            stop(context)
            clearResultNotification(context)
        }

        private fun formatEta(seconds: Long): String {
            if (seconds <= 0L) return ""
            val m = seconds / 60L
            val s = seconds % 60L
            return if (m > 0L) "${m}m ${s}s" else "${s}s"
        }

        private fun buildForegroundNotification(context: Context, state: DownloadNotifState): Notification {
            val tapIntent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val tap = PendingIntent.getActivity(
                context, 0, tapIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val cancelIntent = Intent(context, DownloadForegroundService::class.java).apply {
                action = ACTION_CANCEL
            }
            val cancelPending = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                PendingIntent.getForegroundService(
                    context, 1, cancelIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            } else {
                PendingIntent.getService(
                    context, 1, cancelIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            }

            val title = when {
                state.isPlaylist && state.playlistTitle.isNotBlank() ->
                    "Downloading \u201c${state.playlistTitle}\u201d"
                state.isPlaylist -> "Downloading playlist"
                state.activeCount > 1 -> "Downloading ${state.activeCount} songs"
                else -> "Downloading song"
            }

            val badge = when {
                state.isPlaylist && state.totalCount > 0 ->
                    "${state.doneCount.coerceAtMost(state.totalCount)} / ${state.totalCount}"
                state.percent in 0..100 -> "${state.percent}%"
                else -> ""
            }

            val progressValue = when {
                state.isPlaylist && state.totalCount > 0 -> {
                    val activeFrac = if (state.activeFractionSum > 0.0) {
                        state.activeFractionSum
                    } else if (state.percent in 0..100) {
                        state.percent / 100.0
                    } else {
                        0.0
                    }
                    (((state.doneCount + activeFrac) / state.totalCount.toDouble()) * 100.0)
                        .toInt()
                        .coerceIn(0, 100)
                }
                state.percent in 0..100 -> state.percent
                else -> -1
            }
            val indeterminate = progressValue < 0

            val metaParts = mutableListOf<String>()
            if (state.isPlaylist && progressValue in 0..100) {
                metaParts.add("$progressValue%")
            }
            if (state.downloaded.isNotBlank() && state.totalSize.isNotBlank()) {
                metaParts.add("${state.downloaded} / ${state.totalSize}")
            } else if (state.downloaded.isNotBlank()) {
                metaParts.add(state.downloaded)
            }
            if (state.speed.isNotBlank()) {
                metaParts.add(state.speed)
            }
            val eta = formatEta(state.etaSeconds)
            if (eta.isNotBlank()) {
                metaParts.add("ETA $eta")
            }

            val subtitle = when {
                metaParts.isNotEmpty() -> metaParts.joinToString(" \u2022 ")
                state.isPlaylist && state.totalCount > 0 ->
                    "${state.doneCount} of ${state.totalCount} songs done"
                else -> "Preparing download\u2026"
            }

            val detail = if (state.isPlaylist && state.totalCount > 0) {
                val pct = if (state.totalCount > 0) ((state.doneCount * 100) / state.totalCount).coerceIn(0, 100) else 0
                "${state.doneCount} of ${state.totalCount} songs finished ($pct%)"
            } else {
                ""
            }

            val accentColor = getAccentColor(context)
            val accentStrongColor = getAccentStrongColor(context)
            val collapsedBar = renderProgressBarBitmap(
                context, progressValue, indeterminate, 5f, accentColor, accentStrongColor
            )
            val expandedBar = renderProgressBarBitmap(
                context, progressValue, indeterminate, 6f, accentColor, accentStrongColor
            )

            val collapsed = RemoteViews(context.packageName, R.layout.notification_download_collapsed).apply {
                setTextViewText(R.id.notif_dl_title, title)
                setTextViewText(R.id.notif_dl_badge, badge)
                setTextColor(R.id.notif_dl_badge, accentColor)
                setViewVisibility(R.id.notif_dl_badge, if (badge.isNotEmpty()) View.VISIBLE else View.GONE)
                setTextViewText(R.id.notif_dl_subtitle, subtitle)
                setImageViewBitmap(R.id.notif_dl_progress, collapsedBar)
            }

            val expanded = RemoteViews(context.packageName, R.layout.notification_download_expanded).apply {
                setTextViewText(R.id.notif_dl_title, title)
                setTextViewText(R.id.notif_dl_badge, badge)
                setTextColor(R.id.notif_dl_badge, accentColor)
                setViewVisibility(R.id.notif_dl_badge, if (badge.isNotEmpty()) View.VISIBLE else View.GONE)
                setTextViewText(R.id.notif_dl_subtitle, subtitle)
                if (detail.isNotEmpty()) {
                    setTextViewText(R.id.notif_dl_detail, detail)
                    setViewVisibility(R.id.notif_dl_detail, View.VISIBLE)
                } else {
                    setViewVisibility(R.id.notif_dl_detail, View.GONE)
                }
                setImageViewBitmap(R.id.notif_dl_progress, expandedBar)
            }

            return NotificationCompat.Builder(context, CHANNEL_FG)
                .setSmallIcon(R.drawable.ic_stat_music)
                .setColor(accentColor)
                .setContentTitle(title)
                .setContentText(subtitle)
                .setStyle(NotificationCompat.DecoratedCustomViewStyle())
                .setCustomContentView(collapsed)
                .setCustomBigContentView(expanded)
                .setContentIntent(tap)
                .addAction(R.drawable.ic_stat_music, "Cancel", cancelPending)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build()
        }

        private fun renderProgressBarBitmap(
            context: Context,
            progressValue: Int,
            indeterminate: Boolean,
            heightDp: Float,
            accentColor: Int,
            accentStrongColor: Int,
        ): Bitmap {
            val density = context.resources.displayMetrics.density.coerceAtLeast(1f)
            val widthPx = (context.resources.displayMetrics.widthPixels - (48f * density).toInt()).coerceIn(240, 1080)
            val heightPx = (heightDp * density).toInt().coerceAtLeast(4)
            val bitmap = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            val radius = heightPx / 2f
            val trackRect = RectF(0f, 0f, widthPx.toFloat(), heightPx.toFloat())

            val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = 0x2E8E8E9E
                style = Paint.Style.FILL
            }
            canvas.drawRoundRect(trackRect, radius, radius, trackPaint)

            val clipPath = Path().apply {
                addRoundRect(trackRect, radius, radius, Path.Direction.CW)
            }
            canvas.save()
            canvas.clipPath(clipPath)

            if (indeterminate) {
                val segW = widthPx * 0.35f
                val left = (widthPx - segW) / 2f
                val right = left + segW
                val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    shader = LinearGradient(left, 0f, right, 0f, accentColor, accentStrongColor, Shader.TileMode.CLAMP)
                    style = Paint.Style.FILL
                }
                canvas.drawRoundRect(RectF(left, 0f, right, heightPx.toFloat()), radius, radius, fillPaint)
            } else if (progressValue > 0) {
                val clamped = progressValue.coerceIn(0, 100)
                val fillW = (widthPx * (clamped / 100f)).coerceAtLeast(heightPx.toFloat())
                val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    shader = LinearGradient(0f, 0f, fillW, 0f, accentColor, accentStrongColor, Shader.TileMode.CLAMP)
                    style = Paint.Style.FILL
                }
                canvas.drawRoundRect(RectF(0f, 0f, fillW, heightPx.toFloat()), radius, radius, fillPaint)
            }

            canvas.restore()
            return bitmap
        }

        private fun ensureChannels(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return

            if (nm.getNotificationChannel(CHANNEL_FG) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(
                        CHANNEL_FG,
                        "Background download",
                        NotificationManager.IMPORTANCE_LOW
                    ).apply {
                        description = "Shown while songs are downloading in the background."
                        setShowBadge(false)
                    }
                )
            }
            if (nm.getNotificationChannel(CHANNEL_SONG) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(
                        CHANNEL_SONG,
                        "Song download updates",
                        NotificationManager.IMPORTANCE_DEFAULT
                    ).apply {
                        description = "Each song's download result."
                        setSound(null, null)
                    }
                )
            }
        }
    }
}
