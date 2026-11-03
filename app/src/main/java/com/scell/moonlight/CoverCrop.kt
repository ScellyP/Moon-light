package com.scell.moonlight

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream

/**
 * Cuts the part of a picture you chose out of it and returns it as a square JPEG (for the song's cover).
 * The area is given as fractions of the picture, so it does not matter how big the picture is:
 *   x, y  = the top-left corner as a fraction of the width / height (0..1)
 *   size  = the side of the square as a fraction of the SHORTER side of the picture (0.05..1)
 */
object CoverCrop {

    /** The cropped square as JPEG bytes (at most [maxSide] pixels wide), or null when the picture cannot be read. */
    fun crop(picture: ByteArray?, x: Float, y: Float, size: Float, maxSide: Int = 720): ByteArray? {
        if (picture == null || picture.isEmpty()) return null
        val bitmap = BitmapFactory.decodeByteArray(picture, 0, picture.size) ?: return null
        try {
            val shorter = minOf(bitmap.width, bitmap.height)
            val side = (shorter * size.coerceIn(0.05f, 1f)).toInt().coerceIn(16, shorter)
            val left = (x * bitmap.width).toInt().coerceIn(0, bitmap.width - side)
            val top = (y * bitmap.height).toInt().coerceIn(0, bitmap.height - side)
            val square = Bitmap.createBitmap(bitmap, left, top, side, side)
            val out = if (side > maxSide) Bitmap.createScaledBitmap(square, maxSide, maxSide, true) else square
            val bytes = ByteArrayOutputStream()
            out.compress(Bitmap.CompressFormat.JPEG, 90, bytes)
            return bytes.toByteArray()
        } finally {
            bitmap.recycle()
        }
    }

    /** Any picture (a gallery image, a song's cover) as a JPEG with its longer side at most [maxSide] pixels. */
    fun shrink(picture: ByteArray?, maxSide: Int = 720): ByteArray? {
        if (picture == null || picture.isEmpty()) return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(picture, 0, picture.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= maxSide && bounds.outHeight / (sample * 2) >= maxSide) sample *= 2
        val bitmap = BitmapFactory.decodeByteArray(picture, 0, picture.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: return null
        try {
            val longer = maxOf(bitmap.width, bitmap.height)
            val out = if (longer > maxSide) {
                val scale = maxSide.toFloat() / longer
                Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt().coerceAtLeast(1), (bitmap.height * scale).toInt().coerceAtLeast(1), true)
            } else {
                bitmap
            }
            val bytes = ByteArrayOutputStream()
            out.compress(Bitmap.CompressFormat.JPEG, 88, bytes)
            return bytes.toByteArray()
        } finally {
            bitmap.recycle()
        }
    }
}
