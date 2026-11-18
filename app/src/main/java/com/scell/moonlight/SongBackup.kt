package com.scell.moonlight

import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/**
 * Portable backup and restore for Moonlight music, playlists, covers and metadata.
 *
 * Requirements (Item 4):
 *   4.1 Backup functionality: collects downloaded songs, packages into an archive, preserves original audio without
 *       quality loss or transcoding, and saves in the device's Downloads folder.
 *   4.2 Archive format: uses universal standard ZIP archive for optimal compatibility, zero transcoding, and independent extraction.
 *   4.3 Backup requirements: allows export/sync to Google Drive, preserves playlist information and metadata, and ensures
 *       the archive can be extracted independently of Moonlight.
 */
class SongBackup(
    private val playerRoot: File = File("/storage/emulated/0/Moonlight"),
    private val downloadDir: File = File("/storage/emulated/0/Download")
) {

    data class BackupResult(
        val success: Boolean,
        val path: String = "",
        val songCount: Int = 0,
        val playlistCount: Int = 0,
        val error: String = ""
    ) {
        fun toJson(): String = JSONObject().apply {
            put("success", success)
            put("path", path)
            put("songCount", songCount)
            put("playlistCount", playlistCount)
            put("error", error)
        }.toString()
    }

    data class RestoreResult(
        val success: Boolean,
        val restoredSongs: Int = 0,
        val restoredPlaylists: Int = 0,
        val error: String = ""
    ) {
        fun toJson(): String = JSONObject().apply {
            put("success", success)
            put("restoredSongs", restoredSongs)
            put("restoredPlaylists", restoredPlaylists)
            put("error", error)
        }.toString()
    }

    /**
     * Creates a portable ZIP backup in the Downloads directory.
     * Audio files are preserved bit-for-bit without transcoding.
     */
    fun createBackup(
        targetZip: File? = null,
        onProgress: ((percent: Int, item: String, total: Int) -> Unit)? = null
    ): BackupResult {
        return try {
            downloadDir.mkdirs()
            val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
            val finalFile = targetZip ?: File(downloadDir, "moonlight-backup-$stamp.zip")
            val tempFile = File(downloadDir, "moonlight-backup-$stamp.zip.tmp")

            val entries = mutableListOf<Pair<File, String>>()

            // 1. Collect songs (Moonlight/Songs)
            val songsDir = File(playerRoot, "Songs")
            val audioFiles = if (songsDir.isDirectory) {
                songsDir.listFiles()?.filter { f ->
                    f.isFile && !f.name.startsWith(".") && !f.name.endsWith(".tmp") && isAudioFile(f.name)
                } ?: emptyList()
            } else emptyList()

            for (f in audioFiles) {
                entries.add(f to "songs/${f.name}")
            }

            // 2. Collect playlists (Moonlight/playlists)
            val playlistsDir = File(playerRoot, "playlists")
            val playlistFiles = if (playlistsDir.isDirectory) {
                playlistsDir.listFiles()?.filter { f ->
                    f.isFile && f.name.endsWith(".json") && !f.name.endsWith(".bak")
                } ?: emptyList()
            } else emptyList()

            for (f in playlistFiles) {
                entries.add(f to "playlists/${f.name}")
            }

            // 3. Collect playlist covers (Moonlight/playlist-covers)
            val coversDir = File(playerRoot, "playlist-covers")
            if (coversDir.isDirectory) {
                coversDir.listFiles()?.filter { it.isFile }?.forEach { f ->
                    entries.add(f to "playlist-covers/${f.name}")
                }
            }

            // 4. Collect persistent metadata text files
            val textNames = listOf("settings.txt", "downloads.txt", "favorites.txt", "recents.txt")
            for (name in textNames) {
                val f = File(playerRoot, name)
                if (f.isFile && f.length() > 0) {
                    entries.add(f to name)
                }
            }

            // 5. Generate manifest JSON
            val manifest = JSONObject().apply {
                put("app", "Moonlight")
                put("format", "moonlight-backup")
                put("version", 1)
                put("createdAt", SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).format(Date()))
                put("songCount", audioFiles.size)
                put("playlistCount", playlistFiles.size)
            }

            val total = entries.size + 1
            var written = 0

            FileOutputStream(tempFile).use { fos ->
                ZipOutputStream(fos.buffered()).use { zos ->
                    // Set compression level: Deflated with standard compression for metadata, bit-for-bit stored
                    zos.setLevel(1)

                    // Write manifest
                    val manifestBytes = manifest.toString(2).toByteArray(Charsets.UTF_8)
                    val manifestEntry = ZipEntry("backup-manifest.json")
                    manifestEntry.size = manifestBytes.size.toLong()
                    zos.putNextEntry(manifestEntry)
                    zos.write(manifestBytes)
                    zos.closeEntry()
                    written++
                    onProgress?.invoke((written * 100) / total, "backup-manifest.json", total)

                    // Write each file
                    val buffer = ByteArray(64 * 1024)
                    for ((file, path) in entries) {
                        val entry = ZipEntry(path)
                        entry.time = file.lastModified()
                        zos.putNextEntry(entry)
                        FileInputStream(file).use { fis ->
                            var len: Int
                            while (fis.read(buffer).also { len = it } > 0) {
                                zos.write(buffer, 0, len)
                            }
                        }
                        zos.closeEntry()
                        written++
                        onProgress?.invoke((written * 100) / total, file.name, total)
                    }
                    zos.finish()
                }
            }

            // Atomic rename
            if (finalFile.exists()) finalFile.delete()
            if (!tempFile.renameTo(finalFile)) {
                tempFile.copyTo(finalFile, overwrite = true)
                tempFile.delete()
            }

            BackupResult(
                success = true,
                path = finalFile.absolutePath,
                songCount = audioFiles.size,
                playlistCount = playlistFiles.size
            )
        } catch (e: Exception) {
            BackupResult(success = false, error = e.message ?: "Backup failed")
        }
    }

    /**
     * Restores music, playlists, and metadata from a backup ZIP archive.
     */
    fun restoreBackup(
        zipFile: File,
        onProgress: ((percent: Int, item: String, total: Int) -> Unit)? = null
    ): RestoreResult {
        return try {
            if (!zipFile.isFile || !zipFile.canRead()) {
                return RestoreResult(success = false, error = "Backup file not found or not readable: ${zipFile.name}")
            }

            playerRoot.mkdirs()
            val songsDir = File(playerRoot, "Songs").apply { mkdirs() }
            val playlistsDir = File(playerRoot, "playlists").apply { mkdirs() }
            val coversDir = File(playerRoot, "playlist-covers").apply { mkdirs() }

            var restoredSongs = 0
            var restoredPlaylists = 0

            // Count entries first for progress
            var totalEntries = 0
            FileInputStream(zipFile).use { fis ->
                ZipInputStream(fis.buffered()).use { zis ->
                    var e = zis.nextEntry
                    while (e != null) {
                        totalEntries++
                        e = zis.nextEntry
                    }
                }
            }
            if (totalEntries == 0) totalEntries = 1

            var processed = 0
            val buffer = ByteArray(64 * 1024)

            FileInputStream(zipFile).use { fis ->
                ZipInputStream(fis.buffered()).use { zis ->
                    var entry = zis.nextEntry
                    while (entry != null) {
                        val name = entry.name
                        if (!entry.isDirectory && !name.contains("..")) {
                            when {
                                name.startsWith("songs/") -> {
                                    val fileName = name.substringAfter("songs/")
                                    if (fileName.isNotBlank()) {
                                        val dest = File(songsDir, fileName)
                                        FileOutputStream(dest).use { fos ->
                                            var len: Int
                                            while (zis.read(buffer).also { len = it } > 0) {
                                                fos.write(buffer, 0, len)
                                            }
                                        }
                                        restoredSongs++
                                    }
                                }
                                name.startsWith("playlists/") -> {
                                    val fileName = name.substringAfter("playlists/")
                                    if (fileName.isNotBlank()) {
                                        val dest = File(playlistsDir, fileName)
                                        FileOutputStream(dest).use { fos ->
                                            var len: Int
                                            while (zis.read(buffer).also { len = it } > 0) {
                                                fos.write(buffer, 0, len)
                                            }
                                        }
                                        restoredPlaylists++
                                    }
                                }
                                name.startsWith("playlist-covers/") -> {
                                    val fileName = name.substringAfter("playlist-covers/")
                                    if (fileName.isNotBlank()) {
                                        val dest = File(coversDir, fileName)
                                        FileOutputStream(dest).use { fos ->
                                            var len: Int
                                            while (zis.read(buffer).also { len = it } > 0) {
                                                fos.write(buffer, 0, len)
                                            }
                                        }
                                    }
                                }
                                name in listOf("settings.txt", "downloads.txt", "favorites.txt", "recents.txt") -> {
                                    val dest = File(playerRoot, name)
                                    FileOutputStream(dest).use { fos ->
                                        var len: Int
                                        while (zis.read(buffer).also { len = it } > 0) {
                                            fos.write(buffer, 0, len)
                                        }
                                    }
                                }
                            }
                        }
                        zis.closeEntry()
                        processed++
                        onProgress?.invoke((processed * 100) / totalEntries, name, totalEntries)
                        entry = zis.nextEntry
                    }
                }
            }

            RestoreResult(
                success = true,
                restoredSongs = restoredSongs,
                restoredPlaylists = restoredPlaylists
            )
        } catch (e: Exception) {
            RestoreResult(success = false, error = e.message ?: "Restore failed")
        }
    }

    /**
     * Lists existing Moonlight backups found in the device's Downloads directory.
     */
    fun listBackups(): String {
        return try {
            val files = if (downloadDir.isDirectory) {
                downloadDir.listFiles()?.filter { f ->
                    f.isFile && f.name.startsWith("moonlight-backup-") && f.name.endsWith(".zip")
                }?.sortedByDescending { it.lastModified() } ?: emptyList()
            } else emptyList()

            val arr = org.json.JSONArray()
            for (f in files) {
                arr.put(JSONObject().apply {
                    put("name", f.name)
                    put("path", f.absolutePath)
                    put("size", f.length())
                    put("lastModified", f.lastModified())
                })
            }
            arr.toString()
        } catch (e: Exception) {
            "[]"
        }
    }

    private fun isAudioFile(name: String): Boolean {
        val lower = name.lowercase(Locale.ROOT)
        return lower.endsWith(".mp3") || lower.endsWith(".m4a") || lower.endsWith(".aac") ||
               lower.endsWith(".opus") || lower.endsWith(".ogg") || lower.endsWith(".flac") ||
               lower.endsWith(".wav")
    }
}
