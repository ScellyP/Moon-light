package com.scell.moonlight

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
    private val cacheDir: File = File("/storage/emulated/0/Android/data/com.scell.moonlight/cache/shared-playlists")
) {

    companion object {
        const val MAGIC_ENCRYPTED = "MLPK"   // Moonlight Package Magic (4 bytes)
        const val VERSION = 1
        const val PBKDF2_ITERATIONS = 65536
        const val KEY_LENGTH_BITS = 256
        const val GCM_TAG_LENGTH_BITS = 128
        const val SALT_LENGTH = 16
        const val IV_LENGTH = 12

        /** Recognizes a Filebin link: e.g. https://filebin.net/abc123xyz or https://filebin.net/abc123xyz/playlist.zip */
        private val FILEBIN_REGEX = Regex("""https?://filebin\.net/([a-zA-Z0-9_-]+)(?:/([^\s/?#]+))?""", RegexOption.IGNORE_CASE)

        fun isFilebinUrl(url: String): Boolean = FILEBIN_REGEX.containsMatchIn(url.trim())

        fun parseFilebinUrl(url: String): Pair<String, String?>? {
            val match = FILEBIN_REGEX.find(url.trim()) ?: return null
            val bin = match.groupValues[1]
            val file = if (match.groupValues.size > 2 && match.groupValues[2].isNotBlank()) match.groupValues[2] else null
            return bin to file
        }
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
        password: String? = null
    ): SharePackageResult {
        return try {
            cacheDir.mkdirs()
            val safeName = playlistKey.replace(Regex("[^a-zA-Z0-9_.-]"), "_")

            // 1. Locate playlist file in Moonlight/playlists/
            val playlistsDir = File(playerRoot, "playlists")
            val playlistFile = File(playlistsDir, "$playlistKey.json").takeIf { it.isFile }
                ?: playlistsDir.listFiles()?.firstOrNull { it.name.startsWith(playlistKey) && it.name.endsWith(".json") }
                ?: return SharePackageResult(success = false, error = "Playlist not found: $playlistKey")

            val playlistJsonStr = playlistFile.readText()
            val playlistJson = JSONObject(playlistJsonStr)
            val plName = playlistJson.optString("name", safeName)

            // 2. Identify referenced songs
            val songsDir = File(playerRoot, "Songs")
            val songsArray = playlistJson.optJSONArray("songs") ?: org.json.JSONArray()
            val songFiles = mutableListOf<File>()

            for (i in 0 until songsArray.length()) {
                val item = songsArray.optJSONObject(i) ?: continue
                val ref = item.optString("ref", "")
                val fileName = ref.substringAfter("Songs/").substringAfter("Audio/")
                val songFile = File(songsDir, fileName).takeIf { it.isFile }
                    ?: File(playerRoot, ref).takeIf { it.isFile }
                if (songFile != null && !songFiles.contains(songFile)) {
                    songFiles.add(songFile)
                }
            }

            // 3. Identify cover
            val coversDir = File(playerRoot, "playlist-covers")
            val coverFile = File(coversDir, "$playlistKey.jpg").takeIf { it.isFile }
                ?: File(coversDir, "$safeName.jpg").takeIf { it.isFile }

            // 4. Build unencrypted ZIP in memory/temp buffer
            val rawZipStream = ByteArrayOutputStream()
            ZipOutputStream(rawZipStream.buffered()).use { zos ->
                zos.setLevel(1)

                // Manifest
                val manifest = JSONObject().apply {
                    put("format", "moonlight-shared-playlist")
                    put("version", VERSION)
                    put("playlistName", plName)
                    put("playlistId", playlistKey)
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
                for (sFile in songFiles) {
                    zos.putNextEntry(ZipEntry("songs/${sFile.name}").apply { time = sFile.lastModified() })
                    FileInputStream(sFile).use { fis ->
                        var len: Int
                        while (fis.read(buf).also { len = it } > 0) {
                            zos.write(buf, 0, len)
                        }
                    }
                    zos.closeEntry()
                }
                zos.finish()
            }

            val rawData = rawZipStream.toByteArray()
            val fileName = "$safeName.moonlight"
            val targetFile = File(cacheDir, fileName)

            if (!password.isNullOrBlank()) {
                // AES-256-GCM encryption with PBKDF2
                val encrypted = encryptAes256Gcm(rawData, password)
                FileOutputStream(targetFile).use { it.write(encrypted) }
                SharePackageResult(
                    success = true,
                    filePath = targetFile.absolutePath,
                    fileName = fileName,
                    isEncrypted = true,
                    songCount = songFiles.size,
                    size = targetFile.length()
                )
            } else {
                FileOutputStream(targetFile).use { it.write(rawData) }
                SharePackageResult(
                    success = true,
                    filePath = targetFile.absolutePath,
                    fileName = fileName,
                    isEncrypted = false,
                    songCount = songFiles.size,
                    size = targetFile.length()
                )
            }
        } catch (e: Exception) {
            SharePackageResult(success = false, error = e.message ?: "Failed to create package")
        }
    }

    /**
     * Uploads a package to Filebin via REST API (POST https://filebin.net/{bin}/{filename}).
     * Returns public shareable URL: https://filebin.net/{bin}
     */
    fun uploadToFilebin(
        file: File,
        binId: String? = null
    ): Pair<Boolean, String> {
        return try {
            if (!file.isFile || file.length() == 0L) {
                return false to "File to upload is empty or not found"
            }
            val bin = binId ?: generateRandomBinId()
            val uploadUrl = URL("https://filebin.net/$bin/${file.name}")
            val conn = (uploadUrl.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                setRequestProperty("Content-Type", "application/octet-stream")
                setRequestProperty("User-Agent", "Moonlight-MusicPlayer/1.16")
                setConnectTimeout(15000)
                setReadTimeout(60000)
            }

            FileInputStream(file).use { fis ->
                conn.outputStream.use { os ->
                    val buf = ByteArray(32 * 1024)
                    var len: Int
                    while (fis.read(buf).also { len = it } > 0) {
                        os.write(buf, 0, len)
                    }
                }
            }

            val code = conn.responseCode
            if (code == 201 || code == 200) {
                val shareLink = "https://filebin.net/$bin"
                true to shareLink
            } else if (code == 503) {
                false to "Filebin server is currently at capacity (503). Use direct sharing instead."
            } else {
                false to "Filebin upload failed with HTTP code $code"
            }
        } catch (e: Exception) {
            false to (e.message ?: "Network error uploading to Filebin")
        }
    }

    /**
     * Downloads a playlist package from a Filebin link into cacheDir.
     */
    fun downloadFromFilebin(
        filebinUrl: String
    ): Pair<Boolean, File?> {
        return try {
            val parsed = parseFilebinUrl(filebinUrl) ?: return false to null
            val bin = parsed.first
            cacheDir.mkdirs()

            // If file was specified, download direct; otherwise check bin metadata for moonlight package
            val downloadUrl = if (parsed.second != null) {
                URL("https://filebin.net/$bin/${parsed.second}")
            } else {
                // Fetch bin metadata
                val metaUrl = URL("https://filebin.net/$bin")
                val metaConn = (metaUrl.openConnection() as HttpURLConnection).apply {
                    setRequestProperty("Accept", "application/json")
                    connectTimeout = 10000
                    readTimeout = 15000
                }
                if (metaConn.responseCode != 200) return false to null
                val metaStr = metaConn.inputStream.bufferedReader().use { it.readText() }
                val metaJson = JSONObject(metaStr)
                val filesArr = metaJson.optJSONArray("files")
                var targetFilename: String? = null
                if (filesArr != null) {
                    for (i in 0 until filesArr.length()) {
                        val f = filesArr.optJSONObject(i) ?: continue
                        val fn = f.optString("filename", "")
                        if (fn.endsWith(".moonlight") || fn.endsWith(".zip")) {
                            targetFilename = fn
                            break
                        }
                    }
                }
                val fn = targetFilename ?: "${bin}.zip"
                URL("https://filebin.net/$bin/$fn")
            }

            val targetFile = File(cacheDir, "downloaded-${bin}.moonlight")
            val conn = (downloadUrl.openConnection() as HttpURLConnection).apply {
                connectTimeout = 15000
                readTimeout = 60000
            }
            if (conn.responseCode != 200) return false to null

            conn.inputStream.use { ins ->
                FileOutputStream(targetFile).use { fos ->
                    val buf = ByteArray(32 * 1024)
                    var len: Int
                    while (ins.read(buf).also { len = it } > 0) {
                        fos.write(buf, 0, len)
                    }
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
     */
    fun importPackage(
        packageFile: File,
        password: String? = null
    ): ImportResult {
        return try {
            if (!packageFile.isFile || packageFile.length() == 0L) {
                return ImportResult(success = false, error = "Package file not found")
            }

            val rawBytes = packageFile.readBytes()
            val zipBytes: ByteArray

            // Check if encrypted
            if (isEncryptedPackage(rawBytes)) {
                if (password.isNullOrBlank()) {
                    return ImportResult(success = false, requiresPassword = true, error = "Password required to decrypt this playlist")
                }
                zipBytes = decryptAes256Gcm(rawBytes, password) ?: return ImportResult(
                    success = false,
                    requiresPassword = true,
                    error = "Incorrect password"
                )
            } else {
                zipBytes = rawBytes
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

            ZipInputStream(ByteArrayInputStream(zipBytes)).use { zis ->
                var entry = zis.nextEntry
                while (entry != null) {
                    val name = entry.name
                    if (!entry.isDirectory && !name.contains("..")) {
                        when {
                            name == "manifest.json" -> {
                                val mStr = zis.bufferedReader().use { it.readText() }
                                val m = JSONObject(mStr)
                                plName = m.optString("playlistName", "")
                                plId = m.optString("playlistId", "")
                            }
                            name == "playlist.json" -> {
                                val plDest = File(playlistsDir, if (plId.isNotBlank()) "$plId.json" else "imported-${System.currentTimeMillis()}.json")
                                FileOutputStream(plDest).use { fos ->
                                    var len: Int
                                    while (zis.read(buf).also { len = it } > 0) {
                                        fos.write(buf, 0, len)
                                    }
                                }
                            }
                            name == "cover.jpg" -> {
                                val cDest = File(coversDir, if (plId.isNotBlank()) "$plId.jpg" else "imported.jpg")
                                FileOutputStream(cDest).use { fos ->
                                    var len: Int
                                    while (zis.read(buf).also { len = it } > 0) {
                                        fos.write(buf, 0, len)
                                    }
                                }
                            }
                            name.startsWith("songs/") -> {
                                val fn = name.substringAfter("songs/")
                                if (fn.isNotBlank()) {
                                    val sDest = File(songsDir, fn)
                                    FileOutputStream(sDest).use { fos ->
                                        var len: Int
                                        while (zis.read(buf).also { len = it } > 0) {
                                            fos.write(buf, 0, len)
                                        }
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
        }
    }

    // ---- AES-256-GCM Helper Methods -------------------------------------------------------------------

    private fun isEncryptedPackage(bytes: ByteArray): Boolean {
        if (bytes.size < 4) return false
        return bytes[0] == MAGIC_ENCRYPTED[0].code.toByte() &&
               bytes[1] == MAGIC_ENCRYPTED[1].code.toByte() &&
               bytes[2] == MAGIC_ENCRYPTED[2].code.toByte() &&
               bytes[3] == MAGIC_ENCRYPTED[3].code.toByte()
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

    private fun generateRandomBinId(): String {
        val chars = "abcdefghijklmnopqrstuvwxyz0123456789"
        val rnd = SecureRandom()
        return (1..16).map { chars[rnd.nextInt(chars.length)] }.joinToString("")
    }
}
