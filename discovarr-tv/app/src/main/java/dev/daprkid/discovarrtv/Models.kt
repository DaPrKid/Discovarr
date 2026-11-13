package dev.daprkid.discovarrtv

import org.json.JSONArray
import org.json.JSONObject

/**
 * The shapes below mirror exactly what Discovarr's `/api/v1` returns. They are
 * parsed by hand with org.json, which ships with Android: the app has no
 * third-party dependencies beyond the Kotlin and Compose runtimes, so there is
 * no serialization library to keep in step with the server.
 */

/** A nullable string, because `optString` turns JSON null into the text "null". */
internal fun JSONObject.str(key: String): String? =
    if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() && it != "null" }

internal fun JSONObject.longOrNull(key: String): Long? =
    if (isNull(key) || !has(key)) null else optLong(key)

internal fun JSONObject.stringList(key: String): List<String> {
    val array = optJSONArray(key) ?: return emptyList()
    return (0 until array.length()).mapNotNull { index ->
        array.optString(index).takeIf { it.isNotEmpty() }
    }
}

data class User(
    val id: Long,
    val username: String,
    val role: String,
    val permissions: Int,
) {
    val isAdmin: Boolean get() = role == "admin"

    /** Administrators hold every permission, matching the server. */
    fun can(flag: Int): Boolean = isAdmin || (permissions and flag) == flag

    val canManageRequests: Boolean get() = can(Permission.MANAGE_REQUESTS)

    companion object {
        fun from(json: JSONObject) = User(
            id = json.optLong("id"),
            username = json.str("username") ?: "unknown",
            role = json.str("role") ?: "user",
            permissions = json.optInt("permissions"),
        )

        /** Parses the `{ user: {...} }` envelope every auth endpoint returns. */
        fun fromEnvelope(json: JSONObject): User? =
            json.optJSONObject("user")?.let(::from)
    }
}

/**
 * One row of the catalog, a search hit, or the media attached to a request.
 * The same model serves all three because the server sends the same fields;
 * `id` is 0 when a title has not been imported into the library yet.
 */
data class Media(
    val id: Long,
    val tmdbId: Long?,
    val mediaType: String,
    val title: String,
    val overview: String?,
    val releaseDate: String?,
    val posterPath: String?,
    val creators: String?,
    /** Numeric MediaStatus from the server's src/constants.js — not a string. */
    val statusId: Int,
    val genres: List<String>,
    val seasonsCount: Int?,
    val runtime: Int?,
    val activeRequests: Int,
    val myActiveRequests: Int,
    /** True when Plex can play this title right now. */
    val onPlex: Boolean = false,
) {
    val year: String? get() = releaseDate?.take(4)?.takeIf { it.length == 4 }

    /** "Author" for books, "Season count" for shows, runtime for films. */
    val subtitle: String?
        get() = when {
            !creators.isNullOrBlank() -> creators
            mediaType == "tv" && seasonsCount != null && seasonsCount > 0 ->
                if (seasonsCount == 1) "1 season" else "$seasonsCount seasons"
            runtime != null && runtime > 0 -> "${runtime} min"
            else -> null
        }

    val hasActiveRequest: Boolean get() = activeRequests > 0

    /** Fully in the library. A partly-available series can still have seasons to request. */
    val isFullyAvailable: Boolean get() = statusId == MediaStatus.AVAILABLE

    /** AVAILABLE or PARTIALLY_AVAILABLE: something is already here. */
    val isAvailable: Boolean
        get() = isFullyAvailable || statusId == MediaStatus.PARTIALLY_AVAILABLE

    /** PENDING or PROCESSING: a download is already moving through the stack. */
    val isProcessing: Boolean
        get() = statusId == MediaStatus.PENDING || statusId == MediaStatus.PROCESSING

    companion object {
        fun from(json: JSONObject) = Media(
            id = json.optLong("id"),
            tmdbId = json.longOrNull("tmdbId"),
            mediaType = json.str("mediaType") ?: "movie",
            title = json.str("title") ?: "Untitled",
            overview = json.str("overview"),
            releaseDate = json.str("releaseDate"),
            posterPath = json.str("posterPath"),
            creators = json.str("creators"),
            statusId = json.optInt("status"),
            genres = json.stringList("genres"),
            seasonsCount = if (json.isNull("seasonsCount")) null else json.optInt("seasonsCount"),
            runtime = if (json.isNull("runtime")) null else json.optInt("runtime"),
            activeRequests = json.optInt("activeRequests"),
            myActiveRequests = json.optInt("myActiveRequests"),
            onPlex = json.optBoolean("plex") || json.optBoolean("onPlex"),
        )

        fun list(array: JSONArray?): List<Media> {
            if (array == null) return emptyList()
            return (0 until array.length()).mapNotNull { index ->
                array.optJSONObject(index)?.let(::from)
            }
        }
    }
}

data class Season(
    val seasonNumber: Int,
    val name: String,
    val episodeCount: Int,
    val statusId: Int = MediaStatus.UNKNOWN,
    val inLibrary: Boolean = false,
)

/** One episode, as the season partial the browser loads renders it. */
data class Episode(
    val number: Int,
    val name: String,
    val airDate: String?,
    val meta: String?,
    val overview: String?,
)

data class MediaDetail(
    val media: Media,
    val seasons: List<Season>,
    val overview: String?,
) {
    companion object {
        fun from(json: JSONObject): MediaDetail {
            val seasons = json.optJSONArray("seasons")
            val parsed = if (seasons == null) emptyList() else (0 until seasons.length()).mapNotNull { index ->
                seasons.optJSONObject(index)?.let { season ->
                    Season(
                        seasonNumber = season.optInt("seasonNumber"),
                        name = season.str("name") ?: "Season ${season.optInt("seasonNumber")}",
                        episodeCount = season.optInt("episodeCount"),
                        statusId = season.optInt("status", MediaStatus.UNKNOWN),
                        inLibrary = season.optBoolean("inLibrary") || season.optInt("status") == MediaStatus.AVAILABLE,
                    )
                }
            }
            return MediaDetail(
                media = Media.from(json),
                seasons = parsed,
                overview = json.str("overview"),
            )
        }
    }
}

/**
 * What this install actually offers. Sections that are off are never drawn,
 * not drawn empty, so a films-only server shows no empty book shelves.
 */
/** Mirrors MediaStatus in the server's src/constants.js. */
internal object MediaStatus {
    const val UNKNOWN = 1
    const val PENDING = 2
    const val PROCESSING = 3
    const val PARTIALLY_AVAILABLE = 4
    const val AVAILABLE = 5
}

/** Mirrors Permission in the server's src/constants.js. */
internal object Permission {
    const val REQUEST_MOVIE = 1
    const val REQUEST_TV = 2
    const val AUTO_APPROVE = 4
    const val MANAGE_REQUESTS = 8
    const val MANAGE_USERS = 16
    const val MANAGE_SETTINGS = 32
}

/** Mirrors MediaRequestStatus in the server's src/constants.js. */
internal object RequestStatus {
    const val PENDING = 1
    const val APPROVED = 2
    const val DECLINED = 3
    const val FAILED = 4
    const val COMPLETED = 5
}

data class RequestItem(
    val id: Long,
    /** Numeric MediaRequestStatus, the same way Media carries its status. */
    val statusId: Int,
    val note: String?,
    val createdAt: String?,
    val qualityProfileName: String?,
    val media: Media?,
    val seasons: List<Int> = emptyList(),
    val requester: String? = null,
    val requesterId: Long? = null,
) {
    /** Requests are only worth colouring red when they are genuinely stuck. */
    val statusLine: String
        get() = when (statusId) {
            RequestStatus.PENDING -> "Waiting for approval"
            RequestStatus.APPROVED -> "Approved — with the download client"
            RequestStatus.DECLINED -> "Declined"
            RequestStatus.FAILED -> "Failed"
            RequestStatus.COMPLETED -> "Available in the library"
            else -> "Unknown state"
        }

    val isFailed: Boolean
        get() = statusId == RequestStatus.DECLINED || statusId == RequestStatus.FAILED

    val isComplete: Boolean get() = statusId == RequestStatus.COMPLETED

    val isMoving: Boolean get() = statusId == RequestStatus.APPROVED

    companion object {
        fun from(json: JSONObject): RequestItem {
            val seasons = json.optJSONArray("seasons")
            val requester = json.optJSONObject("requester")
            return RequestItem(
                id = json.optLong("id"),
                statusId = json.optInt("status"),
                note = json.str("note"),
                createdAt = json.str("createdAt"),
                qualityProfileName = json.str("qualityProfileName"),
                media = json.optJSONObject("media")?.let(Media::from),
                seasons = if (seasons == null) emptyList() else (0 until seasons.length()).map { seasons.optInt(it) },
                requester = requester?.str("username"),
                requesterId = requester?.longOrNull("id"),
            )
        }

        fun list(json: JSONObject): List<RequestItem> {
            val results = json.optJSONArray("results") ?: return emptyList()
            return (0 until results.length()).mapNotNull { index ->
                results.optJSONObject(index)?.let(::from)
            }
        }
    }
}

/** `/api/v1/health` is unauthenticated, so the setup screen can probe a server. */
data class ServerInfo(
    val version: String,
    val setupRequired: Boolean,
    val tmdb: String,
    val mediaCount: Int,
) {
    companion object {
        fun from(json: JSONObject) = ServerInfo(
            version = json.str("version") ?: "unknown",
            setupRequired = json.optBoolean("setupRequired"),
            tmdb = json.str("tmdb") ?: "offline",
            mediaCount = json.optInt("media"),
        )
    }
}

/** Every failure the client raises carries a message fit for the TV screen. */
class ApiException(val status: Int, message: String) : Exception(message) {
    val isAuthError: Boolean get() = status == 401
}
