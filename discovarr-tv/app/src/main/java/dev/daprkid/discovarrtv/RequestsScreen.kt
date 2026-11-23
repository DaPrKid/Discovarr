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
import dev.daprkid.discovarrtv.ui.FocusableSurface
import dev.daprkid.discovarrtv.ui.Palette
import dev.daprkid.discovarrtv.ui.RemoteImage
import dev.daprkid.discovarrtv.ui.StatusLine
import dev.daprkid.discovarrtv.ui.TvButton
import dev.daprkid.discovarrtv.ui.TvChip
import kotlinx.coroutines.launch

/** Every request this account can see, newest first, with its current state. */
@Composable
fun RequestsScreen(client: DiscovarrClient, canManage: Boolean, onOpen: (Media) -> Unit) {
    var requests by remember { mutableStateOf<List<RequestItem>>(emptyList()) }
    var filter by remember { mutableStateOf("all") }
    var loading by remember { mutableStateOf(true) }
    var status by remember { mutableStateOf<String?>(null) }
    var isError by remember { mutableStateOf(false) }
    var reload by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()

    fun load() {
        loading = true
        status = null
        scope.launch {
            try {
                requests = client.requests(filter)
                if (requests.isEmpty()) status = "No requests in this view."
            } catch (error: ApiException) {
                status = error.message ?: "Could not load requests"
                isError = true
            } catch (error: Exception) {
                status = error.message ?: "Could not load requests"
                isError = true
            } finally {
                loading = false
            }
        }
    }

    LaunchedEffect(filter, reload) { load() }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 40.dp, end = 60.dp, top = 40.dp, bottom = 60.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("Requests", style = Palette.Title)
                    Text(
                        if (loading) "Loading..." else "${requests.size} request(s)",
                        style = Palette.BodyMuted,
                    )
                }
                TvButton(label = "Refresh", onClick = { load() }, enabled = !loading, tone = Palette.SurfaceHigh)
            }
        }

        item {
            androidx.compose.foundation.lazy.LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val filters = listOf(
                    "all" to "All",
                    "pending" to "Pending",
                    "approved" to "Approved",
                    "declined" to "Declined",
                    "failed" to "Failed",
                    "completed" to "Completed",
                )
                items(filters.size) { index ->
                    val (value, label) = filters[index]
                    TvChip(label, filter == value) { filter = value }
                }
            }
        }

        item { StatusLine(status, isError) }

        items(requests, key = { it.id }) { request ->
            val media = request.media
            val seasonLine = if (request.seasons.isEmpty()) null else "Seasons ${request.seasons.joinToString(", ")}"
            val meta = listOfNotNull(seasonLine, request.requester?.let { "by $it" }, request.qualityProfileName)
                .joinToString(" · ")
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                FocusableSurface(
                    onClick = { media?.let(onOpen) },
                    modifier = Modifier.weight(1f),
                    focusedScale = 1.02f,
                ) { _ ->
                    Row(modifier = Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        RemoteImage(
                            url = client.resolveImage(media?.posterPath),
                            label = media?.title ?: "?",
                            modifier = Modifier.width(86.dp).height(129.dp).clip(RoundedCornerShape(8.dp)),
                        )
                        Spacer(Modifier.width(20.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(media?.title ?: "Unknown title", style = Palette.Body, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Spacer(Modifier.height(6.dp))
                            Text(
                                request.statusLine,
                                style = Palette.Chip.copy(
                                    color = when {
                                        request.isComplete -> Palette.Success
                                        request.isFailed -> Palette.Danger
                                        request.isMoving -> Palette.Accent
                                        else -> Palette.TextSecondary
                                    },
                                ),
                            )
                            if (meta.isNotBlank()) Text(meta, style = Palette.Chip)
                            request.note?.takeIf { it.isNotBlank() }?.let {
                                Text(it, style = Palette.BodyMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
                Column(
                    modifier = Modifier.padding(start = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    horizontalAlignment = Alignment.End,
                ) {
                    Text(request.createdAt?.take(10) ?: "", style = Palette.Chip)
                    if (canManage && (request.statusId == RequestStatus.PENDING || request.statusId == RequestStatus.FAILED)) {
                        TvButton(
                            label = if (request.statusId == RequestStatus.FAILED) "Retry" else "Approve",
                            onClick = {
                                scope.launch {
                                    runCatching { client.approveRequest(request.id) }
                                        .onSuccess { status = "Updated ${media?.title ?: "request"}."; isError = false; reload += 1 }
                                        .onFailure { status = it.message; isError = true }
                                }
                            },
                        )
                    }
                    if (canManage && request.statusId == RequestStatus.PENDING) {
                        TvButton(label = "Decline", onClick = {
                            scope.launch {
                                runCatching { client.declineRequest(request.id) }
                                    .onSuccess { reload += 1 }
                                    .onFailure { status = it.message; isError = true }
                            }
                        }, tone = Palette.SurfaceHigh)
                    }
                    if (canManage && media != null && media.id > 0) {
                        TvButton(label = "Mark available", onClick = {
                            scope.launch {
                                runCatching { client.markAvailable(media.id) }
                                    .onSuccess { reload += 1 }
                                    .onFailure { status = it.message; isError = true }
                            }
                        }, tone = Palette.SurfaceHigh)
                    }
                    if (canManage || request.statusId == RequestStatus.PENDING) {
                        TvButton(label = "Remove", onClick = {
                            scope.launch {
                                runCatching { client.deleteRequest(request.id) }
                                    .onSuccess { reload += 1 }
                                    .onFailure { status = it.message; isError = true }
                            }
                        }, tone = Palette.Danger)
                    }
                }
            }
        }
    }
}
