package com.example.codez_mobile.remote

import android.content.Context

/**
 * Android 远控壳本地设置模型（纯数据 + 键值解析，便于 JVM 单元测试直接覆盖）。
 */
data class RemoteControlSettings(
    val immersiveMode: Boolean = true,
    val keepScreenOn: Boolean = true,
    val backgroundKeepAlive: Boolean = true,
    val autoReconnectLastDevice: Boolean = false,
) {
    fun toStorageString(): String =
        listOf(
            "$KEY_IMMERSIVE_MODE=$immersiveMode",
            "$KEY_KEEP_SCREEN_ON=$keepScreenOn",
            "$KEY_BACKGROUND_KEEP_ALIVE=$backgroundKeepAlive",
            "$KEY_AUTO_RECONNECT_LAST_DEVICE=$autoReconnectLastDevice",
        ).joinToString(";")

    companion object {
        const val KEY_IMMERSIVE_MODE = "immersiveMode"
        const val KEY_KEEP_SCREEN_ON = "keepScreenOn"
        const val KEY_BACKGROUND_KEEP_ALIVE = "backgroundKeepAlive"
        const val KEY_AUTO_RECONNECT_LAST_DEVICE = "autoReconnectLastDevice"

        fun fromStorageString(raw: String?): RemoteControlSettings {
            if (raw.isNullOrBlank()) {
                return RemoteControlSettings()
            }
            val entries = raw.split(";")
                .mapNotNull { token ->
                    val index = token.indexOf('=')
                    if (index <= 0) {
                        null
                    } else {
                        token.substring(0, index).trim() to token.substring(index + 1).trim()
                    }
                }
                .toMap()
            return RemoteControlSettings(
                immersiveMode = entries[KEY_IMMERSIVE_MODE]?.toBooleanStrictOrNull() ?: true,
                keepScreenOn = entries[KEY_KEEP_SCREEN_ON]?.toBooleanStrictOrNull() ?: true,
                backgroundKeepAlive = entries[KEY_BACKGROUND_KEEP_ALIVE]?.toBooleanStrictOrNull() ?: true,
                autoReconnectLastDevice = entries[KEY_AUTO_RECONNECT_LAST_DEVICE]?.toBooleanStrictOrNull() ?: false,
            )
        }

        /**
         * 计算冷启动时是否应自动重连最近一台设备：
         * - 外部 Intent / 状态恢复已有 URL 时优先使用显式 URL；
         * - 仅在开启 autoReconnectLastDevice 且本次进程会话尚未自动重连过时返回最近一条记录。
         */
        fun resolveInitialAutoReconnectUrl(
            explicitLaunchUrl: String?,
            settings: RemoteControlSettings,
            recentLinks: List<RemoteControlRecentLink>,
            alreadyAutoConnectedInSession: Boolean,
        ): String? {
            if (!explicitLaunchUrl.isNullOrBlank()) {
                return explicitLaunchUrl
            }
            if (!settings.autoReconnectLastDevice || alreadyAutoConnectedInSession) {
                return null
            }
            return recentLinks.firstOrNull()?.url
        }
    }
}

object RemoteControlSettingsStore {
    private const val PREFS_NAME = "codez_remote_control_settings"
    private const val KEY_SETTINGS = "settings_v1"

    fun read(context: Context): RemoteControlSettings {
        val raw = prefs(context).getString(KEY_SETTINGS, null)
        return RemoteControlSettings.fromStorageString(raw)
    }

    fun write(context: Context, settings: RemoteControlSettings): RemoteControlSettings {
        prefs(context).edit().putString(KEY_SETTINGS, settings.toStorageString()).apply()
        return settings
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
}
