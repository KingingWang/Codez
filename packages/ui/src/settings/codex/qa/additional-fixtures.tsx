import { DesktopUpdateMenuFixture } from "./desktop-update-menu-fixture.js";
import { GeneralAccessibilityFixture } from "./general-accessibility-fixture.js";
import { RootProviderStartupFixture } from "./root-provider-startup-fixture.js";

export function AdditionalFixtures({ onInspect }: { onInspect: (value: unknown) => void }) {
  return (
    <>
      <DesktopUpdateMenuFixture onInspect={onInspect} />
      <RootProviderStartupFixture />
      <GeneralAccessibilityFixture />
    </>
  );
}
