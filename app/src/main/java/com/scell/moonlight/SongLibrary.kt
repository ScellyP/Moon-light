package com.scell.moonlight

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.Normalizer
import java.util.Locale

/**
 * Storage foundation for the shared Songs folder and the playlists that point into it.
 *
 * LAYOUT (everything the app writes for this lives in ONE folder, /storage/emulated/0/Moonlight/):
 *   Moonlight/Songs/                    every song downloaded from now on (one shared folder), with the
 *                                       downloader's hidden staging folder Songs/.staging inside it.
 *   Moonlight/playlists/<id>.json       one readable JSON file per playlist.
 *   Moonlight/playlists/<id>.json.bak   the previous good copy, kept for recovery.
 *   Moonlight/settings.txt, downloads.txt, favorites.txt, recents.txt   (already there, see song-memory.js)
 * Copying the Moonlight folder to a new phone brings songs, playlists, likes and history along.
 * The old music folder (Novel/Audio, one sub-folder per playlist) is still read and never modified.
 *
 * SONG IDENTITY
 *   A song is referenced by a path with a root prefix and "/" separators:
 *     "Songs/Name.mp3"            -> Moonlight/Songs/Name.mp3
 *     "Audio/Lo-fi Focus/2AM.mp3" -> Novel/Audio/Lo-fi Focus/2AM.mp3   (a song still in an old folder)
 *   (A ref with no prefix is read as relative to the old music folder, for files written by an earlier
 *   build.) The page's track id stays the absolute path, so likes, history and the queue keep working.
 *
 * PLAYLIST FILE
 *   {
 *     "format": "moonlight-playlist", "version": 1,
 *     "id": "folder-lo-fi-focus", "name": "Lo-fi Focus", "description": "",
 *     "artwork": null,                      // a ref (song or image) or null
 *     "privacy": "private",
 *     "source": "folder" | "curated" | "user",
 *     "legacy": { "folder": "Lo-fi Focus" } | { "curatedId": "3" } | null,
 *     "createdAt": "...", "updatedAt": "...",
 *     "songs": [ { "ref": "Songs/x.mp3", "title": "x" }, ... ]     // ORDER IS THE PLAYLIST ORDER
 *   }
 *   "title" is only a last-known name, so a song whose file is missing can still be shown (as
 *   unavailable) instead of silently disappearing.
 *
 * MIGRATION (non-destructive, repeat-safe): [migrateFolders] writes a "folder" playlist for every old
 * folder playlist that has none yet. It never moves, renames, deletes or rewrites a music file, and never
 * overwrites a playlist file that exists. Curated playlists are migrated by the page (they live in its
 * prefs) through [save] with overwrite = false.
 *
 * No Android classes are used besides org.json, so this can be run on a plain JVM.
 */
class SongLibrary(
    private val audioRoot: File,      // the old music folder: Novel/Audio
    private val songsRoot: File,      // the shared Songs folder: Moonlight/Songs
    private val playlistsDir: File,   // Moonlight/playlists
) {

    companion object {
        const val SONGS_PREFIX = "Songs"      // ref prefix of the shared Songs folder
        const val AUDIO_PREFIX = "Audio"      // ref prefix of the old music folder
        const val FORMAT = "moonlight-playlist"
        const val VERSION = 1
        const val MAX_MANIFEST_BYTES = 2_000_000L
        const val MAX_SONGS = 20_000

        val AUDIO_EXTENSIONS = setOf("mp3", "m4a", "aac", "flac", "ogg", "opus", "wav")

        private val ID_RE = Regex("^[a-z0-9][a-z0-9-]{0,79}$")

        /** ASCII id fragment for a playlist name; names with no ASCII letters get a stable hash. */
        fun slug(name: String): String {
            val folded = Normalizer.normalize(name.trim(), Normalizer.Form.NFD)
                .replace(Regex("\\p{M}+"), "")
                .lowercase(Locale.ROOT)
                .replace(Regex("[^a-z0-9]+"), "-")
                .trim('-')
                .take(60)
                .trim('-')
            return if (folded.isNotEmpty()) folded
            else "p-" + Integer.toHexString(name.trim().lowercase(Locale.ROOT).hashCode())
        }

        /** A ref must stay inside the Audio root: relative, no "..", no empty parts, no dot folders' tricks. */
        fun isSafeRef(ref: String?): Boolean {
            if (ref.isNullOrBlank() || ref.length > 1000) return false
            if (ref.startsWith("/") || ref.contains('\\') || ref.contains('\u0000')) return false
            return ref.split('/').none { it.isEmpty() || it == "." || it == ".." }
        }

        private fun nowIso(): String =
            java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssZ", Locale.ROOT).format(java.util.Date())
    }

    val songsDir: File get() = songsRoot

    /** Creates Moonlight/Songs when missing. Returns whether the folder exists afterwards. */
    fun ensureSongsDir(): Boolean = songsRoot.isDirectory || songsRoot.mkdirs() || songsRoot.isDirectory

    private fun under(root: File, file: File): String? = try {
        val r = root.canonicalFile
        val f = file.canonicalFile
        if (f.path.startsWith(r.path + File.separator)) f.toRelativeString(r).replace(File.separatorChar, '/') else null
    } catch (e: Exception) {
        null
    }

    /** The ref of a file ("Songs/a.mp3" or "Audio/Folder/a.mp3"), or null when it lies in neither folder. */
    fun refFor(file: File): String? =
        under(songsRoot, file)?.let { "$SONGS_PREFIX/$it" } ?: under(audioRoot, file)?.let { "$AUDIO_PREFIX/$it" }

    /** The file a ref points to, or null when the ref is unsafe. The file may not exist (missing song). */
    fun fileFor(ref: String): File? {
        if (!isSafeRef(ref)) return null
        val slash = ref.indexOf('/')
        val head = if (slash > 0) ref.substring(0, slash) else ""
        val rest = if (slash > 0) ref.substring(slash + 1) else ref
        val candidates = when (head) {
            SONGS_PREFIX -> listOf(File(songsRoot, rest), File(audioRoot, ref))   // 2nd: an earlier build's Audio/Songs
            AUDIO_PREFIX -> listOf(File(audioRoot, rest), File(audioRoot, ref))
            else -> listOf(File(audioRoot, ref))
        }
        for (c in candidates) {
            val inside = under(songsRoot, c) != null || under(audioRoot, c) != null
            if (inside && c.isFile) return c.canonicalFile
        }
        // None exists: report the first candidate if it is a safe place (so a missing song can be shown).
        val first = candidates.first()
        return if (under(songsRoot, first) != null || under(audioRoot, first) != null) first else null
    }

    /* ------------------------------------------------------------------ reading */

    private fun fileOf(id: String) = File(playlistsDir, "$id.json")

    private fun parse(f: File): JSONObject? = try {
        if (!f.isFile || f.length() > MAX_MANIFEST_BYTES) null
        else JSONObject(f.readText()).takeIf { it.optString("format") == FORMAT && validId(it.optString("id")) }
    } catch (e: Exception) {
        null
    }

    private fun validId(id: String) = ID_RE.matches(id)

    /** Reads one playlist; a damaged file falls back to its .bak copy. */
    @Synchronized
    fun read(id: String): JSONObject? {
        if (!validId(id)) return null
        val main = fileOf(id)
        return parse(main) ?: parse(File(playlistsDir, "$id.json.bak"))
    }

    /** Every readable playlist, sorted by id so the result is stable. */
    @Synchronized
    fun readAll(): List<JSONObject> {
        val names = playlistsDir.list() ?: return emptyList()
        val ids = names.filter { it.endsWith(".json") || it.endsWith(".json.bak") }
            .map { it.removeSuffix(".bak").removeSuffix(".json") }
            .filter { validId(it) }
            .distinct().sorted()
        return ids.mapNotNull { read(it) }
    }

    /**
     * The playlists as JSON for the page. Each song gets `available` (the file exists right now),
     * so a missing file is shown as unavailable rather than dropped.
     */
    @Synchronized
    fun listJson(): String {
        val out = JSONArray()
        for (m in readAll()) {
            val copy = JSONObject(m.toString())
            val songs = copy.optJSONArray("songs") ?: JSONArray().also { copy.put("songs", it) }
            for (i in 0 until songs.length()) {
                val s = songs.optJSONObject(i) ?: continue
                val f = fileFor(s.optString("ref"))
                s.put("available", f != null && f.isFile)
            }
            out.put(copy)
        }
        return out.toString()
    }

    /** ref -> names of the playlists holding it. Curated lists are left out: the page already shows them. */
    @Synchronized
    fun membership(): Map<String, List<String>> {
        val map = LinkedHashMap<String, MutableList<String>>()
        for (m in readAll()) {
            if (m.optString("source") == "curated") continue
            val name = m.optString("name")
            if (name.isBlank()) continue
            val songs = m.optJSONArray("songs") ?: continue
            for (i in 0 until songs.length()) {
                val ref = songs.optJSONObject(i)?.optString("ref") ?: continue
                val list = map.getOrPut(ref) { mutableListOf() }
                if (!list.contains(name)) list.add(name)
            }
        }
        return map
    }

    /* ------------------------------------------------------------------ writing */

    /**
     * Checks a playlist coming from the page (it is not trusted) and returns a clean copy,
     * or null when it is unusable. Unknown fields are dropped; every song ref must be safe.
     */
    fun sanitize(raw: JSONObject): JSONObject? {
        val id = raw.optString("id")
        val name = raw.optString("name").trim().take(60)
        if (!validId(id) || name.isEmpty()) return null
        val source = raw.optString("source").let { if (it == "folder" || it == "curated") it else "user" }
        val now = nowIso()
        val clean = JSONObject()
        clean.put("format", FORMAT)
        clean.put("version", VERSION)
        clean.put("id", id)
        clean.put("name", name)
        clean.put("description", raw.optString("description").take(500))
        val art = raw.optString("artwork")
        clean.put("artwork", if (isSafeRef(art)) art else JSONObject.NULL)
        clean.put("privacy", if (raw.optString("privacy") == "public") "public" else "private")
        clean.put("source", source)
        val legacy = raw.optJSONObject("legacy")
        clean.put("legacy", if (legacy == null) JSONObject.NULL else JSONObject().apply {
            if (legacy.has("folder")) put("folder", legacy.optString("folder").take(200))
            if (legacy.has("curatedId")) put("curatedId", legacy.optString("curatedId").take(40))
        })
        clean.put("createdAt", raw.optString("createdAt").ifBlank { now })
        clean.put("updatedAt", now)
        val songs = JSONArray()
        val seen = HashSet<String>()
        val src = raw.optJSONArray("songs") ?: JSONArray()
        for (i in 0 until minOf(src.length(), MAX_SONGS)) {
            val s = src.optJSONObject(i) ?: continue
            val ref = s.optString("ref")
            if (!isSafeRef(ref) || !seen.add(ref)) continue          // no duplicates, nothing outside the Audio root
            songs.put(JSONObject().put("ref", ref).put("title", s.optString("title").take(200)))
        }
        clean.put("songs", songs)
        return clean
    }

    /**
     * Writes one playlist file next to a .bak of the previous copy (write to .tmp, then rename, so a crash
     * half-way never leaves a broken file). With [overwrite] false an existing playlist is never touched.
     * Returns true when the playlist is on disk afterwards in the form given (or already existed, if not overwriting).
     */
    @Synchronized
    fun save(manifest: JSONObject, overwrite: Boolean): Boolean {
        val clean = sanitize(manifest) ?: return false
        val id = clean.getString("id")
        return try {
            playlistsDir.mkdirs()
            val target = fileOf(id)
            if (target.exists()) {
                if (!overwrite && parse(target) != null) return true
                if (parse(target) != null) target.copyTo(File(playlistsDir, "$id.json.bak"), overwrite = true)
            }
            val tmp = File(playlistsDir, "$id.json.tmp")
            tmp.writeText(clean.toString(2))
            if (!tmp.renameTo(target)) {
                target.writeText(clean.toString(2))
                tmp.delete()
            }
            true
        } catch (e: Exception) {
            false
        }
    }

    /** An unused id for a new playlist called [name]. */
    private fun freeId(prefix: String, name: String): String {
        val base = (prefix + slug(name)).take(70).trim('-')
        var id = base
        var n = 2
        while (fileOf(id).exists() || File(playlistsDir, "$id.json.bak").exists()) id = "$base-${n++}"
        return id
    }

    /** The playlist called [name] (case-insensitive, any source but "curated"), if any. */
    @Synchronized
    fun findByName(name: String): JSONObject? {
        val key = name.trim().lowercase(Locale.ROOT)
        return readAll().firstOrNull { it.optString("source") != "curated" && it.optString("name").trim().lowercase(Locale.ROOT) == key }
    }

    /**
     * Adds a reference to [ref] at the END of the playlist called [name], creating the playlist when it
     * does not exist. No song file is created, moved or copied. Returns true when the reference is saved
     * (also when it was already there).
     */
    @Synchronized
    fun addSong(name: String, ref: String, title: String): Boolean {
        if (!isSafeRef(ref) || name.isBlank()) return false
        val existing = findByName(name)
        val m = existing ?: JSONObject()
            .put("id", freeId("pl-", name)).put("name", name.trim().take(60)).put("source", "user")
            .put("songs", JSONArray())
        val songs = m.optJSONArray("songs") ?: JSONArray().also { m.put("songs", it) }
        for (i in 0 until songs.length()) if (songs.optJSONObject(i)?.optString("ref") == ref) return true
        songs.put(JSONObject().put("ref", ref).put("title", title.take(200)))
        return save(m, overwrite = true)
    }

    /** Takes a reference back out of the playlist called [name] (used to undo a failed placement). */
    @Synchronized
    fun removeSong(name: String, ref: String): Boolean {
        val m = findByName(name) ?: return true
        val songs = m.optJSONArray("songs") ?: return true
        val kept = JSONArray()
        var changed = false
        for (i in 0 until songs.length()) {
            val s = songs.optJSONObject(i)
            if (s != null && s.optString("ref") == ref) changed = true else if (s != null) kept.put(s)
        }
        if (!changed) return true
        m.put("songs", kept)
        return save(m, overwrite = true)
    }

    /* ------------------------------------------------------------------ migration */

    /**
     * Creates a "folder" playlist for every old folder playlist that has none yet, keeping the scan order
     * (the caller passes the files already sorted). Files directly in the Audio root and dot folders are skipped. Nothing is moved, renamed, deleted or overwritten. Returns how many
     * playlists were created, so repeating the call does nothing.
     */
    @Synchronized
    fun migrateFolders(sortedFiles: List<File>): Int {
        val byFolder = LinkedHashMap<String, MutableList<String>>()
        for (f in sortedFiles) {
            val inside = under(audioRoot, f) ?: continue          // only the old music folder has folder playlists
            val slash = inside.indexOf('/')
            if (slash <= 0) continue
            val folder = inside.substring(0, slash)
            if (folder.startsWith(".")) continue
            byFolder.getOrPut(folder) { mutableListOf() }.add("$AUDIO_PREFIX/$inside")
        }
        if (byFolder.isEmpty()) return 0
        val known = readAll()
        var created = 0
        for ((folder, refs) in byFolder) {
            val done = known.any { it.optJSONObject("legacy")?.optString("folder") == folder }
            if (done) continue
            val songs = JSONArray()
            for (ref in refs) songs.put(JSONObject().put("ref", ref).put("title", File(ref).nameWithoutExtension))
            val m = JSONObject()
                .put("id", freeId("folder-", folder)).put("name", folder).put("source", "folder")
                .put("legacy", JSONObject().put("folder", folder)).put("songs", songs)
            if (save(m, overwrite = false)) created++
        }
        return created
    }

    /**
     * [migrateFolders] for one old folder only (what the downloader needs before it adds a song to a
     * playlist that is still just a folder, so the folder's existing songs are not left out of the new
     * playlist file). True when a playlist file was created.
     */
    @Synchronized
    fun migrateFolder(folder: String): Boolean {
        if (folder.isEmpty() || folder.startsWith(".")) return false
        val dir = File(audioRoot, folder)
        if (!dir.isDirectory) return false
        val files = dir.walkTopDown()
            .filter { it.isFile && AUDIO_EXTENSIONS.contains(it.extension.lowercase()) }
            .filter { f -> f.toRelativeString(audioRoot).split(File.separatorChar).none { it.startsWith(".") } }
            .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.toRelativeString(audioRoot) })
            .toList()
        return migrateFolders(files) > 0
    }
}
