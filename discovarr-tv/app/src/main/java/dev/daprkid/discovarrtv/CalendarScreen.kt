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
import dev.daprkid.discovarrtv.ui.FocusableSurface
import dev.daprkid.discovarrtv.ui.Palette
import dev.daprkid.discovarrtv.ui.StatusLine
import dev.daprkid.discovarrtv.ui.TvButton

/**
 * Upcoming releases for what is in the library and what has been asked for.
 *
 * The browser builds this month by month and offers both a seven-column grid and
 * an agenda; a television has no pointer and a long way to travel, so the agenda
 * is the one that survives the trip: one date heading, then its titles, all
 * reachable with up and down.
 */
@Composable
fun CalendarScreen(client: DiscovarrClient, onOpen: (Media) -> Unit) {
    var month by remember { mutableStateOf<String?>(null) }
    var data by remember { mutableStateOf<CalendarMonth?>(null) }
    var loading by remember { mutableStateOf(true) }
    var status by remember { mutableStateOf<String?>(null) }
    var isError by remember { mutableStateOf(false) }

    LaunchedEffect(month) {
        loading = true
        try {
            data = client.calendar(month)
            status = null
            isError = false
        } catch (error: Exception) {
            status = error.message ?: "Could not read the calendar"
            isError = true
        } finally {
            loading = false
        }
    }

    val byDay = data?.entries.orEmpty()
        .groupBy { it.date }
        .toSortedMap()

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 40.dp, end = 60.dp, top = 40.dp, bottom = 60.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column {
                    Text("Calendar", style = Palette.Title)
                    Text(
                        when {
                            loading -> "Reading the month..."
                            byDay.isEmpty() -> "Nothing releases this month, and nothing in your library or requests is due."
                            else -> "${data?.entries?.size ?: 0} release(s) in ${data?.label.orEmpty()}".trim()
                        },
                        style = Palette.BodyMuted,
                    )
                }
                Spacer(Modifier.weight(1f))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    data?.previous?.let { previous ->
                        TvButton(
                            label = "← ${previous}",
                            onClick = { month = previous },
                            tone = Palette.SurfaceHigh,
                        )
                    }
                    TvButton(label = "This month", onClick = { month = null }, tone = Palette.SurfaceHigh)
                    data?.next?.let { next ->
                        TvButton(
                            label = "$next →",
                            onClick = { month = next },
                            tone = Palette.SurfaceHigh,
                        )
                    }
                }
            }
        }

        item { StatusLine(status, isError) }

        byDay.forEach { (date, entries) ->
            item(key = "day-$date") {
                Column(modifier = Modifier.padding(top = 18.dp)) {
                    Text(date, style = Palette.Label)
                    Spacer(Modifier.height(6.dp))
                    entries.forEach { entry ->
                        FocusableSurface(
                            onClick = {
                                onOpen(
                                    stubMedia(
                                        tmdbId = entry.tmdbId ?: 0,
                                        mediaType = entry.mediaType,
                                        title = entry.title,
                                    ).copy(id = entry.mediaId ?: 0),
                                )
                            },
                            modifier = Modifier.fillMaxWidth().padding(bottom = 6.dp),
                            focusedScale = 1.01f,
                        ) { focused ->
                            Row(
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    entry.title,
                                    style = Palette.Body.copy(
                                        color = if (focused) Palette.Accent else Palette.TextPrimary,
                                    ),
                                )
                                Spacer(Modifier.width(12.dp))
                                Text(
                                    if (entry.mediaType == "tv") "Series" else "Film",
                                    style = Palette.Chip,
                                )
                                if (entry.inLibrary) {
                                    Spacer(Modifier.width(10.dp))
                                    Text("In library", style = Palette.Chip.copy(color = Palette.Success))
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
