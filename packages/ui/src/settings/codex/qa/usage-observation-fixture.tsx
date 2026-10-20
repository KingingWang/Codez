import { useMemo, useRef, useState } from "react";
import type { IServiceAccessor } from "@codez/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { CodexOnlyUsagePanel } from "@/settings/usage-stats/CodexOnlyUsagePanel.js";
import { Button } from "@/components/ui/button.js";

interface PendingRead {
  generation: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** Same workspace identity, different Host service generation with out-of-order completions. */
export function UsageObservationRaceFixture() {
  const [mounted, setMounted] = useState(false);
  const [generation, setGeneration] = useState(0);
  const pending = useRef<PendingRead[]>([]);
  const services = useMemo(
    () =>
      ({
        usageStatsService: {
          getCodexUsageObservations: () =>
            new Promise((resolve, reject) => {
              pending.current.push({ generation, resolve, reject });
            }),
        },
      }) as unknown as IServiceAccessor,
    [generation],
  );
  function finish(target: number, fail: boolean) {
    const index = pending.current.findIndex((read) => read.generation === target);
    if (index < 0) throw new Error(`Expected pending read for Host generation ${target}`);
    const [read] = pending.current.splice(index, 1);
    if (!read) throw new Error(`Missing pending read for Host generation ${target}`);
    if (fail) read.reject(new Error("stale Host read failed"));
    else
      read.resolve({
        threads: [
          {
            threadId: `thread-${target}`,
            observation: { payload: { inputTokens: target * 10 + 20 } },
            conflict: false,
          },
        ],
        stale: false,
        conflict: false,
      });
  }
  return (
    <section data-testid="usage-race-fixture">
      <Button onClick={() => setMounted(true)}>Mount usage race</Button>
      <Button onClick={() => setGeneration((value) => value + 1)}>Advance usage Host</Button>
      <Button onClick={() => finish(generation, false)}>Complete current usage read</Button>
      <Button onClick={() => finish(generation - 1, false)}>Complete stale usage read</Button>
      <Button onClick={() => finish(generation - 1, true)}>Reject stale usage read</Button>
      {mounted ? (
        <ServiceProvider services={services}>
          <CodexOnlyUsagePanel workspacePath="/isolated/workspace" />
        </ServiceProvider>
      ) : null}
    </section>
  );
}
