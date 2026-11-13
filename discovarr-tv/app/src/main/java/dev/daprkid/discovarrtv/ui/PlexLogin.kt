package dev.daprkid.discovarrtv.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.daprkid.discovarrtv.DiscovarrClient
import dev.daprkid.discovarrtv.PlexPin
import dev.daprkid.discovarrtv.PlexPoll
import dev.daprkid.discovarrtv.PlexProfile
import dev.daprkid.discovarrtv.Qr
import dev.daprkid.discovarrtv.Session
import dev.daprkid.discovarrtv.TvPrefs
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Plex sign-in, done on the television instead of in a browser.
 *
 * Plex authorises a device with a pin: the server asks plex.tv for one, and
 * anyone already signed in to Plex confirms it. A four-character `plex.tv/link`
 * code hands back a *limited* token that plex.tv then refuses on its own account
 * calls, which is why the browser flow — a strong pin, twenty-five characters —
 * works and that one never could. The server therefore issues the strong pin and
 * this screen shows its authorisation URL as a QR code, because no one types a
 * hundred characters with a remote.
 *
 * The layout assumes the height of a television is small: the title, the code and
 * the way out all have to be visible at once, so only the middle band scrolls and
 * the buttons are pinned underneath it, never inside it.
 */
@Composable
fun PlexLoginScreen(
    baseUrl: String,
    onSignedIn: (cookie: String) -> Unit,
    onCancel: () -> Unit,
) {
    val client = remember(baseUrl) { DiscovarrClient(baseUrl) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val prefs = remember(context) { TvPrefs(context) }

    var pin by remember(baseUrl) { mutableStateOf<PlexPin?>(null) }
    var profiles by remember(baseUrl) { mutableStateOf<List<PlexProfile>>(emptyList()) }
    var tokenCookie by remember(baseUrl) { mutableStateOf("") }
    var pendingPin by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf<PlexProfile?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    var isError by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var attempts by remember { mutableStateOf(0) }
    var restart by remember { mutableStateOf(0) }

    // Which build is actually on the television. Two rounds of "it still does
    // the old thing" are worth one line of text: the install date comes from the
    // package manager, so it cannot be stale.
    val buildStamp = remember(context) {
        runCatching {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            val installed = java.text.SimpleDateFormat("d MMM HH:mm", java.util.Locale.US)
                .format(java.util.Date(info.lastUpdateTime))
            "tv build ${info.versionName} · installed $installed"
        }.getOrNull().orEmpty()
    }

    BackHandler {
        // Back inside the PIN stage returns to the profiles, not out of the whole
        // sign-in: one wrong card should cost a press, not a new code.
        if (selected?.protected == true) {
            selected = null
            pendingPin = ""
            status = null
            isError = false
        } else {
            onCancel()
        }
    }

    LaunchedEffect(baseUrl, restart) {
        // A retry starts clean: an answer from the last attempt must not stay on
        // screen beside a freshly issued code, where it reads as this code's fault.
        status = null
        isError = false
        attempts = 0
        profiles = emptyList()
        try {
            pin = client.plexStart(prefs.plexClientId)
        } catch (error: Exception) {
            status = error.message ?: "Plex sign-in is not available on this server"
            isError = true
        }
    }

    // Plex confirms the code out of band, so the callback is polled. Two seconds
    // is slow enough to be polite and quick enough not to feel stuck.
    LaunchedEffect(pin, profiles) {
        val current = pin ?: return@LaunchedEffect
        if (profiles.isNotEmpty()) return@LaunchedEffect

        while (true) {
            attempts += 1
            when (val result = client.plexPoll(current)) {
                is PlexPoll.SignedIn -> {
                    onSignedIn(result.cookie)
                    return@LaunchedEffect
                }

                is PlexPoll.ChooseProfile -> {
                    tokenCookie = result.tokenCookie
                    profiles = result.profiles
                    status = null
                    return@LaunchedEffect
                }

                is PlexPoll.Failed -> {
                    status = result.message
                    isError = true
                    return@LaunchedEffect
                }

                // Each poll makes the server ask plex.tv about the pin, so the
                // wait grows after the first few: quick enough to feel instant
                // when the phone's Allow arrives, gentle enough not to make the
                // server hammer Plex for minutes.
                PlexPoll.Waiting -> delay(if (attempts < 5) 2_000L else 4_000L)
            }
        }
    }

    fun choose(profile: PlexProfile, pinCode: String) {
        if (profile.protected && pinCode.length != 4) {
            status = "Enter the 4-digit PIN for ${profile.name}"
            isError = true
            return
        }
        busy = true
        scope.launch {
            try {                when (val result = client.plexChoose(tokenCookie, profile.uuid, pinCode)) {
                    is PlexPoll.SignedIn -> onSignedIn(result.cookie)
                    is PlexPoll.Failed -> {
                        status = result.message
                        isError = true
                        // A refused PIN has to leave empty boxes, or the next
                        // digit would have nowhere to go.
                        pendingPin = ""
                    }

                    else -> Unit
                }
            } catch (error: Exception) {
                status = error.message ?: "That profile could not be signed in"
                isError = true
                pendingPin = ""
            } finally {
                busy = false
            }
        }
    }

    val scroll = rememberScrollState()
    val bodyFocus = remember { FocusRequester() }
    val cardFocus = remember { FocusRequester() }
    val pinPadFocus = remember { FocusRequester() }

    // Whatever the remote can do something with gets focus first: the first
    // profile card, or the number pad once a PIN is being asked for. Retried
    // because a node can only take focus after it has been laid out.
    LaunchedEffect(profiles, selected) {
        if (profiles.isEmpty()) return@LaunchedEffect
        val target = if (selected?.protected == true) pinPadFocus else cardFocus
        repeat(20) {
            if (runCatching { target.requestFocus() }.isSuccess) return@LaunchedEffect
            delay(50)
        }
    }

    // The scroll container only sees remote presses if something inside it holds
    // focus. Without this the code was printed below the fold and no key could
    // reach it, which is precisely what the screen was reported as. The request
    // is retried because the node only exists once composition has been laid
    // out, and a silent failure here would bring the same bug back.
    LaunchedEffect(Unit) {
        repeat(20) {
            if (runCatching { bodyFocus.requestFocus() }.isSuccess) return@LaunchedEffect
            delay(50)
        }
    }

    GlowBackground {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 56.dp, vertical = 22.dp),
            contentAlignment = Alignment.Center,
        ) {
            // The panel is given the whole height, so the buttons below the
            // scrolling band are guaranteed to be on screen no matter how long
            // plex.tv's answer is.
            AuthPanel(modifier = Modifier.fillMaxHeight()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Mark(size = 34.dp)
                    Spacer(Modifier.width(14.dp))
                    Text(
                        if (profiles.isEmpty()) "Continue with Plex" else "Who's watching?",
                        style = Palette.AuthTitle,
                    )
                }

                Spacer(Modifier.height(6.dp))
                Text(
                    when {
                        profiles.isEmpty() ->
                            "Scan this with your phone's camera, then press Allow in Plex."

                        selected?.protected == true ->
                            "Enter the PIN for ${selected!!.name} on the pad below."

                        else -> "Pick the profile this Discovarr account belongs to."
                    },
                    style = Palette.BodyMuted,
                )

                Spacer(Modifier.height(12.dp))

                // The scrolling band. Up and down scroll it while there is more
                // to see, and are handed on to the buttons once there is not, so
                // focus can never be trapped here.
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .verticalScroll(scroll)
                        .focusRequester(bodyFocus)
                        .focusable()
                        .onPreviewKeyEvent { event ->
                            // Only the code screen scrolls by key. While profiles or a
                            // number pad are on screen the up and down keys belong to
                            // them: taking them here is what made the picker
                            // unreachable and dropped focus straight onto Cancel.
                            val scrolling = profiles.isEmpty() && selected == null
                            if (!scrolling || event.type != KeyEventType.KeyDown) {
                                false
                            } else {
                                when (event.key) {
                                    Key.DirectionDown -> {
                                        if (!scroll.canScrollForward) {
                                            false
                                        } else {
                                            scope.launch { scroll.animateScrollBy(140f) }
                                            true
                                        }
                                    }

                                    Key.DirectionUp -> {
                                        if (!scroll.canScrollBackward) {
                                            false
                                        } else {
                                            scope.launch { scroll.animateScrollBy(-140f) }
                                            true
                                        }
                                    }

                                    else -> false
                                }
                            }
                        },
                ) {
                    // A 401 is plex.tv refusing the server's own request for the
                    // account's profiles, after this television has already been
                    // given a token. Saying so keeps it from reading as a remote
                    // that mistyped something: the way to disprove it is the same
                    // sign-in in a browser, which the server cannot tell apart.
                    Alert(
                        if (isError && status != null && status!!.contains("401") &&
                            !status!!.contains("plex.tv")
                        ) {
                            "$status — plex.tv is refusing your server, not this TV. " +
                                "Press New code once, or open $baseUrl in a browser " +
                                "and try Continue with Plex there."
                        } else {
                            status
                        },
                        isError,
                    )

                    if (profiles.isEmpty()) {
                        val authUrl = pin?.authUrl
                        if (authUrl == null) {
                            Text("Asking Plex for a sign-in link…", style = Palette.Chip)
                        } else {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                QrImage(authUrl)
                                Spacer(Modifier.width(20.dp))
                                Column {
                                    Text(
                                        "Press Allow on Plex and this TV signs in. " +
                                            "Nothing has to be typed with the remote.",
                                        style = Palette.BodyMuted,
                                    )
                                    Spacer(Modifier.height(8.dp))
                                    Text("waiting for Plex to confirm…", style = Palette.Chip)
                                    if (attempts > 90) {
                                        Spacer(Modifier.height(6.dp))
                                        Text(
                                            "Still waiting. The link expires; press New code.",
                                            style = Palette.Chip.copy(color = Palette.Warning),
                                        )
                                    }
                                }
                            }
                        }
                    } else if (selected?.protected == true) {
                        // A PIN gets its own stage, with its own pad. Digits typed
                        // into a field buried in a scrolling band are reached only by
                        // luck on a remote, and a television remote usually has no
                        // number keys at all.
                        val profile = selected!!
                        Spacer(Modifier.height(6.dp))
                        PinSlots(filled = pendingPin.length, wrong = isError)
                        Spacer(Modifier.height(16.dp))
                        PinPad(
                            firstKeyFocus = pinPadFocus,
                            onDigit = { digit ->
                                if (!busy) {
                                    val next = (pendingPin + digit).take(4)
                                    pendingPin = next
                                    // Four digits is the whole PIN: a fifth press to
                                    // confirm would only be telling the TV what it
                                    // already knows.
                                    if (next.length == 4) choose(profile, next)
                                }
                            },
                            onBackspace = { if (!busy) pendingPin = pendingPin.dropLast(1) },
                            onBack = {
                                selected = null
                                pendingPin = ""
                                status = null
                                isError = false
                            },
                        )
                    } else {
                        Spacer(Modifier.height(4.dp))
                        // Cards, three to a row. The full-width rows this replaces put
                        // every profile on the vertical axis, inside a band that took
                        // the up and down keys for itself, so none of them could be
                        // reached at all. A grid also keeps a household of seven
                        // profiles inside one screen.
                        profiles.chunked(4).forEach { row ->
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                row.forEach { profile ->
                                    ProfileCard(
                                        profile = profile,
                                        chosen = selected?.uuid == profile.uuid,
                                        modifier = Modifier
                                            .weight(1f)
                                            .then(
                                                if (profile.uuid == profiles.first().uuid) {
                                                    Modifier.focusRequester(cardFocus)
                                                } else {
                                                    Modifier
                                                },
                                            ),
                                        onClick = {
                                            pendingPin = ""
                                            status = null
                                            isError = false
                                            selected = profile
                                            if (!profile.protected) choose(profile, "")
                                        },
                                    )
                                }
                                // A short last row keeps its cards as wide as the
                                // rows above instead of stretching them.
                                repeat(4 - row.size) { Spacer(Modifier.weight(1f)) }
                            }
                            Spacer(Modifier.height(10.dp))
                        }
                    }
                }

                // Pinned: the way out of this screen, above the build stamp.
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    if (profiles.isEmpty()) {
                        TvButton(label = "New code", onClick = { restart += 1 })
                    }
                    TvButton(label = "Cancel", onClick = onCancel, tone = Palette.SurfaceHigh)
                }

                if (buildStamp.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    Text(buildStamp, style = Palette.Chip)
                }
            }
        }
    }
}

/**
 * One profile as a card.
 *
 * The name is the whole point, so it is the one line that is never truncated away
 * by anything else: lock state sits underneath it, not beside it.
 */
@Composable
private fun ProfileCard(
    profile: PlexProfile,
    chosen: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    FocusableSurface(
        onClick = onClick,
        modifier = modifier.height(104.dp),
        focusedScale = 1.03f,
    ) { focused ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 8.dp, vertical = 9.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Box(
                modifier = Modifier
                    .size(34.dp)
                    .clip(CircleShape)
                    .background(
                        if (chosen || focused) Palette.Accent.copy(alpha = 0.3f) else Palette.Surface,
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    initialsOf(profile.name),
                    style = Palette.Chip.copy(
                        color = if (chosen || focused) Palette.Accent else Palette.TextSecondary,
                    ),
                )
            }
            Spacer(Modifier.height(8.dp))
            Text(
                profile.name,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = Palette.Body.copy(
                    color = if (chosen || focused) Palette.Accent else Palette.TextPrimary,
                ),
            )
            Spacer(Modifier.height(4.dp))
            Text(
                if (profile.protected) "PIN needed" else "\u00a0",
                style = Palette.Chip.copy(
                    color = if (profile.protected) Palette.Warning else Palette.TextPrimary,
                ),
            )
        }
    }
}

private fun initialsOf(name: String): String {
    val letters = name.trim()
        .split(Regex("\\s+"))
        .filter { it.isNotEmpty() }
        .take(2)
        .mapNotNull { it.firstOrNull()?.uppercaseChar() }
        .joinToString("")
    return letters.ifEmpty { "P" }
}

/** The four boxes the PIN fills, so no digit is ever drawn on a shared screen. */
@Composable
private fun PinSlots(filled: Int, wrong: Boolean) {
    val shape = RoundedCornerShape(10.dp)
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        repeat(4) { slot ->
            val filledSlot = slot < filled
            Box(
                modifier = Modifier
                    .size(54.dp)
                    .clip(shape)
                    .background(Palette.SurfaceHigh)
                    .border(
                        2.dp,
                        when {
                            wrong -> Palette.Danger
                            filledSlot -> Palette.Accent
                            else -> Palette.Line
                        },
                        shape,
                    ),
                contentAlignment = Alignment.Center,
            ) {
                if (filledSlot) {
                    Box(
                        Modifier
                            .size(14.dp)
                            .clip(CircleShape)
                            .background(Palette.TextPrimary),
                    )
                }
            }
        }
    }
}

/** Digits laid out for a D-pad, plus the two keys a number pad always needs. */
@Composable
private fun PinPad(
    firstKeyFocus: FocusRequester,
    onDigit: (String) -> Unit,
    onBackspace: () -> Unit,
    onBack: () -> Unit,
) {
    Column {
        listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "0").chunked(5)
            .forEachIndexed { rowIndex, row ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    row.forEach { digit ->
                        PinKey(
                            label = digit,
                            modifier = if (rowIndex == 0 && digit == "1") {
                                Modifier.focusRequester(firstKeyFocus)
                            } else {
                                Modifier
                            },
                            onClick = { onDigit(digit) },
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
            }

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PinKey(
                label = "Delete",
                width = 108.dp,
                onClick = onBackspace,
            )
            PinKey(
                label = "Other profiles",
                width = 176.dp,
                onClick = onBack,
            )
        }
    }
}

@Composable
private fun PinKey(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    width: Dp = 64.dp,
) {
    FocusableSurface(
        onClick = onClick,
        modifier = modifier
            .width(width)
            .height(60.dp),
        focusedScale = 1.05f,
    ) { focused ->
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
                label,
                style = Palette.Body.copy(
                    color = if (focused) Palette.Accent else Palette.TextPrimary,
                ),
            )
        }
    }
}

/**
 * The Plex authorisation URL as something a phone can read.
 *
 * A remote control cannot type a hundred-character URL, and this code is the
 * only thing on the screen the viewer has to carry to another device. It is
 * sized in dp rather than by weight because a QR code that is stretched is a QR
 * code no camera can read.
 */
@Composable
private fun QrImage(url: String) {
    val bitmap = remember(url) {
        val code = runCatching { Qr.encode(url) }.getOrNull() ?: return@remember null
        // Four light modules of margin on every side, so a camera finds the code
        // against a dark panel.
        val quiet = 4
        val side = code.size + quiet * 2
        val pixels = IntArray(side * side)
        for (y in 0 until side) {
            for (x in 0 until side) {
                val inside = x >= quiet && y >= quiet &&
                    x - quiet < code.size && y - quiet < code.size
                val dark = inside && code.isDark(x - quiet, y - quiet)
                pixels[y * side + x] =
                    if (dark) android.graphics.Color.BLACK else android.graphics.Color.WHITE
            }
        }
        android.graphics.Bitmap.createBitmap(
            pixels,
            side,
            side,
            android.graphics.Bitmap.Config.ARGB_8888,
        )
    }
    if (bitmap == null) return

    Image(
        bitmap = bitmap.asImageBitmap(),
        contentDescription = "Plex sign-in code",
        modifier = Modifier.size(160.dp),
    )
}

@Composable
private fun AuthPanel(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val shape = RoundedCornerShape(18.dp)
    Column(
        modifier = Modifier
            .width(720.dp)
            .then(modifier)
            .clip(shape)
            .background(Palette.Surface)
            .border(1.dp, Palette.Line, shape)
            .padding(horizontal = 34.dp, vertical = 24.dp),
        content = content,
    )
}

@Composable
private fun Alert(message: String?, isError: Boolean) {
    if (message.isNullOrBlank()) return
    val tint = if (isError) Palette.Danger else Palette.Success
    val shape = RoundedCornerShape(10.dp)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(tint.copy(alpha = 0.12f))
            .border(1.dp, tint.copy(alpha = 0.4f), shape)
            .padding(horizontal = 14.dp, vertical = 9.dp),
    ) {
        Text(message, style = Palette.BodyMuted.copy(color = tint))
    }
    Spacer(Modifier.height(12.dp))
}

/** Kept so a screen can hand a finished Plex session to the caller unchanged. */
fun Session.withPlexCookie(cookie: String): Session = copy(cookie = cookie, token = null)
