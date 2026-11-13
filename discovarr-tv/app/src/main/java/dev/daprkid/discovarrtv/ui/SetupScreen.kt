package dev.daprkid.discovarrtv.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.daprkid.discovarrtv.ApiException
import dev.daprkid.discovarrtv.DiscovarrClient
import dev.daprkid.discovarrtv.ServerInfo
import dev.daprkid.discovarrtv.Session
import kotlinx.coroutines.launch

/** The address has to work before a password can mean anything. */
private enum class Step { Address, SignIn }

/**
 * The way in, built to look like the web app's sign-in rather than like a
 * settings form: the same auth card, the same two fields in the same order, the
 * same "or use the Plex account" beneath them, and the same wordmark above.
 *
 * Two steps, because a TV has no address bar. First the container's address —
 * probed with `/api/v1/health`, so a typo reads as "nothing is listening there"
 * rather than as a wrong password — then the account, either username and
 * password, a personal token, or the server's own Plex flow.
 *
 * The brand sits beside the card when the screen is wide enough to hold both and
 * above it when it is not. Fixed widths are what clipped the wordmark to "Di" on
 * a 1080p set, so every width here is derived from the space actually available.
 */
@Composable
fun SetupScreen(
    initialAddress: String,
    startAtSignIn: Boolean = false,
    onSignedIn: (Session) -> Unit,
) {
    var step by remember { mutableStateOf(if (startAtSignIn) Step.SignIn else Step.Address) }
    var address by remember { mutableStateOf(initialAddress) }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var useToken by remember { mutableStateOf(false) }
    var token by remember { mutableStateOf("") }
    var status by remember { mutableStateOf<String?>(null) }
    var isError by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var serverInfo by remember { mutableStateOf<ServerInfo?>(null) }
    var plexAvailable by remember { mutableStateOf(false) }
    var plexSignIn by remember { mutableStateOf(false) }

    val scope = rememberCoroutineScope()
    val baseUrl = remember(address) { DiscovarrClient.normalise(address) }

    fun report(message: String?, error: Boolean = false) {
        status = message
        isError = error
    }

    fun connect() {
        if (baseUrl.isEmpty()) {
            report("Enter the address of your Discovarr container, for example 192.168.1.10:5057", true)
            return
        }
        busy = true
        report("Looking for Discovarr at $baseUrl...")
        scope.launch {
            try {
                val client = DiscovarrClient(baseUrl)
                val info = client.health()
                serverInfo = info

                if (info.setupRequired) {
                    // No account yet: credentials cannot work, and Plex sign-in
                    // would try to create the first user from the TV.
                    report("That server has no account yet. Finish its setup in a browser first.", true)
                    return@launch
                }

                plexAvailable = client.plexLoginAvailable()
                step = Step.SignIn
                report(null)
            } catch (error: Exception) {
                serverInfo = null
                plexAvailable = false
                report(error.message ?: "Could not reach that address", true)
            } finally {
                busy = false
            }
        }
    }

    fun signIn() {
        busy = true
        scope.launch {
            try {
                if (useToken) {
                    val client = DiscovarrClient(baseUrl, token = token.trim())
                    val user = client.me()
                    onSignedIn(Session(baseUrl, cookie = null, token = token.trim(), username = user.username))
                } else {
                    val result = DiscovarrClient(baseUrl).login(username.trim(), password)
                    onSignedIn(
                        Session(
                            baseUrl = baseUrl,
                            cookie = result.session,
                            token = null,
                            username = result.user.username,
                        ),
                    )
                }
            } catch (error: ApiException) {
                report(error.message ?: "Sign-in failed", true)
            } catch (error: Exception) {
                report(error.message ?: "Sign-in failed", true)
            } finally {
                busy = false
            }
        }
    }

    /** The Plex flow ends with a session cookie, exactly like a password login. */
    fun acceptPlexSession(cookie: String) {
        plexSignIn = false
        busy = true
        scope.launch {
            try {
                val user = DiscovarrClient(baseUrl, session = cookie).me()
                onSignedIn(Session(baseUrl, cookie = cookie, token = null, username = user.username))
            } catch (error: Exception) {
                report("Plex finished, but Discovarr did not accept the session: ${error.message}", true)
            } finally {
                busy = false
            }
        }
    }

    // Coming back to sign in as someone else keeps the server and skips the
    // address step, which is the only difference from a first run.
    LaunchedEffect(startAtSignIn, baseUrl) {
        if (startAtSignIn && serverInfo == null && !busy && baseUrl.isNotEmpty()) connect()
    }

    BackHandler(enabled = step == Step.SignIn && !plexSignIn && !startAtSignIn) {
        step = Step.Address
        status = null
    }

    val stepContent: @Composable ColumnScope.() -> Unit = {
        when (step) {
            Step.Address -> AddressStep(
                address = address,
                onAddressChange = {
                    address = it
                    serverInfo = null
                    status = null
                },
                busy = busy,
                status = status,
                isError = isError,
                onConnect = { connect() },
            )

            Step.SignIn -> SignInStep(
                baseUrl = baseUrl,
                info = serverInfo,
                username = username,
                onUsernameChange = { username = it },
                password = password,
                onPasswordChange = { password = it },
                token = token,
                onTokenChange = { token = it },
                useToken = useToken,
                onToggleToken = {
                    useToken = !useToken
                    status = null
                },
                busy = busy,
                status = status,
                isError = isError,
                plexAvailable = plexAvailable,
                onSignIn = { signIn() },
                onPlex = { plexSignIn = true },
                onChangeServer = {
                    step = Step.Address
                    status = null
                },
            )
        }
    }

    GlowBackground {
        BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
            val wide = maxWidth >= 1180.dp
            val cardWidth = if (wide) 600.dp else minOf(680.dp, maxWidth - 80.dp)

            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 48.dp, vertical = 36.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = if (wide) Alignment.Start else Alignment.CenterHorizontally,
            ) {
                if (wide) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(56.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        BrandPanel(
                            baseUrl = baseUrl,
                            info = serverInfo,
                            narrow = false,
                            modifier = Modifier.weight(1f),
                        )
                        AuthCard(width = cardWidth) { stepContent() }
                    }
                } else {
                    Column(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(22.dp),
                    ) {
                        BrandPanel(
                            baseUrl = baseUrl,
                            info = serverInfo,
                            narrow = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        AuthCard(width = cardWidth) { stepContent() }
                    }
                }
            }
        }

        if (plexSignIn) {
            PlexLoginScreen(
                baseUrl = baseUrl,
                onSignedIn = { cookie -> acceptPlexSession(cookie) },
                onCancel = { plexSignIn = false },
            )
        }
    }
}

@Composable
private fun BrandPanel(
    baseUrl: String,
    info: ServerInfo?,
    narrow: Boolean,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // The web brand is a mark beside a violet-to-cyan wordmark, on one line.
        // The size follows the layout: a stacked layout has the whole width to
        // itself, a side-by-side one only has what the card leaves over.
        Wordmark(size = if (narrow) 46.dp else 62.dp)
        Text(
            "Movies, series and books for the library on your Unraid box.",
            style = Palette.BodyMuted,
        )
        if (baseUrl.isNotEmpty()) {
            Text(baseUrl, style = Palette.Chip.copy(color = Palette.Accent))
        }
        info?.let {
            Text("Discovarr ${it.version} · ${it.mediaCount} titles", style = Palette.Chip)
        }
    }
}

/** The web app's `section.auth`: a bordered surface with generous padding. */
@Composable
private fun AuthCard(width: Dp, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(18.dp)
    Column(
        modifier = Modifier
            .width(width)
            .clip(shape)
            .background(Palette.Surface)
            .border(1.dp, Palette.Line, shape)
            .padding(horizontal = 36.dp, vertical = 32.dp),
        content = content,
    )
}

@Composable
private fun AuthAlert(message: String?, isError: Boolean) {
    if (message.isNullOrBlank()) return
    val tint = if (isError) Palette.Danger else Palette.Success
    val shape = RoundedCornerShape(10.dp)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(tint.copy(alpha = 0.12f))
            .border(1.dp, tint.copy(alpha = 0.40f), shape)
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Text(message, style = Palette.BodyMuted.copy(color = tint))
    }
}

@Composable
private fun ColumnScope.AddressStep(
    address: String,
    onAddressChange: (String) -> Unit,
    busy: Boolean,
    status: String?,
    isError: Boolean,
    onConnect: () -> Unit,
) {
    Text("Connect to Discovarr", style = Palette.AuthTitle)
    Spacer(Modifier.height(6.dp))
    Text(
        "Point this box at the Discovarr container on your Unraid server.",
        style = Palette.BodyMuted,
    )
    Spacer(Modifier.height(18.dp))
    AuthAlert(status, isError)
    if (!status.isNullOrBlank()) Spacer(Modifier.height(16.dp))

    TvTextField(
        value = address,
        onValueChange = onAddressChange,
        label = "Server address",
        placeholder = "192.168.1.10:5057",
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(8.dp))
    Text(
        "Host and port from the Docker tab in Unraid. http:// is assumed, so only the port is needed.",
        style = Palette.Chip,
    )

    Spacer(Modifier.height(22.dp))
    TvButton(
        label = if (busy) "Connecting..." else "Connect",
        onClick = onConnect,
        enabled = !busy,
        fillWidth = true,
    )
}

@Composable
private fun ColumnScope.SignInStep(
    baseUrl: String,
    info: ServerInfo?,
    username: String,
    onUsernameChange: (String) -> Unit,
    password: String,
    onPasswordChange: (String) -> Unit,
    token: String,
    onTokenChange: (String) -> Unit,
    useToken: Boolean,
    onToggleToken: () -> Unit,
    busy: Boolean,
    status: String?,
    isError: Boolean,
    plexAvailable: Boolean,
    onSignIn: () -> Unit,
    onPlex: () -> Unit,
    onChangeServer: () -> Unit,
) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text("Sign in", style = Palette.AuthTitle)
        Spacer(Modifier.weight(1f))
        TvButton(label = "Change server", onClick = onChangeServer, tone = Palette.SurfaceHigh)
    }

    Spacer(Modifier.height(6.dp))
    Text("Request and track media for your library.", style = Palette.BodyMuted)

    Spacer(Modifier.height(10.dp))
    Text(
        info?.let { "${it.mediaCount} titles on $baseUrl" } ?: baseUrl,
        style = Palette.Chip,
    )

    Spacer(Modifier.height(18.dp))
    AuthAlert(status, isError)
    if (!status.isNullOrBlank()) Spacer(Modifier.height(16.dp))

    if (useToken) {
        TvTextField(
            value = token,
            onValueChange = onTokenChange,
            label = "Personal API token",
            placeholder = "Paste the token",
            isSecret = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(8.dp))
        Text("Discovarr → Settings → Account creates one.", style = Palette.Chip)
    } else {
        TvTextField(
            value = username,
            onValueChange = onUsernameChange,
            label = "Username",
            placeholder = "username or email",
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(14.dp))
        TvTextField(
            value = password,
            onValueChange = onPasswordChange,
            label = "Password",
            placeholder = "password",
            isSecret = true,
            modifier = Modifier.fillMaxWidth(),
        )
    }

    Spacer(Modifier.height(24.dp))
    TvButton(
        label = if (busy) "Signing in..." else "Sign in",
        onClick = onSignIn,
        enabled = !busy && (if (useToken) token.isNotBlank() else username.isNotBlank() && password.isNotEmpty()),
        fillWidth = true,
    )

    Spacer(Modifier.height(10.dp))
    TvButton(
        label = if (useToken) "Use username and password" else "Use an API token instead",
        onClick = onToggleToken,
        tone = Palette.SurfaceHigh,
    )

    // Offered only when the server allows it, because the button would
    // otherwise lead to a page that refuses the sign-in.
    if (plexAvailable) {
        Spacer(Modifier.height(22.dp))
        OrDivider()
        Spacer(Modifier.height(18.dp))
        Text(
            "or use the Plex account your library is shared with",
            style = Palette.Chip,
        )
        Spacer(Modifier.height(10.dp))
        TvButton(
            label = "Continue with Plex",
            onClick = onPlex,
            enabled = !busy,
            tone = Palette.Plex,
            fillWidth = true,
        )
    }
}

@Composable
private fun OrDivider() {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f).height(1.dp).background(Palette.Line))
        Text("or", style = Palette.Chip, modifier = Modifier.padding(horizontal = 14.dp))
        Box(Modifier.weight(1f).height(1.dp).background(Palette.Line))
    }
}
