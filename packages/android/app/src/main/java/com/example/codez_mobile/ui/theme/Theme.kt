package com.example.codez_mobile.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val DarkColorScheme = darkColorScheme(
    primary = BrandBlueDark,
    onPrimary = NeutralDarkBackground,
    primaryContainer = BrandBlueContainerDark,
    onPrimaryContainer = BrandBlueOnContainerDark,
    secondary = NeutralDarkSubtle,
    onSecondary = NeutralDarkBackground,
    background = NeutralDarkBackground,
    onBackground = NeutralDarkText,
    surface = NeutralDarkSurface,
    onSurface = NeutralDarkText,
    onSurfaceVariant = NeutralDarkSubtle,
    surfaceContainer = DarkSurfaceContainer,
    surfaceContainerHigh = DarkSurfaceContainerHigh,
    outline = DarkOutline,
    outlineVariant = DarkOutlineVariant,
)

private val LightColorScheme = lightColorScheme(
    primary = BrandBlue,
    onPrimary = NeutralLightSurface,
    primaryContainer = BrandBlueContainerLight,
    onPrimaryContainer = BrandBlueOnContainerLight,
    secondary = NeutralLightSubtle,
    onSecondary = NeutralLightSurface,
    background = NeutralLightBackground,
    onBackground = NeutralLightText,
    surface = NeutralLightSurface,
    onSurface = NeutralLightText,
    onSurfaceVariant = NeutralLightSubtle,
    surfaceContainer = LightSurfaceContainer,
    surfaceContainerHigh = LightSurfaceContainerHigh,
    outline = LightOutline,
    outlineVariant = LightOutlineVariant,
)

@Composable
fun ZcodemobileTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colorScheme = when {
        darkTheme -> DarkColorScheme
        else -> LightColorScheme
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = Typography,
        content = content
    )
}
