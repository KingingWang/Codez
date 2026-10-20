# Codex desktop update_plan tool gating and projection

## Outcome

The existing `messageStreamShowTodos` setting ("显示待办") owns both halves of the
plan-tool feature on the Codex desktop runtime:

1. **Tool availability.** When the setting is enabled, the Host injects the
   native Codex `update_plan` tool into every app-server it spawns by adding
   `-c tools.update_plan.enabled=true` to the process argv. When disabled, no
   override is passed and Codex keeps its default (tool not registered).
2. **Presentation.** Native `turn/plan/updated` notifications are projected into
   the conversation as a todo tool-call row, rendered by the existing Todo card
   and gated by the same setting in the message stream.

Codex remains the execution authority: the bridge never stores plan state beyond
the live projection cache, never invents plan items for history, and never
retries or synthesizes plan updates.

## Ownership and event order

```text
Settings page → Host settingService.update (single write funnel)
            → observable onDidUpdate(keys includes messageStreamShowTodos)
            → dispose every active workspace runtime owned by this Host
            → next getClient lazily respawns bridge + app-server with new argv

agent spawn: resolveSpawnEnv reads setting.json
            → CODEZ_CODEX_UPDATE_PLAN_ENABLED=1 env (only when enabled)
            → bridge main → createCodexProcess({ updatePlanToolEnabled })
            → codex app-server -c tools.update_plan.enabled=true --listen stdio://

live turn:  codex update_plan call → EventMsg.PlanUpdate
            → app-server turn/plan/updated { threadId, turnId, explanation?, plan[] }
            → bridge ThreadStateStore.apply upserts one synthetic planUpdate item
            → projectRows → toolCall row (toolName "update_plan")
            → UI todo identity/renderer (existing) + messageStreamShowTodos gate
```

- The setting file (`~/.codez/v2/setting.json` on the spawning host) is the only
  source of truth. The bridge learns the flag once at process start from its
  env; it does not read settings and has no live update channel.
- Each Host restarts only workspace processes it owns. Hosts in other windows
  pick up the new value on their next natural spawn (there is no cross-process
  settings watcher; this matches the existing httpProxy spawn-env semantics).
- Disposal interrupts in-flight turns, identical to the existing model-switch
  workspace restart. The setting description states this.
- The env var is namespaced to the Codex bridge; legacy CLI runtimes ignore it,
  and the Host skips the forced restart entirely when the codex bridge runtime
  is not active.

## Bridge projection rules

- `turn/plan/updated` carries the full replacement plan (not a delta). The store
  upserts a single synthetic item `{ id: "plan-update", type: "planUpdate",
  plan: [...], explanation? }` into the addressed turn, replacing the previous
  content in place so the card keeps its first-seen position.
- Step status is normalized at the boundary: `pending`/`inProgress`/`completed`
  become `pending`/`in_progress`/`completed`. Steps without a usable title or
  recognizable status are dropped; a notification with no usable steps is
  ignored entirely. Malformed payloads must never fail the serialized event
  tail.
- The projection emits a `toolCall` row with `toolName: "update_plan"`,
  `status: "success"`, structured `input: { explanation?, plan }`, and no
  fabricated output. Todo extraction, icons, and the display gate are the
  existing shared/UI code paths (`tool-plan-adapter`, `TodoToolCallBlock`).
- Unknown turns, threads not loaded in this Host, and events arriving after a
  turn completed are still accepted: Codex emits plan updates only inside live
  turns, but the store treats late arrivals as ordinary upserts.
- Native history does not persist plan updates; reloading a thread drops the
  synthetic item. This transient-only presentation is intentional and matches
  the native authority boundary.

## Failure semantics

- Env absent or not `"1"`: no argv override; the tool is not registered and no
  `turn/plan/updated` is expected. If a user-side `config.toml` enables the tool
  anyway, events are still projected, and the message-stream display gate still
  applies (bridge projects native facts faithfully; it does not re-derive the
  setting).
- Bulk restart is best-effort: individual workspace disposal failures are
  logged and never fail the settings write.
- The synthetic item id lives in a bridge-owned namespace (`plan-update`) and
  cannot collide with native item ids.

## Acceptance scenarios

1. Setting enabled → bridge spawns app-server with
   `-c tools.update_plan.enabled=true`; a model `update_plan` call renders as a
   todo card in the message stream.
2. Setting disabled → no override in argv; the tool is absent from the model's
   tool set; no todo card is produced.
3. Toggling the setting disposes this Host's active workspace runtimes exactly
   once per write; respawned processes observe the new value.
4. Repeated `turn/plan/updated` events for one turn keep exactly one card whose
   content reflects the latest notification.
5. A malformed plan notification (missing steps, unknown status values) leaves
   the projection and event tail intact.
