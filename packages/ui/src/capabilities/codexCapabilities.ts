import type { CodexFeatureCapabilities } from "@codez/shared";

export type CodexFeatureAvailability =
  | { readonly status: "supported" }
  | { readonly status: "degraded"; readonly reason: string }
  | { readonly status: "unsupported"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string };

export type CodexCapabilityProjection = Readonly<
  Record<keyof CodexFeatureCapabilities, CodexFeatureAvailability>
>;

const features = [
  "auxiliaryTextGeneration",
  "observedSessionUsage",
  "observedAppUsage",
  "sharedContextContentCopy",
  "scheduledPromptAutomations",
  "nativeBrowserCuaMcp",
  "readOnlyWorkflowHistory",
  "safeDesktopFileRewind",
  "legacyWorkflowRuns",
] as const satisfies readonly (keyof CodexFeatureCapabilities)[];

const unsupported = (feature: (typeof features)[number]): CodexFeatureAvailability => ({
  status: "unsupported",
  reason: `codex.capabilities.${String(feature)}.unsupported`,
});

export type CodexCapabilitySource =
  | { readonly available: false }
  | { readonly available: true; readonly codex?: unknown };

export function codexCapabilitySource(hello: { capabilities?: unknown }): CodexCapabilitySource {
  if (!hello.capabilities || typeof hello.capabilities !== "object") {
    return { available: false };
  }
  const capabilities = hello.capabilities as Record<string, unknown>;
  if (capabilities.codexUnavailable !== undefined) return { available: false };
  return {
    available: true,
    ...(capabilities.codex !== undefined ? { codex: capabilities.codex } : {}),
  };
}

export function projectCodexCapabilities(source: CodexCapabilitySource): CodexCapabilityProjection {
  if (source.available === false) {
    return Object.fromEntries(
      features.map((feature) => [
        feature,
        {
          status: "unavailable",
          reason: "codex.capabilities.unavailable",
        } satisfies CodexFeatureAvailability,
      ]),
    ) as CodexCapabilityProjection;
  }
  const capabilities = source.codex;
  const raw =
    capabilities === null || capabilities === undefined || typeof capabilities !== "object"
      ? {}
      : (capabilities as Record<string, unknown>);
  return Object.fromEntries(
    features.map((feature) => {
      const state = raw[feature];
      if (state === "supported")
        return [feature, { status: "supported" } satisfies CodexFeatureAvailability];
      if (state === "degraded")
        return [
          feature,
          {
            status: "degraded",
            reason: `codex.capabilities.${String(feature)}.degraded`,
          } satisfies CodexFeatureAvailability,
        ];
      return [feature, unsupported(feature)];
    }),
  ) as CodexCapabilityProjection;
}

export function codexCapabilityGate(availability: CodexFeatureAvailability): {
  hidden: boolean;
  disabled: boolean;
  degraded: boolean;
  reason: string | undefined;
} {
  if (availability.status === "supported")
    return { hidden: false, disabled: false, degraded: false, reason: undefined };
  if (availability.status === "unavailable")
    return { hidden: false, disabled: true, degraded: false, reason: availability.reason };
  if (availability.status === "degraded")
    return { hidden: false, disabled: false, degraded: true, reason: availability.reason };
  return { hidden: false, disabled: true, degraded: false, reason: availability.reason };
}
