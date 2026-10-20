package com.example.codez_mobile.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteControlSettingsTest {
    @Test
    fun `默认设置符合产品约定`() {
        val defaults = RemoteControlSettings()
        assertTrue(defaults.immersiveMode)
        assertTrue(defaults.keepScreenOn)
        assertTrue(defaults.backgroundKeepAlive)
        assertFalse(defaults.autoReconnectLastDevice)
    }

    @Test
    fun `序列化与反序列化保持一致且对损坏数据安全回退默认值`() {
        val custom = RemoteControlSettings(
            immersiveMode = false,
            keepScreenOn = false,
            backgroundKeepAlive = true,
            autoReconnectLastDevice = true,
        )
        val encoded = custom.toStorageString()
        val decoded = RemoteControlSettings.fromStorageString(encoded)
        assertEquals(custom, decoded)

        assertEquals(RemoteControlSettings(), RemoteControlSettings.fromStorageString(null))
        assertEquals(RemoteControlSettings(), RemoteControlSettings.fromStorageString(""))
        assertEquals(RemoteControlSettings(), RemoteControlSettings.fromStorageString("invalid_payload"))
    }

    @Test
    fun `启动自动重连仅在开关开启且无显式链接且本会话首次启动时触发`() {
        val recent = listOf(
            RemoteControlRecentLink("https://zcode.z.ai/remote?sid=latest", 200L),
            RemoteControlRecentLink("https://zcode.z.ai/remote?sid=older", 100L),
        )
        val autoEnabled = RemoteControlSettings(autoReconnectLastDevice = true)
        val autoDisabled = RemoteControlSettings(autoReconnectLastDevice = false)

        // 显式深链优先于最近设备
        assertEquals(
            "https://zcode.z.ai/remote?sid=explicit",
            RemoteControlSettings.resolveInitialAutoReconnectUrl(
                explicitLaunchUrl = "https://zcode.z.ai/remote?sid=explicit",
                settings = autoEnabled,
                recentLinks = recent,
                alreadyAutoConnectedInSession = false,
            ),
        )

        // 开启自动重连且首次启动时返回第一条最近记录
        assertEquals(
            "https://zcode.z.ai/remote?sid=latest",
            RemoteControlSettings.resolveInitialAutoReconnectUrl(
                explicitLaunchUrl = null,
                settings = autoEnabled,
                recentLinks = recent,
                alreadyAutoConnectedInSession = false,
            ),
        )

        // 本次会话已自动重连过则不再重复触发
        assertNull(
            RemoteControlSettings.resolveInitialAutoReconnectUrl(
                explicitLaunchUrl = null,
                settings = autoEnabled,
                recentLinks = recent,
                alreadyAutoConnectedInSession = true,
            ),
        )

        // 开关关闭时不自动重连
        assertNull(
            RemoteControlSettings.resolveInitialAutoReconnectUrl(
                explicitLaunchUrl = null,
                settings = autoDisabled,
                recentLinks = recent,
                alreadyAutoConnectedInSession = false,
            ),
        )
    }
}
