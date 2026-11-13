package dev.daprkid.discovarrtv

import android.content.Context
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * Choices that belong to this television rather than to the account.
 *
 * A phone opens a poster by tapping it; a remote has one button and no pointer,
 * so how many presses that button needs to open something is a genuine
 * preference rather than an implementation detail. It lives here, and is
 * provided down the tree so every card honours the same answer.
 */
class TvPrefs(context: Context) {
    private val prefs =
        context.applicationContext.getSharedPreferences("discovarr.tv", Context.MODE_PRIVATE)

    /** True: one press opens. False: the first press selects, the second opens. */
    var singlePress: Boolean
        get() = prefs.getBoolean(KEY_SINGLE_PRESS, true)
        set(value) {
            prefs.edit().putBoolean(KEY_SINGLE_PRESS, value).apply()
        }

    /**
     * The last theme applied on this box. The account owns the choice, so this is
     * only the copy painted before the account has been asked, and the fallback
     * if the server cannot be reached.
     */
    var theme: String?
        get() = prefs.getString(KEY_THEME, null)
        set(value) {
            prefs.edit().putString(KEY_THEME, value).apply()
        }

    /**
     * Identifies this television to plex.tv, created once and then reused.
     *
     * Plex ties a confirmed pin to the identifier that asked for it, so this has
     * to survive restarts or every sign-in would need a fresh code.
     */
    val plexClientId: String
        get() {
            prefs.getString(KEY_PLEX_CLIENT_ID, null)?.takeIf { it.isNotBlank() }?.let { return it }
            val created = java.util.UUID.randomUUID().toString()
            prefs.edit().putString(KEY_PLEX_CLIENT_ID, created).apply()
            return created
        }

    private companion object {
        const val KEY_SINGLE_PRESS = "singlePress"
        const val KEY_THEME = "theme"
        const val KEY_PLEX_CLIENT_ID = "plexClientId"
    }
}

/** Read by the card and row components so the setting applies without plumbing. */
val LocalSinglePressOpen = staticCompositionLocalOf { true }
