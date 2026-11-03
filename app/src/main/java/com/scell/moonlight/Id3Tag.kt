package com.scell.moonlight

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

/**
 * Reads and writes the pieces of an MP3's ID3v2 tag that Moonlight cares about, without ffmpeg:
 *
 *   TIT2  the title            (replaced when a song is saved under a new name)
 *   APIC  the cover picture    (replaced by the part of the video thumbnail you chose)
 *   WOAS  the source link      (the web page the song was downloaded from, kept for a future "Share")
 *
 * Everything else in the tag (artist, album, ReplayGain, ...) and the audio are copied byte for byte, and the
 * source file is never changed: the result goes to a second file, so a failure leaves the song as it was.
 * Pure java.io, so it also runs on a plain JVM. Like Id3Title, it does not support ID3v2.2, tags that are
 * unsynchronised as a whole, or damaged tags: an [IOException] says so (yt-dlp/ffmpeg never write those).
 *
 * The source link is stored as the standard WOAS frame ("official audio source webpage"), plain Latin-1 text.
 * [readSourceUrl] also understands the "purl" frame that yt-dlp's --embed-metadata writes (a TXXX frame), so
 * songs downloaded before this tag existed still know where they came from.
 */
object Id3Tag {

    private class Tag(val major: Int, val frames: List<ByteArray>, val audioStart: Long)

    /* ---------------------------------------------------------------------------------- reading */

    @Throws(IOException::class)
    private fun parse(raf: RandomAccessFile): Tag {
        val length = raf.length()
        if (length < 10) return Tag(3, emptyList(), 0L)
        val header = ByteArray(10)
        raf.seek(0)
        raf.readFully(header)
        if (header[0] != 'I'.code.toByte() || header[1] != 'D'.code.toByte() || header[2] != '3'.code.toByte()) {
            return Tag(3, emptyList(), 0L)
        }
        val major = header[3].toInt()
        if (major != 3 && major != 4) throw IOException("ID3v2.$major tags are not supported")
        val flags = header[5].toInt() and 0xFF
        if (flags and 0x80 != 0) throw IOException("unsynchronised ID3 tags are not supported")
        val size = syncsafe(header, 6)
        if (size < 0 || 10L + size > length) throw IOException("the ID3 tag is damaged")
        val body = ByteArray(size)
        raf.readFully(body)
        val footer = if (major == 4 && flags and 0x10 != 0) 10 else 0
        val frames = ArrayList<ByteArray>()
        var pos = 0
        if (flags and 0x40 != 0) {                              // an extended header: skip (and drop) it
            if (body.size < 4) throw IOException("the ID3 tag is damaged")
            val ext = if (major == 4) syncsafe(body, 0) else bigEndian(body, 0) + 4
            if (ext < 4 || ext > body.size) throw IOException("the ID3 tag is damaged")
            pos = ext
        }
        while (pos + 10 <= body.size) {
            if (body[pos].toInt() == 0) break                    // padding: no more frames
            val frameSize = if (major == 4) syncsafe(body, pos + 4) else bigEndian(body, pos + 4)
            if (frameSize < 0 || pos + 10L + frameSize > body.size) throw IOException("the ID3 tag is damaged")
            frames.add(body.copyOfRange(pos, pos + 10 + frameSize))
            pos += 10 + frameSize
        }
        return Tag(major, frames, 10L + size + footer)
    }

    private fun idOf(frame: ByteArray) = String(frame, 0, 4, Charsets.ISO_8859_1)

    /** The first cover picture (APIC) of the file: the raw image bytes (JPEG/PNG), or null when there is none. */
    fun readCover(file: File): ByteArray? {
        return try {
            RandomAccessFile(file, "r").use { raf ->
                for (f in parse(raf).frames) {
                    if (idOf(f) != "APIC") continue
                    val b = f.copyOfRange(10, f.size)
                    if (b.size < 4) continue
                    val enc = b[0].toInt()
                    var i = 1
                    while (i < b.size && b[i].toInt() != 0) i++            // the MIME type
                    i += 2                                                   // its terminator and the picture type
                    if (i >= b.size) continue
                    val afterDescription = endOfText(b, i, enc)
                    if (afterDescription in 0 until b.size) return b.copyOfRange(afterDescription, b.size)
                }
                null
            }
        } catch (e: Exception) {
            null
        }
    }

    /** The web page the song came from (WOAS, else a TXXX "SOURCE_URL" / yt-dlp "purl"), or null. */
    fun readSourceUrl(file: File): String? {
        return try {
            RandomAccessFile(file, "r").use { raf ->
                var fallback: String? = null
                for (f in parse(raf).frames) {
                    val id = idOf(f)
                    if (id == "WOAS") {
                        val url = String(f, 10, f.size - 10, Charsets.ISO_8859_1).substringBefore('\u0000').trim()
                        if (url.isNotEmpty()) return url
                    } else if (id == "TXXX" && f.size > 12) {
                        val b = f.copyOfRange(10, f.size)
                        val enc = b[0].toInt()
                        val valueStart = endOfText(b, 1, enc)
                        if (valueStart < 0 || valueStart > b.size) continue
                        val desc = decode(enc, b, 1, termStart(b, 1, enc)).trim()
                        if (desc.equals("SOURCE_URL", true) || desc.equals("purl", true)) {
                            val v = decode(enc, b, valueStart, b.size).substringBefore('\u0000').trim()
                            if (v.isNotEmpty() && fallback == null) fallback = v
                        }
                    }
                }
                fallback
            }
        } catch (e: Exception) {
            null
        }
    }

    // The index of the first byte of the text's terminator (a single 0 for Latin-1/UTF-8, an aligned 00 00 for UTF-16).
    private fun termStart(b: ByteArray, from: Int, enc: Int): Int {
        var i = from
        if (enc == 1 || enc == 2) {
            while (i + 1 < b.size && !(b[i].toInt() == 0 && b[i + 1].toInt() == 0 && (i - from) % 2 == 0)) i++
            return minOf(i, b.size)
        }
        while (i < b.size && b[i].toInt() != 0) i++
        return i
    }

    // The index just after the text's terminator (where the next field starts).
    private fun endOfText(b: ByteArray, from: Int, enc: Int): Int {
        val t = termStart(b, from, enc)
        return t + if (enc == 1 || enc == 2) 2 else 1
    }

    private fun decode(enc: Int, b: ByteArray, from: Int, to: Int): String {
        if (to <= from) return ""
        val n = to - from
        return when (enc) {
            0 -> String(b, from, n, Charsets.ISO_8859_1)
            1 -> {
                val bomBE = n >= 2 && (b[from].toInt() and 0xFF) == 0xFE && (b[from + 1].toInt() and 0xFF) == 0xFF
                val bomLE = n >= 2 && (b[from].toInt() and 0xFF) == 0xFF && (b[from + 1].toInt() and 0xFF) == 0xFE
                when {
                    bomBE -> String(b, from + 2, n - 2, Charsets.UTF_16BE)
                    bomLE -> String(b, from + 2, n - 2, Charsets.UTF_16LE)
                    else -> String(b, from, n, Charsets.UTF_16LE)
                }
            }
            2 -> String(b, from, n, Charsets.UTF_16BE)
            else -> String(b, from, n, Charsets.UTF_8)
        }
    }

    /* ---------------------------------------------------------------------------------- writing */

    /**
     * Writes a copy of [src] to [dst] with the given pieces replaced. A null argument leaves that piece as it
     * is. [title] "" is treated like null. [sourceUrl] must be an ASCII web address (anything else is ignored).
     */
    @Throws(IOException::class)
    fun copyWith(src: File, dst: File, title: String?, cover: ByteArray?, sourceUrl: String?) {
        RandomAccessFile(src, "r").use { raf ->
            val length = raf.length()
            val tag = parse(raf)
            val major = tag.major
            val newTitle = title?.takeIf { it.isNotEmpty() }
            val url = sourceUrl?.takeIf { it.isNotEmpty() && it.all { c -> c.code in 32..126 } }

            val kept = ByteArrayOutputStream()
            for (f in tag.frames) {
                val id = idOf(f)
                if (newTitle != null && id == "TIT2") continue
                if (cover != null && id == "APIC") continue
                if (url != null && id == "WOAS") continue
                kept.write(f)
            }
            val added = ByteArrayOutputStream()
            if (newTitle != null) added.write(titleFrame(newTitle, major))
            if (cover != null) added.write(coverFrame(cover, major))
            if (url != null) added.write(frame("WOAS", url.toByteArray(Charsets.ISO_8859_1), major))
            val bodySize = added.size() + kept.size()

            dst.outputStream().buffered().use { out ->
                out.write(byteArrayOf('I'.code.toByte(), 'D'.code.toByte(), '3'.code.toByte(), major.toByte(), 0, 0))
                out.write(syncsafeBytes(bodySize))
                added.writeTo(out)
                kept.writeTo(out)

                // The audio, up to a trailing ID3v1 tag (128 bytes starting with "TAG") if there is one.
                val audioStart = tag.audioStart
                var audioEnd = length
                var v1: ByteArray? = null
                if (length - audioStart >= 128) {
                    val tail = ByteArray(128)
                    raf.seek(length - 128)
                    raf.readFully(tail)
                    if (tail[0] == 'T'.code.toByte() && tail[1] == 'A'.code.toByte() && tail[2] == 'G'.code.toByte()) {
                        v1 = tail
                        audioEnd = length - 128
                    }
                }
                raf.seek(audioStart)
                val buffer = ByteArray(64 * 1024)
                var left = audioEnd - audioStart
                while (left > 0) {
                    val n = raf.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
                    if (n < 0) throw IOException("the file ended unexpectedly")
                    out.write(buffer, 0, n)
                    left -= n
                }
                if (v1 != null) {
                    if (newTitle != null) {                                  // ID3v1: the title is bytes 3..32, Latin-1
                        for (i in 3 until 33) v1[i] = 0
                        val text = newTitle.map { if (it.code <= 0xFF) it.code.toByte() else '?'.code.toByte() }
                        for (i in 0 until minOf(30, text.size)) v1[3 + i] = text[i]
                    }
                    out.write(v1)
                }
            }
        }
    }

    private fun frame(id: String, payload: ByteArray, major: Int): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(id.toByteArray(Charsets.ISO_8859_1))
        out.write(if (major == 4) syncsafeBytes(payload.size) else bigEndianBytes(payload.size))
        out.write(0)
        out.write(0)
        out.write(payload)
        return out.toByteArray()
    }

    /** A TIT2 frame: Latin-1 when every character fits, otherwise UTF-16 with a byte-order mark. */
    private fun titleFrame(title: String, major: Int): ByteArray {
        val payload = ByteArrayOutputStream()
        if (title.all { it.code <= 0xFF }) {
            payload.write(0)
            payload.write(title.toByteArray(Charsets.ISO_8859_1))
        } else {
            payload.write(1)
            payload.write(0xFF)
            payload.write(0xFE)
            payload.write(title.toByteArray(Charsets.UTF_16LE))
        }
        return frame("TIT2", payload.toByteArray(), major)
    }

    /** An APIC frame holding a JPEG as the front cover. */
    private fun coverFrame(jpeg: ByteArray, major: Int): ByteArray {
        val payload = ByteArrayOutputStream()
        payload.write(0)                                              // text encoding: Latin-1
        payload.write("image/jpeg".toByteArray(Charsets.ISO_8859_1))
        payload.write(0)
        payload.write(3)                                              // picture type: front cover
        payload.write(0)                                              // empty description
        payload.write(jpeg)
        return frame("APIC", payload.toByteArray(), major)
    }

    private fun syncsafe(b: ByteArray, at: Int): Int {
        var value = 0
        for (i in 0 until 4) {
            val v = b[at + i].toInt() and 0xFF
            if (v and 0x80 != 0) return -1                            // not a valid size
            value = (value shl 7) or v
        }
        return value
    }

    private fun bigEndian(b: ByteArray, at: Int): Int {
        var value = 0L
        for (i in 0 until 4) value = (value shl 8) or (b[at + i].toLong() and 0xFF)
        return if (value > Int.MAX_VALUE) -1 else value.toInt()
    }

    private fun syncsafeBytes(n: Int) = byteArrayOf(
        ((n shr 21) and 0x7F).toByte(), ((n shr 14) and 0x7F).toByte(),
        ((n shr 7) and 0x7F).toByte(), (n and 0x7F).toByte(),
    )

    private fun bigEndianBytes(n: Int) = byteArrayOf(
        ((n shr 24) and 0xFF).toByte(), ((n shr 16) and 0xFF).toByte(),
        ((n shr 8) and 0xFF).toByte(), (n and 0xFF).toByte(),
    )
}
