package dev.daprkid.discovarrtv

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.daprkid.discovarrtv.ui.Palette
import dev.daprkid.discovarrtv.ui.PosterCard
import dev.daprkid.discovarrtv.ui.StatusLine
import dev.daprkid.discovarrtv.ui.TvButton

/**
 * The watchlist, exactly the server's list.
 *
 * There is no JSON endpoint for it — the web app saves with a form post and
 * lists by rendering — so the page is read the way the detail page is. That
 * makes the television and the browser the same list rather than two lists that
 * look alike.
 */
@Composable
fun WatchlistScreen(client: DiscovarrClient, onOpen: (Media) -> Unit) {
    var items by remember { mutableStateOf<List<WatchlistEntry>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var status by remember { mutableStateOf<String?>(null) }
    var isError by remember { mutableStateOf(false) }
    var reload by remember { mutableStateOf(0) }

    LaunchedEffect(reload) {
        loading = true
        try {
            items = client.watchlist()
            status = null
            isError = false
        } catch (error: Exception) {
            status = error.message ?: "Could not read the watchlist"
            isError = true
        } finally {
            loading = false
        }
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 40.dp, end = 60.dp, top = 40.dp, bottom = 60.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        item {
            Row {
                Column {
                    Text("Watchlist", style = Palette.Title)
                    Text(
                        if (loading) "Loading your saved titles..." else "Titles saved for later, newest first.",
                        style = Palette.BodyMuted,
                    )
                }
                Spacer(Modifier.weight(1f))
                TvButton(label = "Refresh", onClick = { reload += 1 }, tone = Palette.SurfaceHigh)
            }
        }

        item { StatusLine(status, isError) }

        if (!loading && items.isEmpty() && !isError) {
            item {
                Text(
                    "Nothing saved yet. Open a title and choose Save to watchlist.",
                    style = Palette.BodyMuted,
                )
            }
        }

        items.chunked(6).forEachIndexed { index, row ->
            item(key = "watch-row-$index") {
                Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                    row.forEach { entry ->
                        PosterCard(
                            title = entry.title,
                            subtitle = entry.meta,
                            imageUrl = client.resolveImage(entry.posterPath),
                            onClick = {
                                onOpen(
                                    stubMedia(
                                        tmdbId = entry.tmdbId,
                                        mediaType = entry.mediaType,
                                        title = entry.title,
                                        posterPath = entry.posterPath,
                                    ),
                                )
                            },
                        )
                    }
                }
            }
        }

        if (items.isNotEmpty()) {
            item {
                Text("${items.size} saved", style = Palette.Chip)
                Spacer(Modifier.height(2.dp))
            }
        }
    }
}
