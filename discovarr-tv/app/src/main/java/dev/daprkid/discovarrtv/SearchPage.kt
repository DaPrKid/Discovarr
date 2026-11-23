package dev.daprkid.discovarrtv

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.daprkid.discovarrtv.ui.FocusableSurface
import dev.daprkid.discovarrtv.ui.Palette
import dev.daprkid.discovarrtv.ui.PosterCard
import dev.daprkid.discovarrtv.ui.RemoteImage
import dev.daprkid.discovarrtv.ui.StatusLine
import dev.daprkid.discovarrtv.ui.TvButton
import dev.daprkid.discovarrtv.ui.TvTextField
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Search, built the way the web's search box behaves.
 *
 * The browser answers as you type: its suggestion endpoint returns names, art
 * and whether the library already holds the title before anybody presses
 * anything, so the television does the same and puts those eight names straight
 * under the field, ready for the D-pad. Pressing Search then asks the full
 * endpoint for a grid.
 *
 * The filters are the web's own, as far as the JSON behind them goes: type,
 * decade, newest first and "in my library". Genre and rating are filtered on
 * TMDB's side in the browser and simply do not travel in `/api/v1/search`
 * results, so offering them here would only produce an empty screen.
 */
@Composable
fun SearchScreen(
    client: DiscovarrClient,
    libraryKeys: Set<String>,
    onOpen: (Media) -> Unit,
) {
    var query by remember { mutableStateOf("") }
    var type by remember { mutableStateOf("all") }
    var decade by remember { mutableStateOf<String?>(null) }
    var newestFirst by remember { mutableStateOf(false) }
    var inLibraryOnly by remember { mutableStateOf(false) }

    var suggestions by remember { mutableStateOf<List<Media>>(emptyList()) }
    var everyResult by remember { mutableStateOf<List<Media>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    var isError by remember { mutableStateOf(false) }
    var searched by remember { mutableStateOf(false) }

    val scope = rememberCoroutineScope()

    fun inLibrary(item: Media): Boolean =
        item.isAvailable ||
            (item.tmdbId != null && libraryKeys.contains("${item.mediaType}:${item.tmdbId}"))

    // Filters are applied to what came back rather than to a new request: the
    // endpoint has no filter parameters, and re-running it for a decade would
    // search the same catalog for the same answer.
    val results = remember(everyResult, decade, newestFirst, inLibraryOnly) {
        val picked = decade
        val kept = everyResult
            .filter { item ->
                when (picked) {
                    null -> true
                    "older" -> (item.year?.toIntOrNull() ?: 9999) < 1990
                    else -> item.year?.startsWith(picked) == true
                }
            }
            .filter { !inLibraryOnly || inLibrary(it) }
        if (newestFirst) kept.sortedByDescending { it.year ?: "" } else kept
    }

    // Suggestions restart the effect on every keystroke, which is the debounce:
    // somebody typing six letters quickly makes one request, not six.
    LaunchedEffect(query, type) {
        val text = query.trim()
        if (text.length < 2) {
            suggestions = emptyList()
            return@LaunchedEffect
        }
        delay(280)
        suggestions = runCatching { client.suggest(text, type) }.getOrDefault(emptyList())
    }

    fun run() {
        if (query.isBlank()) {
            status = "Type something to search for."
            isError = true
            return
        }
        busy = true
        status = null
        scope.launch {
            try {
                everyResult = client.search(query, type)
                searched = true
                if (everyResult.isEmpty()) {
                    status = "Nothing found for \"$query\"."
                    isError = true
                }
            } catch (error: Exception) {
                everyResult = emptyList()
                status = error.message ?: "Search failed"
                isError = true
            } finally {
                busy = false
            }
        }
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 36.dp, end = 52.dp, top = 28.dp, bottom = 48.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Column {
                Text("Search", style = Palette.Title)
                Text(
                    "Films and series",
                    style = Palette.BodyMuted,
                )
            }
        }

        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TvTextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = "Film or series",
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(12.dp))
                TvButton(
                    label = if (busy) "Searching..." else "Search",
                    onClick = { run() },
                    enabled = !busy,
                )
            }
        }

        if (suggestions.isNotEmpty()) {
            item {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(Palette.Surface)
                        .border(1.dp, Palette.Line, RoundedCornerShape(12.dp))
                        .padding(vertical = 6.dp),
                ) {
                    Text(
                        "Suggestions",
                        style = Palette.Label,
                        modifier = Modifier.padding(start = 14.dp, top = 4.dp, bottom = 4.dp),
                    )
                    suggestions.forEach { item ->
                        SuggestionRow(
                            item = item,
                            imageUrl = item.posterPath?.let { client.resolveImage(it) },
                            badge = when {
                                item.isAvailable -> "Available"
                                inLibrary(item) -> "In library"
                                else -> null
                            },
                            onClick = { onOpen(item) },
                        )
                    }
                }
            }
        }

        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val types = listOf(
                        "All" to "all",
                        "Movies" to "movie",
                        "Shows" to "tv",
                    )
                    items(types.size) { index ->
                        val (label, value) = types[index]
                        FilterChip(label, type == value) { type = value }
                    }
                }

                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val decades = listOf(
                        "Any year" to null,
                        "2020s" to "202",
                        "2010s" to "201",
                        "2000s" to "200",
                        "1990s" to "199",
                        "Older" to "older",
                    )
                    items(decades.size) { index ->
                        val (label, value) = decades[index]
                        FilterChip(label, decade == value) { decade = value }
                    }
                }

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip("In my library", inLibraryOnly) { inLibraryOnly = !inLibraryOnly }
                    FilterChip("Newest first", newestFirst) { newestFirst = !newestFirst }
                }
            }
        }

        item { StatusLine(status, isError) }

        if (!searched) {
            item {
                Text(
                    "Start typing and the titles appear above; press Search for the full list.",
                    style = Palette.BodyMuted,
                )
            }
        } else if (results.isEmpty()) {
            item {
                Text(
                    "Nothing matches these filters. Widen the decade or turn the library switch off.",
                    style = Palette.BodyMuted,
                )
            }
        }

        results.chunked(4).forEachIndexed { index, row ->
            item(key = "row-$index") {
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    row.forEach { media ->
                        PosterCard(
                            title = media.title,
                            subtitle = media.year ?: media.subtitle,
                            imageUrl = client.resolveImage(media.posterPath),
                            onClick = { onOpen(media) },
                            badge = if (inLibrary(media)) "LIBRARY" else null,
                            artFallback = { client.posterFor(media) },
                        )
                    }
                }
            }
        }

        if (searched && results.isNotEmpty()) {
            item {
                Text(
                    if (results.size == everyResult.size) {
                        "${results.size} result(s)"
                    } else {
                        "${results.size} of ${everyResult.size} result(s) after the filters"
                    },
                    style = Palette.Chip,
                )
            }
        }
    }
}

/** One suggestion: its art, its name, and what the library thinks of it. */
@Composable
private fun SuggestionRow(
    item: Media,
    imageUrl: String?,
    badge: String?,
    onClick: () -> Unit,
) {
    FocusableSurface(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        focusedScale = 1.01f,
    ) { focused ->
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RemoteImage(
                url = imageUrl,
                label = item.title,
                modifier = Modifier
                    .width(32.dp)
                    .height(48.dp)
                    .clip(RoundedCornerShape(5.dp)),
            )
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    item.title,
                    style = Palette.Body.copy(
                        color = if (focused) Palette.Accent else Palette.TextPrimary,
                    ),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    listOfNotNull(
                        when (item.mediaType) {
                            "tv" -> "Series"
                            "movie" -> "Movie"
                            "book" -> "Book"
                            "audiobook" -> "Audiobook"
                            else -> null
                        },
                        item.year,
                    ).joinToString(" · "),
                    style = Palette.Chip,
                )
            }
            badge?.let {
                Text(it, style = Palette.Chip.copy(color = Palette.Success))
            }
        }
    }
}

/** A filter you can see at a glance: filled when on, outlined when off. */
@Composable
private fun FilterChip(label: String, active: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(18.dp)
    FocusableSurface(
        onClick = onClick,
        shape = shape,
        focusedScale = 1.03f,
    ) { focused ->
        Box(
            modifier = Modifier
                .clip(shape)
                .background(if (active) Palette.Accent else Palette.SurfaceHigh)
                .border(
                    if (focused) 2.dp else 1.dp,
                    when {
                        focused -> Palette.TextPrimary
                        active -> Palette.Accent
                        else -> Palette.Line
                    },
                    shape,
                )
                .padding(horizontal = 16.dp, vertical = 9.dp),
        ) {
            Text(
                label,
                style = Palette.Chip.copy(
                    color = if (active) Color.White else Palette.TextSecondary,
                ),
            )
        }
    }
}
