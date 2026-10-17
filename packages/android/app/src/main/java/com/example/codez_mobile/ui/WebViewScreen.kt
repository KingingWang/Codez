package com.example.codez_mobile.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.example.codez_mobile.BuildConfig
import com.example.codez_mobile.R
import com.example.codez_mobile.remote.NativeSocketBridge
import com.example.codez_mobile.remote.RemoteControlUrlPolicy

@Composable
fun RemoteControlWebViewScreen(
    remoteUrl: String,
    onCloseRemote: () -> Unit,
) {
    val context = LocalContext.current
    var webView by remember { mutableStateOf<WebView?>(null) }
    var socketBridge by remember { mutableStateOf<NativeSocketBridge?>(null) }
    var progress by remember { mutableStateOf(0) }
    var isLoading by remember { mutableStateOf(true) }
    var pageError by remember { mutableStateOf<String?>(null) }

    BackHandler {
        val view = webView
        if (view != null && view.canGoBack()) {
            view.goBack()
        } else {
            onCloseRemote()
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            // 先关桥再销毁 WebView，避免桥持有已销毁视图或泄漏 OkHttp 线程。
            socketBridge?.destroy()
            socketBridge = null
            webView?.destroy()
            webView = null
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        RemoteControlTopBar(
            remoteUrl = remoteUrl,
            isLoading = isLoading,
            onReload = {
                pageError = null
                webView?.reload()
            },
            onClose = onCloseRemote,
        )
        if (isLoading) {
            LinearProgressIndicator(
                progress = { (progress.coerceIn(0, 100) / 100f) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Box(modifier = Modifier.fillMaxSize()) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = {
                    createRemoteControlWebView(
                        context = context,
                        onLoadingChanged = { loading ->
                            isLoading = loading
                        },
                        onProgressChanged = { nextProgress ->
                            progress = nextProgress
                        },
                        onMainFrameError = { message ->
                            pageError = message
                        },
                        onBridgeCreated = { bridge ->
                            socketBridge = bridge
                        },
                    ).also { view ->
                        webView = view
                        view.loadUrl(remoteUrl)
                    }
                },
                update = { view ->
                    if (view.url != remoteUrl) {
                        pageError = null
                        view.loadUrl(remoteUrl)
                    }
                },
            )
            if (pageError != null) {
                RemoteControlErrorOverlay(
                    message = pageError.orEmpty(),
                    onRetry = {
                        pageError = null
                        webView?.reload()
                    },
                )
            }
        }
    }
}

@Composable
private fun RemoteControlTopBar(
    remoteUrl: String,
    isLoading: Boolean,
    onReload: () -> Unit,
    onClose: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .height(48.dp)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = stringResource(R.string.remote_screen_title),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.titleSmall,
            )
            Text(
                text = remoteUrl,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (isLoading) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                strokeWidth = 2.dp,
            )
            Spacer(modifier = Modifier.width(8.dp))
        }
        TextButton(onClick = onReload) {
            Text(stringResource(R.string.remote_reload_button))
        }
        TextButton(onClick = onClose) {
            Text(stringResource(R.string.remote_close_button))
        }
    }
}

@Composable
private fun RemoteControlErrorOverlay(
    message: String,
    onRetry: () -> Unit,
) {
    Surface(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 2.dp,
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.Start,
        ) {
            Text(
                text = stringResource(R.string.remote_load_failed_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.height(16.dp))
            Button(onClick = onRetry) {
                Text(stringResource(R.string.remote_retry_button))
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
private fun createRemoteControlWebView(
    context: Context,
    onLoadingChanged: (Boolean) -> Unit,
    onProgressChanged: (Int) -> Unit,
    onMainFrameError: (String) -> Unit,
    onBridgeCreated: (NativeSocketBridge) -> Unit,
): WebView {
    CookieManager.getInstance().setAcceptCookie(true)

    return WebView(context).apply {
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        overScrollMode = WebView.OVER_SCROLL_NEVER
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = "$userAgentString CodezAndroid/${BuildConfig.VERSION_NAME}"
        }
        // 原生 WebSocket 桥：relay 按 Origin 白名单放行，页面在 WebView 内直连会被 403。
        // 桥在 loadUrl 之前注入，页面 JS 启动时即可检测到 window.CodezAndroidSocket。
        addJavascriptInterface(
            NativeSocketBridge(this).also(onBridgeCreated),
            "CodezAndroidSocket",
        )
        webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                onProgressChanged(newProgress)
            }
        }
        webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                onLoadingChanged(true)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                onLoadingChanged(false)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                if (!request.isForMainFrame) {
                    return false
                }

                val resolved = RemoteControlUrlPolicy.resolve(request.url)
                if (resolved != null) {
                    if (request.url.scheme == "codez") {
                        view.loadUrl(resolved)
                        return true
                    }
                    return false
                }

                openExternalUrl(view.context, request.url)
                return true
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?,
            ) {
                if (request?.isForMainFrame != true) {
                    return
                }
                onLoadingChanged(false)
                onMainFrameError(error?.description?.toString().orEmpty())
            }
        }
    }
}

private fun openExternalUrl(context: Context, uri: Uri) {
    val intent = Intent(Intent.ACTION_VIEW, uri)
    runCatching {
        context.startActivity(intent)
    }
}
