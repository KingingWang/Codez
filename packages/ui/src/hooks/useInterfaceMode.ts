import { useCodezStoreWithDefault } from "@/store/StoreProvider.js";

export function useIsOfficeMode(): boolean {
  return useCodezStoreWithDefault((state) => state.interfaceMode === "office", false);
}
