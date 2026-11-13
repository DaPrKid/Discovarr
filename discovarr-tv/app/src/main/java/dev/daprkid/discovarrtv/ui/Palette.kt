package dev.daprkid.discovarrtv.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * The web app's palette, ported rather than invented.
 *
 * Every value is read from [CurrentTheme], which holds one of the six colourways
 * out of `public/styles.css`. Because the getters read Compose state, switching
 * theme repaints every screen that used them, with no plumbing through the tree.
 *
 * Sizes are the web's scale roughly doubled: a browser is read at arm's length,
 * a television from the sofa.
 */
object Palette {
    private val t: ThemeTokens get() = CurrentTheme.tokens

    val Background: Color get() = t.bg
    val Surface: Color get() = t.surface
    val SurfaceHigh: Color get() = t.surface2
    val Line: Color get() = t.line

    val Accent: Color get() = t.accent
    val AccentSoft: Color get() = t.accentSoft

    /** Kept as the old name so nothing that reaches for it breaks. */
    val AccentDim: Color get() = t.accentSoft

    val BrandA: Color get() = t.brandA
    val BrandB: Color get() = t.brandB
    val GlowA: Color get() = t.glowA
    val GlowB: Color get() = t.glowB

    val TextPrimary: Color get() = t.text
    val TextSecondary: Color get() = t.muted

    val Success: Color get() = t.ok
    val Warning: Color get() = t.warn
    val Danger: Color get() = t.danger

    /** Plex's own yellow, for the one button that leaves for another app. */
    val Plex: Color get() = Color(0xFFE5A00D)
    val Scrim: Color get() = t.bg.copy(alpha = 0.86f)

    // The scale the web page uses, read from a sofa rather than a desk chair.
    // It used to be the web's size roughly doubled, which made a title page feel
    // like a poster rather than a page: one line of description filled the
    // screen. These are the web's own sizes with about a sixth added, so a
    // headline still reads at three metres without pushing the facts away.
    val Title: TextStyle
        get() = TextStyle(fontSize = 28.sp, fontWeight = FontWeight.SemiBold, color = t.text)
    val AuthTitle: TextStyle
        get() = TextStyle(fontSize = 28.sp, fontWeight = FontWeight.SemiBold, color = t.text)
    val SectionTitle: TextStyle
        get() = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = t.text)
    val Body: TextStyle
        get() = TextStyle(fontSize = 15.sp, color = t.text, lineHeight = 22.sp)
    val BodyMuted: TextStyle
        get() = TextStyle(fontSize = 14.sp, color = t.muted, lineHeight = 20.sp)
    val Label: TextStyle
        get() = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium, color = t.muted)
    val Chip: TextStyle
        get() = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium, color = t.muted)
    val Button: TextStyle
        get() = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = Color.White)
}
