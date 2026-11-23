package dev.daprkid.discovarrtv

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.daprkid.discovarrtv.ui.FocusableSurface
import dev.daprkid.discovarrtv.ui.Palette
import dev.daprkid.discovarrtv.ui.StatusLine
import dev.daprkid.discovarrtv.ui.TvButton
import kotlinx.coroutines.launch

/** The bell. Same updates as the browser, opened in place of the header panel. */
@Composable
fun NotificationsScreen(
    client: DiscovarrClient,
    onOpen: (Media) -> Unit,
    onChanged: () -> Unit,
) {
    var unread by remember { mutableStateOf(0) }
    var items by remember { mutableStateOf<List<AppNotification>>(emptyList()) }
    var status by remember { mutableStateOf<String?>(null) }
    var isError by remember { mutableStateOf(false) }
    var reload by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(reload) {
        runCatching { client.notifications() }
            .onSuccess { (count, list) ->
                unread = count
                items = list
                status = if (list.isEmpty()) "No updates yet." else null
                isError = false
            }
            .onFailure {
                status = it.message ?: "Could not load updates"
                isError = true
            }
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 36.dp, end = 48.dp, top = 28.dp, bottom = 48.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("Updates", style = Palette.Title)
                    Text(if (unread == 0) "Nothing unread" else "$unread unread", style = Palette.BodyMuted)
                }
                TvButton(
                    label = "Mark all read",
                    onClick = {
                        scope.launch {
                            runCatching { client.markNotificationsRead() }
                                .onSuccess { reload += 1; onChanged() }
                                .onFailure { status = it.message; isError = true }
                        }
                    },
                    enabled = unread > 0,
                    tone = Palette.SurfaceHigh,
                )
            }
        }
        item { StatusLine(status, isError) }
        items(items, key = { it.id }) { note ->
            FocusableSurface(
                onClick = {
                    scope.launch {
                        if (!note.read) runCatching { client.markNotificationsRead(note.id) }
                        onChanged()
                        reload += 1
                    }
                    hrefMedia(note.href)?.let(onOpen)
                },
                modifier = Modifier.fillMaxWidth(),
                focusedScale = 1.01f,
            ) { focused ->
                Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    Text(
                        note.title,
                        style = Palette.Body.copy(color = if (note.read) Palette.TextSecondary else Palette.TextPrimary),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (note.body.isNotBlank()) {
                        Text(note.body, style = Palette.Chip, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    Text(
                        listOfNotNull(note.kind, note.createdAt?.take(16)?.replace('T', ' ')).joinToString(" · "),
                        style = Palette.Chip.copy(color = if (focused) Palette.Accent else Palette.TextSecondary),
                    )
                }
            }
        }
    }
}

/** `/media/12` and `/title/movie/99` from a notification become a title to open. */
internal fun hrefMedia(href: String?): Media? {
    if (href.isNullOrBlank()) return null
    val local = Regex("/media/(\\d+)").find(href)
    if (local != null) {
        return stubMedia(null, "movie", "Title").copy(id = local.groupValues[1].toLong())
    }
    val remote = Regex("/title/([a-z]+)/(\\d+)").find(href) ?: return null
    return stubMedia(remote.groupValues[2].toLong(), remote.groupValues[1], "Title")
}
