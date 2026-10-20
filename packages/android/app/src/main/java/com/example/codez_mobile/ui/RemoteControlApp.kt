package com.example.codez_mobile.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.core.content.ContextCompat
import com.example.codez_mobile.R
import com.example.codez_mobile.remote.RemoteControlRecentLink
import com.example.codez_mobile.remote.RemoteControlSettings

private sealed interface RemoteControlDestination {
    data object Home : RemoteControlDestination
    data object Scanner : RemoteControlDestination
    data class Web(val url: String) : RemoteControlDestination
}

/**
 * 顶层状态机：首页（多设备） -> 扫码页 -> WebView 远控页。
 * 远控页 URL 的统一校验在 MainActivity 的 onOpenUrl 里完成。
 */
@Composable
fun RemoteControlApp(
    remoteUrl: String?,
    recentLinks: List<RemoteControlRecentLink>,
    settings: RemoteControlSettings = RemoteControlSettings(),
    modifier: Modifier = Modifier,
    onOpenUrl: (String) -> Boolean,
    onCloseRemote: () -> Unit,
    onRemoveRecentLink: (String) -> Unit,
    onClearRecentLinks: () -> Unit,
    onUpdateSettings: (RemoteControlSettings) -> Unit = {},
    onClearWebViewCache: () -> Unit = {},
) {
    val context = LocalContext.current
    var scannerOpen by rememberSaveable { mutableStateOf(false) }
    var launcherError by rememberSaveable { mutableStateOf<String?>(null) }
    var permissionDeniedError by rememberSaveable { mutableStateOf(false) }
    val cameraPermissionDenied = stringResource(R.string.remote_scan_permission_denied)
    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            launcherError = null
            permissionDeniedError = false
            scannerOpen = true
        } else {
            launcherError = cameraPermissionDenied
            permissionDeniedError = true
        }
    }

    // 导航状态收敛为唯一 destination 后由 AnimatedContent 渲染；旧分支残片不能
    // 留在函数闭括号之后，否则会被 Kotlin 当作顶层声明并导致状态引用全部失效。
    val destination: RemoteControlDestination = when {
        scannerOpen -> RemoteControlDestination.Scanner
        remoteUrl == null -> RemoteControlDestination.Home
        else -> RemoteControlDestination.Web(remoteUrl)
    }

    Surface(
        modifier = modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
        contentColor = MaterialTheme.colorScheme.onBackground,
    ) {
        AnimatedContent(
            targetState = destination,
            transitionSpec = {
                fadeIn(animationSpec = tween(180)) togetherWith
                    fadeOut(animationSpec = tween(140))
            },
            label = "RemoteControlDestinationTransition",
        ) { state ->
            when (state) {
                RemoteControlDestination.Scanner -> {
                    RemoteControlQrScannerScreen(
                        onClose = {
                            scannerOpen = false
                        },
                        onScanned = { raw ->
                            val opened = onOpenUrl(raw)
                            if (opened) {
                                scannerOpen = false
                                launcherError = null
                                permissionDeniedError = false
                            } else {
                                launcherError = context.getString(R.string.remote_scan_invalid)
                                permissionDeniedError = false
                            }
                            opened
                        },
                    )
                }

                RemoteControlDestination.Home -> {
                    RemoteControlHomeScreen(
                        recentLinks = recentLinks,
                        settings = settings,
                        errorMessage = launcherError,
                        showOpenAppSettingsAction = permissionDeniedError,
                        onOpenAppSettings = {
                            val intent = Intent(
                                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                Uri.fromParts("package", context.packageName, null),
                            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            runCatching { context.startActivity(intent) }
                        },
                        onOpenUrl = { raw ->
                            val opened = onOpenUrl(raw)
                            if (opened) {
                                launcherError = null
                                permissionDeniedError = false
                            }
                            opened
                        },
                        onScanQrCode = {
                            if (
                                ContextCompat.checkSelfPermission(
                                    context,
                                    Manifest.permission.CAMERA,
                                ) == PackageManager.PERMISSION_GRANTED
                            ) {
                                launcherError = null
                                permissionDeniedError = false
                                scannerOpen = true
                            } else {
                                cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                            }
                        },
                        onRemoveRecentLink = onRemoveRecentLink,
                        onClearRecentLinks = onClearRecentLinks,
                        onUpdateSettings = onUpdateSettings,
                        onClearWebViewCache = onClearWebViewCache,
                    )
                }

                is RemoteControlDestination.Web -> {
                    RemoteControlWebViewScreen(
                        remoteUrl = state.url,
                        immersiveMode = settings.immersiveMode,
                        onCloseRemote = onCloseRemote,
                    )
                }
            }
        }
    }
}
