# Codex desktop imageView (view_image) projection

## Outcome

When the model calls the native Codex `view_image` tool, the conversation shows
a read-style file card carrying the image's file name and path. Clicking the
file name opens the existing preview pane, which renders the image content.
This matches the upstream ZCode presentation for the native agent's `Read`
tool on images: the message stream shows which file is being viewed; the image
itself renders in the preview pane on demand.

Before this change the `imageView` thread item was unknown to the bridge, so it
fell back to a generic raw-JSON card (`codex.imageView`) and neither the file
name nor the image was visible.

## Ownership and boundaries

```text
codex view_image call → core TurnItem::ImageView (only after the image file
                       was read successfully; failures produce no item)
  → app-server item/started + item/completed { type:"imageView", id, path }
  → bridge codex-types (known item) → projection-rows
  → v4 toolCall row { toolName:"view_image", input:{ path }, status:"success" }
  → UI tool identity (/^(?:view|read|...)(?:_|$)/i → file-read family)
  → ReadToolCallBlock file chip → onOpenCodeViewer({ type:"file", path })
  → PreviewPane.resolvePreviewPaneImageSource → ImagePreviewContent
    (fileService.readMediaPreview; any local absolute path, not workspace-bound)
```

- Codex remains the execution and history authority; the bridge only translates
  the item. No image bytes enter the v4 row; the renderer loads the file lazily
  through the existing file service, like every other image preview.
- The item carries no status field. Its existence means the image was attached
  successfully (core creates it only on the success path), so the projected row
  is always `success`; it is never turn-derived.
- `path` is a native absolute path string (`LegacyAppPathString`); the bridge
  passes it through verbatim and never fabricates or rewrites locations.

## Acceptance

- Projection: an `imageView` item yields one toolCall row with
  `toolName: "view_image"`, `status: "success"` and `input: { path }`; the item
  no longer appears in the unknown-item fallback test.
- Session-owned bridge attachment resolution: when `imageView.path` points to a
  session-owned staged attachment blob (`.../attachments/objects/<uuid>.data`),
  `BridgeSnapshots` enriches `row.input.fileName` from the verified attachment
  manifest, and `fileService.readMediaPreview` sniffs PNG/JPEG/GIF/WebP magic
  bytes when the path has no known image extension so `PreviewPane` renders the
  image instead of raw `.data` text.
- UI: the card renders the file chip (icon + name + path); clicking it opens
  the preview pane with the rendered image (local desktop workspace).
