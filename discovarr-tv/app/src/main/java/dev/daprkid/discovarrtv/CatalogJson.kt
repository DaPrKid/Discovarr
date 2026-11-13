package dev.daprkid.discovarrtv

import org.json.JSONArray
import org.json.JSONObject

/** A named choice from a filter list. Ids stay strings because genres are numbers and sorts are words. */
data class NamedId(val id: String, val name: String)

/** Query for `/api/v1/discover`. Empty filters are left off the URL. */
data class DiscoverSpec(
    val type: String = "all",
    val query: String = "",
    val page: Int = 1,
    val kinds: Set<String> = emptySet(),
    val genres: Set<String> = emptySet(),
    val networks: Set<String> = emptySet(),
    val studios: Set<String> = emptySet(),
    val collections: Boolean = false,
    val sort: String = "popular",
    val rating: String = "",
    val language: String = "",
) {
    fun path(): String {
        val parts = mutableListOf("type=" + urlEncode(type), "page=$page")
        if (query.isNotBlank()) parts += "q=" + urlEncode(query)
        if (kinds.isNotEmpty()) parts += "kind=" + urlEncode(kinds.joinToString(","))
        if (genres.isNotEmpty()) parts += "genre=" + urlEncode(genres.joinToString(","))
        if (networks.isNotEmpty()) parts += "network=" + urlEncode(networks.joinToString("|"))
        if (studios.isNotEmpty()) parts += "studio=" + urlEncode(studios.joinToString("|"))
        if (collections) parts += "collections=1"
        if (sort.isNotBlank() && sort != "popular") parts += "sort=" + urlEncode(sort)
        if (rating.isNotBlank()) parts += "rating=" + urlEncode(rating)
        if (language.isNotBlank()) parts += "lang=" + urlEncode(language)
        return "/api/v1/discover?" + parts.joinToString("&")
    }

    private fun urlEncode(value: String): String = java.net.URLEncoder.encode(value, "UTF-8")
}

data class QualityProfile(
    val index: Int,
    val name: String,
    val profileName: String,
    val isDefault: Boolean,
)

data class WatchGroup(val label: String, val names: List<String>)

data class CollectionPart(
    val tmdbId: Long,
    val title: String,
    val posterPath: String?,
    val releaseDate: String?,
    val state: String?,
    val label: String,
    val blocked: Boolean,
    val current: Boolean,
    val mediaId: Long?,
) {
    fun asMedia(): Media = Media(
        id = mediaId ?: 0L,
        tmdbId = tmdbId,
        mediaType = "movie",
        title = title,
        overview = null,
        releaseDate = releaseDate,
        posterPath = posterPath,
        creators = null,
        statusId = when (state) {
            "library" -> MediaStatus.AVAILABLE
            "requested" -> MediaStatus.PENDING
            else -> MediaStatus.UNKNOWN
        },
        genres = emptyList(),
        seasonsCount = null,
        runtime = null,
        activeRequests = if (state == "requested") 1 else 0,
        myActiveRequests = 0,
    )
}

data class CollectionSide(
    val id: Long,
    val name: String,
    val overview: String,
    val posterPath: String?,
    val parts: List<CollectionPart>,
    val count: Int = parts.size,
)

/** One page of Discover or a filtered browse. */
data class DiscoverPage(
    val source: String,
    val page: Int,
    val totalPages: Int,
    val error: String?,
    val results: List<Media>,
    val collections: List<CollectionSide>,
)

data class Facets(
    val tmdb: Boolean,
    val genres: List<NamedId>,
    val types: List<NamedId>,
    val networks: List<NamedId>,
    val studios: List<NamedId>,
    val sorts: List<NamedId>,
    val ratings: List<NamedId>,
    val languages: List<NamedId>,
)

data class Recommendations(
    val configured: Boolean,
    val reason: String,
    val results: List<Media>,
)

/**
 * A title page. The JSON endpoint is the source of truth; the HTML page is only
 * a fallback for a server that has not been updated yet.
 */
data class TitleView(
    val media: Media,
    val overview: String?,
    val tagline: String?,
    val meta: String?,
    val facts: List<Fact>,
    val cast: List<CastMember>,
    val plexUrl: String?,
    val plexLibrary: String?,
    val trailerUrl: String?,
    val watched: Boolean,
    val seasons: List<Season>,
    val profiles: List<QualityProfile>,
    val quotaUsed: Int,
    val quotaLimit: Int,
    val inLibrary: Boolean,
    val blocked: Boolean,
    val blockReason: String?,
    val canRequest: Boolean,
    val collection: CollectionSide?,
    val watch: List<WatchGroup>,
) {
    /** The hidden-field shape the older watchlist form post still wants. */
    fun asPage(): MediaPage = MediaPage(
        overview = overview,
        tagline = tagline,
        meta = meta,
        facts = facts,
        cast = cast,
        plexUrl = plexUrl,
        trailerUrl = trailerUrl,
        watched = watched,
        tmdbId = media.tmdbId,
        mediaType = media.mediaType,
        title = media.title,
        posterPath = media.posterPath,
        releaseDate = media.releaseDate,
        seasonCounts = seasons.associate { it.seasonNumber to it.episodeCount },
    )
}

data class PersonPage(
    val id: Long,
    val name: String,
    val biography: String,
    val profilePath: String?,
    val facts: List<Fact>,
    val page: Int,
    val totalPages: Int,
    val credits: List<Media>,
)

data class AppNotification(
    val id: Long,
    val kind: String,
    val title: String,
    val body: String,
    val href: String?,
    val read: Boolean,
    val createdAt: String?,
)

data class ActivityView(
    val canManage: Boolean,
    val maxAttempts: Int,
    val waiting: List<RequestItem>,
    val exhausted: List<RequestItem>,
    val queue: List<QueueService>,
)

data class QueueService(
    val label: String,
    val error: String?,
    val items: List<QueueItem>,
)

data class QueueItem(
    val title: String,
    val status: String,
    val progress: Int?,
    val eta: String?,
)

internal fun JSONObject.namedList(key: String): List<NamedId> {
    val array = optJSONArray(key) ?: return emptyList()
    return (0 until array.length()).mapNotNull { index ->
        val row = array.optJSONObject(index) ?: return@mapNotNull null
        val id = when (val raw = row.opt("id")) {
            is Number -> raw.toLong().toString()
            else -> row.optString("id")
        }
        if (id.isBlank()) null else NamedId(id, row.str("name") ?: id)
    }
}

internal fun JSONArray.mediaList(): List<Media> =
    (0 until length()).mapNotNull { index -> optJSONObject(index)?.let(Media::from) }

internal fun JSONObject.collectionPart(): CollectionPart? {
    val tmdbId = longOrNull("tmdbId") ?: return null
    return CollectionPart(
        tmdbId = tmdbId,
        title = str("title") ?: "Untitled",
        posterPath = str("posterPath"),
        releaseDate = str("releaseDate"),
        state = str("state"),
        label = str("label").orEmpty(),
        blocked = optBoolean("blocked"),
        current = optBoolean("current"),
        mediaId = longOrNull("mediaId"),
    )
}

internal fun JSONObject.collectionSide(): CollectionSide? {
    val id = longOrNull("id") ?: return null
    val parts = optJSONArray("parts")
    return CollectionSide(
        id = id,
        name = str("name") ?: "Collection",
        overview = str("overview").orEmpty(),
        posterPath = str("posterPath"),
        parts = if (parts == null) emptyList() else (0 until parts.length()).mapNotNull { parts.optJSONObject(it)?.collectionPart() },
        count = optInt("count").takeIf { it > 0 } ?: (if (parts == null) 0 else parts.length()),
    )
}

fun titleView(json: JSONObject): TitleView {
    val media = json.optJSONObject("media")?.let(Media::from)
        ?: throw ApiException(500, "The server sent an unreadable title")
    val facts = json.optJSONArray("facts")
    val cast = json.optJSONArray("cast")
    val seasons = json.optJSONArray("seasons")
    val profiles = json.optJSONArray("profiles")
    val quota = json.optJSONObject("quota")
    val plex = json.optJSONObject("plex")
    val watch = json.optJSONObject("watch")?.optJSONArray("groups")
    return TitleView(
        media = media,
        overview = json.str("overview"),
        tagline = json.str("tagline"),
        meta = json.str("meta"),
        facts = if (facts == null) emptyList() else (0 until facts.length()).mapNotNull { index ->
            facts.optJSONObject(index)?.let { Fact(it.str("label").orEmpty(), it.str("value").orEmpty()) }
        }.filter { it.label.isNotBlank() && it.value.isNotBlank() },
        cast = if (cast == null) emptyList() else (0 until cast.length()).mapNotNull { index ->
            cast.optJSONObject(index)?.let { member ->
                CastMember(
                    id = member.optLong("id"),
                    name = member.str("name") ?: return@let null,
                    role = member.str("character") ?: member.str("role").orEmpty(),
                    photoPath = member.str("photoPath"),
                )
            }
        },
        plexUrl = plex?.str("playUrl"),
        plexLibrary = plex?.str("library"),
        trailerUrl = json.optJSONObject("trailer")?.str("url"),
        watched = json.optBoolean("watched"),
        seasons = if (seasons == null) emptyList() else (0 until seasons.length()).mapNotNull { index ->
            seasons.optJSONObject(index)?.let { season ->
                Season(
                    seasonNumber = season.optInt("seasonNumber"),
                    name = season.str("name") ?: "Season ${season.optInt("seasonNumber")}",
                    episodeCount = season.optInt("episodeCount"),
                    statusId = season.optInt("status", MediaStatus.UNKNOWN),
                    inLibrary = season.optBoolean("inLibrary"),
                )
            }
        },
        profiles = if (profiles == null) emptyList() else (0 until profiles.length()).mapNotNull { index ->
            profiles.optJSONObject(index)?.let { profile ->
                QualityProfile(
                    index = profile.optInt("index", index),
                    name = profile.str("name") ?: "Profile ${index + 1}",
                    profileName = profile.str("profileName").orEmpty(),
                    isDefault = profile.optBoolean("isDefault"),
                )
            }
        },
        quotaUsed = quota?.optInt("used") ?: 0,
        quotaLimit = quota?.optInt("limit") ?: 0,
        inLibrary = json.optBoolean("inLibrary"),
        blocked = json.optBoolean("blocked"),
        blockReason = json.str("blockReason"),
        canRequest = json.optBoolean("canRequest"),
        collection = json.optJSONObject("collection")?.collectionSide(),
        watch = if (watch == null) emptyList() else (0 until watch.length()).mapNotNull { index ->
            watch.optJSONObject(index)?.let { group ->
                val providers = group.optJSONArray("providers")
                WatchGroup(
                    label = group.str("label") ?: "Watch",
                    names = if (providers == null) emptyList() else (0 until providers.length()).mapNotNull {
                        providers.optJSONObject(it)?.str("name")
                    },
                )
            }
        }.filter { it.names.isNotEmpty() },
    )
}

fun titleViewFromPage(page: MediaPage, item: Media): TitleView {
    val fullyHere = item.isFullyAvailable || page.plexUrl != null
    val blocked = !fullyHere && item.activeRequests > 0
    return TitleView(
        media = item.copy(
            tmdbId = page.tmdbId ?: item.tmdbId,
            title = page.title ?: item.title,
            overview = page.overview ?: item.overview,
            posterPath = page.posterPath ?: item.posterPath,
            releaseDate = page.releaseDate ?: item.releaseDate,
            mediaType = page.mediaType ?: item.mediaType,
        ),
        overview = page.overview,
        tagline = page.tagline,
        meta = page.meta,
        facts = page.facts,
        cast = page.cast,
        plexUrl = page.plexUrl,
        plexLibrary = null,
        trailerUrl = page.trailerUrl,
        watched = page.watched,
        seasons = page.seasonCounts.entries.sortedBy { it.key }.map { (number, count) ->
            Season(number, "Season $number", count)
        },
        profiles = emptyList(),
        quotaUsed = 0,
        quotaLimit = 0,
        inLibrary = fullyHere,
        blocked = blocked,
        blockReason = if (blocked) "Requested in Discovarr" else null,
        canRequest = !fullyHere && !blocked,
        collection = null,
        watch = emptyList(),
    )
}

/** Lets the parsers live next to the type without a companion object of their own. */
fun discoverPage(json: JSONObject): DiscoverPage {
    val collections = json.optJSONArray("collections")
    return DiscoverPage(
        source = json.str("source") ?: "local",
        page = json.optInt("page", 1),
        totalPages = json.optInt("totalPages", 1),
        error = json.str("error"),
        results = json.optJSONArray("results")?.mediaList().orEmpty(),
        collections = if (collections == null) emptyList() else (0 until collections.length()).mapNotNull {
            collections.optJSONObject(it)?.collectionSide()
        },
    )
}

fun facets(json: JSONObject) = Facets(
    tmdb = json.optBoolean("tmdb"),
    genres = json.namedList("genres"),
    types = json.namedList("types"),
    networks = json.namedList("networks"),
    studios = json.namedList("studios"),
    sorts = json.namedList("sorts"),
    ratings = json.namedList("ratings"),
    languages = json.namedList("languages"),
)

fun recommendations(json: JSONObject) = Recommendations(
    configured = json.optBoolean("configured"),
    reason = json.str("reason").orEmpty(),
    results = json.optJSONArray("results")?.mediaList().orEmpty(),
)

fun personPage(json: JSONObject) = PersonPage(
    id = json.optLong("id"),
    name = json.str("name") ?: "Unknown",
    biography = json.str("biography").orEmpty(),
    profilePath = json.str("profilePath"),
    facts = json.optJSONArray("facts")?.let { facts ->
        (0 until facts.length()).mapNotNull { index ->
            facts.optJSONObject(index)?.let { Fact(it.str("label").orEmpty(), it.str("value").orEmpty()) }
        }
    }.orEmpty(),
    page = json.optInt("page", 1),
    totalPages = json.optInt("totalPages", 1),
    credits = json.optJSONArray("credits")?.mediaList().orEmpty(),
)

fun calendarMonth(json: JSONObject): CalendarMonth {
    val days = json.optJSONArray("days")
    val entries = mutableListOf<CalendarEntry>()
    if (days != null) {
        for (index in 0 until days.length()) {
            val day = days.optJSONObject(index) ?: continue
            val date = day.str("date") ?: continue
            val rows = day.optJSONArray("entries") ?: continue
            for (rowIndex in 0 until rows.length()) {
                val row = rows.optJSONObject(rowIndex) ?: continue
                entries += CalendarEntry(
                    date = date,
                    title = row.str("title") ?: continue,
                    mediaType = row.str("mediaType") ?: "movie",
                    mediaId = row.longOrNull("mediaId"),
                    tmdbId = row.longOrNull("tmdbId"),
                    inLibrary = row.optBoolean("inLibrary"),
                )
            }
        }
    }
    return CalendarMonth(
        key = json.str("key").orEmpty(),
        label = json.str("label").orEmpty(),
        entries = entries,
        previous = json.str("previous"),
        next = json.str("next"),
    )
}

fun notifications(json: JSONObject): Pair<Int, List<AppNotification>> {
    val rows = json.optJSONArray("results")
    val items = if (rows == null) emptyList() else (0 until rows.length()).mapNotNull { index ->
        rows.optJSONObject(index)?.let { row ->
            AppNotification(
                id = row.optLong("id"),
                kind = row.str("kind").orEmpty(),
                title = row.str("title") ?: "Update",
                body = row.str("body").orEmpty(),
                href = row.str("href"),
                read = row.optBoolean("read"),
                createdAt = row.str("createdAt"),
            )
        }
    }
    return json.optInt("unread") to items
}

fun activityView(json: JSONObject): ActivityView {
    val queue = json.optJSONArray("queue")
    return ActivityView(
        canManage = json.optBoolean("canManage"),
        maxAttempts = json.optInt("maxAttempts", 3),
        waiting = RequestItem.list(JSONObject().put("results", json.optJSONArray("waiting") ?: JSONArray())),
        exhausted = RequestItem.list(JSONObject().put("results", json.optJSONArray("exhausted") ?: JSONArray())),
        queue = if (queue == null) emptyList() else (0 until queue.length()).mapNotNull { index ->
            queue.optJSONObject(index)?.let { service ->
                val items = service.optJSONArray("items")
                QueueService(
                    label = service.str("label") ?: "Queue",
                    error = service.str("error"),
                    items = if (items == null) emptyList() else (0 until items.length()).mapNotNull { itemIndex ->
                        items.optJSONObject(itemIndex)?.let { item ->
                            QueueItem(
                                title = item.str("title") ?: "Unknown",
                                status = item.str("status") ?: "",
                                progress = if (item.isNull("progress")) null else item.optInt("progress"),
                                eta = item.str("eta"),
                            )
                        }
                    },
                )
            }
        },
    )
}

fun episodesFromJson(json: JSONObject): List<Episode> {
    val rows = json.optJSONArray("episodes") ?: return emptyList()
    return (0 until rows.length()).mapNotNull { index ->
        rows.optJSONObject(index)?.let { row ->
            Episode(
                number = row.optInt("number"),
                name = row.str("name") ?: "Episode",
                airDate = row.str("airDate"),
                meta = row.str("meta"),
                overview = row.str("overview"),
            )
        }
    }
}
