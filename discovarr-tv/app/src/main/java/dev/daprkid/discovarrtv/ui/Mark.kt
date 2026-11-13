package dev.daprkid.discovarrtv.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.Canvas

/**
 * The Discovarr mark, drawn the same way the web draws it.
 *
 * `views.js` ships it as inline SVG — a magnifier ring with a play triangle
 * inside — so it can take the theme's `--brand-a`/`--brand-b` gradient. A
 * television has no stylesheet, so the same four shapes are drawn here on a 64
 * unit grid, scaled to whatever size the header asks for.
 */
@Composable
fun Mark(size: Dp = 40.dp, modifier: Modifier = Modifier) {
    Box(modifier = modifier.size(size)) {
        Canvas(Modifier.size(size)) {
            val unit = this.size.minDimension / 64f
            val tint = Brush.linearGradient(
                colors = listOf(Palette.BrandA, Palette.BrandB),
                start = Offset.Zero,
                end = Offset(this.size.width, this.size.height),
            )
            drawMark(unit = unit, tint = tint)
        }
    }
}

private fun DrawScope.drawMark(unit: Float, tint: Brush) {
    val ring = 17.5f * unit
    val disc = 13.5f * unit
    val centre = Offset(27f * unit, 27f * unit)

    // The handle, then the ring it sits against.
    drawLine(
        brush = tint,
        start = Offset(40.5f * unit, 40.5f * unit),
        end = Offset(55f * unit, 55f * unit),
        strokeWidth = 6f * unit,
        cap = StrokeCap.Round,
    )
    drawCircle(
        brush = tint,
        radius = ring,
        center = centre,
        style = Stroke(width = 4.5f * unit),
    )

    // The lens: a soft tint rather than a flat fill, so the mark reads as one
    // object at both 24dp and 120dp.
    drawCircle(
        brush = Brush.radialGradient(
            colors = listOf(Palette.AccentSoft, Color.Transparent),
            center = centre,
            radius = disc * 1.6f,
        ),
        radius = disc * 1.6f,
        center = centre,
    )

    // The play triangle, the same three points as the SVG path.
    val play = Path().apply {
        moveTo(23f * unit, 20.5f * unit)
        lineTo(34.5f * unit, 27f * unit)
        lineTo(23f * unit, 33.5f * unit)
        close()
    }
    drawPath(play, Color.White.copy(alpha = 0.92f))
}

/** The mark and the wordmark together, as the web's `.brand` lays them out. */
@Composable
fun Wordmark(modifier: Modifier = Modifier, size: Dp = 42.dp) {
    androidx.compose.foundation.layout.Row(
        modifier = modifier,
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
    ) {
        Mark(size = size)
        androidx.compose.foundation.layout.Spacer(Modifier.size(size * 0.28f))
        androidx.compose.material3.Text(
            text = "Discovarr",
            maxLines = 1,
            softWrap = false,
            style = androidx.compose.ui.text.TextStyle(
                fontSize = (size.value * 0.72f).sp,
                fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                brush = Brush.linearGradient(listOf(Palette.BrandA, Palette.BrandB)),
            ),
        )
    }
}
