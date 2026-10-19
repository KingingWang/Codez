package com.example.codez_mobile.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.example.codez_mobile.BuildConfig
import com.example.codez_mobile.R
import com.example.codez_mobile.remote.NativeSocketBridge
import com.example.codez_mobile.remote.RemoteControlUrlPolicy

/**
 * 全屏远控页：默认进入沉浸模式（隐藏系统状态栏/导航栏，上滑可短暂呼出），也可在设置中关闭沉浸模式保留系统栏。
 * 无论是否开启沉浸模式，容器均消费 imePadding()，确保软键盘弹起时底部输入框不被遮挡。
 * 页面不显示 App 顶栏，整个屏幕交给远控 Web UI；返回手势退出到首页。
 */
@Composable
fun RemoteControlWebViewScreen(
    remoteUrl: String,
    immersiveMode: Boolean = true,
    onCloseRemote: () -> Unit,
) {
    val context = LocalContext.current
    var webView by remember { mutableStateOf<WebView?>(null) }
    var socketBridge by remember { mutableStateOf<NativeSocketBridge?>(null) }
    var progress by remember { mutableStateOf(0) }
    var isLoading by remember { mutableStateOf(true) }
    var pageError by remember { mutableStateOf<String?>(null) }
    // 页面附件 <input type=file> 选择：WebView 不自带处理，必须实现
    // WebChromeClient.onShowFileChooser 拉起系统选择器；用户取消也要回调 null，
    // 否则页面 input 永久卡死。
    var pendingFileCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    val fileChooserTitle = stringResource(R.string.remote_file_chooser_title)
    val fileChooserLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val callback = pendingFileCallback
        pendingFileCallback = null
        val uris = result.data
            ?.takeIf { result.resultCode == Activity.RESULT_OK }
            ?.let { WebChromeClient.FileChooserParams.parseResult(result.resultCode, it) }
        callback?.onReceiveValue(uris)
    }

    DisposableEffect(immersiveMode) {
        context.findActivity()?.let { setImmersiveMode(it, immersiveMode) }
        onDispose {
            context.findActivity()?.let { setImmersiveMode(it, false) }
        }
    }

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

    val containerModifier = if (immersiveMode) {
        Modifier
            .fillMaxSize()
            .imePadding()
    } else {
        Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .imePadding()
    }

    Column(modifier = containerModifier) {
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
                        onShowFileChooser = { callback, params ->
                            // 同一时刻只挂起一个选择请求；新请求到来先取消旧回调。
                            pendingFileCallback?.onReceiveValue(null)
                            pendingFileCallback = callback
                            val chooserIntent = buildFileChooserIntent(params, fileChooserTitle)
                            val launched = runCatching {
                                fileChooserLauncher.launch(chooserIntent)
                            }.isSuccess
                            if (!launched) {
                                pendingFileCallback?.onReceiveValue(null)
                                pendingFileCallback = null
                            }
                            launched
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
            if (isLoading && pageError == null) {
                LinearProgressIndicator(
                    progress = { (progress.coerceIn(0, 100) / 100f) },
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .fillMaxWidth(),
                )
            }
            if (pageError != null) {
                RemoteControlErrorOverlay(
                    message = pageError.orEmpty(),
                    onRetry = {
                        pageError = null
                        webView?.reload()
                    },
                    onBackHome = onCloseRemote,
                )
            }
        }
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

private fun buildFileChooserIntent(
    params: WebChromeClient.FileChooserParams?,
    title: String,
): Intent {
    // createIntent 按页面 accept 类型与多选模式构造；个别 ROM 解析失败时回退通用 */*。
    val target = runCatching { params?.createIntent() }.getOrNull()
        ?: Intent(Intent.ACTION_GET_CONTENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
    return Intent.createChooser(target, title)
}

private fun setImmersiveMode(activity: Activity, enabled: Boolean) {
    val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
    if (enabled) {
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    } else {
        controller.show(WindowInsetsCompat.Type.systemBars())
    }
}

@Composable
private fun RemoteControlErrorOverlay(
    message: String,
    onRetry: () -> Unit,
    onBackHome: () -> Unit,
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
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(onClick = onRetry) {
                    Text(stringResource(R.string.remote_retry_button))
                }
                OutlinedButton(onClick = onBackHome) {
                    Text(stringResource(R.string.remote_back_home_button))
                }
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
    onShowFileChooser: (ValueCallback<Array<Uri>>?, WebChromeClient.FileChooserParams?) -> Boolean,
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

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean = onShowFileChooser(filePathCallback, fileChooserParams)
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

                val trustedCallbackUrl =
                    RemoteControlUrlPolicy.resolveOfficialOAuthCallbackToTrustedUrl(request.url)
                if (trustedCallbackUrl != null) {
                    view.loadUrl(trustedCallbackUrl)
                    return true
                }

                val resolved = RemoteControlUrlPolicy.resolve(request.url)
                if (resolved != null) {
                    if (request.url.scheme == "codez") {
                        view.loadUrl(resolved)
                        return true
                    }
                    return false
                }

                if (RemoteControlUrlPolicy.isAllowedOAuthNavigationUri(request.url)) {
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
