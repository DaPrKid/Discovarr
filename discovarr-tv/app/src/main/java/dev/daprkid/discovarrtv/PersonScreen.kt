package dev.daprkid.discovarrtv

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import dev.daprkid.discovarrtv.ui.Palette
import dev.daprkid.discovarrtv.ui.PosterCard
import dev.daprkid.discovarrtv.ui.RemoteImage
import dev.daprkid.discovarrtv.ui.StatusLine
import dev.daprkid.discovarrtv.ui.TvButton

/** One person's biography and the films and series they appear in. */
@Composable
fun PersonScreen(
    personId: Long,
    client: DiscovarrClient,
    onOpen: (Media) -> Unit,
    onBack: () -> Unit,
) {
    var person by remember(personId) { mutableStateOf<PersonPage?>(null) }
    var page by remember(personId) { mutableIntStateOf(1) }
    var error by remember(personId) { mutableStateOf<String?>(null) }
    var loading by remember(personId) { mutableStateOf(true) }

    LaunchedEffect(personId, page) {
        loading = true
        runCatching { client.person(personId, page) }
            .onSuccess { person = it; error = null }
            .onFailure { error = it.message ?: "This person could not be loaded" }
        loading = false
    }

    val shown = person
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 36.dp, end = 48.dp, top = 28.dp, bottom = 48.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Row {
                TvButton(label = "Back", onClick = onBack, tone = Palette.SurfaceHigh)
            }
        }
        item { StatusLine(error, isError = true) }
        if (shown != null) {
            item {
                Row {
                    val photo = shown.profilePath?.let { client.resolveImage(it) }
                    RemoteImage(
                        url = photo,
                        label = shown.name,
                        modifier = Modifier.size(160.dp).clip(RoundedCornerShape(12.dp)),
                    )
                    Spacer(Modifier.width(24.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(shown.name, style = Palette.Title)
                        shown.facts.forEach { fact ->
                            Text("${fact.label}: ${fact.value}", style = Palette.BodyMuted)
                        }
                    }
                }
            }
            item {
                Text(
                    shown.biography.ifBlank { "No biography for this person yet." },
                    style = Palette.Body,
                )
            }
            item { Text("Known for", style = Palette.SectionTitle) }
            shown.credits.chunked(5).forEachIndexed { index, row ->
                item(key = "credit-$index") {
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        row.forEach { credit ->
                            PosterCard(
                                title = credit.title,
                                subtitle = credit.year,
                                imageUrl = client.resolveImage(credit.posterPath),
                                badge = if (credit.onPlex) "PLEX" else null,
                                onClick = { onOpen(credit) },
                            )
                        }
                    }
                }
            }
            if (shown.totalPages > 1) {
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        TvButton("Previous", { page = (page - 1).coerceAtLeast(1) }, enabled = page > 1, tone = Palette.SurfaceHigh)
                        Text("Page $page of ${shown.totalPages}", style = Palette.BodyMuted)
                        TvButton("Next", { page = (page + 1).coerceAtMost(shown.totalPages) }, enabled = page < shown.totalPages, tone = Palette.SurfaceHigh)
                    }
                }
            }
        } else if (loading) {
            item { Text("Loading...", style = Palette.BodyMuted) }
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
}
