package dev.daprkid.discovarrtv

import android.content.Context
import android.content.SharedPreferences

/**
 * Where the signed-in server lives between launches.
 *
 * Only the session cookie (or an API token) and the server address are kept.
 * The password is never stored: after sign-in the cookie is the credential, and
 * it can be revoked from Discovarr's settings page like any other session.
 */
data class Session(
    val baseUrl: String,
    val cookie: String?,
    val token: String?,
    val username: String,
)

class ServerStore(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("discovarr", Context.MODE_PRIVATE)

    fun load(): Session? {
        val baseUrl = prefs.getString(KEY_BASE_URL, null) ?: return null
        val cookie = prefs.getString(KEY_COOKIE, null)
        val token = prefs.getString(KEY_TOKEN, null)
        if (cookie.isNullOrBlank() && token.isNullOrBlank()) return null

        return Session(
            baseUrl = baseUrl,
            cookie = cookie,
            token = token,
            username = prefs.getString(KEY_USERNAME, "") ?: "",
        )
    }

    fun save(session: Session) {
        prefs.edit()
            .putString(KEY_BASE_URL, session.baseUrl)
            .putString(KEY_COOKIE, session.cookie)
            .putString(KEY_TOKEN, session.token)
            .putString(KEY_USERNAME, session.username)
            .apply()
    }

    /** Replaces just the cookie, after a re-login from the settings screen. */
    fun updateCookie(cookie: String) {
        prefs.edit().putString(KEY_COOKIE, cookie).apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    private companion object {
        const val KEY_BASE_URL = "baseUrl"
        const val KEY_COOKIE = "cookie"
        const val KEY_TOKEN = "token"
        const val KEY_USERNAME = "username"
    }
}
