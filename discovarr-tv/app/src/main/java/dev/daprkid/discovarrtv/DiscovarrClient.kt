package dev.daprkid.discovarrtv

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Talks to Discovarr's existing `/api/v1` surface over plain HttpURLConnection.
 *
 * There is no HTTP library here on purpose: the only thing the app needs beyond
 * the platform is JSON, which Android already ships. That keeps the APK small
 * and means an Unraid user can build it offline after the first Gradle run.
 *
 * Sign-in works two ways, matching what the server accepts:
 *  - username/password, which returns a `discovarr_session` cookie. Android has
 *    no browser cookie jar, so the value is read out of Set-Cookie and sent
 *    back as a header, and it is persisted by [ServerStore] to survive restarts.
 *  - a personal API token, sent as `Authorization: Bearer`, for setups where
 *    typing a password on a D-pad remote is unwanted.
 */
class DiscovarrClient(
    baseUrl: String,
    private val session: String? = null,
    private val token: String? = null,
) {
    /** Normalised once so every call site can just append a path. */
    val baseUrl: String = normalise(baseUrl)

    // ---------------------------------------------------------------------
    // Auth
    // ---------------------------------------------------------------------

    suspend fun health(): ServerInfo = ServerInfo.from(get("/api/v1/health"))

    /**
     * Returns the new session cookie on success. The password never leaves this
     * call and is not retained anywhere.
     */
    suspend fun login(username: String, password: String): LoginResult {
        val body = JSONObject().put("username", username).put("password", password)
        val response = execute("POST", "/api/v1/auth/login", body)

        if (response.status !in 200..299) {
            throw ApiException(
                response.status,
                errorMessage(response.body) ?: "Incorrect username or password",
            )
        }

        val cookie = sessionFrom(response.headers["set-cookie"].orEmpty().firstOrNull())
            ?: throw ApiException(500, "The server signed in but sent no session cookie")

        val user = User.fromEnvelope(JSONObject(response.body))
            ?: throw ApiException(500, "The server sent an unreadable account")

        return LoginResult(user = user, session = cookie)
    }

    suspend fun me(): User {
        val user = User.fromEnvelope(get("/api/v1/auth/me"))
        return user ?: throw ApiException(500, "The server sent an unreadable account")
    }

    suspend fun logout() {
        runCatching { execute("POST", "/api/v1/auth/logout", JSONObject()) }
    }

    /**
     * Whether this server offers "sign in with Plex".
     *
     * `plex.login` is a setting and settings need MANAGE_SETTINGS, so the login
     * page itself is the reliable public answer: it renders the Plex link only
     * when the option is on. Never throws — an unreachable page just means the
     * button is not offered.
     */
    suspend fun plexLoginAvailable(): Boolean =
        runCatching { execute("GET", "/login", null).body.contains("/auth/plex") }.getOrDefault(false)

    /**
     * Whether the books half of the app applies at all.
     *
     * Administrators can read `services.readarr.enabled` straight from the
     * settings API. Everyone else cannot, and needs no special case: if the
     * server holds no books and no audiobooks, there is nothing to show either
     * way, and the app behaves exactly as it did before books existed.
     */
    suspend fun booksEnabled(): Boolean {
        val settings = runCatching { get("/api/v1/settings").optJSONObject("settings") }.getOrNull()
        if (settings != null) {
            return settings.str("services.readarr.enabled")?.equals("true", ignoreCase = true) == true
        }
        return runCatching {
            media("book").isNotEmpty() || media("audiobook").isNotEmpty()
        }.getOrDefault(false)
    }

    // ---------------------------------------------------------------------
    // Catalog
    // ---------------------------------------------------------------------

    /** One shelf's worth of titles. `type` is movie, tv, book, audiobook or all. */
    suspend fun media(type: String, query: String = ""): List<Media> {
        val path = buildString {
            append("/api/v1/media?type=").append(encode(type))
            if (query.isNotBlank()) append("&q=").append(encode(query))
        }
        return Media.list(get(path).optJSONArray("results"))
    }

    suspend fun mediaDetail(id: Long): MediaDetail = MediaDetail.from(get("/api/v1/media/$id"))

    suspend fun search(query: String, type: String = "all"): List<Media> {
        if (query.isBlank()) return emptyList()
        val path = "/api/v1/search?query=${encode(query)}&type=${encode(type)}"
        return Media.list(get(path).optJSONArray("results"))
    }

    suspend fun requests(): List<RequestItem> =
        RequestItem.list(get("/api/v1/request?filter=all&page=1&take=50"))

    /**
     * Creates a request. Titles already in the library go by `mediaId`; a search
     * hit the server has not imported yet goes by type and id, and the server
     * imports it first. Both shapes are accepted by the same endpoint.
     */
    suspend fun request(item: Media, seasons: List<Int>? = null): RequestItem {
        val body = JSONObject()
        if (item.id > 0) {
            body.put("mediaId", item.id)
        } else {
            body.put("mediaType", item.mediaType)
            item.tmdbId?.let { body.put("tmdbId", it) }
        }
        if (!seasons.isNullOrEmpty()) {
            body.put("seasons", JSONArray(seasons))
        }

        val response = execute("POST", "/api/v1/request", body)
        if (response.status !in 200..299) {
            throw ApiException(response.status, errorMessage(response.body) ?: "The request was refused")
        }
        val created = JSONObject(response.body).optJSONObject("request")
        return created?.let(RequestItem::from) ?: throw ApiException(500, "The server sent an unreadable request")
    }

    /** Artwork is public, so posters load whether or not a session exists. */
    fun resolveImage(path: String?): String? {
        val value = path?.trim().orEmpty()
        return when {
            value.isEmpty() -> null
            // Book covers are absolute covers.openlibrary.org URLs.
            value.startsWith("http://") || value.startsWith("https://") -> value
            else -> baseUrl + "/img/w342/" + value.trimStart('/')
        }
    }

    // ---------------------------------------------------------------------
    // Pages the server renders but never serves as JSON
    // ---------------------------------------------------------------------

    /**
     * The account's theme, read from the `data-theme` the server paints into
     * every page. The browser stores it on the account, so this is simply the
     * same answer the browser would get. Null when the app cannot tell.
     */
    suspend fun accountTheme(): String? = runCatching {
        Html.first(page("/"), "<html[^>]*data-theme=\"([a-z]+)\"")
    }.getOrNull()

    /** Saves the theme on the account, exactly as the web picker does. */
    suspend fun saveTheme(name: String) {
        runCatching {
            request(
                "POST",
                "/account/theme",
                body = "theme=" + encode(name),
                contentType = "application/x-www-form-urlencoded",
            )
        }
    }

    suspend fun page(path: String): String = request("GET", path, accept = "text/html").body

    /**
     * A title page, whether or not the server has imported the title yet.
     *
     * `/media/<id>` and `/title/<type>/<tmdbId>` render the same sections, so a
     * search hit that has never been requested shows the same overview, facts,
     * cast and Plex link as one already in the library.
     */
    suspend fun mediaPage(item: Media): MediaPage {
        val path = if (item.id > 0) {
            "/media/${item.id}"
        } else {
            "/title/${item.mediaType}/${item.tmdbId ?: 0}"
        }
        return mediaPageAt(path)
    }

    private suspend fun mediaPageAt(path: String): MediaPage {
        val html = page(path)
        val watchForm = Html.first(html, "<form method=\"post\" action=\"/watchlist/toggle\"[^>]*>(.*?)</form>")
        val fields = watchForm?.let(Html::hiddenFields).orEmpty()

        val facts = Html.all(html, "<div class=\"fact\"><dt>(.*?)</dt><dd>(.*?)</dd></div>")
            .map { match -> Fact(Html.text(match.groupValues[1]), Html.text(match.groupValues[2])) }
            .filter { it.label.isNotBlank() && it.value.isNotBlank() }

        val cast = Html.all(html, "<a class=\"cast\" href=\"/person/\\d+\">(.*?)</a>")
            .mapNotNull { match ->
                val block = match.groupValues[1]
                val name = Html.firstText(block, "<strong>(.*?)</strong>") ?: return@mapNotNull null
                CastMember(
                    name = name,
                    role = Html.firstText(block, "<span class=\"muted small\">(.*?)</span>").orEmpty(),
                    photoPath = Html.attribute(block, "src"),
                )
            }
            .take(20)

        // Every season row prints "<name>" and "<n> episodes" side by side, and
        // those counts come from TMDB rather than from the catalog, which is why
        // they are right while the catalog's own rows still say zero.
        val seasonCounts = Html.all(
            html,
            "<summary>\\s*<span>(.*?)</span>\\s*<span class=\"muted small\">(.*?)</span>",
        ).mapNotNull { match ->
            val name = Html.text(match.groupValues[1])
            val label = Html.text(match.groupValues[2])
            val number = Regex("(\\d+)").find(name)?.groupValues?.get(1)?.toIntOrNull()
            val episodes = Regex("(\\d+)").find(label)?.groupValues?.get(1)?.toIntOrNull()
            if (number != null && episodes != null && episodes > 0) number to episodes else null
        }.toMap()

        return MediaPage(
            overview = Html.firstText(html, "<p class=\"overview\">(.*?)</p>"),
            tagline = Html.firstText(html, "<p class=\"tagline\">(.*?)</p>"),
            meta = Html.firstText(html, "<p class=\"media-meta\">(.*?)</p>"),
            facts = facts,
            cast = cast,
            plexUrl = Html.first(html, "href=\"(https://app\\.plex\\.tv[^\"]*)\"")
                ?.replace("&amp;", "&"),
            trailerUrl = Html.first(
                html,
                "<a class=\"btn btn-sm btn-ghost\" href=\"([^\"]+)\"[^>]*>\\u25b6 Watch trailer",
            )?.replace("&amp;", "&"),
            watched = html.contains("Saved to your watchlist"),
            tmdbId = fields["tmdbId"]?.toLongOrNull(),
            mediaType = fields["mediaType"],
            title = fields["title"],
            posterPath = fields["posterPath"]?.takeIf { it.isNotBlank() },
            releaseDate = fields["releaseDate"]?.takeIf { it.isNotBlank() },
            seasonCounts = seasonCounts,
        )
    }

    // ---------------------------------------------------------------------
    // What the browser's search box and season lists already use
    // ---------------------------------------------------------------------

    /**
     * Names as they are typed, from the endpoint behind the web's own search
     * field. It answers with the artwork and whether the library already holds
     * the title, which is more than the full search's JSON carries.
     */
    suspend fun suggest(query: String, type: String = "all"): List<Media> {
        val text = query.trim()
        if (text.length < 2) return emptyList()
        val json = runCatching {
            get("/search/suggest?q=" + encode(text) + "&type=" + encode(type))
        }.getOrNull() ?: return emptyList()

        val array = json.optJSONArray("results") ?: return emptyList()
        return (0 until array.length()).mapNotNull { index ->
            val row = array.optJSONObject(index) ?: return@mapNotNull null
            val href = row.str("href").orEmpty()
            val meta = row.str("meta").orEmpty()
            val mediaType = when {
                href.contains("/title/") -> href.substringAfter("/title/").substringBefore("/")
                meta.startsWith("Series") -> "tv"
                else -> "movie"
            }

            Media(
                id = Regex("/media/(\\d+)").find(href)?.groupValues?.get(1)?.toLongOrNull() ?: 0L,
                tmdbId = Regex("/title/[a-z]+/(\\d+)").find(href)?.groupValues?.get(1)?.toLongOrNull(),
                mediaType = mediaType,
                title = row.str("title") ?: "Untitled",
                overview = null,
                releaseDate = Regex("(19|20)\\d{2}").find(meta)?.value,
                posterPath = row.str("posterPath"),
                creators = null,
                statusId = if (row.optBoolean("available")) MediaStatus.AVAILABLE else MediaStatus.UNKNOWN,
                genres = emptyList(),
                seasonsCount = null,
                runtime = null,
                activeRequests = 0,
                myActiveRequests = 0,
            )
        }
    }

    /**
     * A poster for a row the library imported without artwork.
     *
     * The server renders a title's page with TMDB's poster even when the stored
     * row has none, so the page is asked for the one `img` it draws. Library
     * rows already have a page of their own; a search hit has its `/title` page.
     * Asked once per title and remembered, because a shelf would otherwise make
     * the same request every time it scrolled back into view.
     */
    suspend fun posterFor(item: Media): String? {
        val key = listOf(item.mediaType, item.id, item.tmdbId, item.title).joinToString("|")
        synchronized(posterLock) { if (posterCache.containsKey(key)) return posterCache[key] }

        val pattern = "<img[^>]+src=\"(/img/[^\"]+)\""
        var found: String? = null
        if (item.id > 0) {
            found = runCatching { Html.first(page("/media/${item.id}"), pattern) }
                .getOrNull()?.let(::absolute)
        }
        if (found == null && item.tmdbId != null && item.mediaType != "book" && item.mediaType != "audiobook") {
            found = runCatching { Html.first(page("/title/${item.mediaType}/${item.tmdbId}"), pattern) }
                .getOrNull()?.let(::absolute)
        }
        if (found == null) {
            val title = item.title.trim()
            val exact = suggest(title, item.mediaType)
                .firstOrNull { it.title.trim().equals(title, ignoreCase = true) }
            found = exact?.posterPath?.let(::resolveImage)
        }

        synchronized(posterLock) { posterCache[key] = found }
        return found
    }

    /**
     * One season's episodes, from the partial the browser's season rows open.
     *
     * The catalog keeps a count per season and no episodes at all, so this is
     * the only place the actual list exists — the same list the browser shows
     * when a season is expanded.
     */
    suspend fun episodes(tmdbId: Long, seasonNumber: Int): List<Episode> {
        if (tmdbId <= 0) return emptyList()
        val html = page("/partial/tv/$tmdbId/season/$seasonNumber")
        return Html.all(html, "<article class=\"episode\">(.*?)</article>").mapNotNull { match ->
            val block = match.groupValues[1]
            val head = Html.firstText(block, "<strong>(.*?)</strong>") ?: return@mapNotNull null
            val number = Regex("^(\\d+)").find(head)?.groupValues?.get(1)?.toIntOrNull() ?: 0
            Episode(
                number = number,
                name = head.replaceFirst(Regex("^\\d+\\.\\s*"), "").ifBlank { head },
                airDate = null,
                meta = Html.firstText(block, "<span class=\"muted small\">(.*?)</span>"),
                overview = Html.firstText(block, "<p class=\"episode-overview\">(.*?)</p>"),
            )
        }
    }

    /** The title's own page address, so a "Play on Plex" link never guesses. */
    suspend fun plexPlayUrl(mediaId: Long): String? = runCatching {
        Html.first(page("/media/$mediaId"), "href=\"(https://app\\.plex\\.tv[^\"]*)\"")
            ?.replace("&amp;", "&")
    }.getOrNull()

    // ---------------------------------------------------------------------
    // Watchlist
    // ---------------------------------------------------------------------

    suspend fun watchlist(): List<WatchlistEntry> {
        val html = page("/watchlist")
        return html.split("<div class=\"watch-row\">").drop(1).mapNotNull { row ->
            val title = Html.firstText(row, "<a class=\"media-title\"[^>]*>(.*?)</a>") ?: return@mapNotNull null
            val fields = Html.hiddenFields(row.substringBefore("</form>"))
            val tmdbId = fields["tmdbId"]?.toLongOrNull() ?: return@mapNotNull null
            WatchlistEntry(
                tmdbId = tmdbId,
                mediaType = fields["mediaType"] ?: "movie",
                title = title,
                meta = Html.firstText(row, "<p class=\"media-meta\">(.*?)</p>"),
                posterPath = Html.attribute(row, "src")?.let(::absolute)?.let { it },
            )
        }
    }

    /**
     * Saves or removes a title. The browser posts a form; so does this.
     *
     * A personal API token cannot be used for this, because the endpoint is a
     * form handler rather than part of `/api/v1`; it needs the session cookie
     * the sign-in already stored.
     */
    suspend fun toggleWatchlist(page: MediaPage, returnTo: String = "/watchlist"): Boolean {
        val tmdbId = page.tmdbId ?: throw ApiException(400, "This title has no TMDB id to save")
        val fields = linkedMapOf(
            "tmdbId" to tmdbId.toString(),
            "mediaType" to (page.mediaType ?: "movie"),
            "title" to (page.title ?: ""),
            "posterPath" to (page.posterPath ?: ""),
            "releaseDate" to (page.releaseDate ?: ""),
            "returnTo" to returnTo,
        )
        val response = request(
            "POST",
            "/watchlist/toggle",
            body = fields.entries.joinToString("&") { (key, value) -> encode(key) + "=" + encode(value) },
            contentType = "application/x-www-form-urlencoded",
            followRedirects = false,
        )
        if (response.status !in 200..399) {
            throw ApiException(response.status, errorMessage(response.body) ?: "The watchlist refused the change")
        }

        // Read back rather than assume: the page is the source of truth, and the
        // endpoint toggles, so the direction depends on what was there before.
        val path = if (page.mediaType == "tv" || page.mediaType == "movie") {
            "/title/${page.mediaType}/$tmdbId"
        } else {
            "/watchlist"
        }
        val after = runCatching { mediaPageAt(path) }.getOrNull()
        return after?.watched ?: (response.status in 300..399)
    }

    // ---------------------------------------------------------------------
    // Calendar
    // ---------------------------------------------------------------------

    suspend fun calendar(month: String? = null): CalendarMonth {
        val path = if (month.isNullOrBlank()) "/calendar" else "/calendar?month=" + encode(month)
        val html = page(path)

        val links = Html.all(html, "href=\"/calendar\\?month=([0-9]{4}-[0-9]{2})\"")
            .map { it.groupValues[1] }
            .distinct()

        // The agenda underneath the month grid, day by day: each day heading is
        // a <time>, and the releases for that day follow it.
        val entries = mutableListOf<CalendarEntry>()
        val days = Html.all(html, "<time datetime=\"([0-9]{4}-[0-9]{2}-[0-9]{2})\"")
        val agenda = html.substringAfter("<ol class=\"cal-agenda\">", html)

        for ((index, day) in days.withIndex()) {
            val from = agenda.indexOf(day.value).takeIf { it >= 0 } ?: continue
            val until = days.getOrNull(index + 1)?.let { agenda.indexOf(it.value) }.let { next ->
                if (next != null && next > from) next else agenda.length
            }
            val block = agenda.substring(from, until)
            Html.all(block, "href=\"(/media/\\d+|/title/[a-z]+/\\d+)\"[^>]*>(.*?)</a>").forEach { link ->
                val href = link.groupValues[1]
                val title = Html.text(link.groupValues[2])
                if (title.isNotBlank()) {
                    entries += CalendarEntry(
                        date = day.groupValues[1],
                        title = title,
                        mediaType = if (href.contains("/title/tv/")) "tv" else "movie",
                        mediaId = Regex("/media/(\\d+)").find(href)?.groupValues?.get(1)?.toLongOrNull(),
                        tmdbId = Regex("/title/[a-z]+/(\\d+)").find(href)?.groupValues?.get(1)?.toLongOrNull(),
                        inLibrary = href.startsWith("/media/"),
                    )
                }
            }
        }

        val label = Html.firstText(html, "<h1>Calendar</h1>[\\s\\S]*?<p class=\"muted\">(.*?)</p>")
            ?.substringAfter("in ")?.substringBefore(" \u2014")
            ?: month.orEmpty()

        return CalendarMonth(
            key = month ?: "",
            label = label,
            entries = entries.distinctBy { it.date + it.title },
            previous = links.firstOrNull(),
            next = links.lastOrNull(),
        )
    }

    // ---------------------------------------------------------------------
    // Plex sign-in, done on the television
    // ---------------------------------------------------------------------

    /**
     * Starts Plex's device authorisation, with a code plex.tv/link accepts.
     *
     * `/auth/plex` proves the server offers Plex sign-in and leaves the pin
     * cookie its callback insists on, but that pin is a "strong" one: plex.tv
     * gives those a twenty-five character code, because they are meant to travel
     * inside a browser URL. plex.tv/link has a four-character field, so the
     * television asks plex.tv for a plain pin of its own, shows that code, and
     * then hands the confirmed account token to the server's callback — the same
     * `authToken` parameter Plex appends when it forwards a browser back.
     */
    suspend fun plexStart(clientId: String): PlexPin {
        val gate = request("GET", "/auth/plex", followRedirects = false, accept = "text/html")
        val redirect = gate.headers["location"].orEmpty().firstOrNull().orEmpty()
        if (redirect.contains("/login")) {
            throw ApiException(400, "Signing in with Plex is turned off on this server")
        }

        val stored = gate.headers["set-cookie"].orEmpty().firstNotNullOfOrNull { header ->
            Regex("discovarr_plex_pin=([^;]+)").find(header)?.groupValues?.get(1)
        } ?: throw ApiException(400, "This server does not offer Plex sign-in")

        // The pin the server just made is a strong one: its code is twenty-five
        // characters, because it belongs inside Plex's web authorisation URL and
        // not in plex.tv/link's four-character box. That is the pin worth using,
        // because plex.tv refuses a token from a plain pin on its own account API
        // — `HTTP 401` from `/api/v2/user` and from `/api/v2/home/users`, which is
        // the profile call this server makes next. So the television rides the
        // server's pin and hands it the full token the browser flow produces.
        val decoded = runCatching { java.net.URLDecoder.decode(stored, "UTF-8") }.getOrDefault(stored)
        val pinId = decoded.substringBefore(":")
        val pinCode = decoded.substringAfter(":", "")
        if (pinId.isBlank() || pinCode.isBlank()) {
            throw ApiException(400, "This server does not offer Plex sign-in")
        }

        // The phone must not be pulled into the web application. Plex's
        // authorisation page takes a forward URL, and the one on this code was
        // written for the server's own browser callback: scanning it signed the
        // *phone* in and left the television waiting, which is exactly what was
        // reported. The pin is the only part that matters, so the forward URL
        // comes off the code, the phone stops at Plex's "close this window"
        // page, and the television drives the rest through the server.
        val authUrl = redirect
            .replace(Regex("([?&#])forwardUrl=[^&]*"), "$1")
            .trimEnd('?', '&', '#')

        return PlexPin(
            id = pinId,
            code = pinCode,
            clientId = clientId,
            serverCookie = stored,
            authUrl = authUrl,
        )
    }

    /**
     * One poll of plex.tv for the pin, then one hand-over to the server.
     *
     * Waiting is the normal answer until somebody has entered the code on a
     * phone, so it is not an error and must not end the loop.
     */
    suspend fun plexPoll(pin: PlexPin): PlexPoll = try {
        plexCallback(pin)
    } catch (error: ApiException) {
        // A dropped connection is not a verdict on the sign-in: the screen is
        // already saying "waiting", and the next poll is two seconds away.
        if (error.status == 0) PlexPoll.Waiting
        else PlexPoll.Failed(error.message ?: "Plex sign-in could not be completed")
    }

    /**
     * Asks the server's own callback where this pin stands.
     *
     * This is the browser's path with the browser taken out. The server made the
     * pin, with its own client id, so it is the only party plex.tv will hand the
     * token to; polling plex.tv directly from the television needed that id to
     * match and then needed to prove the token was honoured, both of which failed
     * on this hardware. Here the server converts the pin into a session and the
     * cookie it sets belongs to the television.
     */
    private suspend fun plexCallback(pin: PlexPin, authToken: String? = null): PlexPoll {
        val response = request(
            "GET",
            "/auth/plex/callback" + (authToken?.let { "?authToken=" + encode(it) } ?: ""),
            extraCookie = "discovarr_plex_pin=" + pin.serverCookie,
            followRedirects = false,
            accept = "text/html",
        )

        val cookies = response.headers["set-cookie"].orEmpty()
        cookies.firstNotNullOfOrNull { DiscovarrClient.sessionFrom(it) }
            ?.let { return PlexPoll.SignedIn(it) }

        val location = response.headers["location"].orEmpty().firstOrNull().orEmpty()
        if (location.contains("/login")) {
            val message = Regex("err=([^&]+)").find(location)?.groupValues?.get(1)
                ?.let { java.net.URLDecoder.decode(it, "UTF-8") }
                ?: "Plex confirmed the code, but Discovarr did not start a session."
            // "Plex did not confirm the sign-in" is the ordinary answer until the
            // phone's Allow arrives; anything else is a real refusal.
            return if (message.contains("did not confirm")) PlexPoll.Waiting
            else PlexPoll.Failed(message)
        }

        val tokenCookie = cookies.firstNotNullOfOrNull { header ->
            Regex("discovarr_plex_token=([^;]+)").find(header)?.groupValues?.get(1)
        }

        val profiles = Html.all(response.body, """<span class="plex-profile-name">(.*?)</span>""")
            .mapNotNull { nameMatch ->
                val name = Html.text(nameMatch.groupValues[1])
                val rest = response.body.substring(nameMatch.range.last + 1)
                val uuid = Html.first(rest, """name="uuid" value="([^"]+)""")
                    ?: return@mapNotNull null
                // The locked marker is on the card's own wrapper, which sits
                // *before* the name, so it has to be read from the card's opening
                // tag rather than from what follows the name.
                val card = response.body.substring(
                    response.body.lastIndexOf("plex-profile", nameMatch.range.first).coerceAtLeast(0),
                    nameMatch.range.first,
                )
                PlexProfile(
                    uuid = uuid,
                    name = name,
                    protected = card.contains("-locked"),
                )
            }

        if (tokenCookie != null && profiles.isNotEmpty()) {
            return PlexPoll.ChooseProfile(tokenCookie, profiles)
        }

        return PlexPoll.Failed("Plex confirmed the code, but Discovarr did not start a session.")
    }

    /** Signs in as one profile of the household, PIN and all. */
    suspend fun plexChoose(tokenCookie: String, uuid: String, pin: String = ""): PlexPoll {
        val fields = linkedMapOf("uuid" to uuid)
        if (pin.isNotBlank()) fields["pin-$uuid"] = pin

        val response = request(
            "POST",
            "/auth/plex/profile",
            body = fields.entries.joinToString("&") { (key, value) -> encode(key) + "=" + encode(value) },
            contentType = "application/x-www-form-urlencoded",
            extraCookie = "discovarr_plex_token=" + tokenCookie,
            followRedirects = false,
            accept = "text/html",
        )

        val cookies = response.headers["set-cookie"].orEmpty()
        cookies.firstNotNullOfOrNull { DiscovarrClient.sessionFrom(it) }?.let { return PlexPoll.SignedIn(it) }

        val location = response.headers["location"].orEmpty().firstOrNull().orEmpty()
        val message = Regex("err=([^&]+)").find(location)?.groupValues?.get(1)
            ?: Regex("<p class=\"alert alert-err\">(.*?)</p>").find(response.body)?.groupValues?.get(1)
        return PlexPoll.Failed(
            message?.let { java.net.URLDecoder.decode(Html.text(it), "UTF-8") }
                ?: "That profile could not be signed in",
        )
    }

    /**
     * plex.tv's own API, over the platform's HTTPS stack.
     *
     * The television identifies itself with a client id it keeps, which is what
     * ties a confirmed pin back to this box.
     */
    private suspend fun plexTv(
        path: String,
        clientId: String,
        method: String = "GET",
        token: String? = null,
    ): JSONObject = withContext(Dispatchers.IO) {
        val connection = (URL(PLEX_TV + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 15_000
            instanceFollowRedirects = true
            setRequestProperty("accept", "application/json")
            setRequestProperty("X-Plex-Product", "Discovarr")
            setRequestProperty("X-Plex-Version", "1")
            setRequestProperty("X-Plex-Client-Identifier", clientId)
            token?.takeIf { it.isNotBlank() }?.let { setRequestProperty("X-Plex-Token", it) }

            if (method != "GET") {
                doOutput = true
                setFixedLengthStreamingMode(0)
                outputStream.close()
            }
        }

        try {
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.use { input ->
                BufferedReader(InputStreamReader(input, Charsets.UTF_8)).readText()
            }.orEmpty()

            if (status !in 200..299) {
                throw ApiException(
                    status,
                    if (status == 404) "Plex did not recognise that code" else "Plex answered $status",
                )
            }

            runCatching { JSONObject(text) }.getOrElse {
                throw ApiException(500, "Plex sent a reply this app cannot read")
            }
        } catch (error: IOException) {
            throw ApiException(0, "Plex could not be reached. Check this TV's connection to the internet.")
        } finally {
            connection.disconnect()
        }
    }

    /** Turns a server path into something RemoteImage can fetch. */
    private fun absolute(path: String?): String? {
        val value = path?.trim().orEmpty()
        return when {
            value.isEmpty() -> null
            value.startsWith("http") -> value
            value.startsWith("/") -> baseUrl + value
            else -> baseUrl + "/" + value
        }
    }

    // ---------------------------------------------------------------------
    // Transport
    // ---------------------------------------------------------------------

    /** Poster lookups already answered, keyed by the row they were asked for. */
    private val posterCache = mutableMapOf<String, String?>()
    private val posterLock = Any()

    private suspend fun get(path: String): JSONObject {
        val response = execute("GET", path, null)
        if (response.status !in 200..299) {
            throw ApiException(response.status, errorMessage(response.body) ?: httpMessage(response.status))
        }
        return runCatching { JSONObject(response.body) }
            .getOrElse { throw ApiException(500, "The server sent a response this app cannot read") }
    }

    private class RawResponse(
        val status: Int,
        val body: String,
        val headers: Map<String, List<String>>,
    )

    /**
     * The general form: HTML pages, form posts, cookies that are not the session,
     * and redirects left alone so a `Location` can be read instead of followed.
     */
    private suspend fun request(
        method: String,
        path: String,
        body: String? = null,
        contentType: String = "application/json; charset=utf-8",
        accept: String = "application/json",
        extraCookie: String? = null,
        followRedirects: Boolean = true,
    ): RawResponse = withContext(Dispatchers.IO) {
        val connection = (URL(baseUrl + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 20_000
            instanceFollowRedirects = followRedirects
            setRequestProperty("accept", accept)
            token?.takeIf { it.isNotBlank() }?.let {
                setRequestProperty("authorization", "Bearer $it")
            }

            val cookie = buildString {
                session?.takeIf { it.isNotBlank() }?.let { append("discovarr_session=$it") }
                extraCookie?.takeIf { it.isNotBlank() }?.let {
                    if (isNotEmpty()) append("; ")
                    append(it)
                }
            }
            if (cookie.isNotEmpty()) setRequestProperty("cookie", cookie)

            if (body != null) {
                doOutput = true
                setRequestProperty("content-type", contentType)
                val bytes = body.toByteArray(Charsets.UTF_8)
                setFixedLengthStreamingMode(bytes.size)
                outputStream.use { it.write(bytes) }
            }
        }

        try {
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            // A 302 has no body of its own and reading it can throw; the headers
            // are what matter there.
            val text = runCatching {
                stream?.use { input ->
                    BufferedReader(InputStreamReader(input, Charsets.UTF_8)).readText()
                }.orEmpty()
            }.getOrDefault("")

            RawResponse(status, text, connection.headerFields.orEmpty())
        } catch (error: IOException) {
            throw ApiException(
                0,
                "Cannot reach Discovarr at $baseUrl. Check that the address is right and the box is on this network.",
            )
        } finally {
            connection.disconnect()
        }
    }

    private suspend fun execute(method: String, path: String, body: JSONObject?): RawResponse =
        withContext(Dispatchers.IO) {
            val connection = (URL(baseUrl + path).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 10_000
                readTimeout = 20_000
                // Discovarr's API answers JSON only; the default gzip handling
                // already applies because HttpURLConnection asks for it.
                setRequestProperty("accept", "application/json")
                token?.takeIf { it.isNotBlank() }?.let {
                    setRequestProperty("authorization", "Bearer $it")
                }
                session?.takeIf { it.isNotBlank() }?.let {
                    setRequestProperty("cookie", "discovarr_session=$it")
                }

                if (body != null) {
                    doOutput = true
                    setRequestProperty("content-type", "application/json; charset=utf-8")
                    val bytes = body.toString().toByteArray(Charsets.UTF_8)
                    setFixedLengthStreamingMode(bytes.size)
                    outputStream.use { it.write(bytes) }
                }
            }

            try {
                val status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val text = stream?.use { input ->
                    BufferedReader(InputStreamReader(input, Charsets.UTF_8)).readText()
                }.orEmpty()

                RawResponse(status, text, connection.headerFields.orEmpty())
            } catch (error: IOException) {
                throw ApiException(
                    0,
                    "Cannot reach Discovarr at $baseUrl. Check that the address is right and the box is on this network.",
                )
            } finally {
                connection.disconnect()
            }
        }

    private fun errorMessage(body: String): String? =
        runCatching { JSONObject(body).str("error") }.getOrNull()?.takeIf { it.isNotBlank() }

    private fun httpMessage(status: Int): String = when (status) {
        401 -> "That account was not accepted. Sign in again."
        403 -> "This account is not allowed to do that."
        429 -> "Too many attempts. Wait a minute and try again."
        in 500..599 -> "Discovarr reported a server error ($status)."
        else -> "The server answered $status."
    }

    companion object {
        private const val SESSION_COOKIE = "discovarr_session"

        /** plex.tv's API host: pins and their confirmation are read from here. */
        private const val PLEX_TV = "https://plex.tv"

        /** Accepts "box:5057", "http://box:5057/" and anything in between. */
        fun normalise(raw: String): String {
            var value = raw.trim()
            if (value.isEmpty()) return ""
            if (!value.startsWith("http://") && !value.startsWith("https://")) {
                value = "http://$value"
            }
            return value.trimEnd('/')
        }

        private fun encode(value: String): String = URLEncoder.encode(value, "UTF-8")

        /** Pulls the value out of `discovarr_session=abc; Path=/; HttpOnly; ...`. */
        fun sessionFrom(setCookie: String?): String? {
            val header = setCookie?.trim().orEmpty()
            if (!header.startsWith(SESSION_COOKIE)) return null
            val pair = header.substringBefore(';')
            return pair.substringAfter('=', "").takeIf { it.isNotEmpty() }
        }
    }
}

data class LoginResult(val user: User, val session: String)
