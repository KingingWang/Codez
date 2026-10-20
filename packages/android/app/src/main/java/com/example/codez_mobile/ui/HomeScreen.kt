package com.example.codez_mobile.ui

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.example.codez_mobile.BuildConfig
import com.example.codez_mobile.R
import com.example.codez_mobile.remote.RemoteControlRecentLink
import com.example.codez_mobile.remote.RemoteControlSettings
import com.example.codez_mobile.remote.parseRemoteDeviceDisplay
import java.util.Locale

/**
 * 多设备首页：扫码主入口 + 设备卡片列表 + 手动输入兜底。
 * 视觉遵循 DESIGN.md 的克制风格：品牌蓝只用于主行动点，层级靠 surface/outline 区分。
 */
@Composable
fun RemoteControlHomeScreen(
    recentLinks: List<RemoteControlRecentLink>,
    settings: RemoteControlSettings = RemoteControlSettings(),
    errorMessage: String?,
    showOpenAppSettingsAction: Boolean = false,
    onOpenAppSettings: () -> Unit = {},
    onOpenUrl: (String) -> Boolean,
    onScanQrCode: () -> Unit,
    onRemoveRecentLink: (String) -> Unit,
    onClearRecentLinks: () -> Unit,
    onUpdateSettings: (RemoteControlSettings) -> Unit = {},
    onClearWebViewCache: () -> Unit = {},
) {
    var manualExpanded by rememberSaveable { mutableStateOf(false) }
    var settingsSheetOpen by rememberSaveable { mutableStateOf(false) }
    var clearConfirmOpen by rememberSaveable { mutableStateOf(false) }
    var currentTimeMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val lifecycleOwner = LocalLifecycleOwner.current

    // App 从后台回到前台时刷新相对时间（如“刚刚”->“5 分钟前”）。
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                currentTimeMs = System.currentTimeMillis()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
            .imePadding(),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 560.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 16.dp),
        ) {
            HomeHeader(onOpenSettings = { settingsSheetOpen = true })
            if (errorMessage != null) {
                Spacer(modifier = Modifier.height(12.dp))
                ErrorBanner(
                    message = errorMessage,
                    showOpenAppSettingsAction = showOpenAppSettingsAction,
                    onOpenAppSettings = onOpenAppSettings,
                )
            }
            Spacer(modifier = Modifier.height(20.dp))
            ScanCard(onScanQrCode = onScanQrCode)
            Spacer(modifier = Modifier.height(24.dp))
            DeviceSection(
                recentLinks = recentLinks,
                nowMs = currentTimeMs,
                onOpenUrl = onOpenUrl,
                onRemoveRecentLink = onRemoveRecentLink,
                onRequestClearRecentLinks = { clearConfirmOpen = true },
            )
            Spacer(modifier = Modifier.height(16.dp))
            ManualEntryCard(
                expanded = manualExpanded,
                onToggle = { manualExpanded = !manualExpanded },
                onOpenUrl = onOpenUrl,
            )
            Spacer(modifier = Modifier.height(24.dp))
            HomeFooter()
        }
    }

    if (clearConfirmOpen) {
        ClearDevicesConfirmDialog(
            onConfirm = {
                clearConfirmOpen = false
                onClearRecentLinks()
            },
            onDismiss = { clearConfirmOpen = false },
        )
    }

    if (settingsSheetOpen) {
        RemoteControlSettingsSheet(
            settings = settings,
            onUpdateSettings = onUpdateSettings,
            onClearWebViewCache = onClearWebViewCache,
            onDismiss = { settingsSheetOpen = false },
        )
    }
}

@Composable
private fun HomeHeader(onOpenSettings: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(44.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.primary),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                painter = painterResource(R.drawable.ic_desktop),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onPrimary,
                modifier = Modifier.size(24.dp),
            )
        }
        Spacer(modifier = Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = stringResource(R.string.remote_home_title),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onBackground,
            )
            Text(
                text = stringResource(R.string.remote_home_subtitle),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        IconButton(onClick = onOpenSettings) {
            Icon(
                painter = painterResource(R.drawable.ic_settings),
                contentDescription = stringResource(R.string.remote_settings_title),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(22.dp),
            )
        }
    }
}

@Composable
private fun ErrorBanner(
    message: String,
    showOpenAppSettingsAction: Boolean,
    onOpenAppSettings: () -> Unit,
) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.errorContainer,
            contentColor = MaterialTheme.colorScheme.onErrorContainer,
        ),
        shape = RoundedCornerShape(12.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = message,
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodySmall,
            )
            if (showOpenAppSettingsAction) {
                Spacer(modifier = Modifier.width(8.dp))
                TextButton(onClick = onOpenAppSettings) {
                    Text(
                        text = stringResource(R.string.remote_open_app_settings),
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
    }
}

@Composable
private fun ScanCard(onScanQrCode: () -> Unit) {
    Card(
        onClick = onScanQrCode,
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primary,
            contentColor = MaterialTheme.colorScheme.onPrimary,
        ),
        shape = RoundedCornerShape(20.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 88.dp)
                .padding(horizontal = 20.dp, vertical = 18.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(52.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.18f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    painter = painterResource(R.drawable.ic_qr_scan),
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onPrimary,
                    modifier = Modifier.size(30.dp),
                )
            }
            Spacer(modifier = Modifier.width(16.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = stringResource(R.string.remote_scan_card_title),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(modifier = Modifier.height(2.dp))
                Text(
                    text = stringResource(R.string.remote_scan_card_desc),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.85f),
                )
            }
            Icon(
                painter = painterResource(R.drawable.ic_chevron_right),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.85f),
            )
        }
    }
}

@Composable
private fun DeviceSection(
    recentLinks: List<RemoteControlRecentLink>,
    nowMs: Long,
    onOpenUrl: (String) -> Boolean,
    onRemoveRecentLink: (String) -> Unit,
    onRequestClearRecentLinks: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = stringResource(R.string.remote_devices_title),
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onBackground,
        )
        if (recentLinks.isNotEmpty()) {
            TextButton(onClick = onRequestClearRecentLinks) {
                Text(stringResource(R.string.remote_devices_clear))
            }
        }
    }
    Spacer(modifier = Modifier.height(4.dp))
    if (recentLinks.isEmpty()) {
        EmptyDevicesCard()
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        recentLinks.forEach { link ->
            DeviceCard(
                link = link,
                nowMs = nowMs,
                onConnect = { onOpenUrl(link.url) },
                onRemove = { onRemoveRecentLink(link.url) },
            )
        }
    }
}

@Composable
private fun EmptyDevicesCard() {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainer,
        ),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        shape = RoundedCornerShape(16.dp),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 28.dp, horizontal = 20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(
                painter = painterResource(R.drawable.ic_desktop),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(36.dp),
            )
            Spacer(modifier = Modifier.height(10.dp))
            Text(
                text = stringResource(R.string.remote_devices_empty),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = stringResource(R.string.remote_devices_empty_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun DeviceCard(
    link: RemoteControlRecentLink,
    nowMs: Long,
    onConnect: () -> Unit,
    onRemove: () -> Unit,
) {
    val zh = Locale.getDefault().language.startsWith("zh")
    val display = remember(link.url, link.openedAt, nowMs, zh) {
        parseRemoteDeviceDisplay(link.url, link.openedAt, nowMs, zh)
    }
    Card(
        onClick = onConnect,
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainer,
        ),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        shape = RoundedCornerShape(16.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            DeviceAvatar(title = display.title)
            Spacer(modifier = Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = display.title,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Spacer(modifier = Modifier.height(2.dp))
                Text(
                    text = "${display.host} · ${display.relativeTime}",
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = onRemove) {
                Icon(
                    painter = painterResource(R.drawable.ic_delete),
                    contentDescription = stringResource(R.string.remote_device_remove),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(20.dp),
                )
            }
            Icon(
                painter = painterResource(R.drawable.ic_chevron_right),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

@Composable
private fun DeviceAvatar(title: String) {
    val initial = title.trim().firstOrNull()?.uppercase() ?: "C"
    Box(
        modifier = Modifier
            .size(42.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.primaryContainer),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = initial,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onPrimaryContainer,
        )
    }
}

@Composable
private fun ManualEntryCard(
    expanded: Boolean,
    onToggle: () -> Unit,
    onOpenUrl: (String) -> Boolean,
) {
    val context = LocalContext.current
    val focusManager = LocalFocusManager.current
    var input by rememberSaveable { mutableStateOf("") }
    var localError by rememberSaveable { mutableStateOf<String?>(null) }
    val invalidUrlMessage = stringResource(R.string.remote_url_invalid)
    val emptyClipboardMessage = stringResource(R.string.remote_clipboard_empty)

    val submitInput = {
        if (onOpenUrl(input)) {
            localError = null
            focusManager.clearFocus()
        } else {
            localError = invalidUrlMessage
        }
    }

    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainer,
        ),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        shape = RoundedCornerShape(16.dp),
    ) {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .clickable(onClick = onToggle)
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    painter = painterResource(R.drawable.ic_link),
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(20.dp),
                )
                Spacer(modifier = Modifier.width(10.dp))
                Text(
                    text = stringResource(R.string.remote_manual_entry_title),
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Icon(
                    painter = painterResource(R.drawable.ic_chevron_right),
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .size(20.dp)
                        .rotate(if (expanded) 90f else 0f),
                )
            }
            AnimatedVisibility(visible = expanded) {
                Column(
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                ) {
                    OutlinedTextField(
                        value = input,
                        onValueChange = {
                            input = it
                            localError = null
                        },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = false,
                        minLines = 2,
                        label = { Text(stringResource(R.string.remote_url_label)) },
                        placeholder = { Text(stringResource(R.string.remote_url_placeholder)) },
                        isError = localError != null,
                        supportingText = { localError?.let { Text(it) } },
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Uri,
                            imeAction = ImeAction.Go,
                        ),
                        keyboardActions = KeyboardActions(
                            onGo = { submitInput() },
                        ),
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        OutlinedButton(
                            onClick = {
                                val pasted = readClipboardText(context)
                                if (pasted.isNullOrBlank()) {
                                    localError = emptyClipboardMessage
                                } else {
                                    input = pasted
                                    localError = null
                                    // 如果剪贴板本身就是有效远控链接，粘贴后直接进入连接。
                                    if (onOpenUrl(pasted)) {
                                        focusManager.clearFocus()
                                    }
                                }
                            },
                        ) {
                            Icon(
                                painter = painterResource(R.drawable.ic_paste),
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(stringResource(R.string.remote_paste_button))
                        }
                        Button(
                            modifier = Modifier.weight(1f),
                            onClick = submitInput,
                        ) {
                            Text(stringResource(R.string.remote_connect_button))
                        }
                    }
                }
            }
        }
    }
}

private fun readClipboardText(context: Context): String? {
    val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return null
    val clip = clipboard.primaryClip ?: return null
    if (clip.itemCount <= 0) {
        return null
    }
    return clip.getItemAt(0)?.coerceToText(context)?.toString()?.trim()?.takeIf { it.isNotEmpty() }
}

@Composable
private fun ClearDevicesConfirmDialog(
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(text = stringResource(R.string.remote_devices_clear_confirm_title))
        },
        text = {
            Text(text = stringResource(R.string.remote_devices_clear_confirm_message))
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(text = stringResource(R.string.remote_devices_clear))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(text = stringResource(R.string.remote_cancel_button))
            }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RemoteControlSettingsSheet(
    settings: RemoteControlSettings,
    onUpdateSettings: (RemoteControlSettings) -> Unit,
    onClearWebViewCache: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var cacheClearedHint by remember { mutableStateOf(false) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 20.dp, vertical = 8.dp),
        ) {
            Text(
                text = stringResource(R.string.remote_settings_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Spacer(modifier = Modifier.height(12.dp))
            SettingsSwitchRow(
                title = stringResource(R.string.remote_settings_immersive_title),
                description = stringResource(R.string.remote_settings_immersive_desc),
                checked = settings.immersiveMode,
                onCheckedChange = { checked ->
                    onUpdateSettings(settings.copy(immersiveMode = checked))
                },
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            SettingsSwitchRow(
                title = stringResource(R.string.remote_settings_keep_screen_on_title),
                description = stringResource(R.string.remote_settings_keep_screen_on_desc),
                checked = settings.keepScreenOn,
                onCheckedChange = { checked ->
                    onUpdateSettings(settings.copy(keepScreenOn = checked))
                },
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            SettingsSwitchRow(
                title = stringResource(R.string.remote_settings_keep_alive_title),
                description = stringResource(R.string.remote_settings_keep_alive_desc),
                checked = settings.backgroundKeepAlive,
                onCheckedChange = { checked ->
                    onUpdateSettings(settings.copy(backgroundKeepAlive = checked))
                },
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            SettingsSwitchRow(
                title = stringResource(R.string.remote_settings_auto_reconnect_title),
                description = stringResource(R.string.remote_settings_auto_reconnect_desc),
                checked = settings.autoReconnectLastDevice,
                onCheckedChange = { checked ->
                    onUpdateSettings(settings.copy(autoReconnectLastDevice = checked))
                },
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Spacer(modifier = Modifier.height(14.dp))
            OutlinedButton(
                onClick = {
                    onClearWebViewCache()
                    cacheClearedHint = true
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(text = stringResource(R.string.remote_settings_clear_cache_button))
            }
            if (cacheClearedHint) {
                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    text = stringResource(R.string.remote_settings_cache_cleared),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}

@Composable
private fun SettingsSwitchRow(
    title: String,
    description: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onCheckedChange(!checked) }
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Spacer(modifier = Modifier.height(2.dp))
            Text(
                text = description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(modifier = Modifier.width(12.dp))
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
        )
    }
}

@Composable
private fun HomeFooter() {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painter = painterResource(R.drawable.ic_lock),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(12.dp),
        )
        Spacer(modifier = Modifier.width(4.dp))
        Text(
            text = stringResource(R.string.remote_footer_security),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = "  ·  v${BuildConfig.VERSION_NAME}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
