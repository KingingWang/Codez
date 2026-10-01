// Native facts owned by the isolated Host fixture, never by the legacy registry.
import type { IPlatformService } from "@codez/shared";

export const platform = {
  openExternal: () => {
    throw new Error("External navigation forbidden");
  },
  showTaskNotification() {},
} as unknown as IPlatformService;

export const model = (name: string, isDefault = false) => ({
  id: `id-${name}`,
  model: name,
  displayName: name,
  description: "QA fixture",
  hidden: false,
  isDefault,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Balanced" },
    { reasoningEffort: "high", description: "Detailed" },
  ],
});

export const config = {
  config: {
    model: "native-model",
    model_provider: "native-provider",
    model_reasoning_effort: "medium",
    model_providers: {
      "native-provider": {
        name: "Native Provider",
        base_url: "http://127.0.0.1:9/v1",
        wire_api: "responses",
      },
      "unused-provider": {
        name: "Unused Provider",
        base_url: "http://127.0.0.1:9/v1",
        wire_api: "chat",
      },
      "referenced-provider": {
        name: "Referenced Provider",
        base_url: "http://127.0.0.1:9/v1",
        wire_api: "responses",
      },
    },
  },
  origins: {},
  layers: [
    { name: { type: "user", file: "/isolated/config.toml" }, version: "fixture-v1", config: {} },
  ],
};

export const otherWorkspaceConfig = {
  config: {
    model: "workspace-model",
    model_provider: "native-provider",
    model_reasoning_effort: "medium",
  },
  origins: {},
  layers: [
    {
      name: { type: "user", file: "/isolated/other-config.toml" },
      version: "fixture-v1",
      config: {},
    },
  ],
};

export const questions = [
  {
    id: "deployment-target",
    header: "Target",
    question: "Where should this run?",
    options: [
      { label: "Staging", description: "Isolated" },
      { label: "Production", description: "Not used" },
    ],
  },
  { id: "private-code", header: "Secret", question: "Enter fixture secret", isSecret: true },
];
