package com.example.codez_mobile.remote

import java.net.URI
import java.net.URLDecoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 首页设备卡片的展示模型与格式化逻辑（纯 JVM，无 Android 依赖，单测直接覆盖）。
 */
data class RemoteDeviceDisplay(
    val title: String,
    val host: String,
    val relativeTime: String,
)

private const val MINUTE_MS = 60_000L
private const val HOUR_MS = 60 * MINUTE_MS
private const val DAY_MS = 24 * HOUR_MS
private const val WEEK_MS = 7 * DAY_MS

fun formatRemoteRelativeTime(nowMs: Long, timeMs: Long, zh: Boolean): String {
    val delta = (nowMs - timeMs).coerceAtLeast(0L)
    if (delta < MINUTE_MS) {
        return if (zh) "刚刚" else "Just now"
    }
    if (delta < HOUR_MS) {
        val minutes = delta / MINUTE_MS
        return if (zh) "${minutes} 分钟前" else "$minutes min ago"
    }
    if (delta < DAY_MS) {
        val hours = delta / HOUR_MS
        return if (zh) "${hours} 小时前" else "$hours h ago"
    }
    if (delta < WEEK_MS) {
        val days = delta / DAY_MS
        return if (zh) "${days} 天前" else "$days d ago"
    }
    val pattern = if (zh) "yyyy年M月d日" else "MMM d, yyyy"
    return SimpleDateFormat(pattern, if (zh) Locale.CHINA else Locale.US).format(Date(timeMs))
}

/** 从远控链接提取 QR 里桌面端写入的 name 参数与页面 host。 */
fun parseRemoteDeviceDisplay(url: String, openedAt: Long, nowMs: Long, zh: Boolean): RemoteDeviceDisplay {
    val uri = runCatching { URI(url) }.getOrNull()
    val rawHost = uri?.host?.lowercase().orEmpty()
    val host = if (rawHost == RemoteControlUrlMatcher.BUNDLED_ASSETS_HOST) {
        if (zh) "内置客户端" else "Bundled App"
    } else {
        rawHost
    }
    val name = uri?.rawQuery
        ?.split("&")
        ?.firstNotNullOfOrNull { part ->
            val separator = part.indexOf('=')
            if (separator <= 0) {
                return@firstNotNullOfOrNull null
            }
            val key = part.substring(0, separator)
            if (key != "name") {
                return@firstNotNullOfOrNull null
            }
            runCatching {
                URLDecoder.decode(part.substring(separator + 1), Charsets.UTF_8)
            }.getOrNull()?.trim()?.takeIf { it.isNotEmpty() }
        }
    val title = name ?: host.ifBlank { "Codez Remote" }
    return RemoteDeviceDisplay(
        title = title,
        host = host,
        relativeTime = formatRemoteRelativeTime(nowMs, openedAt, zh),
    )
}
