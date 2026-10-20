import { CODEZ_PRODUCT_FLAVOR } from "@codez/shared";
import { Button } from "@/components/ui/button.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { desktopCommands } from "./harnessConfig.js";

export function DesktopUpdateMenuFixture({ onInspect }: { onInspect: (ids: string[]) => void }) {
  return (
    <>
      <span data-testid="qa-product-flavor">{CODEZ_PRODUCT_FLAVOR}</span>
      <div data-testid="qa-desktop-help">
        <WorkspaceHelpMenuButton isDesktop />
      </div>
      <div data-testid="qa-web-help">
        <WorkspaceHelpMenuButton />
      </div>
      <Button onClick={() => onInspect([...desktopCommands])}>Inspect desktop commands</Button>
    </>
  );
}
