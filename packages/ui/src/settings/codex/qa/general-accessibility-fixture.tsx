import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  AgentBehaviorSectionContent,
  GeneralSectionContent,
  TaskAutoArchiveSettings,
} from "@/settingsPageHelpers.js";

const noopAsync = async () => {};

export function GeneralAccessibilityFixture() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [archive, setArchive] = useState(false);
  return (
    <section aria-label="General accessibility fixture">
      <Button onClick={() => setOpen((current) => !current)}>
        Toggle General accessibility fixture
      </Button>
      {open ? (
        <div data-testid="qa-general-controls">
          <GeneralSectionContent
            localePreference="en-US"
            notificationEnabled={notifications}
            notificationSoundEnabled={false}
            closeToTrayOnWindows={false}
            receivePreviewUpdates={false}
            autoDownloadAndInstallUpdates={false}
            dataBaseDir="/isolated"
            terminalInheritSystemProfile
            terminalFontFamily=""
            defaultHomeDir="/isolated"
            isDesktop
            isWindowsDesktop
            showIntegratedTerminalShell
            setLocalePreference={() => {}}
            setNotificationEnabled={setNotifications}
            setNotificationSoundEnabled={() => {}}
            onDataBaseDirChange={noopAsync}
            onSelectDataBaseDir={async () => null}
            onTerminalInheritSystemProfileChange={noopAsync}
            onTerminalFontFamilyChange={noopAsync}
            onCloseToTrayOnWindowsChange={noopAsync}
            onReceivePreviewUpdatesChange={noopAsync}
            onAutoDownloadAndInstallUpdatesChange={noopAsync}
            onOpenOnboardingDialog={() => {}}
          />
          {/* 上游 3.18 把 Agent 行为偏好从通用区拆到独立区；夹具跟随当前公开控件，
              不再验收已被上游删除的工具分组开关。 */}
          <AgentBehaviorSectionContent
            nativeSearchEnhancementsEnabled
            messageStreamShowReasoning
            messageStreamShowTodos={false}
            codezInteractionBehavior="queue"
            onToolSearchModeChange={noopAsync}
            onNativeSearchEnhancementsEnabledChange={noopAsync}
            onMessageStreamShowReasoningChange={noopAsync}
            onMessageStreamShowTodosChange={noopAsync}
            onCodezInteractionBehaviorChange={noopAsync}
          />
          {/* 上游已把归档偏好移到独立设置区；夹具仍验收同一组公开控件，不恢复旧通用页实现。 */}
          <TaskAutoArchiveSettings
            taskAutoArchiveEnabled={archive}
            taskAutoArchiveOlderThanDays={7}
            onTaskAutoArchiveEnabledChange={async (enabled) => setArchive(enabled)}
            onTaskAutoArchiveOlderThanDaysChange={noopAsync}
          />
        </div>
      ) : null}
    </section>
  );
}
