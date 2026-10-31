package com.scell.moonlight

import android.annotation.SuppressLint
import android.app.Dialog
import android.graphics.Color
import android.view.Gravity
import android.view.KeyEvent
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import java.io.File

/**
 * "Sign in to YouTube" for the downloader, so yt-dlp can get past YouTube's
 * "Sign in to confirm you're not a bot" check without exporting a cookies.txt by hand.
 *
 * HOW IT WORKS
 *  1. [start] opens a full-screen sign-in page (Google's own login, in a web view inside the app).
 *  2. When the page lands on youtube.com with a sign-in cookie present (or when you tap Done),
 *     the cookies are written as a Netscape cookies.txt into the app's PRIVATE storage
 *     (filesDir/youtube_cookies.txt). Nothing leaves the phone, and other apps cannot read it.
 *  3. SongDownloader hands yt-dlp a throw-away copy of that file for every download.
 *  4. [signOut] deletes the file and expires the cookies this sign-in created.
 *
 * WHAT IT DOES NOT DO: it never reads your password (it is typed into Google's own page), it does not
 * change the web view's user agent to look like a normal browser (Google may refuse sign-in inside an app's
 * web view; if so, use a cookies.txt exported from a browser instead, see README), and it cannot renew
 * cookies by itself: when they expire, sign in again.
 *
 * Android's CookieManager only returns "name=value" pairs, without domain, path or expiry, so the file
 * is written with the cookie's domain (.youtube.com / .google.com), path "/", secure, and an expiry
 * ~6 months ahead. That is enough for yt-dlp.
 */
class YouTubeSignIn(
    private val activity: ComponentActivity,
    /** Called on the UI thread when the sign-in state changed: (status, message), status = "signed-in" | "signed-out". */
    private val onChanged: (status: String, message: String) -> Unit,
) {

    companion object {
        const val COOKIE_FILE_NAME = "youtube_cookies.txt"

        private const val LOGIN_URL =
            "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F"

        /** Cookies that only exist while signed in. */
        private val AUTH_COOKIES = setOf("SAPISID", "__Secure-3PAPISID", "SID", "__Secure-3PSID")

        /** Where to read cookies from, and the domain each set is written under. */
        private val SOURCES = listOf(
            "https://www.youtube.com" to ".youtube.com",
            "https://accounts.google.com" to ".google.com",
        )

        fun cookieFile(dir: File) = File(dir, COOKIE_FILE_NAME)

        /** "a=b; c=d" -> [(a, b), (c, d)]; pieces without "=" are ignored. */
        fun parseHeader(header: String?): List<Pair<String, String>> =
            (header ?: "").split(';').map { it.trim() }
                .filter { it.indexOf('=') > 0 }
                .map { it.substringBefore('=') to it.substringAfter('=') }

        fun hasAuth(header: String?): Boolean = parseHeader(header).any { it.first in AUTH_COOKIES }

        /** Netscape cookie lines for one cookie header, under [domain]. Tabs/newlines in a value would break the line, so such cookies are skipped. */
        fun toNetscape(header: String?, domain: String, expiry: Long): String {
            val out = StringBuilder()
            for ((name, value) in parseHeader(header)) {
                if (name.any { it == '\t' || it == '\n' || it == '\r' } || value.any { it == '\t' || it == '\n' || it == '\r' }) continue
                out.append(domain).append('\t').append("TRUE").append('\t').append('/').append('\t')
                    .append("TRUE").append('\t').append(expiry).append('\t').append(name).append('\t').append(value).append('\n')
            }
            return out.toString()
        }
    }

    private val file: File get() = cookieFile(activity.filesDir)
    private var dialog: Dialog? = null

    /** "signed-in" when a saved cookie file holds a sign-in cookie, else "signed-out". */
    fun status(): String = try {
        val signedIn = file.isFile && file.readLines().any { line ->
            val parts = line.split('\t')
            parts.size >= 7 && parts[5] in AUTH_COOKIES
        }
        if (signedIn) "signed-in" else "signed-out"
    } catch (e: Exception) {
        "signed-out"
    }

    /** Opens the sign-in page. Call on the UI thread. */
    @SuppressLint("SetJavaScriptEnabled")
    fun start() {
        if (dialog?.isShowing == true) return
        val d = Dialog(activity, android.R.style.Theme_Black_NoTitleBar)
        val web = WebView(activity)
        web.settings.javaScriptEnabled = true      // Google's sign-in page needs it
        web.settings.domStorageEnabled = true
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)

        val bar = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#14161d"))
            setPadding(16, 8, 16, 8)
        }
        val cancel = Button(activity).apply { text = "Cancel" }
        val title = TextView(activity).apply {
            text = "Sign in to YouTube"
            setTextColor(Color.WHITE)
            textSize = 16f
            gravity = Gravity.CENTER
        }
        val done = Button(activity).apply { text = "Done" }
        bar.addView(cancel, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        bar.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(done, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        val rootView = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        rootView.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        rootView.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        d.setContentView(rootView)
        d.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)

        var finished = false
        fun close(message: String?) {
            if (finished) return
            finished = true
            try { d.dismiss() } catch (e: Exception) { /* already closed */ }
            if (message != null) onChanged(status(), message)
        }

        cancel.setOnClickListener { close(null) }
        done.setOnClickListener {
            if (saveCookies()) close("Signed in to YouTube. Try the download again.")
            else Toast.makeText(activity, "Finish signing in first.", Toast.LENGTH_SHORT).show()
        }
        d.setOnKeyListener { _, keyCode, event ->
            if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
                if (web.canGoBack()) web.goBack() else close(null)
                true
            } else {
                false
            }
        }
        web.webViewClient = object : WebViewClient() {
            // Sign-in finished: Google sends you on to youtube.com, and the sign-in cookies exist by then.
            override fun onPageFinished(view: WebView?, url: String?) {
                val host = try { android.net.Uri.parse(url ?: "").host ?: "" } catch (e: Exception) { "" }
                if (host == "youtube.com" || host.endsWith(".youtube.com")) {
                    if (hasAuth(CookieManager.getInstance().getCookie("https://www.youtube.com")) && saveCookies()) {
                        close("Signed in to YouTube. Try the download again.")
                    }
                }
            }
        }
        d.setOnDismissListener {
            try { web.stopLoading(); web.destroy() } catch (e: Exception) { /* nothing more to do */ }
            dialog = null
        }
        dialog = d
        web.loadUrl(LOGIN_URL)
        d.show()
    }

    /** Writes the cookies of the current web view session. False (nothing written) when no sign-in cookie is there. */
    private fun saveCookies(): Boolean {
        return try {
            val cm = CookieManager.getInstance()
            val expiry = System.currentTimeMillis() / 1000 + 180L * 24 * 3600
            val text = StringBuilder("# Netscape HTTP Cookie File\n# Written by Moonlight after you signed in to YouTube. Private: do not share.\n")
            var signedIn = false
            for ((url, domain) in SOURCES) {
                val header = cm.getCookie(url) ?: continue
                if (hasAuth(header)) signedIn = true
                text.append(toNetscape(header, domain, expiry))
            }
            if (!signedIn) return false
            val tmp = File(activity.filesDir, "$COOKIE_FILE_NAME.tmp")
            tmp.writeText(text.toString())
            if (!tmp.renameTo(file)) { file.writeText(text.toString()); tmp.delete() }
            true
        } catch (e: Exception) {
            false
        }
    }

    /** Deletes the saved cookies and expires the ones this sign-in put in the web view. */
    fun signOut(): Boolean {
        return try {
            val cm = CookieManager.getInstance()
            for ((url, domain) in SOURCES) {
                for ((name, _) in parseHeader(cm.getCookie(url))) {
                    cm.setCookie(url, "$name=; Domain=$domain; Path=/; Max-Age=0")
                }
            }
            cm.flush()
            file.delete()
            true
        } catch (e: Exception) {
            false
        }
    }
}
