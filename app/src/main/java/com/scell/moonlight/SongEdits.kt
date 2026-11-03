package com.scell.moonlight

import org.json.JSONObject
import java.io.File
import java.util.Locale

/**
 * Your edits to a song's title, artist and album, kept in Moonlight/song-edits.json.
 *
 * The edits are an OVERLAY: the music file and its tags are never touched, so every format works (mp3, m4a,
 * flac, ogg, ...), an edit can always be undone ("Reset to the file's info"), and the file stays exactly as
 * downloaded. The scan lays the edit over what the file says (see MainActivity.buildTrackJson).
 *
 * A song is found again by its file name (lower case) plus its size in bytes: a file that is moved between
 * folders (for example into Moonlight/Songs) keeps both, so its edits follow it. Replacing the file with a
 * different one, or renaming it, starts it fresh.
 *
 * File format (readable text, written atomically with a .bak copy of the previous one):
 *   { "v": 1, "edits": { "2am.mp3|4812345": { "title": "2 AM", "artist": "Someone", "album": "" } } }
 * A field that is missing or empty means "use what the file says".
 */
class SongEdits(private val file: File) {

    companion object {
        const val MAX_LEN = 200

        fun keyFor(f: File): String = f.name.lowercase(Locale.ROOT) + "|" + f.length()
    }

    private var cache: JSONObject? = null

    private fun parse(f: File): JSONObject? = try {
        if (f.isFile && f.length() > 0L && f.length() <= 5_000_000L) JSONObject(f.readText()).optJSONObject("edits") else null
    } catch (e: Exception) {
        null
    }

    @Synchronized
    private fun load(): JSONObject {
        cache?.let { return it }
        val loaded = parse(file) ?: parse(File(file.path + ".bak")) ?: JSONObject()
        cache = loaded
        return loaded
    }

    /** The edit of this song, or null when it has none. */
    @Synchronized
    fun get(f: File): JSONObject? = load().optJSONObject(keyFor(f))

    private fun clean(s: String?): String = (s ?: "").replace(Regex("[\\u0000-\\u001f]"), " ").trim().take(MAX_LEN)

    /**
     * Saves the edit of this song. Fields left empty are removed, so they show the file's own info again; when
     * all three are empty the edit is removed altogether. Returns false when the file could not be written.
     */
    @Synchronized
    fun set(f: File, title: String?, artist: String?, album: String?): Boolean {
        val edits = load()
        val key = keyFor(f)
        val entry = JSONObject()
        clean(title).let { if (it.isNotEmpty()) entry.put("title", it) }
        clean(artist).let { if (it.isNotEmpty()) entry.put("artist", it) }
        clean(album).let { if (it.isNotEmpty()) entry.put("album", it) }
        val previous = edits.optJSONObject(key)
        if (entry.length() == 0) edits.remove(key) else edits.put(key, entry)
        if (write(edits)) return true
        // Writing failed: put memory back the way it was, so what the page shows matches what is on disk.
        if (previous == null) edits.remove(key) else edits.put(key, previous)
        return false
    }

    /** Removes an edit by its key (see [keyFor]); used when the song file has been deleted. True when it is gone. */
    @Synchronized
    fun removeKey(key: String): Boolean {
        val edits = load()
        if (!edits.has(key)) return true
        val previous = edits.opt(key)
        edits.remove(key)
        if (write(edits)) return true
        edits.put(key, previous)
        return false
    }

    /** Removes the edit of this song (back to the file's own info). */
    @Synchronized
    fun clear(f: File): Boolean = set(f, null, null, null)

    private fun write(edits: JSONObject): Boolean {
        return try {
            file.parentFile?.mkdirs()
            if (file.isFile && parse(file) != null) file.copyTo(File(file.path + ".bak"), overwrite = true)
            val text = JSONObject().put("v", 1).put("edits", edits).toString(2)
            val tmp = File(file.path + ".tmp")
            tmp.writeText(text)
            if (!tmp.renameTo(file)) { file.writeText(text); tmp.delete() }
            true
        } catch (e: Exception) {
            false
        }
    }
}
