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
    const val BUNDLED_ASSETS_HOST = "appassets.androidplatform.net"
    const val FORK_PAGES_PATH_PREFIX = "/Codez/remote"
    const val BUNDLED_ASSETS_DIR_PREFIX = "remote/v4"
    const val REMOTE_PATH_PREFIX = "/remote"
    const val CODEZ_REMOTE_SCHEME = "codez"
    const val CODEZ_REMOTE_HOST = "remote"
    private val OAUTH_ALLOWED_HOSTS = setOf(
        "bigmodel.cn",
        "open.bigmodel.cn",
        "chat.z.ai",
    )

    fun isCodezDeepLink(scheme: String?, host: String?): Boolean =
        scheme == CODEZ_REMOTE_SCHEME && host == CODEZ_REMOTE_HOST

    /**
     * 判断是否为手机远控登录期间允许在 WebView 内部打开的智谱 OAuth 授权页。
     * 放行后登录全程留在 App WebView 内完成，避免跳出到系统默认浏览器丢失 sessionStorage 与 #e2ee 密钥。
     */
    fun isAllowedOAuthNavigationTarget(
        scheme: String?,
        host: String?,
    ): Boolean {
        val normalizedScheme = scheme?.lowercase().orEmpty()
        val normalizedHost = host?.lowercase().orEmpty()
        if (normalizedScheme != "https") {
            return false
        }
        return OAUTH_ALLOWED_HOSTS.any { allowed ->
            normalizedHost == allowed || normalizedHost.endsWith(".$allowed")
        }
    }

    /**
     * 判断是否为智谱 OAuth 授权完成后回跳到官方域名的回调链接（/remote/v4?code|authCode|error=...&state=...）。
     * 命中时由 WebView 重写回可信加密页面（kingingwang.github.io/Codez/remote/v4/）完成 Token 兑换。
     */
    fun isOfficialOAuthCallback(
        scheme: String?,
        host: String?,
        path: String?,
        queryParameterNames: Set<String>,
    ): Boolean {
        val normalizedScheme = scheme?.lowercase().orEmpty()
        val normalizedHost = host?.lowercase().orEmpty()
        val normalizedPath = path?.trimEnd('/').orEmpty()
        if (normalizedScheme != "https" || normalizedHost != OFFICIAL_REMOTE_HOST) {
            return false
        }
        if (normalizedPath != "/remote/v4") {
            return false
        }
        if (!queryParameterNames.contains("state")) {
            return false
        }
        return queryParameterNames.contains("code") ||
            queryParameterNames.contains("authCode") ||
            queryParameterNames.contains("error")
    }

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
        if (isBundledAssetRemoteTarget(normalizedScheme, normalizedHost, normalizedPath)) {
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

    /**
     * 判断该远控入口是否应改写到 APK 本地内置的 Web 前端（而非请求远端服务器下载 HTML/JS）。
     * 生产环境下的 fork 发布页、官方页与内置虚拟域名均走本地内置资源；Debug 下的局域网/本机开发地址仍直连 Vite。
     */
    fun shouldRewriteToBundledRemotePage(
        scheme: String?,
        host: String?,
        path: String?,
    ): Boolean {
        val normalizedScheme = scheme?.lowercase().orEmpty()
        val normalizedHost = host?.lowercase().orEmpty()
        val normalizedPath = path.orEmpty()
        return isOfficialRemoteTarget(normalizedScheme, normalizedHost, normalizedPath) ||
            isForkPagesRemoteTarget(normalizedScheme, normalizedHost, normalizedPath) ||
            isBundledAssetRemoteTarget(normalizedScheme, normalizedHost, normalizedPath)
    }

    /**
     * 将虚拟域名 https://appassets.androidplatform.net/Codez/remote/v4/... 的请求映射为
     * APK assets/ 目录下的相对路径（如 remote/v4/index.html 或 remote/v4/assets/index.js）。
     * 非内置资源请求或包含路径穿越（..）时返回 null。
     */
    fun resolveBundledAssetRelativePath(
        scheme: String?,
        host: String?,
        path: String?,
    ): String? {
        val normalizedScheme = scheme?.lowercase().orEmpty()
        val normalizedHost = host?.lowercase().orEmpty()
        val rawPath = path.orEmpty()
        if (normalizedScheme != "https" || normalizedHost != BUNDLED_ASSETS_HOST) {
            return null
        }
        val routePrefix = "$FORK_PAGES_PATH_PREFIX/v4"
        if (rawPath == routePrefix || rawPath == "$routePrefix/") {
            return "$BUNDLED_ASSETS_DIR_PREFIX/index.html"
        }
        if (!rawPath.startsWith("$routePrefix/")) {
            return null
        }
        val subPath = rawPath.removePrefix("$routePrefix/").trimStart('/')
        if (subPath.isEmpty()) {
            return "$BUNDLED_ASSETS_DIR_PREFIX/index.html"
        }
        val segments = subPath.split('/')
        if (segments.any { it.isEmpty() || it == "." || it == ".." }) {
            return null
        }
        return "$BUNDLED_ASSETS_DIR_PREFIX/${segments.joinToString("/")}"
    }

    /**
     * 根据静态资源路径后缀推断 MIME 类型（纯逻辑，供 WebView 本地资源拦截响应使用）。
     */
    fun guessBundledAssetMimeType(assetPath: String): String {
        val extension = assetPath.substringAfterLast('.', "").lowercase()
        return when (extension) {
            "html" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "css" -> "text/css"
            "json", "map" -> "application/json"
            "wasm" -> "application/wasm"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "webp" -> "image/webp"
            "gif" -> "image/gif"
            "ico" -> "image/x-icon"
            "woff2" -> "font/woff2"
            "woff" -> "font/woff"
            "ttf" -> "font/ttf"
            "mp3" -> "audio/mpeg"
            "md", "txt" -> "text/plain"
            "bcmap" -> "application/octet-stream"
            else -> "application/octet-stream"
        }
    }

    private fun isOfficialRemoteTarget(scheme: String, host: String, path: String): Boolean =
        scheme == "https" && host == OFFICIAL_REMOTE_HOST && path.startsWith(REMOTE_PATH_PREFIX)

    private fun isForkPagesRemoteTarget(scheme: String, host: String, path: String): Boolean =
        scheme == "https" && host == FORK_PAGES_HOST && path.startsWith(FORK_PAGES_PATH_PREFIX)

    private fun isBundledAssetRemoteTarget(scheme: String, host: String, path: String): Boolean =
        scheme == "https" && host == BUNDLED_ASSETS_HOST && path.startsWith(FORK_PAGES_PATH_PREFIX)

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
