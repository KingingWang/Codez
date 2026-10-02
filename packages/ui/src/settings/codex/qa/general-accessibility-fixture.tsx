import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { GeneralSectionContent } from "@/settingsPageHelpers.js";

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
            nativeSearchEnhancementsEnabled
            defaultHomeDir="/isolated"
            isDesktop
            isWindowsDesktop
            showIntegratedTerminalShell
            setLocalePreference={() => {}}
            setNotificationEnabled={setNotifications}
            setNotificationSoundEnabled={() => {}}
            taskAutoArchiveEnabled={archive}
            taskAutoArchiveOlderThanDays={7}
            messageStreamShowReasoning
            messageStreamShowTodos={false}
            toolGroupingExploreEnabled
            toolGroupingTerminalEnabled
            toolGroupingChangesEnabled={false}
            codezInteractionBehavior="queue"
            onDataBaseDirChange={noopAsync}
            onSelectDataBaseDir={async () => null}
            onTerminalInheritSystemProfileChange={noopAsync}
            onTerminalFontFamilyChange={noopAsync}
            onNativeSearchEnhancementsEnabledChange={noopAsync}
            onTaskAutoArchiveEnabledChange={async (enabled) => setArchive(enabled)}
            onTaskAutoArchiveOlderThanDaysChange={noopAsync}
            onCloseToTrayOnWindowsChange={noopAsync}
            onReceivePreviewUpdatesChange={noopAsync}
            onAutoDownloadAndInstallUpdatesChange={noopAsync}
            onMessageStreamShowReasoningChange={noopAsync}
            onMessageStreamShowTodosChange={noopAsync}
            onToolGroupingExploreEnabledChange={noopAsync}
            onToolGroupingTerminalEnabledChange={noopAsync}
            onToolGroupingChangesEnabledChange={noopAsync}
            onCodezInteractionBehaviorChange={noopAsync}
            onOpenOnboardingDialog={() => {}}
          />
        </div>
      ) : null}
    </section>
  );
}
