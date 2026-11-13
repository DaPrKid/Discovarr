package dev.daprkid.discovarrtv

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.daprkid.discovarrtv.ui.Palette
import dev.daprkid.discovarrtv.ui.PosterCard
import dev.daprkid.discovarrtv.ui.StatusLine
import dev.daprkid.discovarrtv.ui.TvButton
import dev.daprkid.discovarrtv.ui.TvChip

private enum class BrowseMode(val label: String, val type: String) {
    Networks("Networks", "tv"),
    Studios("Studios", "movie"),
    MovieGenres("Movie genres", "movie"),
    SeriesGenres("Series genres", "tv"),
    Recommendations("For you", "all"),
}

/**
 * The web's browse rail: networks, studios, genres and recommendations, with
 * the same filters. Everything is a chip the remote can land on, then a poster
 * grid that pages.
 */
@Composable
fun BrowseScreen(
    client: DiscovarrClient,
    onOpen: (Media) -> Unit,
    onCollection: (Long) -> Unit,
) {
    var mode by remember { mutableStateOf(BrowseMode.Networks) }
    var facets by remember { mutableStateOf<Facets?>(null) }
    var page by remember { mutableStateOf(DiscoverPage("local", 1, 1, null, emptyList(), emptyList())) }
    var reason by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    var kinds by remember { mutableStateOf(setOf<String>()) }
    var genres by remember { mutableStateOf(setOf<String>()) }
    var networks by remember { mutableStateOf(setOf<String>()) }
    var studios by remember { mutableStateOf(setOf<String>()) }
    var sort by remember { mutableStateOf("popular") }
    var rating by remember { mutableStateOf("") }
    var language by remember { mutableStateOf("") }
    var collections by remember { mutableStateOf(false) }
    var pageNumber by remember { mutableStateOf(1) }

    LaunchedEffect(mode) {
        kinds = emptySet()
        genres = emptySet()
        networks = emptySet()
        studios = emptySet()
        collections = false
        pageNumber = 1
        if (mode.type == "movie" || mode.type == "tv") {
            facets = runCatching { client.facets(mode.type) }.getOrNull()
        }
    }

    LaunchedEffect(mode, kinds, genres, networks, studios, sort, rating, language, collections, pageNumber) {
        loading = true
        error = null
        try {
            if (mode == BrowseMode.Recommendations) {
                val found = client.recommendations()
                reason = found.reason
                page = DiscoverPage(
                    source = if (found.configured) "tmdb" else "local",
                    page = 1,
                    totalPages = 1,
                    error = if (found.configured) null else found.reason,
                    results = found.results,
                    collections = emptyList(),
                )
            } else {
                reason = ""
                page = client.discover(
                    DiscoverSpec(
                        type = mode.type,
                        page = pageNumber,
                        kinds = kinds,
                        genres = genres,
                        networks = networks,
                        studios = studios,
                        collections = collections,
                        sort = sort,
                        rating = rating,
                        language = language,
                    ),
                )
            }
        } catch (failure: Exception) {
            error = failure.message ?: "Browse could not be loaded"
        } finally {
            loading = false
        }
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 36.dp, end = 48.dp, top = 28.dp, bottom = 48.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Text("Browse", style = Palette.Title)
            Text(
                if (loading) "Loading..." else reason.ifBlank {
                    val count = if (page.collections.isNotEmpty()) page.collections.size else page.results.size
                    "$count on this page · ${page.source}"
                },
                style = Palette.BodyMuted,
            )
        }

        item {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(BrowseMode.entries.toList()) { option ->
                    TvChip(option.label, option == mode) {
                        mode = option
                    }
                }
            }
        }

        if (mode != BrowseMode.Recommendations) {
            facets?.let { options ->
                item { ChipRow("Type", options.types, kinds) { id -> kinds = kinds.toggle(id); pageNumber = 1 } }
                item { ChipRow("Genres", options.genres.take(24), genres) { id -> genres = genres.toggle(id); pageNumber = 1 } }
                if (mode.type == "tv") {
                    item { ChipRow("Networks", options.networks, networks) { id -> networks = networks.toggle(id); pageNumber = 1 } }
                } else {
                    item { ChipRow("Studios", options.studios, studios) { id -> studios = studios.toggle(id); pageNumber = 1 } }
                    item {
                        TvChip("Collections only", collections) {
                            collections = !collections
                            pageNumber = 1
                        }
                    }
                }
                item { SingleRow("Sort", options.sorts, sort) { sort = it; pageNumber = 1 } }
                item { SingleRow("Rating", options.ratings, rating) { rating = it; pageNumber = 1 } }
                item { SingleRow("Language", options.languages, language) { language = it; pageNumber = 1 } }
            }
        }

        item { StatusLine(error ?: page.error, isError = true) }

        if (!loading && page.results.isEmpty() && page.collections.isEmpty() && error == null) {
            item {
                Text(
                    if (facets?.tmdb == false && mode != BrowseMode.Recommendations) {
                        "This server has no TMDB key, so browse stays on the local catalog. Discover still lists what is already here."
                    } else {
                        "Nothing matches these filters."
                    },
                    style = Palette.BodyMuted,
                )
            }
        }

        if (page.collections.isNotEmpty()) {
            page.collections.chunked(5).forEachIndexed { index, row ->
                item(key = "col-$index") {
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        row.forEach { collection ->
                            PosterCard(
                                title = collection.name,
                                subtitle = "${if (collection.count > 0) collection.count else collection.parts.size} films",
                                imageUrl = client.resolveImage(collection.posterPath),
                                onClick = { onCollection(collection.id) },
                            )
                        }
                    }
                }
            }
        } else {
            page.results.chunked(5).forEachIndexed { index, row ->
                item(key = "row-$index-${row.firstOrNull()?.tmdbId}") {
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        row.forEach { item ->
                            PosterCard(
                                title = item.title,
                                subtitle = item.year,
                                imageUrl = client.resolveImage(item.posterPath),
                                badge = when {
                                    item.onPlex -> "PLEX"
                                    item.myActiveRequests > 0 -> "REQUESTED"
                                    item.isFullyAvailable -> "LIBRARY"
                                    else -> null
                                },
                                onClick = { onOpen(item) },
                            )
                        }
                    }
                }
            }
        }

        if (page.totalPages > 1) {
            item {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TvButton(
                        label = "Previous",
                        onClick = { pageNumber = (pageNumber - 1).coerceAtLeast(1) },
                        enabled = pageNumber > 1,
                        tone = Palette.SurfaceHigh,
                    )
                    Text("Page $pageNumber of ${page.totalPages}", style = Palette.BodyMuted)
                    TvButton(
                        label = "Next",
                        onClick = { pageNumber = (pageNumber + 1).coerceAtMost(page.totalPages) },
                        enabled = pageNumber < page.totalPages,
                        tone = Palette.SurfaceHigh,
                    )
                }
            }
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
}

private fun Set<String>.toggle(id: String): Set<String> = if (id in this) this - id else this + id

@Composable
private fun ChipRow(title: String, options: List<NamedId>, selected: Set<String>, onToggle: (String) -> Unit) {
    if (options.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = Palette.Label)
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(options, key = { title + it.id }) { option ->
                TvChip(option.name, option.id in selected) { onToggle(option.id) }
            }
        }
    }
}

@Composable
private fun SingleRow(title: String, options: List<NamedId>, selected: String, onSelect: (String) -> Unit) {
    if (options.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = Palette.Label)
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(options, key = { title + it.id }) { option ->
                TvChip(option.name, option.id == selected) { onSelect(option.id) }
            }
        }
    }
}
