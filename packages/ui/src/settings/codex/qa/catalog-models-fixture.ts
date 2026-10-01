import type { CodezCatalogModelEntry } from "@codez/shared";

/** One native catalog model; test mutations stay in this injected Host fixture. */
export function createCatalogModelsFixture() {
  let model: CodezCatalogModelEntry = {
    slug: "second-model",
    provider: "referenced-provider",
  };
  let writes = 0;
  let disposals = 0;
  return {
    read: async () => ({ path: "/isolated/catalog.json", models: [model] }),
    write: async ({ model: next }: { model: CodezCatalogModelEntry }) => {
      model = next;
      writes++;
      return { path: "/isolated/catalog.json", models: [model] };
    },
    dispose: async () => {
      disposals++;
    },
    get writes() {
      return writes;
    },
    get visibility() {
      return model.visibility ?? "list";
    },
    get disposals() {
      return disposals;
    },
  };
}
