package dev.daprkid.discovarrtv.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.Color

/**
 * The six colourways Discovarr ships, copied value for value out of
 * `public/styles.css`.
 *
 * The account's theme is saved on the server (`/account/theme`) and painted into
 * every page the browser renders, so the television reads the same theme the
 * account already chose. Nothing here invents a colour: each field is one
 * `--variable` from the stylesheet, which is why a themed TV and a themed
 * browser are indistinguishable.
 */
data class ThemeTokens(
    val name: String,
    val label: String,
    val bg: Color,
    val surface: Color,
    val surface2: Color,
    val line: Color,
    val text: Color,
    val muted: Color,
    val accent: Color,
    val accentSoft: Color,
    val ok: Color,
    val warn: Color,
    val danger: Color,
    val glowA: Color,
    val glowB: Color,
    val brandA: Color,
    val brandB: Color,
    val radius: Int,
)

object Themes {
    private fun hex(value: Long) = Color(value)

    val Midnight = ThemeTokens(
        name = "midnight",
        label = "Midnight",
        bg = hex(0xFF0C0E14),
        surface = hex(0xFF141824),
        surface2 = hex(0xFF1B2030),
        line = hex(0xFF262C3D),
        text = hex(0xFFE8ECF6),
        muted = hex(0xFF8D97AD),
        accent = hex(0xFF7C5CFF),
        accentSoft = hex(0xFF2A2350),
        ok = hex(0xFF3DDC97),
        warn = hex(0xFFFFC857),
        danger = hex(0xFFFF6B81),
        glowA = hex(0xFF211A45),
        glowB = hex(0xFF102A3D),
        brandA = hex(0xFFA48BFF),
        brandB = hex(0xFF6FE7FF),
        radius = 14,
    )

    val Cinema = ThemeTokens(
        name = "cinema",
        label = "Cinema",
        bg = hex(0xFF0D0A08),
        surface = hex(0xFF171210),
        surface2 = hex(0xFF221A15),
        line = hex(0xFF33261E),
        text = hex(0xFFF7ECDF),
        muted = hex(0xFFB19A85),
        accent = hex(0xFFE8A04B),
        accentSoft = hex(0xFF3A2A17),
        ok = hex(0xFF93D69A),
        warn = hex(0xFFF2C452),
        danger = hex(0xFFE5695F),
        glowA = hex(0xFF3D2411),
        glowB = hex(0xFF1D1510),
        brandA = hex(0xFFF0C07A),
        brandB = hex(0xFFE8A04B),
        radius = 10,
    )

    val Teal = ThemeTokens(
        name = "teal",
        label = "Deep Teal",
        bg = hex(0xFF07100F),
        surface = hex(0xFF0D1A19),
        surface2 = hex(0xFF132524),
        line = hex(0xFF1E3A38),
        text = hex(0xFFE4F4F1),
        muted = hex(0xFF8FB3AD),
        accent = hex(0xFF14C8B4),
        accentSoft = hex(0xFF0F3B36),
        ok = hex(0xFF35D399),
        warn = hex(0xFFF2C14E),
        danger = hex(0xFFFF6F6F),
        glowA = hex(0xFF0D3B39),
        glowB = hex(0xFF06282B),
        brandA = hex(0xFF5EEAD4),
        brandB = hex(0xFF7DD3FC),
        radius = 12,
    )

    val Forest = ThemeTokens(
        name = "forest",
        label = "Enchanted Forest",
        bg = hex(0xFF0F1211),
        surface = hex(0xFF171B19),
        surface2 = hex(0xFF1F2621),
        line = hex(0xFF2C372F),
        text = hex(0xFFEAF3E8),
        muted = hex(0xFFA1B3A0),
        accent = hex(0xFF3FA66B),
        accentSoft = hex(0xFF1C3A28),
        ok = hex(0xFF6FD18A),
        warn = hex(0xFFE6C15A),
        danger = hex(0xFFE06C6C),
        glowA = hex(0xFF16331F),
        glowB = hex(0xFF1D2A25),
        brandA = hex(0xFF86EFAC),
        brandB = hex(0xFFD9F99D),
        radius = 12,
    )

    val Sapphire = ThemeTokens(
        name = "sapphire",
        label = "Midnight Sapphire",
        bg = hex(0xFF060A15),
        surface = hex(0xFF0D1322),
        surface2 = hex(0xFF141C31),
        line = hex(0xFF222D49),
        text = hex(0xFFE8EEFC),
        muted = hex(0xFF93A1C2),
        accent = hex(0xFF4C7DFF),
        accentSoft = hex(0xFF16224A),
        ok = hex(0xFF48D4A4),
        warn = hex(0xFFF0C463),
        danger = hex(0xFFFF6F8B),
        glowA = hex(0xFF14265C),
        glowB = hex(0xFF0A1832),
        brandA = hex(0xFF7AA2FF),
        brandB = hex(0xFF67E8F9),
        radius = 12,
    )

    val Crimson = ThemeTokens(
        name = "crimson",
        label = "Imperial Crimson",
        bg = hex(0xFF0B0709),
        surface = hex(0xFF150F12),
        surface2 = hex(0xFF1E1519),
        line = hex(0xFF33252A),
        text = hex(0xFFF9EAEC),
        muted = hex(0xFFBD9BA2),
        accent = hex(0xFFE13B4F),
        accentSoft = hex(0xFF3D1018),
        ok = hex(0xFF5FCF95),
        warn = hex(0xFFF0BC55),
        danger = hex(0xFFFF7B6B),
        glowA = hex(0xFF4A0F1A),
        glowB = hex(0xFF290A12),
        brandA = hex(0xFFFF9AA8),
        brandB = hex(0xFFF5C26B),
        radius = 12,
    )

    /** The picker's order, the same order the web's select lists them in. */
    val all = listOf(Midnight, Cinema, Teal, Forest, Sapphire, Crimson)

    fun named(name: String?): ThemeTokens = all.firstOrNull { it.name == name } ?: Midnight
}

/**
 * The theme currently painted.
 *
 * A singleton rather than a CompositionLocal because every screen already reads
 * `Palette.x` directly; backing those reads with this one state is what lets the
 * picker re-colour the whole app without threading tokens through forty call
 * sites. Reading it inside composition subscribes to changes like any other
 * Compose state.
 */
object CurrentTheme {
    private val state = mutableStateOf(Themes.Midnight)

    val tokens: ThemeTokens get() = state.value

    fun apply(theme: ThemeTokens) {
        state.value = theme
    }
}
