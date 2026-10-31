/** 原 PiP coordinator/presenter 的适配边界。 */
export const cuaPipModule = {
  id: "cua-pip",
  requires: ["codez-cua"],
  provides: ["pip-presentation"],
  publicEntrypoints: ["contract.ts"],
} as const;
