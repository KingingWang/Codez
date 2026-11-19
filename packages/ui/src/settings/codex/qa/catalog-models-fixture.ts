import type { CodezCatalogModelEntry } from "@codez/shared";

/** One native catalog model; test mutations stay in this injected Host fixture. */
export function createCatalogModelsFixture() {
  let model: CodezCatalogModelEntry = {
    slug: "second-model",
    provider: "referenced-provider",
  };
  let writes = 0;
  let disposals = 0;
  let originalSlugRenames = 0;
  let lastWrite: { model: CodezCatalogModelEntry; originalSlug?: string } | null = null;
  let failNextDisposal = false;
  let releaseWrite: (() => void) | undefined;
  let heldWrite: Promise<void> | undefined;
  let releaseDisposal: (() => void) | undefined;
  let heldDisposal: Promise<void> | undefined;
  return {
    read: async () => ({ path: "/isolated/catalog.json", models: [model] }),
    write: async ({
      model: next,
      originalSlug,
    }: {
      model: CodezCatalogModelEntry;
      originalSlug?: string;
    }) => {
      await heldWrite;
      heldWrite = undefined;
      if (originalSlug !== undefined && next.slug !== originalSlug) originalSlugRenames++;
      lastWrite = { model: next, originalSlug };
      model = next;
      writes++;
      return { path: "/isolated/catalog.json", models: [model] };
    },
    dispose: async () => {
      if (failNextDisposal) {
        failNextDisposal = false;
        throw new Error("Fixture app-server restart rejected");
      }
      disposals++;
      await heldDisposal;
      heldDisposal = undefined;
    },
    rejectNextDisposal: () => {
      failNextDisposal = true;
    },
    holdWrite: () => {
      heldWrite = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
    },
    releaseWrite: () => releaseWrite?.(),
    holdDisposal: () => {
      heldDisposal = new Promise<void>((resolve) => {
        releaseDisposal = resolve;
      });
    },
    releaseDisposal: () => releaseDisposal?.(),
    get writes() {
      return writes;
    },
    get visibility() {
      return model.visibility ?? "list";
    },
    get disposals() {
      return disposals;
    },
    get originalSlugRenames() {
      return originalSlugRenames;
    },
    get lastWrite() {
      return lastWrite;
    },
  };
}
