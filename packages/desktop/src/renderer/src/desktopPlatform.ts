import { recordArmsCustomEventForE2E } from "@codez/ui";
import { DesktopCommandIds, buildLocalMediaPreviewUrl, type IPlatformService } from "@codez/shared";

import { desktopBrowserPlatformBridge } from "./desktopBrowserPlatformBridge.js";

export function createDesktopPlatform(options: {
  isLocalDevelopmentRuntime: boolean;
}): IPlatformService {
  return {
    canSelectFilePath: true,
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
    isLocalDevelopmentRuntime: options.isLocalDevelopmentRuntime,
    selectDirectory: () => window.codez.selectDirectory(),
    selectFile: () => window.codez.selectFile(),
    selectFiles: () => window.codez.selectFiles?.() ?? Promise.resolve([]),
    createTempTextAttachment: (payload) => window.codez.createTempTextAttachment(payload),
    onRemoteConnectionLog: (handler) => window.codez.onRemoteConnectionLog(handler),
    onRemoteSessionClosed: (handler) => window.codez.onRemoteSessionClosed(handler),
    onBotRemoteWorkspaceReconnected: (handler) =>
      window.codez.onBotRemoteWorkspaceReconnected(handler),
    activateOrSetWorkspace: (path) =>
      window.codez.activateOrSetWorkspace?.(path) ?? Promise.resolve({ activated: false }),
    connectRemote: (remoteOptions, requestId, context) =>
      window.codez.connectRemote(remoteOptions, requestId, context),
    cancelPendingRemoteConnection: (requestId) =>
      window.codez.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve(),
    bindRemoteWorkspaceSessionContext: (context) =>
      window.codez.bindRemoteWorkspaceSessionContext?.(context) ?? Promise.resolve(),
    disposeRemoteSession: (sessionId) => window.codez.disposeRemoteSession(sessionId),
    isDockerAvailable: () => window.codez.isDockerAvailable(),
    listWSLDistros: () => window.codez.listWSLDistros(),
    listDockerContainers: () => window.codez.listDockerContainers(),
    listSSHConfigAliases: () => window.codez.listSSHConfigAliases(),
    loadMcpFromUserDirectory: (payload) => window.codez.loadMcpFromUserDirectory(payload),
    saveMcpToUserDirectory: (payload) => window.codez.saveMcpToUserDirectory(payload),
    migrateLegacyCommonMcp: (payload) => window.codez.migrateLegacyCommonMcp(payload),
    openExternal: (url) => window.codez.openExternal(url),
    openFeedback: () => window.codez.executeDesktopCommand(DesktopCommandIds.OpenFeedback),
    openCommunity: () => window.codez.executeDesktopCommand(DesktopCommandIds.OpenCommunity),
    canOpenCommunity: (locale) => window.codez.canOpenCommunity(locale),
    openInFileManager: (path) => window.codez.openInFileManager(path),
    openExternalFile: (path) => window.codez.openExternalFile(path),
    openCuaPermissionOnboarding: window.codez.openCuaPermissionOnboarding
      ? (permissionOptions) =>
          window.codez.openCuaPermissionOnboarding?.(permissionOptions) ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    prepareCuaHelperPermissionDrag: window.codez.prepareCuaHelperPermissionDrag
      ? () =>
          window.codez.prepareCuaHelperPermissionDrag?.() ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    startCuaHelperPermissionDrag: window.codez.startCuaHelperPermissionDrag
      ? () => window.codez.startCuaHelperPermissionDrag?.()
      : undefined,
    registerOAuthState: (payload) => window.codez.registerOAuthState(payload),
    onOAuthCallback: (callback) => window.codez.onOAuthCallback(callback),
    onPaymentCallback: (callback) => window.codez.onPaymentCallback(callback),
    onShareImport: (callback) => window.codez.onShareImport?.(callback) ?? (() => {}),
    notifyRendererReady: () => window.codez.notifyRendererReady(),
    reportTelemetryEvent: (payload) => window.codez.reportTelemetryEvent(payload),
    reportArmsCustomEvent: (payload) => {
      recordArmsCustomEventForE2E(payload);
      return window.codez.reportArmsCustomEvent(payload);
    },
    getRendererActionTraceConfig: window.codez.getRendererActionTraceConfig
      ? () => window.codez.getRendererActionTraceConfig!()
      : undefined,
    onRendererActionTraceConfigChanged: window.codez.onRendererActionTraceConfigChanged
      ? (callback) => window.codez.onRendererActionTraceConfigChanged!(callback)
      : undefined,
    reportLocalTtftBatch: (batch) => window.codez.reportLocalTtftBatch(batch),
    reportRendererActionTraceBatch: window.codez.reportRendererActionTraceBatch
      ? (batch) => window.codez.reportRendererActionTraceBatch!(batch)
      : undefined,
    reportRendererHeapSample: window.codez.reportRendererHeapSample
      ? (sample) => window.codez.reportRendererHeapSample!(sample)
      : undefined,
    showTaskNotification: (payload) => window.codez.showTaskNotification(payload),
    syncWindowTabs: (paths) => window.codez.syncWindowTabs(paths),
    syncWindowUnreadCount: (count) => window.codez.syncWindowUnreadCount(count),
    syncActiveTaskSession: (sessionId) => window.codez.syncActiveTaskSession(sessionId),
    syncAppSettings: (patch) => window.codez.syncAppSettings?.(patch),
    setShortcutRecordingActive: (active) => window.codez.setShortcutRecordingActive?.(active),
    onFocusTab: (handler) => window.codez.onFocusTab(handler),
    onNewTab: (handler) => window.codez.onNewTab(handler),
    onCloseActiveContextRequest: (handler) =>
      window.codez.onCloseActiveContextRequest?.(handler) ?? (() => {}),
    onOpenBrowserUrl: (handler) => window.codez.onOpenBrowserUrl?.(handler) ?? (() => {}),
    onBrowserViewScreenshotSurfacePrepare: (handler) =>
      window.codez.onBrowserViewScreenshotSurfacePrepare?.(handler) ?? (() => {}),
    onBrowserViewScreenshotSurfaceRelease: (handler) =>
      window.codez.onBrowserViewScreenshotSurfaceRelease?.(handler) ?? (() => {}),
    browserViewScreenshotSurfaceReady: (payload) =>
      window.codez.browserViewScreenshotSurfaceReady?.(payload),
    ...desktopBrowserPlatformBridge,
    onNewTask: (handler) => window.codez.onNewTask(handler),
    onOpenWorkspace: (handler) => {
      // 开发态或升级后的旧窗口可能仍运行未暴露 onOpenWorkspace 的 preload，
      // renderer 直接调用会在启动时崩溃。这里和 activateOrSetWorkspace 一样做兼容兜底，
      // 缺少该 bridge 时只禁用原生菜单回调，不影响应用继续打开。
      return window.codez.onOpenWorkspace?.(handler) ?? (() => {});
    },
    onOpenWorkspacePath: (handler) => window.codez.onOpenWorkspacePath?.(handler) ?? (() => {}),
    onOpenFeedbackDialog: (handler) => window.codez.onOpenFeedbackDialog?.(handler) ?? (() => {}),
    onOpenTicketsPanel: (handler) => window.codez.onOpenTicketsPanel?.(handler) ?? (() => {}),
    onWindowFullscreenChanged: (handler) => window.codez.onWindowFullscreenChanged(handler),
    getDesktopWindowChromeState: window.codez.getDesktopWindowChromeState
      ? () => window.codez.getDesktopWindowChromeState!()
      : undefined,
    onDesktopWindowChromeStateChanged: window.codez.onDesktopWindowChromeStateChanged
      ? (handler) => window.codez.onDesktopWindowChromeStateChanged!(handler)
      : undefined,
    getWindowControlsOverlayMetrics: () => window.codez.getWindowControlsOverlayMetrics?.() ?? null,
    onWindowControlsOverlayChanged: (handler) =>
      window.codez.onWindowControlsOverlayChanged?.(handler) ?? (() => {}),
    getDesktopZoomLevel: () =>
      window.codez.getDesktopZoomLevel?.() ?? Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: (handler) =>
      window.codez.onDesktopZoomLevelChanged?.(handler) ?? (() => {}),
    onTaskNotificationClick: (handler) => window.codez.onTaskNotificationClick(handler),
    exportLogs: () => window.codez.exportLogs(),
    captureWindowScreenshot: () =>
      window.codez.captureWindowScreenshot?.() ?? Promise.resolve(null),
    onUpdateReady: (callback) => window.codez.onUpdateReady(callback),
    onUpdateCheckResult: (callback) => window.codez.onUpdateCheckResult(callback),
    onUpdateStateChanged: (callback) => window.codez.onUpdateStateChanged?.(callback) ?? (() => {}),
    getUpdateState: () =>
      window.codez.getUpdateState?.() ?? Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => window.codez.downloadUpdate?.() ?? Promise.resolve(),
    cancelUpdateDownload: () => window.codez.cancelUpdateDownload?.() ?? Promise.resolve(),
    openUpdateStatusWindow: () => window.codez.openUpdateStatusWindow?.() ?? Promise.resolve(),
    getAutoUpdatePreferences: () =>
      window.codez.getAutoUpdatePreferences?.() ??
      Promise.resolve({ autoDownloadAndInstallUpdates: false }),
    setAutoDownloadAndInstallUpdates: (enabled) =>
      window.codez.setAutoDownloadAndInstallUpdates?.(enabled) ?? Promise.resolve(),
    getDesktopSessionActivity: () =>
      window.codez.getDesktopSessionActivity?.() ??
      Promise.resolve({ runningAgentSessionCount: 0 }),
    getCodezStdioTapDevState: () =>
      window.codez.getCodezStdioTapDevState?.() ??
      Promise.resolve({ enabled: false, visible: false, logDir: "", statePath: "" }),
    onSettingsChanged: (callback) => window.codez.onSettingsChanged?.(callback) ?? (() => {}),
    onApplicationLocaleChanged: (callback) =>
      window.codez.onApplicationLocaleChanged?.(callback) ?? (() => {}),
    onPostUpdateReleaseNotes: (callback) => window.codez.onPostUpdateReleaseNotes(callback),
    acknowledgePostUpdateReleaseNotes: (version) =>
      window.codez.acknowledgePostUpdateReleaseNotes(version),
    skipUpdateVersion: (version) => window.codez.skipUpdateVersion?.(version) ?? Promise.resolve(),
    quitAndInstallUpdate: () => window.codez.quitAndInstallUpdate(),
    getInstalledEditors: () => window.codez.getInstalledEditors(),
    getApplicationIcon: (bundleId) =>
      window.codez.getApplicationIcon?.(bundleId) ?? Promise.resolve(null),
    openInEditor: (editorId, path, editorOptions) =>
      window.codez.openInEditor(editorId, path, editorOptions),
    executeDesktopCommand: (command) => window.codez.executeDesktopCommand(command),
    setApplicationLocale: (locale) => window.codez.setApplicationLocale(locale),
    getSystemLocale: () =>
      window.codez.getSystemLocale?.() ??
      Promise.resolve(navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"),
    setTitleBarTheme: (theme) => window.codez.setTitleBarTheme(theme),
    getDeviceId: () =>
      (window as Window & { __CODEZ_DEVICE_ID__?: string }).__CODEZ_DEVICE_ID__ ?? "",
  };
}
