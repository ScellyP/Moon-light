package com.scell.moonlight

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * Playlist sharing, AES-256 password-protected encryption, and Filebin integration (Item 3).
 *
 * 3.1 Filebin integration: REST API upload (POST /{bin}/{filename}), download, and link generation.
 * 3.2 Share Playlist functionality: packages songs, playlist metadata, and covers into an archive.
 * 3.3 Password-protected sharing: optional AES-256-GCM encryption with PBKDF2 key derivation. Password is never in URL.
 * 3.4 Automatic playlist detection: recognizes Filebin links, downloads, prompts for password if encrypted, extracts, and imports.
 * 3.5 Sharing settings: gated by playlist sharing and Filebin cloud settings.
 */
class PlaylistShare(
    private val playerRoot: File = File("/storage/emulated/0/Moonlight"),
    private val cacheDir: File = File("/storage/emulated/0/Android/data/com.scell.moonlight/cache/shared-playlists"),
    private val audioRoot: File = File("/storage/emulated/0/Novel/Audio")
) {

    companion object {
        const val MAGIC_ENCRYPTED = "MLPK"   // Moonlight Package Magic (4 bytes)
        const val VERSION = 1
        const val PBKDF2_ITERATIONS = 65536
        const val KEY_LENGTH_BITS = 256
        const val GCM_TAG_LENGTH_BITS = 128
        const val SALT_LENGTH = 16
        const val IV_LENGTH = 12

        /** Recognizes an AnonDrop link: e.g. https://anondrop.net/abc123xyz or https://anondrop.net/abc123xyz/download */
        val ANONDROP_REGEX = Regex("""https?://(?:www\.)?anondrop\.net/([a-zA-Z0-9]+)(?:/([^\s/?#]+))?""", RegexOption.IGNORE_CASE)

        fun isAnonDropUrl(url: String): Boolean = ANONDROP_REGEX.containsMatchIn(url.trim())

        fun parseAnonDropUrl(url: String): Pair<String, String?>? {
            val match = ANONDROP_REGEX.find(url.trim()) ?: return null
            val id = match.groupValues[1]
            val extra = if (match.groupValues.size > 2 && match.groupValues[2].isNotBlank()) match.groupValues[2] else null
            return id to extra
        }

        fun isRecognizedShareUrl(url: String): Boolean = isAnonDropUrl(url)
    }

    data class SharePackageResult(
        val success: Boolean,
        val filePath: String = "",
        val fileName: String = "",
        val isEncrypted: Boolean = false,
        val songCount: Int = 0,
        val size: Long = 0,
        val error: String = ""
    ) {
        fun toJson(): String = JSONObject().apply {
            put("success", success)
            put("filePath", filePath)
            put("fileName", fileName)
            put("isEncrypted", isEncrypted)
            put("songCount", songCount)
            put("size", size)
            put("error", error)
        }.toString()
    }

    data class ImportResult(
        val success: Boolean,
        val playlistId: String = "",
        val playlistName: String = "",
        val songCount: Int = 0,
        val requiresPassword: Boolean = false,
        val error: String = ""
    ) {
        fun toJson(): String = JSONObject().apply {
            put("success", success)
            put("playlistId", playlistId)
            put("playlistName", playlistName)
            put("songCount", songCount)
            put("requiresPassword", requiresPassword)
            put("error", error)
        }.toString()
    }

    /**
     * Packages a playlist into a ZIP archive with optional AES-256 encryption.
     */
    fun createPackage(
        playlistKey: String,
        password: String? = null,
        onProgress: ((currentSong: Int, totalSongs: Int, songName: String) -> Unit)? = null
    ): SharePackageResult {
        return try {
            cacheDir.mkdirs()
            val trimmedKey = playlistKey.trim()
            val isFolderPlaylist = trimmedKey.startsWith("name:", ignoreCase = true)
            val isCuratedList = trimmedKey.startsWith("list:", ignoreCase = true)
            val folderName = if (isFolderPlaylist) trimmedKey.substring(5).trim() else null
            val listId = if (isCuratedList) trimmedKey.substring(5).trim() else null

            val playlistsDir = File(playerRoot, "playlists")
            val songsDir = File(playerRoot, "Songs")
            val songLib = SongLibrary(audioRoot, songsDir, playlistsDir)

            // 1. Locate or synthesize playlist JSON
            var playlistJson: JSONObject? = null
            var playlistJsonStr: String? = null

            // Direct candidate filenames in playlistsDir
            val candidateFileNames = mutableListOf<String>()
            if (!trimmedKey.contains(":")) candidateFileNames.add("$trimmedKey.json")
            if (listId != null) {
                candidateFileNames.add("$listId.json")
                candidateFileNames.add("curated-$listId.json")
                candidateFileNames.add("pl-$listId.json")
            }
            if (folderName != null) {
                val slug = SongLibrary.slug(folderName)
                candidateFileNames.add("folder-$slug.json")
                candidateFileNames.add("pl-$slug.json")
                candidateFileNames.add("$folderName.json")
            }

            for (fn in candidateFileNames) {
                val f = File(playlistsDir, fn)
                if (f.isFile) {
                    try {
                        val text = f.readText()
                        playlistJson = JSONObject(text)
                        playlistJsonStr = text
                        break
                    } catch (e: Exception) { /* continue */ }
                }
            }

            // Search by reading JSON files in playlistsDir
            if (playlistJson == null && playlistsDir.isDirectory) {
                val allFiles = playlistsDir.listFiles()?.filter { it.isFile && it.name.endsWith(".json") } ?: emptyList()
                for (f in allFiles) {
                    try {
                        val text = f.readText()
                        val json = JSONObject(text)
                        val id = json.optString("id", "")
                        val name = json.optString("name", "")
                        val legacyFolder = json.optJSONObject("legacy")?.optString("folder", "") ?: ""
                        val legacyCurated = json.optJSONObject("legacy")?.optString("curatedId", "") ?: ""

                        if (folderName != null) {
                            if (name.equals(folderName, ignoreCase = true) || legacyFolder.equals(folderName, ignoreCase = true)) {
                                playlistJson = json
                                playlistJsonStr = text
                                break
                            }
                        } else if (listId != null) {
                            if (id == listId || id == "curated-$listId" || legacyCurated == listId) {
                                playlistJson = json
                                playlistJsonStr = text
                                break
                            }
                        } else {
                            if (id == trimmedKey || name.equals(trimmedKey, ignoreCase = true)) {
                                playlistJson = json
                                playlistJsonStr = text
                                break
                            }
                        }
                    } catch (e: Exception) { /* continue */ }
                }
            }

            // Folder playlist fallback: migrate or synthesize from folder on disk if no JSON exists yet
            if (playlistJson == null && folderName != null) {
                try { songLib.migrateFolder(folderName) } catch (e: Exception) { /* ignore */ }

                val slug = SongLibrary.slug(folderName)
                val migratedFile = File(playlistsDir, "folder-$slug.json").takeIf { it.isFile }
                    ?: File(playlistsDir, "$folderName.json").takeIf { it.isFile }
                if (migratedFile != null) {
                    try {
                        playlistJsonStr = migratedFile.readText()
                        playlistJson = JSONObject(playlistJsonStr)
                    } catch (e: Exception) { /* ignore */ }
                }

                if (playlistJson == null) {
                    val folderInSongs = File(songsDir, folderName)
                    val folderInAudio = File(audioRoot, folderName)
                    val audioExts = SongLibrary.AUDIO_EXTENSIONS
                    val diskFiles = listOf(folderInSongs, folderInAudio).flatMap { dir ->
                        if (dir.isDirectory) {
                            dir.walkTopDown().filter { it.isFile && audioExts.contains(it.extension.lowercase(Locale.ROOT)) }.toList()
                        } else emptyList()
                    }.distinctBy { it.name }

                    if (diskFiles.isNotEmpty()) {
                        val songsArr = JSONArray()
                        for (f in diskFiles) {
                            val ref = songLib.refFor(f) ?: "Songs/${f.name}"
                            songsArr.put(JSONObject().apply {
                                put("ref", ref)
                                put("title", f.nameWithoutExtension)
                                put("size", f.length())
                            })
                        }
                        val syntheticJson = JSONObject().apply {
                            put("format", SongLibrary.FORMAT)
                            put("version", SongLibrary.VERSION)
                            put("id", "folder-$slug")
                            put("name", folderName)
                            put("source", "folder")
                            put("legacy", JSONObject().put("folder", folderName))
                            put("songs", songsArr)
                        }
                        playlistJson = syntheticJson
                        playlistJsonStr = syntheticJson.toString(2)
                        try {
                            playlistsDir.mkdirs()
                            File(playlistsDir, "folder-$slug.json").writeText(playlistJsonStr)
                        } catch (e: Exception) { /* non-fatal */ }
                    }
                }
            }

            if (playlistJson == null || playlistJsonStr == null) {
                val displayName = (folderName ?: listId ?: trimmedKey).removePrefix("name:").removePrefix("list:").ifBlank { "Playlist" }
                return SharePackageResult(success = false, error = "Playlist not found: $displayName")
            }

            val plName = playlistJson.optString("name", folderName ?: listId ?: trimmedKey)
            val plId = playlistJson.optString("id", trimmedKey)
            val safeName = (folderName ?: listId ?: plName).replace(Regex("[^a-zA-Z0-9_.-]"), "_").ifBlank { "shared_playlist" }

            // 2. Identify referenced songs
            val songsArray = playlistJson.optJSONArray("songs") ?: JSONArray()
            val songFiles = mutableListOf<File>()

            for (i in 0 until songsArray.length()) {
                val item = songsArray.optJSONObject(i) ?: continue
                val ref = item.optString("ref", "")
                if (ref.isBlank()) continue

                val resolved = songLib.fileFor(ref)?.takeIf { it.isFile }
                    ?: File(songsDir, ref.substringAfter("Songs/")).takeIf { it.isFile }
                    ?: File(audioRoot, ref.substringAfter("Audio/")).takeIf { it.isFile }
                    ?: File(audioRoot, ref).takeIf { it.isFile }
                    ?: File(playerRoot, ref).takeIf { it.isFile }
                    ?: File(songsDir, ref.substringAfterLast('/')).takeIf { it.isFile }
                    ?: File(audioRoot, ref.substringAfterLast('/')).takeIf { it.isFile }

                if (resolved != null && !songFiles.contains(resolved)) {
                    songFiles.add(resolved)
                }
            }

            // Fallback for folder playlists if referenced files weren't resolved
            if (songFiles.isEmpty() && folderName != null) {
                val folderInSongs = File(songsDir, folderName)
                val folderInAudio = File(audioRoot, folderName)
                val audioExts = SongLibrary.AUDIO_EXTENSIONS
                listOf(folderInSongs, folderInAudio).forEach { dir ->
                    if (dir.isDirectory) {
                        dir.walkTopDown().filter { it.isFile && audioExts.contains(it.extension.lowercase(Locale.ROOT)) }.forEach { f ->
                            if (!songFiles.contains(f)) songFiles.add(f)
                        }
                    }
                }
            }

            if (songFiles.isEmpty()) {
                return SharePackageResult(success = false, error = "Playlist '$plName' has no audio files to share")
            }

            // 3. Identify cover
            val coversDir = File(playerRoot, "playlist-covers")
            val coversMgr = PlaylistCovers(coversDir)
            val coverFile = coversMgr.fileFor(trimmedKey).takeIf { it.isFile }
                ?: folderName?.let { coversMgr.fileFor(it).takeIf { f -> f.isFile } }
                ?: coversMgr.fileFor(plName).takeIf { it.isFile }
                ?: coversMgr.fileFor(plId).takeIf { it.isFile }
                ?: File(coversDir, "$safeName.jpg").takeIf { it.isFile }
                ?: (if (!trimmedKey.contains(":")) File(coversDir, "$trimmedKey.jpg").takeIf { it.isFile } else null)
                ?: folderName?.let { File(coversDir, "$it.jpg").takeIf { f -> f.isFile } }

            // 4. Build unencrypted ZIP directly on disk to prevent RAM exhaustion
            val fileName = "$safeName.moonlight"
            val targetFile = File(cacheDir, fileName)
            val zipOutFile = if (!password.isNullOrBlank()) {
                File.createTempFile("raw_${safeName}_", ".zip", cacheDir)
            } else {
                targetFile
            }

            try {
                FileOutputStream(zipOutFile).buffered().use { fos ->
                    ZipOutputStream(fos).use { zos ->
                        zos.setLevel(1)

                        // Manifest
                        val manifest = JSONObject().apply {
                            put("format", "moonlight-shared-playlist")
                            put("version", VERSION)
                            put("playlistName", plName)
                            put("playlistId", safeName)
                            put("hasCover", coverFile != null)
                            put("isEncrypted", !password.isNullOrBlank())
                            put("songCount", songFiles.size)
                        }
                        val mBytes = manifest.toString(2).toByteArray(Charsets.UTF_8)
                        zos.putNextEntry(ZipEntry("manifest.json").apply { size = mBytes.size.toLong() })
                        zos.write(mBytes)
                        zos.closeEntry()

                        // Playlist definition JSON
                        val plBytes = playlistJsonStr.toByteArray(Charsets.UTF_8)
                        zos.putNextEntry(ZipEntry("playlist.json").apply { size = plBytes.size.toLong() })
                        zos.write(plBytes)
                        zos.closeEntry()

                        // Cover art if present
                        if (coverFile != null) {
                            val coverBytes = coverFile.readBytes()
                            zos.putNextEntry(ZipEntry("cover.jpg").apply { size = coverBytes.size.toLong() })
                            zos.write(coverBytes)
                            zos.closeEntry()
                        }

                        // Songs
                        val buf = ByteArray(64 * 1024)
                        for ((idx, sFile) in songFiles.withIndex()) {
                            onProgress?.invoke(idx + 1, songFiles.size, sFile.name)
                            zos.putNextEntry(ZipEntry("songs/${sFile.name}").apply { time = sFile.lastModified() })
                            FileInputStream(sFile).buffered().use { fis ->
                                var len: Int
                                while (fis.read(buf).also { len = it } > 0) {
                                    zos.write(buf, 0, len)
                                }
                            }
                            zos.closeEntry()
                        }
                        zos.finish()
                    }
                }

                if (!password.isNullOrBlank()) {
                    // Stream AES-256-GCM encryption with PBKDF2 to targetFile
                    encryptFileAes256Gcm(zipOutFile, targetFile, password)
                    zipOutFile.delete()
                    SharePackageResult(
                        success = true,
                        filePath = targetFile.absolutePath,
                        fileName = fileName,
                        isEncrypted = true,
                        songCount = songFiles.size,
                        size = targetFile.length()
                    )
                } else {
                    SharePackageResult(
                        success = true,
                        filePath = targetFile.absolutePath,
                        fileName = fileName,
                        isEncrypted = false,
                        songCount = songFiles.size,
                        size = targetFile.length()
                    )
                }
            } finally {
                if (zipOutFile != targetFile && zipOutFile.exists()) {
                    zipOutFile.delete()
                }
            }
        } catch (e: Exception) {
            SharePackageResult(success = false, error = e.message ?: "Failed to create package")
        }
    }

    /**
     * Uploads a package to AnonDrop via anonymous chunked upload REST API.
     * Generates a public shareable link: https://anondrop.net/{id}
     */
    fun uploadToAnonDrop(
        file: File,
        onProgress: ((uploadedBytes: Long, totalBytes: Long) -> Unit)? = null
    ): Pair<Boolean, String> {
        return try {
            if (!file.isFile || file.length() == 0L) {
                return false to "File to upload is empty or not found"
            }
            val totalBytes = file.length()

            // 1. Fetch userkey from /register (or generate random 20-char key if registration is unreachable)
            val userKey = getOrRegisterAnonDropKey()

            // 2. Initiate chunked upload: GET /initiateupload?filename=...&key=...
            val initUrl = URL("https://anondrop.net/initiateupload?filename=" + java.net.URLEncoder.encode(file.name, "UTF-8") + (if (userKey.isNotBlank()) "&key=$userKey" else ""))
            val initConn = (initUrl.openConnection() as HttpURLConnection).apply {
                setRequestProperty("User-Agent", "Mozilla/5.0 (Android; Mobile)")
                connectTimeout = 15000
                readTimeout = 30000
            }
            if (initConn.responseCode != 200) {
                return false to "AnonDrop initiation failed with HTTP ${initConn.responseCode}"
            }
            val sessionHash = initConn.inputStream.bufferedReader().use { it.readText() }.trim()
            if (sessionHash.isBlank()) {
                return false to "AnonDrop returned empty upload session"
            }

            // 3. Upload chunks: POST /uploadchunk?session_hash=...&chunk_index=...&size=...
            val chunkSize = 9 * 1024 * 1024 // 9 MB chunks
            val totalChunks = ((totalBytes + chunkSize - 1) / chunkSize).toInt()
            var uploadedBytes = 0L

            FileInputStream(file).buffered().use { fis ->
                for (chunkIdx in 0 until totalChunks) {
                    val thisChunkSize = Math.min(chunkSize.toLong(), totalBytes - uploadedBytes).toInt()
                    val chunkUrl = URL("https://anondrop.net/uploadchunk?session_hash=$sessionHash&chunk_index=$chunkIdx&size=$thisChunkSize")
                    val chunkConn = (chunkUrl.openConnection() as HttpURLConnection).apply {
                        requestMethod = "POST"
                        doOutput = true
                        setRequestProperty("Content-Type", "application/octet-stream")
                        setRequestProperty("User-Agent", "Mozilla/5.0 (Android; Mobile)")
                        connectTimeout = 20000
                        readTimeout = 300000
                        setFixedLengthStreamingMode(thisChunkSize)
                    }

                    chunkConn.outputStream.buffered().use { os ->
                        val buf = ByteArray(32 * 1024)
                        var chunkWritten = 0
                        while (chunkWritten < thisChunkSize) {
                            val toRead = Math.min(buf.size, thisChunkSize - chunkWritten)
                            val read = fis.read(buf, 0, toRead)
                            if (read <= 0) break
                            os.write(buf, 0, read)
                            chunkWritten += read
                            uploadedBytes += read
                            onProgress?.invoke(uploadedBytes, totalBytes)
                        }
                        os.flush()
                    }

                    if (chunkConn.responseCode != 200) {
                        return false to "AnonDrop chunk $chunkIdx upload failed with HTTP ${chunkConn.responseCode}"
                    }
                }
            }

            // 4. End upload: GET /endupload?session_hash=...&size=...
            val endUrl = URL("https://anondrop.net/endupload?session_hash=$sessionHash&size=$totalBytes")
            val endConn = (endUrl.openConnection() as HttpURLConnection).apply {
                setRequestProperty("User-Agent", "Mozilla/5.0 (Android; Mobile)")
                connectTimeout = 20000
                readTimeout = 30000
            }
            if (endConn.responseCode != 200) {
                return false to "AnonDrop finalization failed with HTTP ${endConn.responseCode}"
            }
            val endBody = endConn.inputStream.bufferedReader().use { it.readText() }
            val linkMatch = Regex("""https?://(?:www\.)?anondrop\.net/([A-Za-z0-9]+)""").find(endBody)
            val shareUrl = linkMatch?.value ?: "https://anondrop.net/$sessionHash"
            true to shareUrl
        } catch (e: Exception) {
            false to (e.message ?: "Network error uploading to AnonDrop")
        }
    }

    /**
     * Downloads a playlist package from an AnonDrop link into cacheDir.
     * Uses AnonDrop's direct download endpoint: https://anondrop.net/{id}/download
     */
    fun downloadFromAnonDrop(
        anonDropUrl: String,
        onProgress: ((downloadedBytes: Long, totalBytes: Long) -> Unit)? = null
    ): Pair<Boolean, File?> {
        return try {
            val parsed = parseAnonDropUrl(anonDropUrl) ?: return false to null
            val fileId = parsed.first
            cacheDir.mkdirs()

            val downloadUrl = URL("https://anondrop.net/$fileId/download")
            val targetFile = File(cacheDir, "downloaded-$fileId.moonlight")

            val conn = (downloadUrl.openConnection() as HttpURLConnection).apply {
                setRequestProperty("User-Agent", "Mozilla/5.0 (Android; Mobile)")
                connectTimeout = 20000
                readTimeout = 300000
            }
            if (conn.responseCode != 200) return false to null

            val totalBytes = conn.contentLengthLong
            var downloadedBytes = 0L

            conn.inputStream.use { ins ->
                FileOutputStream(targetFile).buffered().use { fos ->
                    val buf = ByteArray(32 * 1024)
                    var len: Int
                    while (ins.read(buf).also { len = it } > 0) {
                        fos.write(buf, 0, len)
                        downloadedBytes += len
                        onProgress?.invoke(downloadedBytes, totalBytes)
                    }
                    fos.flush()
                }
            }
            true to targetFile
        } catch (e: Exception) {
            false to null
        }
    }


    /**
     * Imports a playlist package into Moonlight.
     * Extracts songs to Moonlight/Songs/, playlist to Moonlight/playlists/, cover to Moonlight/playlist-covers/.
     * Fully streaming to handle 1-2 GB packages without memory exhaustion.
     */
    fun importPackage(
        packageFile: File,
        password: String? = null
    ): ImportResult {
        var tempZipFile: File? = null
        return try {
            if (!packageFile.isFile || packageFile.length() == 0L) {
                return ImportResult(success = false, error = "Package file not found")
            }

            val isEncrypted = isEncryptedPackage(packageFile)
            val zipFileToExtract: File

            if (isEncrypted) {
                if (password.isNullOrBlank()) {
                    return ImportResult(
                        success = false,
                        requiresPassword = true,
                        error = "Password required to decrypt this playlist"
                    )
                }
                tempZipFile = File.createTempFile("decrypted_", ".zip", cacheDir)
                val decryptedOk = decryptFileAes256Gcm(packageFile, tempZipFile, password)
                if (!decryptedOk) {
                    if (tempZipFile.exists()) tempZipFile.delete()
                    return ImportResult(
                        success = false,
                        requiresPassword = true,
                        error = "Incorrect password"
                    )
                }
                zipFileToExtract = tempZipFile
            } else {
                zipFileToExtract = packageFile
            }

            // Extract ZIP contents
            playerRoot.mkdirs()
            val songsDir = File(playerRoot, "Songs").apply { mkdirs() }
            val playlistsDir = File(playerRoot, "playlists").apply { mkdirs() }
            val coversDir = File(playerRoot, "playlist-covers").apply { mkdirs() }

            var plName = ""
            var plId = ""
            var songCount = 0
            val buf = ByteArray(64 * 1024)

            ZipInputStream(FileInputStream(zipFileToExtract).buffered()).use { zis ->
                var entry = zis.nextEntry
                while (entry != null) {
                    val name = entry.name
                    // Prevent zip-slip and unsafe paths
                    if (!entry.isDirectory && !name.contains("..") && !name.startsWith("/") && !name.startsWith("\\")) {
                        when {
                            name == "manifest.json" -> {
                                val baos = ByteArrayOutputStream()
                                var len: Int
                                while (zis.read(buf).also { len = it } > 0) {
                                    baos.write(buf, 0, len)
                                }
                                val mStr = baos.toString("UTF-8")
                                val m = JSONObject(mStr)
                                plName = m.optString("playlistName", "")
                                plId = m.optString("playlistId", "")
                            }
                            name == "playlist.json" -> {
                                val baos = ByteArrayOutputStream()
                                var len: Int
                                while (zis.read(buf).also { len = it } > 0) {
                                    baos.write(buf, 0, len)
                                }
                                val rawPlStr = baos.toString("UTF-8")
                                val cleanId = (plId.ifBlank { SongLibrary.slug(plName) })
                                    .removePrefix("name:")
                                    .removePrefix("list:")
                                    .replace(Regex("[^a-zA-Z0-9_.-]"), "_")
                                    .ifBlank { "imported-${System.currentTimeMillis()}" }
                                val plDest = File(playlistsDir, "$cleanId.json")

                                val updatedPlStr = try {
                                    val pj = JSONObject(rawPlStr)
                                    pj.put("id", cleanId)
                                    if (plName.isNotBlank()) pj.put("name", plName)
                                    val songs = pj.optJSONArray("songs")
                                    if (songs != null) {
                                        for (k in 0 until songs.length()) {
                                            val s = songs.optJSONObject(k) ?: continue
                                            val oldRef = s.optString("ref", "")
                                            val fn = oldRef.substringAfterLast('/').substringAfterLast('\\')
                                            if (fn.isNotBlank()) {
                                                s.put("ref", "Songs/$fn")
                                            }
                                        }
                                    }
                                    pj.toString(2)
                                } catch (e: Exception) {
                                    rawPlStr
                                }
                                plDest.writeText(updatedPlStr)
                            }
                            name == "cover.jpg" -> {
                                val cleanId = (plId.ifBlank { SongLibrary.slug(plName) })
                                    .removePrefix("name:")
                                    .removePrefix("list:")
                                    .replace(Regex("[^a-zA-Z0-9_.-]"), "_")
                                    .ifBlank { "imported" }
                                val coversMgr = PlaylistCovers(coversDir)
                                val cTarget = coversMgr.fileFor(plName.ifBlank { cleanId })
                                FileOutputStream(cTarget).buffered().use { fos ->
                                    var len: Int
                                    while (zis.read(buf).also { len = it } > 0) {
                                        fos.write(buf, 0, len)
                                    }
                                    fos.flush()
                                }
                                try { cTarget.copyTo(File(coversDir, "$cleanId.jpg"), overwrite = true) } catch (e: Exception) {}
                            }
                            name.startsWith("songs/") -> {
                                val fn = name.substringAfter("songs/").substringAfterLast("/").substringAfterLast("\\")
                                if (fn.isNotBlank()) {
                                    val sDest = File(songsDir, fn)
                                    FileOutputStream(sDest).buffered().use { fos ->
                                        var len: Int
                                        while (zis.read(buf).also { len = it } > 0) {
                                            fos.write(buf, 0, len)
                                        }
                                        fos.flush()
                                    }
                                    songCount++
                                }
                            }
                        }
                    }
                    zis.closeEntry()
                    entry = zis.nextEntry
                }
            }

            ImportResult(
                success = true,
                playlistId = plId,
                playlistName = plName,
                songCount = songCount
            )
        } catch (e: Exception) {
            ImportResult(success = false, error = e.message ?: "Failed to import package")
        } finally {
            if (tempZipFile != null && tempZipFile.exists()) {
                tempZipFile.delete()
            }
        }
    }

    // ---- AES-256-GCM Helper Methods -------------------------------------------------------------------

    fun isEncryptedPackage(file: File): Boolean {
        if (!file.isFile || file.length() < 4) return false
        return try {
            FileInputStream(file).use { fis ->
                val magic = ByteArray(4)
                if (fis.read(magic) != 4) return false
                magic[0] == MAGIC_ENCRYPTED[0].code.toByte() &&
                magic[1] == MAGIC_ENCRYPTED[1].code.toByte() &&
                magic[2] == MAGIC_ENCRYPTED[2].code.toByte() &&
                magic[3] == MAGIC_ENCRYPTED[3].code.toByte()
            }
        } catch (e: Exception) {
            false
        }
    }

    fun isEncryptedPackage(bytes: ByteArray): Boolean {
        if (bytes.size < 4) return false
        return bytes[0] == MAGIC_ENCRYPTED[0].code.toByte() &&
               bytes[1] == MAGIC_ENCRYPTED[1].code.toByte() &&
               bytes[2] == MAGIC_ENCRYPTED[2].code.toByte() &&
               bytes[3] == MAGIC_ENCRYPTED[3].code.toByte()
    }

    fun encryptFileAes256Gcm(srcFile: File, destFile: File, pass: String) {
        val random = SecureRandom()
        val salt = ByteArray(SALT_LENGTH).also { random.nextBytes(it) }
        val iv = ByteArray(IV_LENGTH).also { random.nextBytes(it) }

        val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        val spec = PBEKeySpec(pass.toCharArray(), salt, PBKDF2_ITERATIONS, KEY_LENGTH_BITS)
        val secretKey = SecretKeySpec(factory.generateSecret(spec).encoded, "AES")

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv))

        val inBuf = ByteArray(64 * 1024)
        FileInputStream(srcFile).buffered().use { fis ->
            FileOutputStream(destFile).buffered().use { fos ->
                fos.write(MAGIC_ENCRYPTED.toByteArray(Charsets.US_ASCII))
                fos.write(salt)
                fos.write(iv)

                var readLen: Int
                while (fis.read(inBuf).also { readLen = it } > 0) {
                    val outBuf = cipher.update(inBuf, 0, readLen)
                    if (outBuf != null && outBuf.isNotEmpty()) {
                        fos.write(outBuf)
                    }
                }
                val finalBuf = cipher.doFinal()
                if (finalBuf != null && finalBuf.isNotEmpty()) {
                    fos.write(finalBuf)
                }
                fos.flush()
            }
        }
    }

    fun decryptFileAes256Gcm(srcFile: File, destFile: File, pass: String): Boolean {
        if (!isEncryptedPackage(srcFile)) return false
        val headerSize = 4 + SALT_LENGTH + IV_LENGTH
        if (srcFile.length() < headerSize) return false

        return try {
            FileInputStream(srcFile).buffered().use { fis ->
                val magic = ByteArray(4)
                if (fis.read(magic) != 4) return false

                val salt = ByteArray(SALT_LENGTH)
                if (fis.read(salt) != SALT_LENGTH) return false

                val iv = ByteArray(IV_LENGTH)
                if (fis.read(iv) != IV_LENGTH) return false

                val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
                val spec = PBEKeySpec(pass.toCharArray(), salt, PBKDF2_ITERATIONS, KEY_LENGTH_BITS)
                val secretKey = SecretKeySpec(factory.generateSecret(spec).encoded, "AES")

                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv))

                val inBuf = ByteArray(64 * 1024)
                FileOutputStream(destFile).buffered().use { fos ->
                    var readLen: Int
                    while (fis.read(inBuf).also { readLen = it } > 0) {
                        val outBuf = cipher.update(inBuf, 0, readLen)
                        if (outBuf != null && outBuf.isNotEmpty()) {
                            fos.write(outBuf)
                        }
                    }
                    val finalBuf = cipher.doFinal()
                    if (finalBuf != null && finalBuf.isNotEmpty()) {
                        fos.write(finalBuf)
                    }
                    fos.flush()
                }
            }
            true
        } catch (e: Exception) {
            if (destFile.exists()) {
                destFile.delete()
            }
            false
        }
    }

    fun encryptAes256Gcm(data: ByteArray, pass: String): ByteArray {
        val random = SecureRandom()
        val salt = ByteArray(SALT_LENGTH).also { random.nextBytes(it) }
        val iv = ByteArray(IV_LENGTH).also { random.nextBytes(it) }

        val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        val spec = PBEKeySpec(pass.toCharArray(), salt, PBKDF2_ITERATIONS, KEY_LENGTH_BITS)
        val secretKey = SecretKeySpec(factory.generateSecret(spec).encoded, "AES")

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv))
        val ciphertext = cipher.doFinal(data)

        // Header layout: MAGIC (4) + SALT (16) + IV (12) + CIPHERTEXT
        val out = ByteArrayOutputStream()
        out.write(MAGIC_ENCRYPTED.toByteArray(Charsets.US_ASCII))
        out.write(salt)
        out.write(iv)
        out.write(ciphertext)
        return out.toByteArray()
    }

    fun decryptAes256Gcm(encrypted: ByteArray, pass: String): ByteArray? {
        return try {
            if (!isEncryptedPackage(encrypted)) return null
            var offset = 4
            val salt = encrypted.copyOfRange(offset, offset + SALT_LENGTH)
            offset += SALT_LENGTH
            val iv = encrypted.copyOfRange(offset, offset + IV_LENGTH)
            offset += IV_LENGTH
            val ciphertext = encrypted.copyOfRange(offset, encrypted.size)

            val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
            val spec = PBEKeySpec(pass.toCharArray(), salt, PBKDF2_ITERATIONS, KEY_LENGTH_BITS)
            val secretKey = SecretKeySpec(factory.generateSecret(spec).encoded, "AES")

            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv))
            cipher.doFinal(ciphertext)
        } catch (e: Exception) {
            null
        }
    }

    private fun getOrRegisterAnonDropKey(): String {
        return try {
            val regUrl = URL("https://anondrop.net/register")
            val conn = (regUrl.openConnection() as HttpURLConnection).apply {
                setRequestProperty("User-Agent", "Mozilla/5.0 (Android; Mobile)")
                connectTimeout = 10000
                readTimeout = 15000
            }
            if (conn.responseCode == 200) {
                val body = conn.inputStream.bufferedReader().use { it.readText() }
                val match = Regex("""(?:localStorage\.setItem\(['"]userkey['"],\s*['"]([a-zA-Z0-9]+)['"]|['"]([a-zA-Z0-9]{20})['"])""").find(body)
                val key = match?.groupValues?.getOrNull(1)?.takeIf { it.isNotBlank() }
                    ?: match?.groupValues?.getOrNull(2)?.takeIf { it.isNotBlank() }
                if (!key.isNullOrBlank()) {
                    return key
                }
            }
            generateRandomKey(20)
        } catch (e: Exception) {
            generateRandomKey(20)
        }
    }

    private fun generateRandomKey(length: Int): String {
        val chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        val rnd = SecureRandom()
        return (1..length).map { chars[rnd.nextInt(chars.length)] }.joinToString("")
    }

    private fun generateRandomBinId(): String {
        val chars = "abcdefghijklmnopqrstuvwxyz0123456789"
        val rnd = SecureRandom()
        return (1..16).map { chars[rnd.nextInt(chars.length)] }.joinToString("")
    }
}
