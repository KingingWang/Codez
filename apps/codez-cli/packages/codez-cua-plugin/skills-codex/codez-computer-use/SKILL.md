---
name: codez-computer-use
description: "Use when a task needs to read or operate a native desktop app's own UI or the OS via Codez Desktop's native `codez-desktop-browser-cua` MCP tools (`cua_command` / `cua_status`). For anything inside a web page, prefer `browser_command`. Main agent only."
---
<!-- codez-managed-skill: codez-computer-use@codez-plugins-official -->

# Codez Computer Use (`codez-computer-use`)

Read or operate the UI of native desktop applications on the user's computer through the Desktop-owned `codez-desktop-browser-cua` MCP tools (`cua_status` and `cua_command`).

- Prefer a dedicated connector, API, CLI, or skill when one can complete the task directly.
- For in-app browser and web-page tasks, use `browser_command` on the same `codez-desktop-browser-cua` MCP server instead of Computer Use.
- Do not use AppleScript, `osascript`, JXA, System Events, shell commands, or any other UI-automation technology unless the user explicitly asks for that technology.
- Do not look for `mcp__node_repl__js` or `@oai/sky`; in Codez Desktop with Codex, call `cua_status` and `cua_command` directly.
- Main agent only. Never delegate Computer Use to a subagent.

## Accessibility First

Accessibility is the primary action path. It is semantic, precise, works on background apps, and does not steal the user's focus.

1. **Observe first**: Call `cua_command` with `method: "get_app_state"` and `app_ref` to inspect the accessibility tree (and element indices) before acting.
2. **Act by element index**: When a matching element exists in the returned tree, pass its integer `index` as `target` (for example `{"method": "left_click", "target": 7, "app_ref": {"name": "Notes"}}`). For a control that advertises a semantic action in the tree, use `method: "perform_action"`.
3. **Prefer `set_value` for inputs**: For a settable text field or control, prefer `method: "set_value"` over `type` or `paste`. Reach for `paste` only when the target is not settable or the content is multiline/formatted (`"text" | "md" | "html"`).
4. **Keyboard and coordinates as fallbacks**: Use `method: "key"` only when no element expresses the operation or the user asked for keyboard interaction. Use screenshot coordinates (`include_screenshot: true` on `get_app_state`, then `target: [x, y]`) only as the last fallback for canvas, games, or custom surfaces that accessibility cannot see.

Do not replace an available element action with a keyboard shortcut just because the shortcut is shorter. Do not run both the accessibility and visual paths for the same action.

Observation works on background apps, screenshots included. Success from an action call means the runtime accepted the input, not that the UI finished updating—verify the resulting state (either via `return_state: "compact"` on the action call or a closing `get_app_state` call) before concluding.

## Tool Surface

All Computer Use operations are exposed by two MCP tools on `codez-desktop-browser-cua`:

### 1. `cua_status`

Takes `{}`. Returns whether the local Desktop Computer Use runtime and permissions are available. If unavailable or permissions are missing, call `cua_command` with `{"method": "request_access"}` or guide the user to enable Computer Use / grant permissions in Codez Settings.

### 2. `cua_command`

Takes a single flat JSON object with a required `method` field:

- `list_apps`: `{"method": "list_apps"}`
- `list_windows`: `{"method": "list_windows", "app_ref": {"name": "Notes"}}`
- `get_app_state`: `{"method": "get_app_state", "app_ref": {"name": "Notes"}, "include_screenshot": false, "disable_diffing": false}`
- `left_click`: `{"method": "left_click", "target": 7, "mouse_button": "left", "click_count": 1, "modifiers": "", "strategy": "auto", "app_ref": {"name": "Notes"}, "return_state": "compact"}`
- `left_click_drag`: `{"method": "left_click_drag", "from_target": 7, "to": [120, 240], "modifiers": "", "app_ref": {"name": "Notes"}, "return_state": "compact"}`
- `scroll`: `{"method": "scroll", "target": 7, "scroll_direction": "down", "scroll_amount": 1, "strategy": "auto", "app_ref": {"name": "Notes"}, "return_state": "compact"}`
- `type`: `{"method": "type", "text": "hello", "target": 7, "app_ref": {"name": "Notes"}, "strategy": "auto", "return_state": "compact"}`
- `set_value`: `{"method": "set_value", "target": 7, "value": "hello", "strategy": "auto", "app_ref": {"name": "Notes"}, "return_state": "compact"}`
- `select_text`: `{"method": "select_text", "target": 7, "text_range": [0, 5], "app_ref": {"name": "Notes"}, "return_state": "compact"}`
- `key`: `{"method": "key", "text": "Return", "repeat": 1, "hold_seconds": 0, "app_ref": {"name": "Notes"}, "strategy": "auto", "return_state": "compact"}`
- `paste`: `{"method": "paste", "text": "hello", "format": "text", "app_ref": {"name": "Notes"}, "return_state": "compact"}`
- `perform_action`: `{"method": "perform_action", "target": 7, "action": "AXPress", "app_ref": {"name": "Notes"}, "return_state": "compact"}`
- `request_access`: `{"method": "request_access", "capabilities": ["accessibility", "screen_recording"]}`
- `stop_computer_control`: `{"method": "stop_computer_control", "reason": "..."}`

### Strict Argument Rules

- **`app_ref`**: Must be an object `{ "name"?: string, "bundle_id"?: string, "pid"?: number, "window_id"?: number }` with at least one of `name`, `bundle_id`, or `pid`.
  - When the user names an application, copy it character-for-character into `app_ref.name`. Do not translate, localize, normalize, or strip suffixes (`{"name": "日历"}` is not `{"name": "Calendar"}`).
  - If the exact string does not resolve, call `{"method": "list_apps"}` once and pick the matching `bundle_id` or `pid`.
  - `get_app_state` automatically launches the target app if it is not running; there is no separate launch tool.
- **`target`, `from_target`, `to`**: Must be literal JSON values—never quote or JSON-stringify them:
  - Nonnegative integer element index: `7`
  - Two-integer coordinate tuple from the latest screenshot raster: `[40, 60]`
  - Explicit element object: `{"type": "element", "index": 7}`
  - Explicit coordinate object: `{"type": "coordinate", "x": 40, "y": 60, "frame_id"?: "..."}`
  - Strings such as `"7"` or `"[40,60]"` are rejected by validation.
- **`return_state`**: Pass `"compact"` (or `"full"`) on action calls to receive the updated accessibility state in the same tool call and avoid an extra round-trip.

## The Loop, Coordinates, and Keyboard

- **Observe → Act → Verify**: An element index addresses that app's latest observation. Every new observation (`get_app_state` or `return_state: "compact" | "full"`) renumbers the tree, so always take indices from the newest returned tree.
- **Windows & Modals**: Without `window_id`, the main/key window is resolved on each observation, so a newly opened dialog becomes the captured window. Check the returned `window` header; pin a specific window with `{"pid": ..., "window_id": ...}` from `list_windows` when needed.
- **Coordinates**: Choose `x` and `y` only from the current returned screenshot raster (`0 <= x < width`, `0 <= y < height`). Never copy diagnostic global screen bounds from the accessibility tree into a coordinate target.
- **Keyboard (`key`)**: Accepts a key name or `+`-separated chord (`"a"`, `"Return"`, `"Tab"`, `"cmd+c"` on macOS, `"ctrl+c"` on Windows/Linux, `"Up"`). Always pass `app_ref` so keyboard input is bound to the target app.
- **No artificial sleeps**: Observations automatically wait for the UI to settle. Do not run shell `sleep` commands between actions.

## Errors and Stopping

- `CONTROLLER_BUSY` means another live Codez Computer Use session owns input. It is never retryable: report the owner from the error and ask the user to close that session.
- Stop immediately after `stop_computer_control`, a kill switch, a permission refusal (`PERMISSION_DENIED`, `NOT_AUTHORIZED`), or a non-retryable error. Do not fall back to `osascript` or shell UI automation after an access refusal.
