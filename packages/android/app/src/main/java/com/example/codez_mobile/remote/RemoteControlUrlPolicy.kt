package com.example.codez_mobile.remote

import android.net.Uri
import com.example.codez_mobile.BuildConfig

object RemoteControlUrlPolicy {
    fun resolve(raw: String?): String? {
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty()) {
            return null
        }

        val uri = runCatching { Uri.parse(trimmed) }.getOrNull() ?: return null
        return resolve(uri)
    }

    fun resolve(uri: Uri?): String? {
        if (uri == null) {
            return null
        }

        if (RemoteControlUrlMatcher.isCodezDeepLink(uri.scheme, uri.host)) {
            return buildDefaultRemoteUrl(uri)
        }

        if (isAllowedRemoteUri(uri)) {
            return uri.toString()
        }

        return null
    }

    fun isAllowedRemoteUrl(raw: String?): Boolean {
        val uri = runCatching { Uri.parse(raw?.trim().orEmpty()) }.getOrNull() ?: return false
        return isAllowedRemoteUri(uri)
    }

    private fun buildDefaultRemoteUrl(uri: Uri): String {
        val base = Uri.parse(BuildConfig.REMOTE_CONTROL_DEFAULT_URL).buildUpon()
        uri.encodedQuery?.let { base.encodedQuery(it) }
        uri.encodedFragment?.let { base.encodedFragment(it) }
        return base.build().toString()
    }

    private fun isAllowedRemoteUri(uri: Uri): Boolean =
        RemoteControlUrlMatcher.isAllowedRemoteTarget(
            scheme = uri.scheme,
            host = uri.host,
            path = uri.path,
            debug = BuildConfig.DEBUG,
        )
}
