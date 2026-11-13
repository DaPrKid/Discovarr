package dev.daprkid.discovarrtv

/**
 * Just enough HTML reading for the three things Discovarr renders and never
 * serves as JSON: the watchlist, the calendar, and a title page's facts and cast.
 *
 * A browser would parse these documents properly; a television only needs a
 * handful of labelled values out of server-rendered markup that this app already
 * fetches with its own cookie for the Plex link. Keeping the parsing here — a
 * few small regexes over the app's own server — avoids adding an HTML parser,
 * which is the entire reason this app has no dependencies.
 */
internal object Html {
    private val FLAGS = RegexOption.DOT_MATCHES_ALL

    fun decoded(value: String): String = value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&#8217;", "\u2019")
        .replace("&mdash;", "\u2014")

    /** The visible text of a fragment: tags dropped, whitespace collapsed. */
    fun text(fragment: String): String =
        decoded(fragment.replace(Regex("<[^>]*>"), " "))
            .replace(Regex("\\s+"), " ")
            .trim()

    fun first(html: String, pattern: String): String? =
        Regex(pattern, FLAGS).find(html)?.let { match ->
            match.groupValues.getOrNull(1)?.takeIf { it.isNotBlank() }
        }

    /** The visible text of the first element matching [pattern]. */
    fun firstText(html: String, pattern: String): String? =
        first(html, pattern)?.let(::text)?.takeIf { it.isNotBlank() }

    fun all(html: String, pattern: String): List<MatchResult> =
        Regex(pattern, FLAGS).findAll(html).toList()

    /** Every `name="..." value="..."` pair, for the hidden fields of a form. */
    fun hiddenFields(fragment: String): Map<String, String> =
        all(fragment, "<input[^>]*name=\"([^\"]+)\"[^>]*value=\"([^\"]*)\"").associate { match ->
            match.groupValues[1] to decoded(match.groupValues[2])
        }

    fun attribute(fragment: String, name: String): String? =
        first(fragment, "$name=\"([^\"]*)\"")
}
