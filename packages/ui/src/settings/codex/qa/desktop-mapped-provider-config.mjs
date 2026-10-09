// 原生目录夹具：模型实际属于 ui_qa，配置 provider 没有可见模型；全部端点只指向本机。
export function createMappedProviderQaConfig(catalogPath, baseUrl) {
  const model = (slug, priority) => ({
    slug,
    provider: "ui_qa",
    display_name: slug === "glm-5.3" ? "GLM-5.3" : slug,
    description: "Isolated mapped-provider QA",
    base_instructions: "Reply briefly to the isolated QA input. Do not use tools.",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "medium", description: "Balanced" },
      { effort: "high", description: "Detailed" },
    ],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    support_verbosity: false,
    truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [],
    input_modalities: ["text"],
  });
  return {
    catalog: { models: [model("glm-5.3", 0), model("ui-qa-second", 1)] },
    config: [
      'model_provider = "ui_qa_config"',
      'model = "glm-5.3"',
      'model_reasoning_effort = "high"',
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      ...["ui_qa_config", "ui_qa"].flatMap((provider) => [
        `[model_providers.${provider}]`,
        'name = "Isolated mapped-provider QA"',
        `base_url = "${baseUrl}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "request_max_retries = 0",
      ]),
      "[analytics]",
      "enabled = false",
      "",
    ].join("\n"),
  };
}
