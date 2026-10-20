# Codex shared context content copy

## Outcome

Codex receives imported shared context as ordinary visible text. The renderer keeps submitting only the opaque `shared_context_import.context_id` reference. An authorized Host-side resolver expands that reference from persistent imported-share provenance for the current workspace and session before the command is forwarded to the Codex bridge. The bridge never receives `context_refs`.

This is content-copy degradation, not native shared-context parity. Once a command is admitted, later source changes do not propagate and there is no reference semantics in Codex.

## Ownership and event order

```text
Composer draft → sendText.context_refs (opaque context id)
              → Host authorized resolver
                 1. validate current workspace/session and all refs
                 2. read and validate persisted imported-share copies
                 3. format every context into one visible block
                 4. replace text and delete context_refs atomically
              → single Codex bridge command
```

- The renderer never supplies paths or formatted content and cannot authorize a context.
- `ConversationShareService`/equivalent Host persistence owns imported context resolution. The resolver accepts only an injected read port; local and remote Hosts provide their respective authorized readers.
- The Codex agent service owns command admission and the all-or-nothing rewrite. It performs the rewrite before any bridge dispatch.
- The bridge rejection of `context_refs` remains a defense-in-depth guard and is not an error-parsing or capability signal.
- Transport failure or ambiguity after dispatch leaves the existing command/no-resend behavior unchanged. Reconnect may reconcile state but must not create a second command.
- Workspace isolation uses `workspaceIdentity?.trim() || workspacePath` as the ownership key; `workspacePath` selects the authorized local/remote storage scope.

## Expanded content

Each expansion uses visible delimiters and includes:

- source (`conversation-share-import`) and context id;
- share id, title, and canonical share URL where persisted;
- SHA-256 of the exact expanded content;
- persisted copy format version and formatter version;
- import/session provenance and expansion timestamp in epoch milliseconds.

The body is the persisted imported-share copy. Unknown format versions and unsupported row formatters fail explicitly. Empty content, missing/unreadable records, invalid Unicode, and byte-limit violations fail with a stable reason and no silent truncation.

The current command-level limit is 262,144 UTF-8 bytes for the combined formatted context. A violating command reports the effective limit and observed byte count.

## Failure semantics

- Multiple contexts expand all-or-nothing; a failure in any one sends nothing.
- Only refs belonging to the current session and workspace may be read.
- Arbitrary renderer paths, URLs, duplicate context ids, unknown ids, and refs absent from persisted provenance are rejected.
- Capability `sharedContextContentCopy` reports the actual Host degradation state (`degraded`) only when an authorized resolver is installed. Missing/unavailable capability resolves unsupported and the command is rejected before bridge dispatch.
- Failures are explicit typed errors and never inferred by parsing bridge error strings.

## UI behavior

Whenever a pending shared context can be submitted, Composer shows a warning explaining that Codex will receive a content copy, reference semantics are lost, and later source changes do not propagate. The warning is localizable, uses the repository typography scale, and does not duplicate or mutate the authoritative imported-share projection.

## Acceptance scenarios

1. Valid persisted context expands into visible provenance-delimited text, and the bridge command has no `context_refs`.
2. Workspace/session mismatch, arbitrary renderer path/id, unknown id, empty content, unreadable record, unknown formatter/version, and byte-limit violation each reject with no bridge command.
3. Multi-context failure is all-or-nothing.
4. Missing or unsupported capability rejects before bridge dispatch; no bridge error string is inspected.
5. UI displays the content-copy/non-propagation warning when a pending shared context is attached.
6. Transport ambiguity/reconnect does not automatically issue a replacement command.
