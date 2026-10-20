package com.example.codez_mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebStorage
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.example.codez_mobile.remote.RemoteControlKeepAliveService
import com.example.codez_mobile.remote.RemoteControlRecentLink
import com.example.codez_mobile.remote.RemoteControlRecentLinksStore
import com.example.codez_mobile.remote.RemoteControlSettings
import com.example.codez_mobile.remote.RemoteControlSettingsStore
import com.example.codez_mobile.remote.RemoteControlUrlPolicy
import com.example.codez_mobile.ui.RemoteControlApp
import com.example.codez_mobile.ui.theme.ZcodemobileTheme

class MainActivity : ComponentActivity() {
    private var remoteUrl by mutableStateOf<String?>(null)
    private var recentLinks by mutableStateOf<List<RemoteControlRecentLink>>(emptyList())
    private var settings by mutableStateOf(RemoteControlSettings())
    private var didAutoReconnectInSession = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        recentLinks = RemoteControlRecentLinksStore.read(this)
        settings = RemoteControlSettingsStore.read(this)
        didAutoReconnectInSession =
            savedInstanceState?.getBoolean(KEY_AUTO_RECONNECTED, false) ?: false

        val restoredRemoteUrl = savedInstanceState?.getString(KEY_REMOTE_URL)
        val explicitLaunchUrl = restoredRemoteUrl ?: resolveRemoteUrlFromIntent(intent)
        val launchRemoteUrl = RemoteControlSettings.resolveInitialAutoReconnectUrl(
            explicitLaunchUrl = explicitLaunchUrl,
            settings = settings,
            recentLinks = recentLinks,
            alreadyAutoConnectedInSession = didAutoReconnectInSession,
        )
        if (explicitLaunchUrl == null && launchRemoteUrl != null) {
            didAutoReconnectInSession = true
        }
        launchRemoteUrl?.let { openRemoteUrl(it) }

        setContent {
            ZcodemobileTheme {
                RemoteControlApp(
                    remoteUrl = remoteUrl,
                    recentLinks = recentLinks,
                    settings = settings,
                    onOpenUrl = ::openRemoteUrl,
                    onCloseRemote = ::closeRemote,
                    onRemoveRecentLink = ::removeRecentLink,
                    onClearRecentLinks = ::clearRecentLinks,
                    onUpdateSettings = ::updateSettings,
                    onClearWebViewCache = ::clearWebViewCache,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        resolveRemoteUrlFromIntent(intent)?.let { openRemoteUrl(it) }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        remoteUrl?.let { outState.putString(KEY_REMOTE_URL, it) }
        outState.putBoolean(KEY_AUTO_RECONNECTED, didAutoReconnectInSession)
    }

    private fun openRemoteUrl(rawUrl: String): Boolean {
        val resolvedUrl = RemoteControlUrlPolicy.resolve(rawUrl) ?: return false
        recentLinks = RemoteControlRecentLinksStore.record(this, resolvedUrl)
        remoteUrl = resolvedUrl
        syncActiveRemoteEffects(resolvedUrl, settings)
        return true
    }

    private fun closeRemote() {
        remoteUrl = null
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        RemoteControlKeepAliveService.stop(this)
    }

    private fun updateSettings(nextSettings: RemoteControlSettings) {
        settings = RemoteControlSettingsStore.write(this, nextSettings)
        val activeUrl = remoteUrl
        if (activeUrl != null) {
            syncActiveRemoteEffects(activeUrl, settings)
        }
    }

    private fun syncActiveRemoteEffects(activeUrl: String, currentSettings: RemoteControlSettings) {
        if (currentSettings.keepScreenOn) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
        if (currentSettings.backgroundKeepAlive) {
            requestNotificationPermissionIfNeeded()
            RemoteControlKeepAliveService.start(this, activeUrl)
        } else {
            RemoteControlKeepAliveService.stop(this)
        }
    }

    private fun clearWebViewCache() {
        runCatching {
            WebView(this).apply {
                clearCache(true)
                destroy()
            }
            WebStorage.getInstance().deleteAllData()
        }
    }

    private fun clearRecentLinks() {
        recentLinks = RemoteControlRecentLinksStore.clear(this)
    }

    private fun removeRecentLink(url: String) {
        recentLinks = RemoteControlRecentLinksStore.remove(this, url)
    }

    private fun resolveRemoteUrlFromIntent(intent: Intent?): String? {
        if (intent == null) {
            return null
        }

        intent.getStringExtra(RemoteControlKeepAliveService.EXTRA_REMOTE_URL)?.let { raw ->
            RemoteControlUrlPolicy.resolve(raw)?.let { return it }
        }
        intent.data?.let { uri ->
            RemoteControlUrlPolicy.resolve(uri)?.let { return it }
        }
        intent.getStringExtra(Intent.EXTRA_TEXT)?.let { raw ->
            RemoteControlUrlPolicy.resolve(raw)?.let { return it }
        }

        return null
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return
        }
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            return
        }
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
    }

    companion object {
        private const val KEY_REMOTE_URL = "remoteUrl"
        private const val KEY_AUTO_RECONNECTED = "autoReconnectedInSession"
        private const val REQUEST_NOTIFICATIONS = 4001
    }
}
