package com.example.codez_mobile.ui

import android.content.Context
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.example.codez_mobile.R
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@Composable
fun RemoteControlQrScannerScreen(
    onClose: () -> Unit,
    onScanned: (String) -> Boolean,
) {
    val context = LocalContext.current
    val hapticFeedback = LocalHapticFeedback.current
    var scanError by rememberSaveable { mutableStateOf<String?>(null) }
    var cameraRef by remember { mutableStateOf<Camera?>(null) }
    var hasFlashUnit by remember { mutableStateOf(false) }
    var torchEnabled by rememberSaveable { mutableStateOf(false) }
    val invalidQrMessage = stringResource(R.string.remote_scan_invalid)
    val noQrInImageMessage = stringResource(R.string.remote_scan_no_qr_in_image)
    val scanner = remember {
        BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build(),
        )
    }

    val handleScannedValue = { raw: String ->
        val accepted = onScanned(raw)
        if (accepted) {
            hapticFeedback.performHapticFeedback(HapticFeedbackType.LongPress)
        } else {
            scanError = invalidQrMessage
        }
        accepted
    }

    val imagePickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri: Uri? ->
        if (uri == null) {
            return@rememberLauncherForActivityResult
        }
        scanQrFromImageUri(
            context = context,
            scanner = scanner,
            uri = uri,
            onFound = { raw ->
                handleScannedValue(raw)
            },
            onNotFound = {
                scanError = noQrInImageMessage
            },
        )
    }

    BackHandler(onBack = onClose)

    Box(modifier = Modifier.fillMaxSize()) {
        RemoteQrCameraPreview(
            scanner = scanner,
            onScanned = handleScannedValue,
            onCameraBound = { camera ->
                cameraRef = camera
                val flashAvailable = camera.cameraInfo.hasFlashUnit()
                hasFlashUnit = flashAvailable
                if (flashAvailable && torchEnabled) {
                    camera.cameraControl.enableTorch(true)
                }
            },
            onCameraError = {
                scanError = it
            },
        )
        QrViewfinderOverlay()
        Surface(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .statusBarsPadding(),
            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp)
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.remote_scan_title),
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Text(
                        text = stringResource(R.string.remote_scan_hint),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = onClose) {
                    Text(stringResource(R.string.remote_close_button))
                }
            }
        }
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 16.dp, vertical = 20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            scanError?.let { message ->
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 12.dp),
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.surface.copy(alpha = 0.94f),
                    tonalElevation = 2.dp,
                ) {
                    Text(
                        text = message,
                        modifier = Modifier.padding(14.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
            Row(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (hasFlashUnit) {
                    FilledTonalButton(
                        onClick = {
                            val next = !torchEnabled
                            torchEnabled = next
                            cameraRef?.cameraControl?.enableTorch(next)
                        },
                    ) {
                        Icon(
                            painter = painterResource(R.drawable.ic_flashlight),
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(
                            text = stringResource(
                                if (torchEnabled) R.string.remote_scan_torch_on else R.string.remote_scan_torch_off,
                            ),
                        )
                    }
                }
                FilledTonalButton(
                    onClick = {
                        scanError = null
                        imagePickerLauncher.launch(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                        )
                    },
                ) {
                    Icon(
                        painter = painterResource(R.drawable.ic_photo_library),
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(text = stringResource(R.string.remote_scan_pick_image))
                }
            }
        }
    }
}

private fun scanQrFromImageUri(
    context: Context,
    scanner: BarcodeScanner,
    uri: Uri,
    onFound: (String) -> Unit,
    onNotFound: () -> Unit,
) {
    val inputImage = runCatching { InputImage.fromFilePath(context, uri) }.getOrNull()
    if (inputImage == null) {
        onNotFound()
        return
    }
    scanner.process(inputImage)
        .addOnSuccessListener { barcodes ->
            val rawValue = barcodes.firstNotNullOfOrNull { barcode ->
                barcode.rawValue?.takeIf { it.isNotBlank() }
            }
            if (rawValue != null) {
                onFound(rawValue)
            } else {
                onNotFound()
            }
        }
        .addOnFailureListener {
            onNotFound()
        }
}

/** 取景框：四角暗化 + 圆角描边窗口，纯 Canvas 绘制避免混合模式兼容问题。 */
@Composable
private fun QrViewfinderOverlay() {
    val frameColor = MaterialTheme.colorScheme.primary
    Canvas(modifier = Modifier.fillMaxSize()) {
        val frameSize = minOf(size.width, size.height) * 0.62f
        val left = (size.width - frameSize) / 2f
        val top = (size.height - frameSize) / 2f - 32.dp.toPx()
        val frameRect = Rect(Offset(left, top), Size(frameSize, frameSize))
        val dim = Color.Black.copy(alpha = 0.4f)
        drawRect(dim, size = Size(size.width, frameRect.top))
        drawRect(
            dim,
            topLeft = Offset(0f, frameRect.bottom),
            size = Size(size.width, size.height - frameRect.bottom),
        )
        drawRect(
            dim,
            topLeft = Offset(0f, frameRect.top),
            size = Size(frameRect.left, frameRect.height),
        )
        drawRect(
            dim,
            topLeft = Offset(frameRect.right, frameRect.top),
            size = Size(size.width - frameRect.right, frameRect.height),
        )
        drawRoundRect(
            color = frameColor,
            topLeft = frameRect.topLeft,
            size = frameRect.size,
            cornerRadius = CornerRadius(20.dp.toPx()),
            style = Stroke(width = 2.5.dp.toPx()),
        )
    }
}

@Composable
private fun RemoteQrCameraPreview(
    scanner: BarcodeScanner,
    onScanned: (String) -> Boolean,
    onCameraBound: (Camera) -> Unit,
    onCameraError: (String) -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val cameraExecutor = remember { Executors.newSingleThreadExecutor() }
    val consumed = remember { AtomicBoolean(false) }
    val disposed = remember { AtomicBoolean(false) }
    var cameraProvider by remember { mutableStateOf<ProcessCameraProvider?>(null) }

    DisposableEffect(Unit) {
        onDispose {
            disposed.set(true)
            cameraProvider?.unbindAll()
            scanner.close()
            cameraExecutor.shutdown()
        }
    }

    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { viewContext ->
            PreviewView(viewContext).apply {
                scaleType = PreviewView.ScaleType.FILL_CENTER
                implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                bindRemoteQrCamera(
                    context = context,
                    lifecycleOwner = lifecycleOwner,
                    previewView = this,
                    scanner = scanner,
                    cameraExecutor = cameraExecutor,
                    consumed = consumed,
                    disposed = disposed,
                    onProviderReady = { provider ->
                        cameraProvider = provider
                    },
                    onCameraBound = onCameraBound,
                    onScanned = { raw ->
                        val accepted = onScanned(raw)
                        if (!accepted) {
                            consumed.set(false)
                        }
                    },
                    onCameraError = onCameraError,
                )
            }
        },
    )
}

private fun bindRemoteQrCamera(
    context: Context,
    lifecycleOwner: LifecycleOwner,
    previewView: PreviewView,
    scanner: BarcodeScanner,
    cameraExecutor: ExecutorService,
    consumed: AtomicBoolean,
    disposed: AtomicBoolean,
    onProviderReady: (ProcessCameraProvider) -> Unit,
    onCameraBound: (Camera) -> Unit,
    onScanned: (String) -> Unit,
    onCameraError: (String) -> Unit,
) {
    val providerFuture = ProcessCameraProvider.getInstance(context)
    providerFuture.addListener(
        {
            val provider = runCatching { providerFuture.get() }
                .getOrElse { error ->
                    previewView.post {
                        onCameraError(
                            error.message ?: context.getString(R.string.remote_scan_camera_failed),
                        )
                    }
                    return@addListener
                }
            if (disposed.get()) {
                provider.unbindAll()
                return@addListener
            }

            onProviderReady(provider)
            val preview = Preview.Builder().build().also {
                it.surfaceProvider = previewView.surfaceProvider
            }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
                .also { imageAnalysis ->
                    imageAnalysis.setAnalyzer(cameraExecutor) { imageProxy ->
                        analyzeRemoteQrImage(
                            scanner = scanner,
                            imageProxy = imageProxy,
                            consumed = consumed,
                            previewView = previewView,
                            onScanned = onScanned,
                        )
                    }
                }

            runCatching {
                provider.unbindAll()
                val camera = provider.bindToLifecycle(
                    lifecycleOwner,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    analysis,
                )
                onCameraBound(camera)
            }.onFailure { error ->
                previewView.post {
                    onCameraError(
                        error.message ?: context.getString(R.string.remote_scan_camera_failed),
                    )
                }
            }
        },
        ContextCompat.getMainExecutor(context),
    )
}

private fun analyzeRemoteQrImage(
    scanner: BarcodeScanner,
    imageProxy: ImageProxy,
    consumed: AtomicBoolean,
    previewView: PreviewView,
    onScanned: (String) -> Unit,
) {
    if (consumed.get()) {
        imageProxy.close()
        return
    }

    val mediaImage = imageProxy.image
    if (mediaImage == null) {
        imageProxy.close()
        return
    }

    val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
    scanner.process(image)
        .addOnSuccessListener { barcodes ->
            val rawValue = barcodes.firstNotNullOfOrNull { barcode ->
                barcode.rawValue?.takeIf { it.isNotBlank() }
            }
            if (rawValue != null && consumed.compareAndSet(false, true)) {
                previewView.post {
                    onScanned(rawValue)
                }
            }
        }
        .addOnCompleteListener {
            imageProxy.close()
        }
}
