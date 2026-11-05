# Preview scroll restore

## Outcome

A preview tab keeps its reading position whenever the preview subtree is
temporarily unmounted and later remounted for the **same workspace and the same
source**. This covers:

- side-pane collapse and session switches (heavy content deferred, boundary
  stays mounted);
- workspace/project switches, where the whole `FileManagerPane` subtree of the
  previous workspace unmounts because side-pane tabs are filtered by
  `workspaceKey`;
- code, Markdown, PDF, DOCX, legacy DOC, and PPTX previews.

PPTX restores the current slide number plus the viewport scroll offset, the same
way PDF restores a page number. Excel is excluded: `@extend-ai/react-xlsx`
renders cells to a canvas through WASM, so there is no DOM reading position, and
its controller only exposes `activeTabIndex` / `activeCell` / `selectCell`. Using
those to fake a scroll restore would also change the visible selection.

Switching back restores the `scrollTop` that was visible before the switch for
code, Markdown, and Office documents, and the page/slide number plus `scrollTop`
for PDF and PPTX. Explicitly navigating the same preview tab to a different
source still starts at the top, matching the upstream behavior.

This behavior is renderer-local. It does not create task, session, Host, relay,
or replayable state.

## Ownership and boundaries

- The `preview-scroll-restore` module owns one durable, renderer-local snapshot
  store. It is the single owner of "reading position per workspace + source".
- Entries are keyed by `workspaceKey + sourceKey`, where `workspaceKey` is
  `workspaceIdentity?.trim() || workspacePath` (the repository-wide identity
  key) and `sourceKey` is `path`-based when available, otherwise type + title.
- The store is a bounded module-level cache (LRU). It survives React unmount
  but is never persisted to storage, task state, session state, Host, or relay,
  and never crosses a window/renderer boundary.
- `PreviewScrollRestoreBoundary` binds one store entry to the React context. It
  holds no snapshot of its own, so a remount cannot lose the position.
- The boundary never remounts its children. `PreviewPane` keeps its own local
  view state (Markdown/SVG view mode, wrap override) across source changes, so
  a source change is expressed by rebinding the context and clearing the target
  entry, not by rebuilding the preview subtree.
- Runtime owners are unchanged while mounted: `CodeViewer` owns code scrolling,
  `MarkdownPreviewContent` owns Markdown DOM and scrolling, `PdfViewer` and
  `PptxPreviewViewer` own page number, zoom, rendering, and scrolling. The store
  keeps only the values needed to reinitialize those runtimes after a remount.
- Wrappers locate the real scroll container through stable DOM markers owned by
  this repository, never through a third-party renderer's private DOM:
  `data-markdown-preview`, `data-office-preview-scroll-container`,
  `data-pptx-preview-viewport`, `data-preview-scroll-container`. Because Office
  and PPTX bodies are lazy and parsed asynchronously, discovery keeps observing
  the subtree until the marker appears, then stops. The observation deadline has
  to stay well above the worst-case parse time; a deadline shorter than the parse
  means the binding is never created and the position is silently lost.
- `PptxPreviewViewer` exposes `initialPageNumber` as a one-shot entry consumed
  once per document generation. It is deliberately not a dependency of the
  `[data]` load effect, so restoring a page never re-parses the deck.
- `PreviewPane`'s local `preservedScrollMetricsRef` remains the upstream
  in-mount layout hint (deferred body height and heavy-content toggle). The
  durable store owns cross-mount restore; the two never write each other's
  values.

## Event order

```text
Preview subtree mounts for (workspaceKey, sourceKey)
  → boundary binds the existing store entry (may already hold a position)
  → runtime component renders
  → wrapper restores scrollTop / page once the container can scroll
  → user scrolls, or changes the PDF page / PPTX slide
      → the scroll event, or the page-number attribute mutation for paged
        previews, writes the latest position into the store entry
  → deferring event (session switch, workspace switch, tab close)
      → React unmounts the subtree; the store entry already holds the last
        event-driven save and survives the unmount
  → user returns to the same workspace and the same source
      → boundary rebinds the same entry → wrapper restores
  → user navigates the same tab to a different source
      → boundary clears the target entry before the new content mounts
      → the new source starts at the top
```

## Failure and reset semantics

- Navigating a mounted boundary to a different `sourceKey` clears the target
  entry during the boundary render, before any wrapper can restore it.
- A wrapper that finds no entry for its binding scrolls its container to the
  top. The scroll container DOM node is reused across source changes, so the
  reset has to be explicit.
- `code-review` sources are excluded from restore: their landing position is
  owned by `focusRequestId`, and a cached offset would fight that scroll.
- PPTX previews carrying a `referenceNavigation` are excluded from restore: the
  reference jump owns the landing page through `goToPage`, and a cached page
  would fight it.
- Saves are event-driven only: the `scroll` event plus, for paged previews, the
  page-number attribute mutation. There is deliberately no save-on-unmount. For
  one frame after a source change the container can still hold the previous
  file's content, and an unmount save would write that stale position into the
  new source's entry.
- Programmatic reset and restore suppress saves until they settle, so the scroll
  events they trigger cannot pollute the entry either.
- Excel never gets a restore wrapper: the call site skips it, so the discovery
  observer is not attached to a canvas grid that has no reading position.
- Unmounting never clears an entry; that is what makes workspace switches and
  tab close/reopen restorable.
- The store is capped; the least recently used entries are evicted first. An
  evicted entry degrades to "start at the top", never to a wrong position.
- A missing or zero-height scroll container does not throw; restore is a
  best-effort no-op.
- PDF page numbers outside the document range are clamped by the existing
  `PdfViewer` behavior.
- Restore is not guaranteed across an app restart or a renderer reload.
- Sources without a `path` fall back to type + title. Two different in-memory
  sources sharing both collide on one entry; the collision is limited to a
  stale reading position within one renderer session.

## Acceptance

1. Markdown, code, and PDF previews scrolled away from the top survive a
   heavy-content unmount/remount and return to the same position; PDF also
   returns to the same page.
2. The same previews survive a full boundary unmount/remount (workspace or
   project switch) and return to the same position.
3. Two workspaces previewing the same source path keep independent positions.
4. Changing the preview source within a mounted boundary resets the cached
   position instead of applying the previous file's offset/page.
5. DOCX/DOC previews and PPTX previews return to the same scroll offset, and
   PPTX returns to the same slide, after a heavy-content remount and after a
   workspace switch.
6. A PPTX preview opened through a reference jump lands on the referenced slide,
   not on a cached one.
7. Switching the preview source inside a mounted boundary does not rebuild
   `PreviewPane`; its local view state survives the switch.
8. The module performs no IO, persistence, Host calls, session writes, or relay
   writes.
