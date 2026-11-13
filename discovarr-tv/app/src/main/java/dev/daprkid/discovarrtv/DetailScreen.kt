package dev.daprkid.discovarrtv

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.daprkid.discovarrtv.ui.Chips
import dev.daprkid.discovarrtv.ui.FocusableSurface
import dev.daprkid.discovarrtv.ui.Palette
import dev.daprkid.discovarrtv.ui.RemoteImage
import dev.daprkid.discovarrtv.ui.StatusLine
import dev.daprkid.discovarrtv.ui.TvButton
import kotlinx.coroutines.launch

/**
 * One title, laid out like the browser's page.
 *
 * The facts, the tagline, the cast and the reading of whether Plex already holds
 * the file all come from the same HTML the browser renders — the JSON API
 * carries none of it. Seasons come from `/api/v1/media/:id`, episodes from the
 * season partial the browser itself opens, and availability from the catalog row,
 * so the request button never offers something that is already here.
 *
 * The page used to be set at browser sizes doubled, which made a synopsis read
 * like a poster: three lines filled the screen and the facts, the seasons and the
 * cast sat below the fold with no sign they existed. It is now the browser's own
 * scale, and the sections run in the browser's own order: art, title, blurb,
 * library state, seasons with their episodes, facts, cast.
 *
 * Actions stay in one row across the top, where the first press reaches them,
 * while up and down scroll the reading. That is the one place the television
 * cannot copy the browser: a pointer can scroll from anywhere on the page.
 */
@Composable
fun DetailScreen(media: Media, client: DiscovarrClient, onBack: () -> Unit) {
    var page by remember(media.id, media.tmdbId) { mutableStateOf(MediaPage()) }
    var detail by remember(media.id) { mutableStateOf<MediaDetail?>(null) }
    var status by remember(media.id) { mutableStateOf<String?>(null) }
    var isError by remember(media.id) { mutableStateOf(false) }
    var busy by remember(media.id) { mutableStateOf(false) }
    var watched by remember(media.id) { mutableStateOf(false) }
    var saving by remember(media.id) { mutableStateOf(false) }
    var loaded by remember(media.id) { mutableStateOf(false) }

    var openSeason by remember(media.id) { mutableStateOf<Int?>(null) }
    var episodes by remember(media.id) { mutableStateOf<List<Episode>>(emptyList()) }
    var episodesLoading by remember(media.id) { mutableStateOf(false) }
    val episodeCache = remember(media.id) { mutableMapOf<Int, List<Episode>>() }

    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val scroll = rememberScrollState()
    // One press moves about a paragraph, not a pixel and not a page.
    val step = with(LocalDensity.current) { 150.dp.toPx() }

    LaunchedEffect(media.id, media.tmdbId) {
        runCatching { client.mediaPage(media) }.onSuccess { incoming ->
            page = incoming
            watched = incoming.watched
            loaded = true
        }
        if (media.id > 0) {
            runCatching { client.mediaDetail(media.id) }.onSuccess { detail = it }
        }
    }

    val shown = detail?.media ?: media
    val overview = page.overview ?: shown.overview

    // The catalog's season rows carry a count, but it stays at zero until Sonarr
    // has reported the files; the page's summaries come from TMDB and know how
    // long the season actually is. Prefer the page, fall back to the catalog.
    val seasons: List<Season> = run {
        val stored = detail?.seasons.orEmpty().map { season ->
            val counted = page.seasonCounts[season.seasonNumber] ?: 0
            if (counted > 0) season.copy(episodeCount = counted) else season
        }
        stored.ifEmpty {
            page.seasonCounts.entries
                .sortedBy { it.key }
                .map { (number, count) -> Season(number, "Season $number", count) }
        }
    }

    // A show opens on its first season, so the episode list is visible without
    // the viewer having to discover that the seasons are selectable at all.
    LaunchedEffect(seasons) {
        if (openSeason == null) openSeason = seasons.firstOrNull()?.seasonNumber
    }

    LaunchedEffect(openSeason) {
        val number = openSeason ?: return@LaunchedEffect
        episodeCache[number]?.let {
            episodes = it
            return@LaunchedEffect
        }
        val tmdbId = page.tmdbId ?: shown.tmdbId
        episodes = emptyList()
        if (tmdbId == null) return@LaunchedEffect
        episodesLoading = true
        val loadedEpisodes = runCatching { client.episodes(tmdbId, number) }.getOrDefault(emptyList())
        episodeCache[number] = loadedEpisodes
        episodes = loadedEpisodes
        episodesLoading = false
    }

    // The page's own fact table when TMDB knows the title; the local record when
    // it does not, so an item Plex added by hand still says what it is. The
    // library row is dropped: the page writes it as "Available · 0 active
    // request(s)", which reads as "nothing is in the library" on a screen where
    // the film obviously is, so that state is said in its own words below.
    val facts = page.facts
        .filterNot { it.label.equals("Library", ignoreCase = true) }
        .ifEmpty {
            buildList {
                shown.year?.let { add(Fact("Release date", it)) }
                if (seasons.isNotEmpty()) {
                    add(Fact("Seasons", seasons.size.toString()))
                    val total = seasons.sumOf { it.episodeCount }
                    if (total > 0) add(Fact("Episodes", total.toString()))
                }
                shown.runtime?.takeIf { it > 0 }?.let { add(Fact("Runtime", "$it min")) }
            }
        }

    val inLibrary = shown.isAvailable || page.plexUrl != null
    val activeRequests = maxOf(shown.activeRequests, detail?.media?.activeRequests ?: 0)
    val libraryLine = when {
        inLibrary && activeRequests > 0 -> "In your library · $activeRequests active request(s)"
        inLibrary -> "In your library"
        activeRequests > 0 -> "Requested · waiting on the download"
        else -> "Not in your library yet"
    }

    fun submit() {
        busy = true
        scope.launch {
            try {
                client.request(shown)
                status = "Requested ${shown.title}. It will appear under Requests until it downloads."
                isError = false
            } catch (error: Exception) {
                status = error.message ?: "The request was refused"
                isError = true
            } finally {
                busy = false
            }
        }
    }

    fun toggleWatchlist() {
        saving = true
        scope.launch {
            try {
                watched = client.toggleWatchlist(page)
                status = if (watched) {
                    "Saved ${shown.title} to your watchlist."
                } else {
                    "Removed ${shown.title} from your watchlist."
                }
                isError = false
            } catch (error: Exception) {
                status = error.message ?: "The watchlist refused the change"
                isError = true
            } finally {
                saving = false
            }
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Palette.Background)
            // Up and down belong to the page, not to focus: everything focusable
            // is in the rows above, so a press that would move focus nowhere is
            // better spent reading. Once at the top, up is released again so the
            // rail and the rest of the shell still get their presses.
            .onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when (event.key) {
                    Key.DirectionDown -> {
                        scope.launch { scroll.animateScrollBy(step) }
                        true
                    }

                    Key.DirectionUp -> {
                        if (scroll.value <= 0) {
                            false
                        } else {
                            scope.launch { scroll.animateScrollBy(-step) }
                            true
                        }
                    }

                    else -> false
                }
            },
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(start = 40.dp, end = 52.dp, top = 26.dp, bottom = 22.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Only drawn when Plex actually holds the title, the same rule the
                // web title page follows. Plex accepts a link it then ignores, so
                // only the attempt that fails says anything: a successful hand-off
                // is the viewer watching Plex, not reading a banner about it.
                var plexForm by remember(page.plexUrl) { mutableStateOf(0) }
                page.plexUrl?.let { link ->
                    TvButton(
                        label = "▶  Play on Plex",
                        onClick = {
                            val mediaType = page.mediaType ?: shown.mediaType
                            val forms = PlexLauncher.formCount(link, mediaType)
                            if (forms == 0) {
                                status = "This server sent a Plex link this TV cannot " +
                                    "turn into a Plex address: $link"
                                isError = true
                            } else {
                                val attempt = plexForm % forms
                                when (PlexLauncher.open(context, link, mediaType, attempt)) {
                                    PlexLauncher.Launch.None -> {
                                        status = "This TV has no app that opens Plex links, so that title cannot be opened there."
                                        isError = true
                                    }

                                    PlexLauncher.Launch.PlexHome -> {
                                        status = "Plex opened at its home screen. Press Play on Plex again to try the next way of linking to it."
                                        isError = false
                                    }

                                    else -> {
                                        // It worked: clear the line rather than
                                        // narrate a link the viewer just watched
                                        // open.
                                        status = null
                                        isError = false
                                    }
                                }
                                plexForm = attempt + 1
                            }
                        },
                        tone = Palette.Plex,
                    )
                }

                page.trailerUrl?.let { trailer ->
                    TvButton(
                        label = "▶  Trailer",
                        onClick = {
                            runCatching {
                                context.startActivity(
                                    Intent(Intent.ACTION_VIEW, Uri.parse(trailer))
                                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                                )
                            }.onFailure {
                                status = "No app on this TV can open links."
                                isError = true
                            }
                        },
                        tone = Palette.SurfaceHigh,
                    )
                }

                when {
                    shown.isAvailable -> Pill(libraryLine, Palette.Success)

                    shown.hasActiveRequest -> Pill("Requested", Palette.Accent)

                    else -> TvButton(
                        label = when {
                            busy -> "Requesting..."
                            shown.mediaType == "tv" -> "Request all seasons"
                            else -> "Request"
                        },
                        onClick = { submit() },
                        enabled = !busy,
                    )
                }

                if (loaded || page.tmdbId != null) {
                    TvButton(
                        label = when {
                            saving -> "..."
                            watched -> "★ Saved"
                            else -> "☆ Watchlist"
                        },
                        onClick = { toggleWatchlist() },
                        enabled = !saving,
                        tone = Palette.SurfaceHigh,
                    )
                }

                Spacer(Modifier.weight(1f))
                TvButton(label = "Back", onClick = onBack, tone = Palette.SurfaceHigh)
            }

            // Answers from the request and the watchlist land here, under the
            // button that was pressed. A Plex launch that worked says nothing.
            StatusLine(status, isError)

            Row(modifier = Modifier.fillMaxWidth().padding(top = 14.dp)) {
                Column(modifier = Modifier.width(224.dp)) {
                    RemoteImage(
                        url = client.resolveImage(shown.posterPath),
                        label = shown.title,
                        modifier = Modifier
                            .width(224.dp)
                            .height(336.dp)
                            .clip(RoundedCornerShape(12.dp)),
                    )
                    Spacer(Modifier.height(12.dp))
                    Pill(
                        if (watched) "★ On your watchlist" else "☆ Not on your watchlist",
                        if (watched) Palette.Warning else Palette.TextSecondary,
                    )
                }

                Column(
                    modifier = Modifier
                        .weight(1f)
                        .padding(start = 32.dp)
                        .verticalScroll(scroll),
                ) {
                    Text(
                        shown.title,
                        style = Palette.Title,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )

                    page.tagline?.takeIf { it.isNotBlank() }?.let { tagline ->
                        Spacer(Modifier.height(2.dp))
                        Text(tagline, style = Palette.BodyMuted.copy(color = Palette.Accent))
                    }

                    val meta = page.meta ?: listOfNotNull(
                        shown.year,
                        when (shown.mediaType) {
                            "movie" -> "Film"
                            "tv" -> "TV series"
                            "book" -> "Book"
                            "audiobook" -> "Audiobook"
                            else -> null
                        },
                        shown.subtitle,
                    ).joinToString(" · ")

                    if (meta.isNotBlank()) {
                        Spacer(Modifier.height(6.dp))
                        Text(meta, style = Palette.BodyMuted)
                    }

                    if (shown.genres.isNotEmpty()) {
                        Spacer(Modifier.height(10.dp))
                        Chips(shown.genres)
                    }

                    Spacer(Modifier.height(10.dp))
                    Text(
                        libraryLine,
                        style = Palette.Chip.copy(
                            color = when {
                                inLibrary -> Palette.Success
                                activeRequests > 0 -> Palette.Accent
                                else -> Palette.TextSecondary
                            },
                        ),
                    )

                    Spacer(Modifier.height(14.dp))
                    Text(
                        overview?.takeIf { it.isNotBlank() } ?: "No description available yet.",
                        style = Palette.Body,
                    )

                    if (seasons.isNotEmpty()) {
                        Spacer(Modifier.height(24.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Seasons", style = Palette.SectionTitle)
                            Spacer(Modifier.width(10.dp))
                            Text(
                                "${seasons.size} · ${seasons.sumOf { it.episodeCount }} episodes",
                                style = Palette.Chip,
                            )
                        }
                        Spacer(Modifier.height(10.dp))
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            items(seasons, key = { it.seasonNumber }) { season ->
                                SeasonChip(
                                    label = "${season.name} · ${season.episodeCount} ep",
                                    selected = season.seasonNumber == openSeason,
                                    onClick = { openSeason = season.seasonNumber },
                                )
                            }
                        }

                        Spacer(Modifier.height(14.dp))
                        when {
                            episodesLoading -> Text("Reading the episodes...", style = Palette.BodyMuted)

                            episodes.isEmpty() -> Text(
                                "No episode list for this season yet.",
                                style = Palette.BodyMuted,
                            )

                            else -> {
                                episodes.take(14).forEach { episode -> EpisodeRow(episode) }
                                if (episodes.size > 14) {
                                    Spacer(Modifier.height(4.dp))
                                    Text(
                                        "and ${episodes.size - 14} more in this season",
                                        style = Palette.Chip,
                                    )
                                }
                            }
                        }

                        if (!inLibrary) {
                            Spacer(Modifier.height(6.dp))
                            Text(
                                "Requesting a series sends every season; pick single seasons in the web UI.",
                                style = Palette.Chip,
                            )
                        }
                    }

                    if (facts.isNotEmpty()) {
                        Spacer(Modifier.height(26.dp))
                        facts.chunked(3).forEach { row ->
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp),
                                horizontalArrangement = Arrangement.spacedBy(20.dp),
                            ) {
                                row.forEach { fact ->
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(fact.label.uppercase(), style = Palette.Chip)
                                        Spacer(Modifier.height(2.dp))
                                        Text(fact.value, style = Palette.Body, maxLines = 3)
                                    }
                                }
                                repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
                            }
                        }
                    }

                    if (page.cast.isNotEmpty()) {
                        Spacer(Modifier.height(20.dp))
                        Text("Cast", style = Palette.SectionTitle)
                        Spacer(Modifier.height(10.dp))
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            items(page.cast, key = { it.name + it.role }) { member ->
                                Column(modifier = Modifier.width(96.dp)) {
                                    val photo = member.photoPath?.let { path ->
                                        if (path.startsWith("http")) path else client.baseUrl + path
                                    }
                                    RemoteImage(
                                        url = photo,
                                        label = member.name,
                                        modifier = Modifier
                                            .width(96.dp)
                                            .height(96.dp)
                                            .clip(RoundedCornerShape(48.dp)),
                                    )
                                    Spacer(Modifier.height(6.dp))
                                    Text(
                                        member.name,
                                        style = Palette.Chip.copy(color = Palette.TextPrimary),
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    Text(
                                        member.role,
                                        style = Palette.Chip,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }

                    Spacer(Modifier.height(24.dp))
                }
            }
        }
    }
}

/** A quiet status lozenge: a dot and a sentence, no button to hunt for. */
@Composable
private fun Pill(label: String, tint: androidx.compose.ui.graphics.Color) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(tint.copy(alpha = 0.14f))
            .padding(horizontal = 14.dp, vertical = 8.dp),
    ) {
        Text(label, style = Palette.Chip.copy(color = tint))
    }
}

/**
 * One season, as a selectable chip.
 *
 * Seasons are a row rather than a stack because up and down already belong to
 * the page: a vertical list inside a scrolling page is the arrangement that made
 * the profile picker unreachable, and there is no reason to repeat it.
 */
@Composable
private fun SeasonChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(8.dp)
    FocusableSurface(
        onClick = onClick,
        modifier = Modifier.height(36.dp),
        shape = shape,
        focusedScale = 1.03f,
    ) { focused ->
        Box(
            modifier = Modifier
                .clip(shape)
                .background(if (selected) Palette.AccentSoft else Palette.SurfaceHigh)
                .border(
                    if (selected) 2.dp else 1.dp,
                    if (selected || focused) Palette.Accent else Palette.Line,
                    shape,
                )
                .padding(horizontal = 14.dp, vertical = 8.dp),
        ) {
            Text(
                label,
                style = Palette.Chip.copy(
                    color = if (selected || focused) Palette.TextPrimary else Palette.TextSecondary,
                ),
            )
        }
    }
}

/** One episode: its number, its name, and the one line that says what it is. */
@Composable
private fun EpisodeRow(episode: Episode) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            modifier = Modifier
                .size(26.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(Palette.SurfaceHigh),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "${episode.number}",
                style = Palette.Chip.copy(color = Palette.TextPrimary),
            )
        }
        Spacer(Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    episode.name,
                    style = Palette.Body.copy(fontWeight = FontWeight.Medium),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                episode.meta?.takeIf { it.isNotBlank() }?.let { meta ->
                    Spacer(Modifier.width(10.dp))
                    Text(meta, style = Palette.Chip, maxLines = 1)
                }
            }
            episode.overview?.takeIf { it.isNotBlank() }?.let { text ->
                Text(text, style = Palette.Chip, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
