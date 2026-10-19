package com.example.codez_mobile.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteControlUrlMatcherTest {
    @Test
    fun `release 放行 fork 发布页与官方远控页`() {
        // fork 发布页是桌面端二维码的固定目标
        assertTrue(
            RemoteControlUrlMatcher.isAllowedRemoteTarget(
                "https", "kingingwang.github.io", "/Codez/remote/v4/", debug = false,
            ),
        )
        assertTrue(
            RemoteControlUrlMatcher.isAllowedRemoteTarget(
                "https", "kingingwang.github.io", "/Codez/remote/v4/index.html", debug = false,
            ),
        )
        assertTrue(
            RemoteControlUrlMatcher.isAllowedRemoteTarget(
                "https", "zcode.z.ai", "/remote", debug = false,
            ),
        )
    }

    @Test
    fun `release 拒绝非白名单站点与降级 http`() {
        assertFalse(
            RemoteControlUrlMatcher.isAllowedRemoteTarget(
                "https", "evil.github.io", "/Codez/remote/v4/", debug = false,
            ),
        )
        assertFalse(
            RemoteControlUrlMatcher.isAllowedRemoteTarget(
                "http", "kingingwang.github.io", "/Codez/remote/v4/", debug = false,
            ),
        )
        assertFalse(
            RemoteControlUrlMatcher.isAllowedRemoteTarget(
                "https", "kingingwang.github.io", "/other/path", debug = false,
            ),
        )
        assertFalse(
            RemoteControlUrlMatcher.isAllowedRemoteTarget(
                "https", "192.168.1.10", "/remote", debug = false,
            ),
        )
        assertFalse(
            RemoteControlUrlMatcher.isAllowedRemoteTarget(
                "file", "kingingwang.github.io", "/Codez/remote/v4/", debug = false,
            ),
        )
    }

    @Test
    fun `debug 放行局域网与本机 remote 路径`() {
        assertTrue(
            RemoteControlUrlMatcher.isAllowedRemoteTarget(
                "http", "192.168.1.10", "/remote", debug = true,
            ),
        )
        assertTrue(
            RemoteControlUrlMatcher.isAllowedRemoteTarget(
                "http", "localhost", "/remote", debug = true,
            ),
        )
        assertTrue(
            RemoteControlUrlMatcher.isAllowedRemoteTarget(
                "http", "10.0.2.2", "/remote", debug = true,
            ),
        )
        assertTrue(
            RemoteControlUrlMatcher.isAllowedRemoteTarget(
                "http", "172.16.0.2", "/remote", debug = true,
            ),
        )
        // debug 也不放行局域网里的非 remote 路径
        assertFalse(
            RemoteControlUrlMatcher.isAllowedRemoteTarget(
                "http", "192.168.1.10", "/admin", debug = true,
            ),
        )
        // 172.32 不在私网段
        assertFalse(
            RemoteControlUrlMatcher.isAllowedRemoteTarget(
                "http", "172.32.0.1", "/remote", debug = true,
            ),
        )
    }

    @Test
    fun `codez 深链识别`() {
        assertTrue(RemoteControlUrlMatcher.isCodezDeepLink("codez", "remote"))
        assertFalse(RemoteControlUrlMatcher.isCodezDeepLink("https", "remote"))
        assertFalse(RemoteControlUrlMatcher.isCodezDeepLink("codez", "other"))
    }

    @Test
    fun `放行智谱 OAuth 授权页并识别官方 OAuth 回调`() {
        assertTrue(
            RemoteControlUrlMatcher.isAllowedOAuthNavigationTarget("https", "bigmodel.cn"),
        )
        assertTrue(
            RemoteControlUrlMatcher.isAllowedOAuthNavigationTarget("https", "open.bigmodel.cn"),
        )
        assertTrue(
            RemoteControlUrlMatcher.isAllowedOAuthNavigationTarget("https", "chat.z.ai"),
        )
        assertFalse(
            RemoteControlUrlMatcher.isAllowedOAuthNavigationTarget("http", "bigmodel.cn"),
        )
        assertFalse(
            RemoteControlUrlMatcher.isAllowedOAuthNavigationTarget("https", "example.com"),
        )

        assertTrue(
            RemoteControlUrlMatcher.isOfficialOAuthCallback(
                scheme = "https",
                host = "zcode.z.ai",
                path = "/remote/v4",
                queryParameterNames = setOf("authCode", "state", "sid"),
            ),
        )
        assertTrue(
            RemoteControlUrlMatcher.isOfficialOAuthCallback(
                scheme = "https",
                host = "zcode.z.ai",
                path = "/remote/v4/",
                queryParameterNames = setOf("code", "state"),
            ),
        )
        assertFalse(
            RemoteControlUrlMatcher.isOfficialOAuthCallback(
                scheme = "https",
                host = "zcode.z.ai",
                path = "/remote/v4",
                queryParameterNames = setOf("sid", "mid"),
            ),
        )
    }
}
