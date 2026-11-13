package dev.daprkid.discovarrtv

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log

/**
 * Hands a title over to the Plex app, landing on that title.
 *
 * Discovarr builds the link for its web UI:
 * `app.plex.tv/desktop/#!/server/<machine>/details?key=/library/metadata/<id>`.
 * The app scheme wants the metadata itself, not a path: `plex://preplay/` with
 * the key, the type and the server, which is the form Plex recognises for
 * "show me this item".
 *
 * The form that is reported to work on Android TV is not `preplay` at all but
 * Plex's library link: `plex://libraries/<machine>/unmatched/<key>`, with the
 * metadata key escaped into a single path segment and series under
 * `unmatched/tv/`. Plex has changed this route several times, so the older
 * `preplay`/`play` links are kept behind it as a second chance.
 *
 * Every candidate is resolved with the package manager before it is fired. An
 * unresolvable intent does not fail quietly: the launcher answers it with
 * "You don't have an app that can do this", which is exactly the toast this used
 * to produce. If no `plex://` handler is installed the app opens at its home
 * screen instead, and if Plex is missing altogether the caller is told so.
 */
object PlexLauncher {
    enum class Launch { PlexItem, PlexHome, Browser, None }

    private const val PLEX_PACKAGE = "com.plexapp.android"
    private const val WEB_PREFIX = "https://app.plex.tv/desktop/#!/"
    private const val TAG = "DiscovarrPlex"

    /** `/library/metadata/1234` and, when the link carried one, the machine id. */
    private data class Target(val machine: String?, val key: String)

    private val MACHINE = Regex("/server/([^/?&]+)")
    private val KEY = Regex("[?&]key=([^&]+)")

    /**
     * `/library/metadata/1234` and, when the link carries one, the server's
     * machine id, out of a web or app link.
     *
     * Neither part is required on its own: Discovarr writes
     * `desktop/#!/server/<machine>/details?key=%2Flibrary%2Fmetadata%2F<id>`, but
     * the app's own links, `plex://server/<machine>/details?key=…` and plain
     * `…?key=%2Flibrary%2Fmetadata%2F<id>` forms all appear in the wild, and a
     * link that only lacks the server is still worth handing to Plex. Requiring
     * the server segment is what made every press of Play on Plex open Plex's
     * home screen with no candidates to try. The key is percent-encoded in the
     * link, so it is decoded here and encoded again per form.
     */
    private fun parse(playUrl: String): Target? {
        val machine = MACHINE.find(playUrl)?.groupValues?.get(1)?.let(Uri::decode)
            ?.takeIf { it.isNotBlank() }
        val rawKey = KEY.find(playUrl)?.groupValues?.get(1) ?: return null
        val key = Uri.decode(rawKey).trim().trimEnd('/')
        if (key.isBlank()) return null
        return Target(machine, if (key.startsWith("/")) key else "/$key")
    }

    /** The candidate `plex://` forms, most specific first. */
    fun deepLinks(playUrl: String, mediaType: String?): List<String> {
        val target = parse(playUrl) ?: return emptyList()
        val isShow = mediaType == "tv" || mediaType == "show"
        val type = if (isShow) 2 else 1
        // The library link takes the metadata key as one path segment, so its
        // slashes have to travel as %2F instead of as path separators, and a
        // series sits one level deeper under `unmatched/tv/`.
        val key = Uri.encode(target.key)
        val server = target.machine?.let(Uri::encode)
        val suffix = if (server == null) "" else "&server=$server"
        val forms = mutableListOf<String>()
        if (server != null) {
            forms += "plex://libraries/$server/unmatched/" +
                (if (isShow) "tv/" else "") + key
        }
        forms += "plex://preplay/?metadataKey=$key&metadataType=$type$suffix"
        forms += "plex://play/?metadataKey=$key&metadataType=$type$suffix"
        return forms
    }

    fun formCount(playUrl: String, mediaType: String?): Int = deepLinks(playUrl, mediaType).size

    /**
     * Opens [attempt]'s link form, counting from zero.
     *
     * Plex accepts a `plex://` intent and then lands on its home screen, which is
     * indistinguishable from success: Android reports the hand-off as done. So
     * the caller walks the forms one press at a time and the viewer says which
     * one arrived, instead of guessing here.
     */
    fun open(context: Context, playUrl: String, mediaType: String?, attempt: Int = 0): Launch {
        val resolver = context.packageManager
        // A link that is accepted and then ignored looks exactly like a link that
        // works, so each step is written down: which form was sent, whether any
        // app claimed it, and what startActivity answered. `adb logcat -s
        // DiscovarrPlex` then says more than the screen does.
        Log.i(TAG, "play=$playUrl mediaType=$mediaType")

        val candidates = deepLinks(playUrl, mediaType)
        if (candidates.isNotEmpty()) {
            // The asked-for form first, then the other accepted ones: a form this
            // build of Plex does not route at all is not an answer.
            val start = ((attempt % candidates.size) + candidates.size) % candidates.size
            for (step in candidates.indices) {
                val link = candidates[(start + step) % candidates.size]
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link)).apply {
                    setPackage(PLEX_PACKAGE)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                val handlers = resolver.queryIntentActivities(intent, 0)
                Log.i(TAG, "candidate $link handlers=${handlers.size}")
                if (handlers.isEmpty()) continue
                val started = runCatching { context.startActivity(intent) }
                Log.i(
                    TAG,
                    "started ok=${started.isSuccess} " +
                        "why=${started.exceptionOrNull()?.javaClass?.simpleName ?: "none"}",
                )
                if (started.isSuccess) return Launch.PlexItem
            }
        }

        // This build of Plex does not route that link: open the app rather than
        // pretend nothing happened, so the viewer can find the title by hand.
        val home = resolver.getLaunchIntentForPackage(PLEX_PACKAGE)
        if (home == null) Log.i(TAG, "Plex is not installed")
        home?.let { launch ->
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val started = runCatching { context.startActivity(launch) }
            Log.i(TAG, "fallback to Plex home ok=${started.isSuccess}")
            if (started.isSuccess) return Launch.PlexHome
        }

        val web = Intent(Intent.ACTION_VIEW, Uri.parse(playUrl)).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        if (resolver.queryIntentActivities(web, 0).isNotEmpty() &&
            runCatching { context.startActivity(web) }.isSuccess
        ) {
            return Launch.Browser
        }

        return Launch.None
    }
}
