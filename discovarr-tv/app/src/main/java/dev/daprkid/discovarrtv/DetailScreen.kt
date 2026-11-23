package dev.daprkid.discovarrtv

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.daprkid.discovarrtv.ui.FocusableSurface
import dev.daprkid.discovarrtv.ui.Palette
import dev.daprkid.discovarrtv.ui.PosterCard
import dev.daprkid.discovarrtv.ui.RemoteImage
import dev.daprkid.discovarrtv.ui.StatusLine
import dev.daprkid.discovarrtv.ui.TvButton
import dev.daprkid.discovarrtv.ui.TvChip
import kotlinx.coroutines.launch

/**
 * One title. Facts, cast, seasons, the quality profile and the collection come
 * from the same decision the browser's title page makes, over JSON.
 *
 * Up and down move between the buttons, the season ticks and the cast. Only
 * when nothing further that way can take focus does the synopsis scroll, so a
 * remote can actually reach the controls that used to sit inside the scroll.
 */
@Composable
fun DetailScreen(
    media: Media,
    client: DiscovarrClient,
    onBack: () -> Unit,
    onPerson: (Long) -> Unit,
    onOpen: (Media) -> Unit,
    onCollection: (Long) -> Unit,
) {
    var view by remember(media.id, media.tmdbId) { mutableStateOf<TitleView?>(null) }
    var status by remember(media.id, media.tmdbId) { mutableStateOf<String?>(null) }
    var isError by remember(media.id, media.tmdbId) { mutableStateOf(false) }
    var busy by remember(media.id, media.tmdbId) { mutableStateOf(false) }
    var saving by remember(media.id, media.tmdbId) { mutableStateOf(false) }
    var picked by remember(media.id, media.tmdbId) { mutableStateOf(setOf<Int>()) }
    var profileIndex by remember(media.id, media.tmdbId) { mutableStateOf<Int?>(null) }
    var openSeason by remember(media.id, media.tmdbId) { mutableStateOf<Int?>(null) }
    var episodes by remember(media.id, media.tmdbId) { mutableStateOf<List<Episode>>(emptyList()) }
    var episodesLoading by remember(media.id, media.tmdbId) { mutableStateOf(false) }
    val episodeCache = remember(media.id, media.tmdbId) { mutableMapOf<Int, List<Episode>>() }
    var reload by remember(media.id, media.tmdbId) { mutableStateOf(0) }

    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    val scroll = rememberScrollState()

    LaunchedEffect(media.id, media.tmdbId, reload) {
        runCatching { client.title(media) }
            .onSuccess { incoming ->
                view = incoming
                picked = incoming.seasons.filter { !it.inLibrary }.map { it.seasonNumber }.toSet()
                profileIndex = incoming.profiles.firstOrNull { it.isDefault }?.index
                    ?: incoming.profiles.firstOrNull()?.index
                if (openSeason == null) openSeason = incoming.seasons.firstOrNull()?.seasonNumber
            }
            .onFailure { error ->
                status = error.message ?: "Could not open this title"
                isError = true
            }
    }

    LaunchedEffect(openSeason, view?.media?.tmdbId) {
        val number = openSeason ?: return@LaunchedEffect
        episodeCache[number]?.let { episodes = it; return@LaunchedEffect }
        val tmdbId = view?.media?.tmdbId ?: media.tmdbId ?: return@LaunchedEffect
        episodesLoading = true
        val loaded = runCatching { client.episodes(tmdbId, number) }.getOrDefault(emptyList())
        episodeCache[number] = loaded
        episodes = loaded
        episodesLoading = false
    }

    val shown = view?.media ?: media
    val page = view

    fun submit() {
        if (shown.mediaType == "tv" && picked.isEmpty()) {
            status = "Select at least one season."
            isError = true
            return
        }
        busy = true
        scope.launch {
            try {
                client.request(
                    shown,
                    seasons = if (shown.mediaType == "tv") picked.sorted() else null,
                    profileIndex = profileIndex,
                )
                status = "Requested ${shown.title}."
                isError = false
                reload += 1
            } catch (error: Exception) {
                status = error.message ?: "The request was refused"
                isError = true
            } finally {
                busy = false
            }
        }
    }

    fun toggleWatchlist() {
        val current = page ?: return
        saving = true
        scope.launch {
            try {
                val saved = client.toggleWatchlist(current.asPage())
                view = current.copy(watched = saved)
                status = if (saved) "Saved ${shown.title} to your watchlist." else "Removed ${shown.title} from your watchlist."
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
            .onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when (event.key) {
                    Key.DirectionDown -> {
                        if (focus.moveFocus(FocusDirection.Down)) true
                        else {
                            scope.launch { scroll.scrollTo((scroll.value + 280).coerceAtMost(scroll.maxValue)) }
                            true
                        }
                    }
                    Key.DirectionUp -> {
                        if (focus.moveFocus(FocusDirection.Up)) true
                        else if (scroll.value <= 0) false
                        else {
                            scope.launch { scroll.scrollTo((scroll.value - 280).coerceAtLeast(0)) }
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
                .padding(start = 36.dp, end = 48.dp, top = 22.dp, bottom = 18.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                var plexForm by remember(page?.plexUrl) { mutableStateOf(0) }
                page?.plexUrl?.let { link ->
                    TvButton(label = "Play on Plex", onClick = {
                        val forms = PlexLauncher.formCount(link, shown.mediaType)
                        if (forms == 0) {
                            status = "This server sent a Plex link this TV cannot open."
                            isError = true
                        } else {
                            val attempt = plexForm % forms
                            when (PlexLauncher.open(context, link, shown.mediaType, attempt)) {
                                PlexLauncher.Launch.None -> {
                                    status = "This TV has no app that opens Plex links."
                                    isError = true
                                }
                                PlexLauncher.Launch.PlexHome -> {
                                    status = "Plex opened at its home screen. Press Play on Plex again to try the next link."
                                    isError = false
                                }
                                else -> {
                                    status = null
                                    isError = false
                                }
                            }
                            plexForm = attempt + 1
                        }
                    }, tone = Palette.Plex)
                }
                page?.trailerUrl?.let { trailer ->
                    TvButton(label = "Trailer", onClick = {
                        runCatching {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(trailer)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        }.onFailure {
                            status = "No app on this TV can open links."
                            isError = true
                        }
                    }, tone = Palette.SurfaceHigh)
                }
                when {
                    page == null -> Unit
                    page.canRequest -> TvButton(
                        label = if (busy) "Requesting..." else "Request",
                        onClick = { submit() },
                        enabled = !busy,
                    )
                    page.blocked -> Pill(page.blockReason ?: "Already requested", Palette.Accent)
                    page.inLibrary -> Pill("In your library", Palette.Success)
                }
                if (page != null) {
                    TvButton(
                        label = when {
                            saving -> "..."
                            page.watched -> "Saved"
                            else -> "Watchlist"
                        },
                        onClick = { toggleWatchlist() },
                        enabled = !saving,
                        tone = Palette.SurfaceHigh,
                    )
                }
                Spacer(Modifier.weight(1f))
                TvButton(label = "Back", onClick = onBack, tone = Palette.SurfaceHigh)
            }

            StatusLine(status, isError)

            Row(modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) {
                Column(modifier = Modifier.width(200.dp)) {
                    RemoteImage(
                        url = client.resolveImage(shown.posterPath),
                        label = shown.title,
                        modifier = Modifier.width(200.dp).height(300.dp).clip(RoundedCornerShape(12.dp)),
                    )
                    page?.plexLibrary?.let {
                        Spacer(Modifier.height(8.dp))
                        Text("On Plex · $it", style = Palette.Chip.copy(color = Palette.Success))
                    }
                }

                Column(
                    modifier = Modifier
                        .weight(1f)
                        .padding(start = 28.dp)
                        .verticalScroll(scroll),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(shown.title, style = Palette.Title, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    page?.tagline?.takeIf { it.isNotBlank() }?.let {
                        Text(it, style = Palette.BodyMuted.copy(color = Palette.Accent))
                    }
                    val meta = page?.meta ?: listOfNotNull(shown.year, shown.subtitle).joinToString(" · ")
                    if (meta.isNotBlank()) Text(meta, style = Palette.BodyMuted)
                    if (page != null && page.quotaLimit > 0) {
                        Text(
                            "${page.quotaUsed}/${page.quotaLimit} requests used this month",
                            style = Palette.Chip,
                        )
                    }
                    Text(
                        page?.overview?.takeIf { it.isNotBlank() } ?: shown.overview?.takeIf { it.isNotBlank() }
                            ?: "No description available yet.",
                        style = Palette.Body,
                    )

                    val seasons = page?.seasons.orEmpty()
                    if (seasons.isNotEmpty()) {
                        Text("Seasons", style = Palette.SectionTitle)
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            items(seasons, key = { it.seasonNumber }) { season ->
                                val included = season.seasonNumber in picked
                                val label = when {
                                    season.inLibrary -> "${season.name} · in library"
                                    page?.canRequest == true && included -> "${season.name} · include"
                                    page?.canRequest == true -> "${season.name} · skip"
                                    else -> "${season.name} · ${season.episodeCount} ep"
                                }
                                TvChip(
                                    label = label,
                                    active = season.seasonNumber == openSeason || included,
                                    onClick = {
                                        openSeason = season.seasonNumber
                                        if (page?.canRequest == true && !season.inLibrary) {
                                            picked = if (included) picked - season.seasonNumber else picked + season.seasonNumber
                                        }
                                    },
                                )
                            }
                        }
                        when {
                            episodesLoading -> Text("Reading the episodes...", style = Palette.BodyMuted)
                            episodes.isEmpty() -> Text("No episode list for this season yet.", style = Palette.BodyMuted)
                            else -> episodes.take(12).forEach { EpisodeRow(it) }
                        }
                    }

                    val profiles = page?.profiles.orEmpty()
                    if (page?.canRequest == true && profiles.size > 1) {
                        Text("Quality profile", style = Palette.SectionTitle)
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            items(profiles, key = { it.index }) { profile ->
                                TvChip(
                                    label = profile.name + if (profile.isDefault) " · default" else "",
                                    active = profile.index == profileIndex,
                                    onClick = { profileIndex = profile.index },
                                )
                            }
                        }
                    } else if (page?.canRequest == true && profiles.size == 1) {
                        Text("Quality profile · ${profiles.first().name}", style = Palette.Chip)
                    }

                    page?.collection?.let { collection ->
                        Text(collection.name, style = Palette.SectionTitle)
                        Text(
                            "${collection.parts.size} films · tick happens on the collection page",
                            style = Palette.Chip,
                        )
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            items(collection.parts, key = { it.tmdbId }) { part ->
                                PosterCard(
                                    title = part.title,
                                    subtitle = part.label.ifBlank { part.releaseDate?.take(4) },
                                    imageUrl = client.resolveImage(part.posterPath),
                                    badge = when {
                                        part.current -> "THIS"
                                        part.blocked -> part.label.ifBlank { "HELD" }
                                        else -> null
                                    },
                                    onClick = { onOpen(part.asMedia()) },
                                )
                            }
                        }
                        TvButton(
                            label = "Open collection",
                            onClick = { onCollection(collection.id) },
                            tone = Palette.SurfaceHigh,
                        )
                    }

                    page?.watch?.takeIf { it.isNotEmpty() }?.let { groups ->
                        Text("Where to watch", style = Palette.SectionTitle)
                        groups.forEach { group ->
                            Text("${group.label}: ${group.names.joinToString(", ")}", style = Palette.BodyMuted)
                        }
                    }

                    val facts = page?.facts.orEmpty().filterNot { it.label.equals("Library", ignoreCase = true) }
                    if (facts.isNotEmpty()) {
                        facts.chunked(3).forEach { row ->
                            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                                row.forEach { fact ->
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(fact.label.uppercase(), style = Palette.Chip)
                                        Text(fact.value, style = Palette.Body, maxLines = 3)
                                    }
                                }
                            }
                        }
                    }

                    page?.cast?.takeIf { it.isNotEmpty() }?.let { cast ->
                        Text("Cast", style = Palette.SectionTitle)
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            items(cast, key = { it.id.toString() + it.name }) { member ->
                                FocusableSurface(onClick = { if (member.id > 0) onPerson(member.id) }, modifier = Modifier.width(110.dp)) {
                                    Column(modifier = Modifier.padding(8.dp)) {
                                        val photo = member.photoPath?.let { path ->
                                            if (path.startsWith("http")) path else client.resolveImage(path)
                                        }
                                        RemoteImage(
                                            url = photo,
                                            label = member.name,
                                            modifier = Modifier.size(84.dp).clip(RoundedCornerShape(42.dp)),
                                        )
                                        Spacer(Modifier.height(6.dp))
                                        Text(member.name, style = Palette.Chip.copy(color = Palette.TextPrimary), maxLines = 2)
                                        Text(member.role, style = Palette.Chip, maxLines = 2)
                                    }
                                }
                            }
                        }
                    }
                    Spacer(Modifier.height(12.dp))
                }
            }
        }
    }
}

@Composable
private fun Pill(label: String, tint: Color) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(tint.copy(alpha = 0.14f))
            .padding(horizontal = 14.dp, vertical = 8.dp),
    ) {
        Text(label, style = Palette.Chip.copy(color = tint), maxLines = 1)
    }
}

@Composable
private fun EpisodeRow(episode: Episode) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Text(
            "${episode.number}. ${episode.name}",
            style = Palette.Body.copy(fontWeight = FontWeight.Medium),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        val line = listOfNotNull(episode.meta, episode.overview).filter { it.isNotBlank() }.joinToString(" — ")
        if (line.isNotBlank()) Text(line, style = Palette.Chip, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}
