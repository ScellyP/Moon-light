package com.scell.moonlight

import java.io.File

/**
 * The cover pictures you chose for playlists, kept as small JPEG files in Moonlight/playlist-covers/ (so they
 * are backed up with the rest of the Moonlight folder). A playlist is addressed by the name the page uses for it
 * ("all", "@list:3", "Lo-fi", ...); the file name is made from that name plus a hash, so any name is safe.
 * A chosen cover always wins over the automatic mosaic and never changes by itself.
 */
class PlaylistCovers(private val dir: File) {

    fun fileFor(key: String): File {
        val safe = key.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').take(24)
        return File(dir, (if (safe.isEmpty()) "playlist" else safe) + "-" + Integer.toHexString(key.hashCode()) + ".jpg")
    }

    /** The cover's JPEG bytes, or null when this playlist has no chosen cover. */
    @Synchronized
    fun get(key: String): ByteArray? = try {
        fileFor(key).takeIf { it.isFile && it.length() > 0L }?.readBytes()
    } catch (e: Exception) {
        null
    }

    /** Stores [jpeg] as this playlist's cover (written to a temporary file first, then moved into place). */
    @Synchronized
    fun save(key: String, jpeg: ByteArray): Boolean = try {
        dir.mkdirs()
        val target = fileFor(key)
        val tmp = File(dir, target.name + ".tmp")
        tmp.writeBytes(jpeg)
        if (!tmp.renameTo(target)) { target.writeBytes(jpeg); tmp.delete() }
        true
    } catch (e: Exception) {
        false
    }

    /** Back to the automatic cover. */
    @Synchronized
    fun clear(key: String): Boolean = try {
        val f = fileFor(key)
        !f.exists() || f.delete()
    } catch (e: Exception) {
        false
    }
}
