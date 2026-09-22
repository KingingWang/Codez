import { Button } from "@/components/ui/button.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { CodexSettingsSection } from "./CodexSettingsSection.js";
import { useCodexMessages } from "./messages.js";

export function CodexWelcomePanel({ onContinue }: { onContinue: () => void }) {
  const text = useCodexMessages();
  const workspacePath = useTabStore((state) => state.activeWorkspacePath);
  const workspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity ?? undefined);
  return (
    <div className="space-y-4">
      <CodexSettingsSection
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        onboarding
      />
      <Button className="w-full" variant="outline" onClick={onContinue}>
        {text.continue}
      </Button>
    </div>
  );
}
