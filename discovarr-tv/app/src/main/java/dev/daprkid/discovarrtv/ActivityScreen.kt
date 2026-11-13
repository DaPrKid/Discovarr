package dev.daprkid.discovarrtv

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.daprkid.discovarrtv.ui.FocusableSurface
import dev.daprkid.discovarrtv.ui.Palette
import dev.daprkid.discovarrtv.ui.StatusLine

/**
 * What happened after a request was approved: retries still waiting, ones that
 * gave up, and — for someone who can change settings — what Radarr and Sonarr
 * are downloading.
 */
@Composable
fun ActivityScreen(client: DiscovarrClient, onOpen: (Media) -> Unit) {
    var activity by remember { mutableStateOf<ActivityView?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        runCatching { client.activity() }
            .onSuccess { activity = it }
            .onFailure { error = it.message ?: "Activity could not be loaded" }
    }

    val shown = activity
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 36.dp, end = 48.dp, top = 28.dp, bottom = 48.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Text("Activity", style = Palette.Title)
            Text(
                shown?.let { "Up to ${it.maxAttempts} automatic attempts, then it waits for someone." }
                    ?: "Loading...",
                style = Palette.BodyMuted,
            )
        }
        item { StatusLine(error, isError = true) }
        if (shown != null) {
            item { Text("Waiting for another attempt", style = Palette.SectionTitle) }
            if (shown.waiting.isEmpty()) item { Text("Nothing is waiting to be retried.", style = Palette.BodyMuted) }
            items(shown.waiting, key = { "w${it.id}" }) { request -> RequestLine(request, onOpen) }

            item { Text("Gave up", style = Palette.SectionTitle) }
            if (shown.exhausted.isEmpty()) item { Text("No request has run out of attempts.", style = Palette.BodyMuted) }
            items(shown.exhausted, key = { "e${it.id}" }) { request -> RequestLine(request, onOpen) }

            if (shown.canManage) {
                shown.queue.forEach { service ->
                    item { Text("${service.label} queue", style = Palette.SectionTitle) }
                    if (service.error != null) {
                        item { Text(service.error, style = Palette.BodyMuted) }
                    } else if (service.items.isEmpty()) {
                        item { Text("Nothing queued.", style = Palette.BodyMuted) }
                    } else {
                        items(service.items, key = { service.label + it.title + (it.eta ?: "") }) { item ->
                            Text(
                                "${item.title} · ${item.status}" +
                                    (item.progress?.let { progress -> " · $progress%" } ?: "") +
                                    (item.eta?.let { eta -> " · ${eta.take(16).replace('T', ' ')}" } ?: ""),
                                style = Palette.Body,
                                maxLines = 2,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RequestLine(request: RequestItem, onOpen: (Media) -> Unit) {
    val media = request.media
    FocusableSurface(
        onClick = { media?.let(onOpen) },
        modifier = Modifier.fillMaxWidth(),
        focusedScale = 1.01f,
    ) {
        Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
            Text(media?.title ?: "Request #${request.id}", style = Palette.Body, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                listOfNotNull(request.requester?.let { "by $it" }, request.note).joinToString(" · "),
                style = Palette.Chip,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
