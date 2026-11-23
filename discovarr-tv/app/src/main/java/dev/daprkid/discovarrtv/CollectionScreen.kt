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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.daprkid.discovarrtv.ui.Palette
import dev.daprkid.discovarrtv.ui.RemoteImage
import dev.daprkid.discovarrtv.ui.StatusLine
import dev.daprkid.discovarrtv.ui.TvButton
import dev.daprkid.discovarrtv.ui.TvChip
import kotlinx.coroutines.launch

/**
 * Every film in a collection. Films already in the library or already requested
 * cannot be ticked. One button requests the rest.
 */
@Composable
fun CollectionScreen(
    collectionId: Long,
    client: DiscovarrClient,
    onOpen: (Media) -> Unit,
    onBack: () -> Unit,
) {
    var collection by remember(collectionId) { mutableStateOf<CollectionSide?>(null) }
    var picked by remember(collectionId) { mutableStateOf(setOf<Long>()) }
    var status by remember(collectionId) { mutableStateOf<String?>(null) }
    var isError by remember(collectionId) { mutableStateOf(false) }
    var busy by remember(collectionId) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun load() {
        scope.launch {
            runCatching { client.collection(collectionId) }
                .onSuccess {
                    collection = it
                    picked = it.parts.filter { part -> !part.blocked }.map { part -> part.tmdbId }.toSet()
                }
                .onFailure {
                    status = it.message ?: "This collection could not be loaded"
                    isError = true
                }
        }
    }

    LaunchedEffect(collectionId) { load() }

    val shown = collection
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 36.dp, end = 48.dp, top = 28.dp, bottom = 48.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(shown?.name ?: "Collection", style = Palette.Title)
                    Text(shown?.overview?.ifBlank { null } ?: "Tick the films you are missing.", style = Palette.BodyMuted, maxLines = 3)
                }
                TvButton(label = "Back", onClick = onBack, tone = Palette.SurfaceHigh)
            }
        }
        item { StatusLine(status, isError) }
        if (shown != null) {
            item {
                TvButton(
                    label = if (busy) "Requesting..." else "Request selected (${picked.size})",
                    onClick = {
                        if (picked.isEmpty()) {
                            status = "Pick at least one film."
                            isError = true
                            return@TvButton
                        }
                        busy = true
                        scope.launch {
                            try {
                                status = client.requestCollection(collectionId, picked.toList())
                                isError = false
                                load()
                            } catch (error: Exception) {
                                status = error.message ?: "Those films could not be requested"
                                isError = true
                            } finally {
                                busy = false
                            }
                        }
                    },
                    enabled = !busy,
                )
            }
            items(shown.parts, key = { it.tmdbId }) { part ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    RemoteImage(
                        url = client.resolveImage(part.posterPath),
                        label = part.title,
                        modifier = Modifier.width(64.dp).height(96.dp).clip(RoundedCornerShape(8.dp)),
                    )
                    Column(modifier = Modifier.weight(1f)) {
                        Text(part.title, style = Palette.Body, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            listOfNotNull(part.releaseDate?.take(4), part.label.takeIf { it.isNotBlank() }).joinToString(" · "),
                            style = Palette.Chip,
                        )
                    }
                    if (part.blocked) {
                        Text(part.label.ifBlank { "Held" }, style = Palette.Chip)
                    } else {
                        TvChip(
                            label = if (part.tmdbId in picked) "Include" else "Skip",
                            active = part.tmdbId in picked,
                        ) {
                            picked = if (part.tmdbId in picked) picked - part.tmdbId else picked + part.tmdbId
                        }
                    }
                    TvButton(label = "Open", onClick = { onOpen(part.asMedia()) }, tone = Palette.SurfaceHigh)
                }
            }
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
}
