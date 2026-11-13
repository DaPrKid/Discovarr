package dev.daprkid.discovarrtv.ui

import android.os.SystemClock
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import dev.daprkid.discovarrtv.LocalSinglePressOpen
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.composed
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/**
 * Focus is the primary input on a television, so every interactive element here
 * is built from the same three pieces: a focusable node with its own interaction
 * source, a visible border when it holds focus, and a small scale-up so the
 * highlighted item is legible from across a room.
 */
private val FocusShape = RoundedCornerShape(10.dp)

/**
 * Activation that happens exactly once per press.
 *
 * `clickable` handles the D-pad itself, but a real remote delivers a press as a
 * key-down, often a repeat, and the click that follows the same press — so a
 * surface could see two activations where the viewer made one, which reads as
 * "the first press did nothing". Handling the key here and ignoring anything
 * inside [DEBOUNCE_MS] makes one press mean one open, which is what the setting
 * promises.
 */
private const val DEBOUNCE_MS = 350L

private fun Modifier.tvActivate(onClick: () -> Unit): Modifier = this.composed {
    var lastFired by remember { mutableStateOf(0L) }

    val fire = {
        val now = SystemClock.uptimeMillis()
        if (now - lastFired >= DEBOUNCE_MS) {
            lastFired = now
            onClick()
        }
    }

    this.onKeyEvent { event ->
        val activates = event.key == Key.Enter ||
            event.key == Key.DirectionCenter ||
            event.key == Key.NumPadEnter ||
            event.key == Key.Spacebar
        if (!activates) return@onKeyEvent false

        when (event.type) {
            KeyEventType.KeyUp -> fire()
            else -> Unit
        }
        // Both halves are consumed so `clickable` cannot fire a second time for
        // the same physical press.
        true
    }
}

@Composable
private fun rememberFocusState(): Pair<MutableInteractionSource, Boolean> {
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    return source to focused
}

/**
 * A focusable tile or row.
 *
 * `requiresConfirm` is what the television adds to the web's behaviour. On a
 * phone a tap both selects and opens; a remote has one button, and for some
 * people that button should open a title immediately while for others it should
 * mark the title first and open it on the second press. The choice lives in
 * [LocalSinglePressOpen], and this is the one place that honours it.
 */
@Composable
fun FocusableSurface(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    shape: androidx.compose.ui.graphics.Shape = FocusShape,
    focusedScale: Float = 1.05f,
    requiresConfirm: Boolean = false,
    content: @Composable (focused: Boolean) -> Unit,
) {
    val (source, focused) = rememberFocusState()
    val singlePress = LocalSinglePressOpen.current
    var armed by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(if (focused) focusedScale else 1f, label = "focusScale")

    // Moving away disarms, so a highlighted title never opens on the next visit.
    LaunchedEffect(focused) { if (!focused) armed = false }

    val borderColor = when {
        focused && armed -> Palette.TextPrimary
        focused -> Palette.Accent
        else -> Color.Transparent
    }
    val borderWidth = if (focused) 3.dp else 1.dp

    Box(
        modifier = modifier
            .scale(scale)
            .clip(shape)
            .background(Palette.SurfaceHigh)
            .border(borderWidth, borderColor, shape)
            .focusable(interactionSource = source)
            .tvActivate {
                if (requiresConfirm && !singlePress && !armed) armed = true else onClick()
            }
            .clickable(
                interactionSource = source,
                indication = null,
            ) {
                if (requiresConfirm && !singlePress && !armed) armed = true else onClick()
            },
    ) {
        content(focused || armed)
    }
}

/** The accent-filled button used for the one action a screen is really about. */
@Composable
fun TvButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    tone: Color = Palette.Accent,
    fillWidth: Boolean = false,
) {
    val (source, focused) = rememberFocusState()
    val scale by animateFloatAsState(if (focused) 1.04f else 1f, label = "buttonScale")
    val shape = RoundedCornerShape(10.dp)

    Box(
        modifier = modifier
            .then(if (fillWidth) Modifier.fillMaxWidth() else Modifier)
            .scale(scale)
            .clip(shape)
            .background(if (enabled) tone else Palette.SurfaceHigh)
            .then(if (focused) Modifier.border(3.dp, Palette.TextPrimary, shape) else Modifier)
            .focusable(enabled = enabled, interactionSource = source)
            .then(if (enabled) Modifier.tvActivate(onClick) else Modifier)
            .clickable(
                interactionSource = source,
                indication = null,
                enabled = enabled,
                onClick = onClick,
            )
            .padding(horizontal = 22.dp, vertical = 11.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            style = Palette.Button.copy(
                color = if (enabled) Color.White else Palette.TextSecondary,
            ),
        )
    }
}

/**
 * A text field that works with a remote: D-pad focus moves the caret into the
 * field, and focusing it asks the platform for its on-screen keyboard.
 */
@Composable
fun TvTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String = "",
    isSecret: Boolean = false,
    textStyle: TextStyle = Palette.Body,
) {
    Column(modifier = modifier) {
        if (label != null) {
            Text(label, style = Palette.Label)
            Spacer(Modifier.height(8.dp))
        }

        val (source, focused) = rememberFocusState()
        val shape = RoundedCornerShape(10.dp)

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(shape)
                // The web draws its inputs in surface-2 with a hairline border.
                .background(Palette.SurfaceHigh)
                .border(if (focused) 2.dp else 1.dp, if (focused) Palette.Accent else Palette.Line, shape)
                .focusable(interactionSource = source)
                .padding(horizontal = 18.dp, vertical = 16.dp),
        ) {
            if (value.isEmpty()) {
                Text(text = placeholder, style = textStyle.copy(color = Palette.TextSecondary))
            }

            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                textStyle = textStyle,
                cursorBrush = SolidColor(Palette.Accent),
                // A password is masked by its own transformation so the field never
                // renders the characters on a shared living-room screen.
                visualTransformation = if (isSecret) {
                    androidx.compose.ui.text.input.PasswordVisualTransformation()
                } else {
                    androidx.compose.ui.text.input.VisualTransformation.None
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = Palette.SectionTitle,
        modifier = modifier.padding(bottom = 12.dp),
    )
}

/**
 * A poster tile: art, then up to two lines beneath it.
 *
 * [artFallback] exists because an imported row can have no poster even though
 * the title does: the web borrows TMDB's artwork in that case, and a grid of
 * coloured initials is what a television shows without the same courtesy. It is
 * asked once, only when there is no URL to draw, and the answer is cached by the
 * client, so a shelf scrolls without a request behind every card.
 */
@Composable
fun PosterCard(
    title: String,
    subtitle: String?,
    imageUrl: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    badge: String? = null,
    artFallback: (suspend () -> String?)? = null,
) {
    var art by remember(imageUrl, title) { mutableStateOf(imageUrl) }
    val fallback by rememberUpdatedState(artFallback)
    LaunchedEffect(imageUrl, title) {
        if (imageUrl == null) fallback?.invoke()?.let { found -> if (found.isNotBlank()) art = found }
    }

    Column(modifier = modifier.width(158.dp)) {
        FocusableSurface(
            onClick = onClick,
            modifier = Modifier.width(158.dp).height(237.dp),
            shape = RoundedCornerShape(10.dp),
        ) {
            Box(Modifier.fillMaxWidth().height(237.dp)) {
                RemoteImage(url = art, label = title, modifier = Modifier.fillMaxWidth().height(237.dp))

                if (badge != null) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.TopStart)
                            .padding(8.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(Palette.Scrim)
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                    ) {
                        Text(badge, style = Palette.Chip.copy(color = Palette.Accent))
                    }
                }
            }
        }

        Spacer(Modifier.height(10.dp))
        Text(
            text = title,
            style = Palette.Body,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        if (!subtitle.isNullOrBlank()) {
            Text(
                text = subtitle,
                style = Palette.Chip,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** A horizontal shelf with a title and a single row of posters. */
@Composable
fun Shelf(
    title: String,
    count: Int,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionTitle(title)
            Spacer(Modifier.width(10.dp))
            if (count > 0) {
                Text(text = "$count", style = Palette.Chip, modifier = Modifier.padding(bottom = 12.dp))
            }
        }
        content()
    }
}

/** Inline error/confirmation line, used by every screen that talks to the server. */
@Composable
fun StatusLine(message: String?, isError: Boolean, modifier: Modifier = Modifier) {
    if (message.isNullOrBlank()) return
    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(if (isError) Palette.Danger.copy(alpha = 0.16f) else Palette.Success.copy(alpha = 0.14f))
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Text(
            text = message,
            style = Palette.BodyMuted.copy(color = if (isError) Palette.Danger else Palette.Success),
        )
    }
}

/** A toggle the remote can land on. Filled while it is the current choice. */
@Composable
fun TvChip(label: String, active: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(18.dp)
    FocusableSurface(
        onClick = onClick,
        modifier = modifier,
        shape = shape,
        focusedScale = 1.03f,
    ) { focused ->
        Box(
            modifier = Modifier
                .clip(shape)
                .background(if (active) Palette.Accent else Palette.SurfaceHigh)
                .border(
                    if (focused) 2.dp else 1.dp,
                    when {
                        focused -> Palette.TextPrimary
                        active -> Palette.Accent
                        else -> Palette.Line
                    },
                    shape,
                )
                .padding(horizontal = 16.dp, vertical = 9.dp),
        ) {
            Text(
                label,
                style = Palette.Chip.copy(color = if (active) Color.White else Palette.TextSecondary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** Chips for genres, status and other short metadata. */
@Composable
fun Chips(values: List<String>, modifier: Modifier = Modifier) {
    if (values.isEmpty()) return
    Row(modifier = modifier, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        values.take(5).forEach { value ->
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(20.dp))
                    .background(Palette.SurfaceHigh)
                    .padding(horizontal = 12.dp, vertical = 6.dp),
            ) {
                Text(value, style = Palette.Chip)
            }
        }
    }
}
