package com.example.codez_mobile.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteDeviceDisplayTest {
    private val now = 1_800_000_000_000L

    @Test
    fun `设备名取 QR name 参数并解码`() {
        val display = parseRemoteDeviceDisplay(
            url = "https://kingingwang.github.io/Codez/remote/v4/?sid=abc&name=MacBook%20Pro&t=1",
            openedAt = now - 30 * 60_000L,
            nowMs = now,
            zh = true,
        )
        assertEquals("MacBook Pro", display.title)
        assertEquals("kingingwang.github.io", display.host)
        assertEquals("30 分钟前", display.relativeTime)
    }

    @Test
    fun `内置前端域名展示为友好本地标识`() {
        val zhDisplay = parseRemoteDeviceDisplay(
            url = "https://appassets.androidplatform.net/Codez/remote/v4/?sid=abc&name=Studio&t=1",
            openedAt = now,
            nowMs = now,
            zh = true,
        )
        assertEquals("Studio", zhDisplay.title)
        assertEquals("内置客户端", zhDisplay.host)

        val enDisplay = parseRemoteDeviceDisplay(
            url = "https://appassets.androidplatform.net/Codez/remote/v4/?sid=abc&name=Studio&t=1",
            openedAt = now,
            nowMs = now,
            zh = false,
        )
        assertEquals("Bundled App", enDisplay.host)
    }

    @Test
    fun `缺少 name 参数时回退 host`() {
        val display = parseRemoteDeviceDisplay(
            url = "https://zcode.z.ai/remote?sid=abc&t=1",
            openedAt = now,
            nowMs = now,
            zh = false,
        )
        assertEquals("zcode.z.ai", display.title)
        assertEquals("Just now", display.relativeTime)
    }

    @Test
    fun `中文设备名正常解码`() {
        val display = parseRemoteDeviceDisplay(
            url = "https://kingingwang.github.io/Codez/remote/v4/?sid=abc&name=%E7%8E%8B%E5%AD%90%E8%B1%AA%E7%9A%84Mac&t=1",
            openedAt = now - 3 * 3_600_000L,
            nowMs = now,
            zh = true,
        )
        assertEquals("王子豪的Mac", display.title)
        assertEquals("3 小时前", display.relativeTime)
    }

    @Test
    fun `相对时间分档`() {
        assertEquals("刚刚", formatRemoteRelativeTime(now, now - 5_000L, zh = true))
        assertEquals("1 分钟前", formatRemoteRelativeTime(now, now - 60_000L, zh = true))
        assertEquals("23 小时前", formatRemoteRelativeTime(now, now - 23 * 3_600_000L, zh = true))
        assertEquals("6 天前", formatRemoteRelativeTime(now, now - 6 * 86_400_000L, zh = true))
        assertEquals("1 min ago", formatRemoteRelativeTime(now, now - 90_000L, zh = false))
        // 未来时间戳按 0 处理，不显示负数
        assertEquals("刚刚", formatRemoteRelativeTime(now, now + 60_000L, zh = true))
    }

    @Test
    fun `超过一周回退绝对日期`() {
        val text = formatRemoteRelativeTime(now, now - 30 * 86_400_000L, zh = true)
        assertTrue(text.contains("年"))
    }
}
