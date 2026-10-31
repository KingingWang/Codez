import type * as Ordering from "../pluginStoreOrdering.js";

/** 纯展示规则；完整插件身份和排序配置沿用当前 shared 类型。 */
export interface PluginStoreOrderingContract {
  readonly compareDocumentPluginPriority: typeof Ordering.compareDocumentPluginPriority;
  readonly resolvePluginStoreCategory: typeof Ordering.resolvePluginStoreCategory;
  readonly sortPluginStoreEntries: typeof Ordering.sortPluginStoreEntries;
}
