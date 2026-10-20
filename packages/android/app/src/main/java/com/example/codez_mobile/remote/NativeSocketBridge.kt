package com.example.codez_mobile.remote

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.decodeBase64
import org.json.JSONObject

/**
 * 原生 WebSocket 桥：由 OkHttp（不附加 Origin 头）代页面发起 relay WebSocket。
 *
 * 背景：relay 按握手 Origin 白名单放行，fork 发布页在 WebView 内直连会被 403；
 * Origin 由渲染进程自动附加、页面无法改写，只能由原生网络栈代发。
 * JS 侧适配类见 packages/web/src/webRemoteControlNativeSocket.ts，
 * 桥只搬运字节，不知道 E2EE/配对/RPC 等业务协议。
 *
 * JS -> 原生：JavascriptInterface（运行在 JavaBridge 线程，OkHttp 调用线程安全）。
 * 原生 -> JS：切主线程后 evaluateJavascript 回派 window.__codezAndroidSocketEvent。
 */
class NativeSocketBridge(private val webView: WebView) {
    private val client = OkHttpClient.Builder()
        // 手机 NAT/运营商会回收空闲 TCP；WS 层 ping 与 JS 侧应用心跳互补，降低半开概率。
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
    private val sockets = ConcurrentHashMap<Int, WebSocket>()
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile
    private var destroyed = false

    @JavascriptInterface
    fun open(id: Int, url: String) {
        if (destroyed) {
            return
        }
        val request = Request.Builder().url(url).build()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                dispatch(
                    id,
                    JSONObject()
                        .put("type", "open")
                        .put("extensions", response.header("Sec-WebSocket-Extensions").orEmpty()),
                )
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                dispatch(id, JSONObject().put("type", "message").put("text", text))
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                // relay-gzip 信封是二进制帧；JS 侧还原为 ArrayBuffer 后用 DecompressionStream 解压。
                dispatch(id, JSONObject().put("type", "message").put("base64", bytes.base64()))
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                // 完成对端发起的关闭握手；最终状态在 onClosed 统一上报。
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                sockets.remove(id)
                dispatchClose(id, code, reason, wasClean = true)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                sockets.remove(id)
                // 浏览器语义：error 事件之后紧跟 close 事件；transport 的重连由 close 驱动。
                dispatch(id, JSONObject().put("type", "error"))
                val reason = t.message?.take(120).orEmpty()
                dispatchClose(id, ABNORMAL_CLOSE_CODE, reason, wasClean = false)
            }
        }
        val socket = client.newWebSocket(request, listener)
        // open 返回前完成注册，JS 侧构造器返回后才可能 send/close，不存在竞态。
        sockets[id] = socket
    }

    @JavascriptInterface
    fun sendText(id: Int, text: String): Boolean = sockets[id]?.send(text) ?: false

    @JavascriptInterface
    fun sendBinary(id: Int, base64: String): Boolean {
        val bytes = base64.decodeBase64() ?: return false
        return sockets[id]?.send(bytes) ?: false
    }

    @JavascriptInterface
    fun close(id: Int, code: Int, reason: String) {
        sockets[id]?.close(code, reason)
    }

    fun destroy() {
        destroyed = true
        sockets.values.forEach { socket ->
            runCatching { socket.close(NORMAL_CLOSE_CODE, "page destroyed") }
        }
        sockets.clear()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }

    private fun dispatchClose(id: Int, code: Int, reason: String, wasClean: Boolean) {
        dispatch(
            id,
            JSONObject()
                .put("type", "close")
                .put("code", code)
                .put("reason", reason)
                .put("wasClean", wasClean),
        )
    }

    private fun dispatch(id: Int, event: JSONObject) {
        if (destroyed) {
            return
        }
        val json = event.toString()
        mainHandler.post {
            if (destroyed) {
                return@post
            }
            // JSONObject.quote 保证 JSON 作为 JS 字符串字面量安全注入。
            webView.evaluateJavascript(
                "window.__codezAndroidSocketEvent && window.__codezAndroidSocketEvent($id, ${JSONObject.quote(json)})",
                null,
            )
        }
    }

    companion object {
        private const val NORMAL_CLOSE_CODE = 1000
        private const val ABNORMAL_CLOSE_CODE = 1006
    }
}
