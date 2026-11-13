package dev.daprkid.discovarrtv.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

/**
 * Poster loading without an image library.
 *
 * Discovarr already proxies TMDB art through `/img/...` (public, cacheable) and
 * returns absolute Open Library URLs for book covers, so all this needs to do is
 * GET a URL and decode it. A 48-bitmap LRU keeps a few screens' worth of posters
 * in memory; the server's own cache means re-fetching is cheap after that.
 */
private object BitmapCache {
    private val cache = object : LruCache<String, Bitmap>(48) {
        override fun sizeOf(key: String, value: Bitmap): Int = 1
    }

    fun get(url: String): Bitmap? = cache.get(url)
    fun put(url: String, bitmap: Bitmap) = cache.put(url, bitmap)
}

private suspend fun fetchBitmap(url: String): Bitmap? = withContext(Dispatchers.IO) {
    BitmapCache.get(url)?.let { return@withContext it }

    // A television on wifi drops the first connection often enough that one
    // retry is the difference between a poster and initials.
    repeat(2) { attempt ->
        var connection: HttpURLConnection? = null
        try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8_000
                readTimeout = 12_000
                instanceFollowRedirects = true
                setRequestProperty("accept", "image/*")
                setRequestProperty("user-agent", "DiscovarrTV")
            }
            if (connection.responseCode !in 200..299) return@withContext null

            // Posters are drawn at roughly a third of their pixel size, so decoding
            // them smaller keeps a low-RAM TV box from thrashing.
            val options = BitmapFactory.Options().apply { inSampleSize = 2 }
            val bitmap = connection.inputStream.use { BitmapFactory.decodeStream(it, null, options) }
            if (bitmap != null) {
                BitmapCache.put(url, bitmap)
                return@withContext bitmap
            }
        } catch (_: Exception) {
            // Fall through to the retry rather than giving up on the first drop.
        } finally {
            connection?.disconnect()
        }

        if (attempt == 0) delay(300)
    }

    null
}

@Composable
fun RemoteImage(
    url: String?,
    label: String,
    modifier: Modifier = Modifier,
    contentScale: ContentScale = ContentScale.Crop,
) {
    val bitmap by produceState<Bitmap?>(initialValue = url?.let(BitmapCache::get), url) {
        if (url != null && value == null) value = fetchBitmap(url)
    }

    // The web fills a missing poster with a hue derived from the title and its
    // initials; this is the same trick, so an untitled release looks deliberate
    // on the television too instead of like a failed download.
    val hue = remember(label) { ((label.hashCode() and 0x7fffffff) % 360).toFloat() }
    val top = remember(hue) { Color.hsl(hue, 0.42f, 0.26f) }
    val bottom = remember(hue) { Color.hsl(hue, 0.40f, 0.13f) }

    Box(modifier = modifier.background(Brush.verticalGradient(listOf(top, bottom)))) {
        val image = bitmap
        if (image != null) {
            Image(
                bitmap = image.asImageBitmap(),
                contentDescription = null,
                contentScale = contentScale,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            // A readable placeholder beats an empty rectangle while art loads,
            // and it stays put if a cover is missing upstream.
            Text(
                text = label.trim().split(" ", "'")
                    .filter { it.isNotBlank() }
                    .take(2)
                    .map { it.first().uppercaseChar() }
                    .joinToString("")
                    .ifEmpty { "?" },
                style = Palette.SectionTitle.copy(color = Palette.TextPrimary.copy(alpha = 0.55f)),
                textAlign = TextAlign.Center,
                modifier = Modifier.align(Alignment.Center),
            )
        }
    }
}
