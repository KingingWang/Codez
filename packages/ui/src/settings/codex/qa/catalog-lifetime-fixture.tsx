import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useCodexModelCatalog, type CodexModelCatalogRead } from "@/hooks/useCodexModelCatalog.js";

let hold = false;
const pending: (() => void)[] = [];
export async function waitForCatalogFixture(): Promise<void> {
  if (hold) await new Promise<void>((resolve) => pending.push(resolve));
}

type Reader = CodexModelCatalogRead["readCurrent"];
function Probe({ capture }: { capture: (reader: Reader) => void }) {
  const catalog = useCodexModelCatalog({ workspacePath: "/isolated/lifetime", enabled: true });
  useEffect(() => {
    capture(catalog.readCurrent);
  }, [capture, catalog.readCurrent]);
  return <output data-testid="lifetime-status">{catalog.status}</output>;
}

/** Browser-only fault controls. No credentials, native state, timers or production imports. */
export function CatalogLifetimeControls({
  read,
  output,
}: {
  read: CodexModelCatalogRead;
  output: (value: unknown) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const captured = useRef<Reader | null>(null);
  const lifetime = useRef<Reader | null>(null);
  const capture = useRef((reader: Reader) => {
    lifetime.current = reader;
  }).current;
  const check = async (reader: Reader | null) => {
    try {
      if (!reader) throw new Error("Reader was not captured");
      await reader();
      output({ readerResult: "ready" });
    } catch {
      output({ readerResult: "stale" });
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        onClick={async () =>
          output({ catalogSelection: (await read.readCurrent()).preferredSelection })
        }
      >
        Inspect catalog
      </Button>
      <Button
        onClick={() => {
          captured.current = read.readCurrent;
        }}
      >
        Capture reader
      </Button>
      <Button
        onClick={() => {
          void check(captured.current);
        }}
      >
        Read captured
      </Button>
      <Button
        onClick={() => {
          read.reload();
          void check(read.readCurrent);
        }}
      >
        Invalidate and read
      </Button>
      <Button
        onClick={() => {
          hold = true;
          setMounted(true);
        }}
      >
        Mount held catalog
      </Button>
      <Button onClick={() => setMounted(true)}>Mount ready catalog</Button>
      <Button onClick={() => setMounted(false)}>Unmount catalog</Button>
      <Button
        onClick={() => {
          void check(lifetime.current);
        }}
      >
        Read lifetime catalog
      </Button>
      <Button
        onClick={() => {
          hold = false;
          for (const release of pending.splice(0)) release();
        }}
      >
        Release catalog
      </Button>
      {mounted && <Probe capture={capture} />}
    </div>
  );
}
