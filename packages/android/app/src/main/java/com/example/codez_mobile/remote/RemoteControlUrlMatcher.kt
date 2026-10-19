package com.example.codez_mobile.remote

/**
 * 远控链接白名单纯逻辑（不依赖 Android SDK，JVM 单测直接覆盖）。
 *
 * 背景：桌面端二维码固定指向 fork 发布页 kingingwang.github.io/Codez/remote/v4/，
 * 官方入口是 zcode.z.ai/remote；两者都必须可打开。Debug 包额外允许局域网/本机，
 * 方便真机调试本地 Vite 页面。
 */
object RemoteControlUrlMatcher {
    const val OFFICIAL_REMOTE_HOST = "zcode.z.ai"
    const val FORK_PAGES_HOST = "kingingwang.github.io"
    const val FORK_PAGES_PATH_PREFIX = "/Codez/remote"
    const val REMOTE_PATH_PREFIX = "/remote"
    const val CODEZ_REMOTE_SCHEME = "codez"
    const val CODEZ_REMOTE_HOST = "remote"

    fun isCodezDeepLink(scheme: String?, host: String?): Boolean =
        scheme == CODEZ_REMOTE_SCHEME && host == CODEZ_REMOTE_HOST

    fun isAllowedRemoteTarget(
        scheme: String?,
        host: String?,
        path: String?,
        debug: Boolean,
    ): Boolean {
        val normalizedScheme = scheme?.lowercase().orEmpty()
        val normalizedHost = host?.lowercase().orEmpty()
        val normalizedPath = path.orEmpty()

        if (isOfficialRemoteTarget(normalizedScheme, normalizedHost, normalizedPath)) {
            return true
        }
        if (isForkPagesRemoteTarget(normalizedScheme, normalizedHost, normalizedPath)) {
            return true
        }

        if (!debug) {
            return false
        }

        // 开发机真机调试时二维码会指向局域网 Vite 地址。
        // 生产包仍只允许上方两个发布域，debug 包才放开本机和局域网 http/https，
        // 避免远控壳变成任意浏览器。
        if (!normalizedPath.startsWith(REMOTE_PATH_PREFIX)) {
            return false
        }
        return (normalizedScheme == "http" || normalizedScheme == "https") &&
            isDebugHost(normalizedHost)
    }

    private fun isOfficialRemoteTarget(scheme: String, host: String, path: String): Boolean =
        scheme == "https" && host == OFFICIAL_REMOTE_HOST && path.startsWith(REMOTE_PATH_PREFIX)

    private fun isForkPagesRemoteTarget(scheme: String, host: String, path: String): Boolean =
        scheme == "https" && host == FORK_PAGES_HOST && path.startsWith(FORK_PAGES_PATH_PREFIX)

    private fun isDebugHost(host: String): Boolean {
        if (host == "localhost" || host == "127.0.0.1" || host == "10.0.2.2") {
            return true
        }
        if (host.endsWith(".local")) {
            return true
        }
        if (host.startsWith("192.168.") || host.startsWith("10.")) {
            return true
        }
        return Regex("^172\\.(1[6-9]|2\\d|3[0-1])\\.").containsMatchIn(host)
    }
}
