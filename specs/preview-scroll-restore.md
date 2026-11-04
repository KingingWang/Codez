# Preview scroll restore

## Outcome

When a Markdown or PDF preview tab survives a side-pane or session switch, its
reading position must survive the temporary unmount of heavy preview content.
Switching back to the tab restores the Markdown scroll offset and the PDF page
number / scroll offset that were visible before the switch. Switching to a
different preview source resets the restore cache.

This behavior is renderer-local. It does not create task, session, Host,
relay, or replayable state.

## Ownership and boundaries

- `PreviewScrollRestoreBoundary` owns only the restore cache for the current
  preview source. It is a renderer-local cache, not a second runtime owner.
- `MarkdownPreviewContent` remains the runtime owner of the rendered Markdown
  DOM and scroll position while mounted.
- `PdfViewer` remains the runtime owner of page number, zoom, rendering, and
  scrolling while mounted. The restore cache stores only the values needed to
  reinitialize that runtime after a remount.
- The cache is keyed by the stable preview source identity (`path` when
  available, otherwise type + title). A source change clears the cache.
- The cache is not persisted to storage, task state, session state, Host, or
  relay.
- Code, image, media, Office, and PPTX preview behavior is unchanged.

## Event order

```text
Preview tab mounted
  → PreviewScrollRestoreBoundary creates empty cache for source key
  → Markdown/PDF runtime renders
  → user scrolls / changes PDF page
      → wrapper writes latest offset/page into boundary cache
  → session switch or side-pane defer unmounts heavy content
      → boundary stays mounted, cache remains
  → user switches back
      → heavy content remounts
      → wrapper restores scrollTop and PDF initial page
      → runtime component resumes as the live owner
```

## Failure and reset semantics

- A different source key clears the cache before the new content mounts.
- Closing the preview tab destroys the cache with the boundary.
- A missing or zero-height scroll container does not throw; restore is a
  best-effort no-op.
- PDF page numbers outside the document range are clamped by the existing
  `PdfViewer` behavior.
- Restore is not guaranteed across app restart, tab close/reopen, workspace
  switch, or source replacement.

## Acceptance

1. Markdown preview scrolled away from the top survives a heavy-content
   unmount/remount and returns to the same `scrollTop`.
2. PDF preview returns to the same page and scroll offset after a
   heavy-content unmount/remount.
3. Changing the preview source resets the cached position instead of applying
   the previous file's offset/page.
4. The preview boundary performs no IO, persistence, Host calls, session
   writes, or relay writes.
