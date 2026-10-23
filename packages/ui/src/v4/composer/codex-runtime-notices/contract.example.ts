import { createElement, type ReactElement } from "react";
import { CodexRuntimeNotices } from "./CodexRuntimeNotices.js";
import type { CodexRuntimeNoticesProps } from "./contract.js";

/** Composer 直接消费 snapshot.runtimeNotices；空数组由组件投影为空。 */
export function exampleCodexRuntimeNotices(props: CodexRuntimeNoticesProps): ReactElement {
  return createElement(CodexRuntimeNotices, props);
}
