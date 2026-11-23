package dev.daprkid.discovarrtv

/**
 * Shapes for the three things Discovarr only renders as HTML: a title page's
 * facts and cast, the watchlist, and the calendar.
 *
 * They exist because the server has no JSON for them: `/api/v1` covers the
 * catalog, search, requests and settings, while the watchlist is a form post and
 * the calendar is a month grid. Rather than change the server, the app reads the
 * page it would otherwise have opened in a browser — which also means the two
 * always agree, because they are literally the same markup.
 */

/** One row of a title page's fact table: "Runtime", "24 min". */
data class Fact(val label: String, val value: String)

data class CastMember(
    val name: String,
    val role: String,
    val photoPath: String?,
    val id: Long = 0,
)

/**
 * Everything the browser's title page shows above the fold.
 *
 * The hidden watchlist form is where the identifiers come from — the page has to
 * carry them so the button can post, and reusing them means a save from the
 * television writes exactly what a save from the browser would.
 */
data class MediaPage(
    val overview: String? = null,
    val tagline: String? = null,
    val meta: String? = null,
    val facts: List<Fact> = emptyList(),
    val cast: List<CastMember> = emptyList(),
    val plexUrl: String? = null,
    val trailerUrl: String? = null,
    val watched: Boolean = false,
    val tmdbId: Long? = null,
    val mediaType: String? = null,
    val title: String? = null,
    val posterPath: String? = null,
    val releaseDate: String? = null,
    /**
     * Season number to episode count, read from the season summaries on the
     * page. The catalog's own season rows can sit at zero until Sonarr has
     * reported the files, and a season that says "0 episodes" next to a show
     * that is on the shelf reads as a bug rather than as a stale sync.
     */
    val seasonCounts: Map<Int, Int> = emptyMap(),
)

/** One saved title, as the watchlist page renders it. */
data class WatchlistEntry(
    val tmdbId: Long,
    val mediaType: String,
    val title: String,
    val meta: String?,
    val posterPath: String?,
    val mediaId: Long? = null,
    val statusId: Int = MediaStatus.UNKNOWN,
    val activeRequests: Int = 0,
)

/** One release on one day of the calendar's agenda. */
data class CalendarEntry(
    val date: String,
    val title: String,
    val mediaType: String,
    /** Set when the title is imported, so the detail page opens by id. */
    val mediaId: Long? = null,
    val tmdbId: Long? = null,
    val inLibrary: Boolean = false,
)

data class CalendarMonth(
    val key: String,
    val label: String,
    val entries: List<CalendarEntry>,
    val previous: String?,
    val next: String?,
)

/**
 * A title the server has not imported yet, standing in for one row of `Media`.
 *
 * A watchlist entry and a calendar entry carry a TMDB id, not a local one, and
 * the title page is addressed the same way the browser addresses it:
 * `/title/<type>/<tmdbId>`. Everything the screen shows for such a row comes
 * from that page, so the placeholder only has to carry the identity.
 */
fun stubMedia(
    tmdbId: Long?,
    mediaType: String,
    title: String,
    posterPath: String? = null,
): Media = Media(
    id = 0,
    tmdbId = tmdbId,
    mediaType = mediaType,
    title = title,
    overview = null,
    releaseDate = null,
    posterPath = posterPath,
    creators = null,
    statusId = MediaStatus.UNKNOWN,
    genres = emptyList(),
    seasonsCount = null,
    runtime = null,
    activeRequests = 0,
    myActiveRequests = 0,
)

/**
 * A device-authorisation pin.
 *
 * [id] and [code] belong to the pin the server itself asked plex.tv for when the
 * television opened `/auth/plex`: a "strong" pin, whose twenty-five character
 * code is meant to travel inside Plex's web authorisation URL rather than in
 * plex.tv/link's four-character box. [authUrl] is that URL, shown on screen as a
 * code for a phone to scan, because a remote control cannot type it. Its forward
 * URL is removed: the television completes the sign-in, not the browser that
 * scanned the code.
 * [serverCookie] is the pin cookie `/auth/plex` set, which the server's callback
 * insists on seeing before it will start a session.
 */
data class PlexPin(
    val id: String,
    val code: String,
    val clientId: String,
    val serverCookie: String,
    val authUrl: String,
)

data class PlexProfile(
    val uuid: String,
    val name: String,
    val protected: Boolean,
)

/**
 * What one poll of `/auth/plex/callback` found.
 *
 * Plex confirms a pin asynchronously, so "still waiting" is a normal answer and
 * not an error: the television shows the code and polls until the household has
 * entered it on a phone.
 */
sealed class PlexPoll {
    object Waiting : PlexPoll()

    /** One profile, or a household with no PINs: already signed in. */
    data class SignedIn(val cookie: String) : PlexPoll()

    /** More than one profile, or a PIN: the picker belongs on the television. */
    data class ChooseProfile(val tokenCookie: String, val profiles: List<PlexProfile>) : PlexPoll()

    data class Failed(val message: String) : PlexPoll()
}
