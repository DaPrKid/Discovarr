package dev.daprkid.discovarrtv

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.lazy.LazyRow
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
import androidx.compose.ui.unit.dp
import dev.daprkid.discovarrtv.ui.FocusableSurface
import dev.daprkid.discovarrtv.ui.Palette
import dev.daprkid.discovarrtv.ui.PlexLoginScreen
import dev.daprkid.discovarrtv.ui.PosterCard
import dev.daprkid.discovarrtv.ui.StatusLine
import dev.daprkid.discovarrtv.ui.ThemeTokens
import dev.daprkid.discovarrtv.ui.Themes
import dev.daprkid.discovarrtv.ui.TvButton
import dev.daprkid.discovarrtv.ui.TvTextField
import kotlinx.coroutines.launch


/**
 * Settings, following the web's account page: the account this box is paired
 * with, the appearance the account has chosen, how a remote opens things, and
 * the way out. Anything that changes the account changes it on the server, which
 * is why the browser and the television never disagree.
 */
@Composable
fun SettingsScreen(
    session: Session,
    client: DiscovarrClient,
    singlePress: Boolean,
    theme: ThemeTokens,
    onSinglePressChange: (Boolean) -> Unit,
    onThemeChange: (ThemeTokens) -> Unit,
    onSwitchAccount: () -> Unit,
    onSessionChanged: (Session) -> Unit,
    onSignOut: () -> Unit,
) {
    var status by remember { mutableStateOf<String?>(null) }
    var isError by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var plexEnabled by remember { mutableStateOf(false) }
    var plexSignIn by remember { mutableStateOf(false) }

    val scope = rememberCoroutineScope()

    LaunchedEffect(session.baseUrl) {
        plexEnabled = client.plexLoginAvailable()
    }

    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 40.dp, vertical = 36.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            item {
                Column {
                    Text("Settings", style = Palette.Title)
                    Text(
                        "This box is paired with one Discovarr server. The account, its theme, its requests and its Plex profile are the same ones the browser uses.",
                        style = Palette.BodyMuted,
                    )
                }
            }

            item {
                SettingsCard("Appearance") {
                    Text(
                        "The theme is saved on the account, so the next device to sign in paints this one instead of whatever it remembered.",
                        style = Palette.BodyMuted,
                    )
                    Spacer(Modifier.height(14.dp))
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        items(Themes.all.size) { index ->
                            val option = Themes.all[index]
                            ThemeSwatch(
                                option = option,
                                active = option.name == theme.name,
                                onClick = {
                                    onThemeChange(option)
                                    scope.launch {
                                        client.saveTheme(option.name)
                                        status = "Theme saved to ${session.username}'s account."
                                        isError = false
                                    }
                                },
                            )
                        }
                    }
                }
            }

            item {
                SettingsCard("Remote") {
                    Text("Opening a title", style = Palette.Body)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "A single press opens right away, like a tap in the browser. Press twice means the first press only highlights a title and the second opens it, which stops a stray thumb on the D-pad.",
                        style = Palette.BodyMuted,
                    )
                    Spacer(Modifier.height(14.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        TvButton(
                            label = "Single press",
                            onClick = { onSinglePressChange(true) },
                            tone = if (singlePress) Palette.Accent else Palette.SurfaceHigh,
                        )
                        TvButton(
                            label = "Press twice",
                            onClick = { onSinglePressChange(false) },
                            tone = if (singlePress) Palette.SurfaceHigh else Palette.Accent,
                        )
                    }
                }
            }

            item {
                SettingsCard("Account") {
                    Text(session.username.ifBlank { "unknown" }, style = Palette.Body)
                    Text(session.baseUrl, style = Palette.Chip)
                    Text(
                        if (session.token != null) {
                            "Signed in with a personal API token"
                        } else {
                            "Signed in with a session cookie"
                        },
                        style = Palette.Chip,
                    )

                    Spacer(Modifier.height(14.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        TvButton(
                            label = "Switch account",
                            onClick = onSwitchAccount,
                            tone = Palette.SurfaceHigh,
                        )
                        if (plexEnabled) {
                            TvButton(
                                label = "Change Plex profile",
                                onClick = { plexSignIn = true },
                                tone = Palette.SurfaceHigh,
                            )
                        }
                        TvButton(label = "Sign out", onClick = onSignOut, tone = Palette.Danger)
                    }
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Switch account signs in as someone else on the same server — the same accounts your browser lists.",
                        style = Palette.Chip,
                    )
                }
            }

            item {
                SettingsCard("Connection") {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        TvButton(
                            label = if (busy) "Checking..." else "Test connection",
                            onClick = {
                                busy = true
                                scope.launch {
                                    try {
                                        val info = client.health()
                                        status = "Connected to Discovarr ${info.version}, ${info.mediaCount} titles."
                                        isError = false
                                    } catch (error: Exception) {
                                        status = error.message ?: "Could not reach the server"
                                        isError = true
                                    } finally {
                                        busy = false
                                    }
                                }
                            },
                            enabled = !busy,
                            tone = Palette.SurfaceHigh,
                        )
                    }
                    Spacer(Modifier.height(12.dp))
                    StatusLine(status, isError, modifier = Modifier.fillMaxWidth())
                }
            }
        }

        if (plexSignIn) {
            PlexLoginScreen(
                baseUrl = session.baseUrl,
                onSignedIn = { cookie ->
                    plexSignIn = false
                    // A different Plex profile is a different Discovarr session,
                    // so the stored credential is replaced, not added to.
                    onSessionChanged(session.copy(cookie = cookie, token = null))
                },
                onCancel = { plexSignIn = false },
            )
        }
    }
}

/** One colourway: its own accents, so the choice is visible before it is made. */
@Composable
private fun ThemeSwatch(option: ThemeTokens, active: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(12.dp)
    FocusableSurface(
        onClick = onClick,
        modifier = Modifier.width(184.dp).height(96.dp),
        shape = shape,
        focusedScale = 1.03f,
    ) { focused ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .clip(shape)
                .background(option.bg)
                .border(if (active) 3.dp else 1.dp, if (active) option.accent else option.line, shape)
                .padding(horizontal = 14.dp, vertical = 12.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.width(26.dp).height(10.dp).clip(RoundedCornerShape(5.dp)).background(option.brandA))
                Box(Modifier.width(26.dp).height(10.dp).clip(RoundedCornerShape(5.dp)).background(option.brandB))
                Box(Modifier.width(26.dp).height(10.dp).clip(RoundedCornerShape(5.dp)).background(option.accent))
            }
            Spacer(Modifier.height(10.dp))
            Text(
                option.label,
                style = Palette.Chip.copy(
                    color = if (focused || active) option.text else option.muted,
                ),
            )
            Text(
                if (active) "Chosen" else " ",
                style = Palette.Chip.copy(color = option.muted),
            )
        }
    }
}

@Composable
private fun SettingsCard(title: String, content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(14.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Palette.Surface)
            .border(1.dp, Palette.Line, shape)
            .padding(horizontal = 24.dp, vertical = 20.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(title, style = Palette.Label)
        Spacer(Modifier.height(6.dp))
        content()
    }
}
