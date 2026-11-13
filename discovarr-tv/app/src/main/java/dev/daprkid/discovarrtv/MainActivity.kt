package dev.daprkid.discovarrtv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import dev.daprkid.discovarrtv.ui.CurrentTheme
import dev.daprkid.discovarrtv.ui.GlowBackground
import dev.daprkid.discovarrtv.ui.SetupScreen
import dev.daprkid.discovarrtv.ui.Themes

/**
 * The whole app is one activity and two states: signed out, or signed in.
 *
 * Session handling lives here rather than in a ViewModel because there is
 * nothing to restore across process death beyond what [ServerStore] already
 * persists: the server address and the credential. [TvPrefs] holds the two
 * choices that belong to the television itself — how many presses open a title,
 * and the last theme painted — while the account owns the theme of record.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { DiscovarrApp() }
    }
}

@Composable
private fun DiscovarrApp() {
    val context = LocalContext.current
    val store = remember { ServerStore(context) }
    val prefs = remember { TvPrefs(context) }

    var session by remember { mutableStateOf(store.load()) }
    var singlePress by remember { mutableStateOf(prefs.singlePress) }
    var theme by remember { mutableStateOf(Themes.named(prefs.theme)) }
    var switchingAccount by remember { mutableStateOf(false) }

    // Applied before anything is drawn, so the first frame is already the right
    // colourway rather than midnight followed by a flash of the chosen theme.
    CurrentTheme.apply(theme)

    // The account owns the theme. Asking the server once per session is what
    // makes a theme chosen in the browser show up here, and a theme chosen here
    // show up in the browser on the next page load.
    LaunchedEffect(session) {
        val current = session ?: return@LaunchedEffect
        val client = DiscovarrClient(
            current.baseUrl,
            session = current.cookie,
            token = current.token,
        )
        val saved = client.accountTheme() ?: return@LaunchedEffect
        prefs.theme = saved
        theme = Themes.named(saved)
    }

    CompositionLocalProvider(LocalSinglePressOpen provides singlePress) {
        GlowBackground {
            Box(modifier = Modifier.fillMaxSize()) {
                val current = session
                if (current == null || switchingAccount) {
                    // Switching account keeps the server: the address step is
                    // skipped and only the credentials are asked for again.
                    SetupScreen(
                        initialAddress = current?.baseUrl ?: "",
                        startAtSignIn = switchingAccount && current != null,
                        onSignedIn = { created ->
                            store.save(created)
                            session = created
                            switchingAccount = false
                        },
                    )
                } else {
                    MainShell(
                        session = current,
                        singlePress = singlePress,
                        theme = theme,
                        onSinglePressChange = { value ->
                            prefs.singlePress = value
                            singlePress = value
                        },
                        onThemeChange = { tokens ->
                            prefs.theme = tokens.name
                            theme = tokens
                        },
                        onSwitchAccount = { switchingAccount = true },
                        onSessionChanged = { updated ->
                            store.save(updated)
                            session = updated
                        },
                        onSignOut = {
                            store.clear()
                            session = null
                            switchingAccount = false
                        },
                    )
                }
            }
        }
    }
}
