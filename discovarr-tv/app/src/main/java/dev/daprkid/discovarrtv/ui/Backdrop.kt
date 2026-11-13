package dev.daprkid.discovarrtv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

/**
 * The page wash the web app paints behind everything: two soft radial glows over
 * the base colour, one top-left and one top-right. On a browser it is a CSS
 * `radial-gradient` stack on `body`; here it is the same two circles, drawn once
 * behind the content.
 */
@Composable
fun GlowBackground(
    modifier: Modifier = Modifier,
    content: @Composable BoxScope.() -> Unit,
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Palette.Background)
            .drawBehind {
                drawRect(
                    brush = Brush.radialGradient(
                        colors = listOf(Palette.GlowA, Color.Transparent),
                        center = Offset(size.width * 0.12f, -size.height * 0.10f),
                        radius = size.width * 0.55f,
                    ),
                )
                drawRect(
                    brush = Brush.radialGradient(
                        colors = listOf(Palette.GlowB, Color.Transparent),
                        center = Offset(size.width * 0.88f, 0f),
                        radius = size.width * 0.45f,
                    ),
                )
            },
        content = content,
    )
}
