package dev.daprkid.discovarrtv

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
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
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.daprkid.discovarrtv.ui.FocusableSurface
import dev.daprkid.discovarrtv.ui.Mark
import dev.daprkid.discovarrtv.ui.Palette
import dev.daprkid.discovarrtv.ui.PosterCard
import dev.daprkid.discovarrtv.ui.Shelf
import dev.daprkid.discovarrtv.ui.StatusLine
import dev.daprkid.discovarrtv.ui.ThemeTokens
import dev.daprkid.discovarrtv.ui.TvButton
import dev.daprkid.discovarrtv.ui.Wordmark
import kotlinx.coroutines.launch
import kotlin.math.cos
import kotlin.math.sin

/** The rail item that should stay lit while a title, person or collection is open. */
private fun Route.anchor(): Route = when (this) {
    is Route.Detail -> from.anchor()
    is Route.Person -> from.anchor()
    is Route.Collection -> from.anchor()
    else -> this
}

/** Where the app is, from the rail's point of view. */
sealed interface Route {
    data object Home : Route
    data object Browse : Route
    data object Calendar : Route
    data object Watchlist : Route
    data object Search : Route
    data object Requests : Route
    data object Activity : Route
    data object Notifications : Route
    data object Settings : Route
    data class Detail(val media: Media, val from: Route) : Route
    data class Person(val id: Long, val from: Route) : Route
    data class Collection(val id: Long, val from: Route) : Route
}

/** Everything the home screen needs, fetched once per sign-in. */
data class Catalog(
    val movies: List<Media> = emptyList(),
    val shows: List<Media> = emptyList(),
    val library: List<Media> = emptyList(),
    val source: String = "local",
    val loading: Boolean = true,
    val error: String? = null,
) {
    val total: Int get() = movies.size + shows.size + library.size
}

@Composable
fun MainShell(
    session: Session,
    singlePress: Boolean,
    theme: ThemeTokens,
    onSinglePressChange: (Boolean) -> Unit,
    onThemeChange: (ThemeTokens) -> Unit,
    onSwitchAccount: () -> Unit,
    onSessionChanged: (Session) -> Unit,
    onSignOut: () -> Unit,
) {
    val client = remember(session) {
        DiscovarrClient(session.baseUrl, session = session.cookie, token = session.token)
    }
    val scope = rememberCoroutineScope()
    val focusManager = LocalFocusManager.current
    val railFocus = remember { FocusRequester() }

    var route by remember { mutableStateOf<Route>(Route.Home) }
    var catalog by remember { mutableStateOf(Catalog()) }
    var authExpired by remember { mutableStateOf(false) }
    var account by remember { mutableStateOf<User?>(null) }
    var unread by remember { mutableStateOf(0) }

    val libraryKeys = remember(catalog) {
        (catalog.movies + catalog.shows + catalog.library).mapNotNull { item ->
            item.tmdbId?.let { "${item.mediaType}:$it" }
        }.toSet()
    }

    fun refreshUnread() {
        scope.launch {
            unread = runCatching { client.notifications().first }.getOrDefault(unread)
        }
    }

    fun loadCatalog() {
        catalog = catalog.copy(loading = true, error = null)
        scope.launch {
            try {
                account = runCatching { client.me() }.getOrNull()
                refreshUnread()
                val films = client.discover(DiscoverSpec(type = "movie"))
                val series = client.discover(DiscoverSpec(type = "tv"))
                val source = if (films.source == "tmdb" || series.source == "tmdb") "tmdb" else "local"
                catalog = Catalog(
                    movies = films.results,
                    shows = series.results,
                    library = if (source == "tmdb") client.media("all").filter { it.isAvailable || it.hasActiveRequest } else emptyList(),
                    source = source,
                    loading = false,
                )
            } catch (error: ApiException) {
                if (error.isAuthError) authExpired = true
                catalog = catalog.copy(loading = false, error = error.message ?: "Could not load Discover")
            } catch (error: Exception) {
                catalog = catalog.copy(loading = false, error = error.message ?: "Could not load Discover")
            }
        }
    }

    LaunchedEffect(session) { loadCatalog() }

    // The remote's back key returns to the shelf you came from, never straight
    // out of the app, which on a TV is how people expect focus to behave.
    BackHandler(enabled = route != Route.Home) {
        route = when (val current = route) {
            is Route.Detail -> current.from
            is Route.Person -> current.from
            is Route.Collection -> current.from
            else -> Route.Home
        }
    }

    Row(modifier = Modifier.fillMaxSize()) {
        Rail(
            route = route,
            username = session.username,
            unread = unread,
            activeRequester = railFocus,
            onSelect = { selected -> route = selected },
            onSignOut = {
                scope.launch { client.logout() }
                onSignOut()
            },
        )

        Box(
            modifier = Modifier
                .fillMaxHeight()
                .weight(1f)
                // Left at the edge of the content is a walk back to the rail. The
                // focused item is asked first, so moving between cards still
                // works; only when nothing is further left does the rail take it,
                // which is what "the back button is the only way out" was missing.
                .onKeyEvent { event ->
                    if (event.type != KeyEventType.KeyDown || event.key != Key.DirectionLeft) {
                        return@onKeyEvent false
                    }
                    val moved = focusManager.moveFocus(FocusDirection.Left)
                    if (!moved) {
                        runCatching { railFocus.requestFocus() }
                    }
                    true
                },
        ) {
            val selected = route
            if (authExpired) {
                Box(Modifier.fillMaxSize().padding(60.dp), contentAlignment = Alignment.Center) {
                    Text(
                        "This session has expired. Sign in again to continue.",
                        style = Palette.SectionTitle,
                    )
                }
            } else {
                when (selected) {
                    is Route.Home -> HomeScreen(
                        catalog = catalog,
                        client = client,
                        onOpen = { media -> route = Route.Detail(media, Route.Home) },
                        onRetry = { loadCatalog() },
                    )

                    is Route.Browse -> BrowseScreen(
                        client = client,
                        onOpen = { media -> route = Route.Detail(media, Route.Browse) },
                        onCollection = { id -> route = Route.Collection(id, Route.Browse) },
                    )

                    is Route.Search -> SearchScreen(
                        client = client,
                        libraryKeys = libraryKeys,
                        onOpen = { media -> route = Route.Detail(media, Route.Search) },
                    )

                    is Route.Calendar -> CalendarScreen(
                        client = client,
                        onOpen = { media -> route = Route.Detail(media, Route.Calendar) },
                    )

                    is Route.Watchlist -> WatchlistScreen(
                        client = client,
                        onOpen = { media -> route = Route.Detail(media, Route.Watchlist) },
                    )

                    is Route.Requests -> RequestsScreen(
                        client = client,
                        canManage = account?.canManageRequests == true,
                        onOpen = { media -> route = Route.Detail(media, Route.Requests) },
                    )

                    is Route.Activity -> ActivityScreen(
                        client = client,
                        onOpen = { media -> route = Route.Detail(media, Route.Activity) },
                    )

                    is Route.Notifications -> NotificationsScreen(
                        client = client,
                        onOpen = { media -> route = Route.Detail(media, Route.Notifications) },
                        onChanged = { refreshUnread() },
                    )

                    is Route.Settings -> SettingsScreen(
                        session = session,
                        client = client,
                        singlePress = singlePress,
                        theme = theme,
                        onSinglePressChange = onSinglePressChange,
                        onThemeChange = onThemeChange,
                        onSwitchAccount = onSwitchAccount,
                        onSessionChanged = onSessionChanged,
                        onSignOut = onSignOut,
                    )

                    is Route.Detail -> DetailScreen(
                        media = selected.media,
                        client = client,
                        onBack = { route = selected.from },
                        onPerson = { id -> route = Route.Person(id, selected) },
                        onOpen = { media -> route = Route.Detail(media, selected) },
                        onCollection = { id -> route = Route.Collection(id, selected) },
                    )

                    is Route.Person -> PersonScreen(
                        personId = selected.id,
                        client = client,
                        onOpen = { media -> route = Route.Detail(media, selected) },
                        onBack = { route = selected.from },
                    )

                    is Route.Collection -> CollectionScreen(
                        collectionId = selected.id,
                        client = client,
                        onOpen = { media -> route = Route.Detail(media, selected) },
                        onBack = { route = selected.from },
                    )
                }
            }
        }
    }
}

/**
 * The left rail.
 *
 * On a TV a vertical rail is easier to navigate than a top tab bar: the first
 * D-pad press lands in it, and up/down walks the destinations. It is wide with
 * its labels while it holds focus, and folds down to its icons while the viewer
 * is reading the page, so the content gets the width and the rail gets its name
 * back the moment it is focused again.
 */
@Composable
private fun Rail(
    route: Route,
    username: String,
    unread: Int,
    activeRequester: FocusRequester,
    onSelect: (Route) -> Unit,
    onSignOut: () -> Unit,
) {
    // The web's navigation, in the web's order: Discover, Calendar, Watchlist,
    // Requests, Activity, Settings. Activity is administration and lives in the
    // account menu there, so a television rail keeps the six that matter.
    val destinations = listOf(
        Triple("Discover", RailGlyph.Home, Route.Home),
        Triple("Browse", RailGlyph.Browse, Route.Browse),
        Triple("Search", RailGlyph.Search, Route.Search),
        Triple("Calendar", RailGlyph.Calendar, Route.Calendar),
        Triple("Watchlist", RailGlyph.Star, Route.Watchlist),
        Triple("Requests", RailGlyph.Download, Route.Requests),
        Triple("Activity", RailGlyph.Activity, Route.Activity),
        Triple(if (unread > 0) "Updates ($unread)" else "Updates", RailGlyph.Bell, Route.Notifications),
        Triple("Settings", RailGlyph.Settings, Route.Settings),
    )

    var expanded by remember { mutableStateOf(true) }
    var active by remember { mutableStateOf(true) }
    val width by animateDpAsState(if (expanded) 236.dp else 92.dp, label = "railWidth")

    Column(
        modifier = Modifier
            .width(width)
            .fillMaxHeight()
            .background(Palette.Surface)
            .onFocusChanged { state ->
                val holding = state.isFocused || state.hasFocus
                expanded = holding
                if (holding) active = true
            }
            .padding(horizontal = if (expanded) 16.dp else 10.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        horizontalAlignment = if (expanded) Alignment.Start else Alignment.CenterHorizontally,
    ) {
        if (expanded) {
            Wordmark(
                size = 32.dp,
                modifier = Modifier.padding(start = 10.dp, bottom = 20.dp),
            )
        } else {
            Mark(size = 34.dp, modifier = Modifier.padding(bottom = 18.dp))
        }

        Column(
            modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            destinations.forEach { (label, glyph, target) ->
                val current = route.anchor() == target
                RailItem(
                    label = label,
                    glyph = glyph,
                    active = current,
                    expanded = expanded,
                    requester = if (current && active) activeRequester else null,
                    onClick = { onSelect(target) },
                )
            }
        }

        if (expanded) {
            Text(
                username,
                style = Palette.Chip,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 14.dp, bottom = 10.dp),
            )
        }
        RailItem(
            label = "Sign out",
            glyph = RailGlyph.SignOut,
            active = false,
            expanded = expanded,
            requester = null,
            onClick = onSignOut,
        )
    }
}

@Composable
private fun RailItem(
    label: String,
    glyph: RailGlyph,
    active: Boolean,
    expanded: Boolean,
    requester: FocusRequester?,
    onClick: () -> Unit,
) {
    FocusableSurface(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .then(if (requester != null) Modifier.focusRequester(requester) else Modifier),
        focusedScale = 1.02f,
    ) { focused ->
        // The row has to fill the item for a centred glyph to be centred: without
        // it the row wraps its content and sits at the item's start, which is why
        // the folded rail drew its icons against the left edge.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(
                    horizontal = if (expanded) 14.dp else 0.dp,
                    vertical = 12.dp,
                ),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = if (expanded) Arrangement.spacedBy(14.dp) else Arrangement.Center,
        ) {
            RailGlyphIcon(
                glyph = glyph,
                tint = if (active || focused) Palette.Accent else Palette.TextSecondary,
            )
            if (expanded) {
                Text(
                    text = label,
                    style = Palette.Body.copy(
                        color = if (active) Palette.Accent else Palette.TextPrimary,
                    ),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** The rail's icons, drawn rather than imported: the app carries no icon set. */
private enum class RailGlyph { Home, Browse, Calendar, Star, Download, Search, Activity, Bell, Settings, SignOut }

@Composable
private fun RailGlyphIcon(glyph: RailGlyph, tint: Color) {
    Canvas(modifier = Modifier.size(26.dp)) {
        val w = size.width
        val h = size.height
        val line = w * 0.11f
        val stroke = Stroke(width = line, cap = StrokeCap.Round, join = StrokeJoin.Round)
        val path = Path()
        val centre = Offset(w / 2f, h / 2f)

        when (glyph) {
            RailGlyph.Home -> {
                path.moveTo(w * 0.12f, h * 0.46f)
                path.lineTo(w * 0.5f, h * 0.14f)
                path.lineTo(w * 0.88f, h * 0.46f)
                drawPath(path, tint, style = stroke)
                drawRoundRect(
                    color = tint,
                    topLeft = Offset(w * 0.22f, h * 0.44f),
                    size = Size(w * 0.56f, h * 0.42f),
                    cornerRadius = CornerRadius(w * 0.06f),
                    style = stroke,
                )
            }

            RailGlyph.Calendar -> {
                drawRoundRect(
                    color = tint,
                    topLeft = Offset(w * 0.12f, h * 0.24f),
                    size = Size(w * 0.76f, h * 0.62f),
                    cornerRadius = CornerRadius(w * 0.08f),
                    style = stroke,
                )
                drawLine(tint, Offset(w * 0.12f, h * 0.42f), Offset(w * 0.88f, h * 0.42f), strokeWidth = line)
                drawLine(tint, Offset(w * 0.32f, h * 0.12f), Offset(w * 0.32f, h * 0.30f), strokeWidth = line, cap = StrokeCap.Round)
                drawLine(tint, Offset(w * 0.68f, h * 0.12f), Offset(w * 0.68f, h * 0.30f), strokeWidth = line, cap = StrokeCap.Round)
            }

            RailGlyph.Star -> {
                val outer = w * 0.44f
                val inner = outer * 0.45f
                repeat(10) { index ->
                    val radius = if (index % 2 == 0) outer else inner
                    val angle = Math.toRadians((index * 36 - 90).toDouble())
                    val x = centre.x + (radius * cos(angle)).toFloat()
                    val y = centre.y + (radius * sin(angle)).toFloat()
                    if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
                }
                path.close()
                drawPath(path, tint, style = stroke)
            }

            RailGlyph.Download -> {
                drawLine(tint, Offset(w * 0.5f, h * 0.12f), Offset(w * 0.5f, h * 0.60f), strokeWidth = line, cap = StrokeCap.Round)
                path.moveTo(w * 0.30f, h * 0.42f)
                path.lineTo(w * 0.5f, h * 0.64f)
                path.lineTo(w * 0.70f, h * 0.42f)
                drawPath(path, tint, style = stroke)
                drawLine(tint, Offset(w * 0.20f, h * 0.86f), Offset(w * 0.80f, h * 0.86f), strokeWidth = line, cap = StrokeCap.Round)
            }

            RailGlyph.Browse -> {
                drawRoundRect(
                    color = tint,
                    topLeft = Offset(w * 0.12f, h * 0.12f),
                    size = Size(w * 0.32f, h * 0.32f),
                    cornerRadius = CornerRadius(w * 0.06f),
                    style = stroke,
                )
                drawRoundRect(
                    color = tint,
                    topLeft = Offset(w * 0.56f, h * 0.12f),
                    size = Size(w * 0.32f, h * 0.32f),
                    cornerRadius = CornerRadius(w * 0.06f),
                    style = stroke,
                )
                drawRoundRect(
                    color = tint,
                    topLeft = Offset(w * 0.12f, h * 0.56f),
                    size = Size(w * 0.32f, h * 0.32f),
                    cornerRadius = CornerRadius(w * 0.06f),
                    style = stroke,
                )
                drawRoundRect(
                    color = tint,
                    topLeft = Offset(w * 0.56f, h * 0.56f),
                    size = Size(w * 0.32f, h * 0.32f),
                    cornerRadius = CornerRadius(w * 0.06f),
                    style = stroke,
                )
            }

            RailGlyph.Activity -> {
                drawLine(tint, Offset(w * 0.16f, h * 0.78f), Offset(w * 0.16f, h * 0.48f), strokeWidth = line, cap = StrokeCap.Round)
                drawLine(tint, Offset(w * 0.40f, h * 0.78f), Offset(w * 0.40f, h * 0.30f), strokeWidth = line, cap = StrokeCap.Round)
                drawLine(tint, Offset(w * 0.64f, h * 0.78f), Offset(w * 0.64f, h * 0.42f), strokeWidth = line, cap = StrokeCap.Round)
                drawLine(tint, Offset(w * 0.86f, h * 0.78f), Offset(w * 0.86f, h * 0.18f), strokeWidth = line, cap = StrokeCap.Round)
            }

            RailGlyph.Bell -> {
                path.moveTo(w * 0.5f, h * 0.12f)
                path.lineTo(w * 0.22f, h * 0.40f)
                path.lineTo(w * 0.22f, h * 0.62f)
                path.lineTo(w * 0.78f, h * 0.62f)
                path.lineTo(w * 0.78f, h * 0.40f)
                path.close()
                drawPath(path, tint, style = stroke)
                drawLine(tint, Offset(w * 0.32f, h * 0.62f), Offset(w * 0.68f, h * 0.62f), strokeWidth = line, cap = StrokeCap.Round)
                drawCircle(tint, radius = w * 0.08f, center = Offset(w * 0.5f, h * 0.78f), style = stroke)
            }

            RailGlyph.Search -> {
                drawCircle(tint, radius = w * 0.27f, center = Offset(w * 0.44f, h * 0.42f), style = stroke)
                drawLine(tint, Offset(w * 0.64f, h * 0.62f), Offset(w * 0.86f, h * 0.86f), strokeWidth = line, cap = StrokeCap.Round)
            }

            RailGlyph.Settings -> {
                drawCircle(tint, radius = w * 0.20f, center = centre, style = stroke)
                drawCircle(tint, radius = w * 0.06f, center = centre, style = stroke)
                repeat(6) { index ->
                    val angle = Math.toRadians((index * 60).toDouble())
                    val from = Offset(
                        centre.x + (w * 0.26f * cos(angle)).toFloat(),
                        centre.y + (w * 0.26f * sin(angle)).toFloat(),
                    )
                    val to = Offset(
                        centre.x + (w * 0.44f * cos(angle)).toFloat(),
                        centre.y + (w * 0.44f * sin(angle)).toFloat(),
                    )
                    drawLine(tint, from, to, strokeWidth = line, cap = StrokeCap.Round)
                }
            }

            RailGlyph.SignOut -> {
                drawRoundRect(
                    color = tint,
                    topLeft = Offset(w * 0.12f, h * 0.16f),
                    size = Size(w * 0.48f, h * 0.68f),
                    cornerRadius = CornerRadius(w * 0.08f),
                    style = stroke,
                )
                drawLine(tint, Offset(w * 0.46f, h * 0.5f), Offset(w * 0.88f, h * 0.5f), strokeWidth = line, cap = StrokeCap.Round)
                path.moveTo(w * 0.70f, h * 0.34f)
                path.lineTo(w * 0.88f, h * 0.5f)
                path.lineTo(w * 0.70f, h * 0.66f)
                drawPath(path, tint, style = stroke)
            }
        }
    }
}

@Composable
private fun HomeScreen(
    catalog: Catalog,
    client: DiscovarrClient,
    onOpen: (Media) -> Unit,
    onRetry: () -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 40.dp, end = 60.dp, top = 40.dp, bottom = 60.dp),
        verticalArrangement = Arrangement.spacedBy(34.dp),
    ) {
        item {
            Column {
                Text("Discover", style = Palette.Title)
                Text(
                    if (catalog.loading) "Loading Discover..." else {
                        if (catalog.source == "tmdb") "Trending this week" else "The local catalog — add a TMDB key for trending"
                    },
                    style = Palette.BodyMuted,
                )
            }
        }

        catalog.error?.let { message ->
            item {
                Column {
                    StatusLine(message, isError = true)
                    Spacer(Modifier.height(12.dp))
                    TvButton(label = "Try again", onClick = onRetry)
                }
            }
        }

        val shelves = buildList {
            if (catalog.source == "tmdb") {
                add("Trending films" to catalog.movies)
                add("Trending series" to catalog.shows)
                if (catalog.library.isNotEmpty()) add("In your library" to catalog.library)
            } else {
                add("Movies" to catalog.movies)
                add("TV shows" to catalog.shows)
            }
        }

        shelves.filter { it.second.isNotEmpty() }.forEach { (label, shelfItems) ->
            item(key = label) {
                Shelf(title = label, count = shelfItems.size) {
                    LazyRow(
                        horizontalArrangement = Arrangement.spacedBy(18.dp),
                        contentPadding = PaddingValues(vertical = 4.dp),
                    ) {
                        items(shelfItems, key = { "${it.mediaType}-${it.id}" }) { media ->
                            PosterCard(
                                title = media.title,
                                subtitle = media.year ?: media.subtitle,
                                imageUrl = client.resolveImage(media.posterPath),
                                badge = when {
                                    media.onPlex -> "PLEX"
                                    media.myActiveRequests > 0 -> "REQUESTED"
                                    else -> null
                                },
                                onClick = { onOpen(media) },
                                // A Radarr or Sonarr import can land without a
                                // poster; the web borrows TMDB's, so the shelf
                                // asks the same server for the same artwork
                                // instead of showing two initials.
                                artFallback = { client.posterFor(media) },
                            )
                        }
                    }
                }
            }
        }

        if (!catalog.loading && catalog.total == 0 && catalog.error == null) {
            item {
                StatusLine(
                    "Nothing to show yet. Add a TMDB key, or run a sync after connecting Sonarr and Radarr.",
                    isError = true,
                )
            }
        }
    }
}
