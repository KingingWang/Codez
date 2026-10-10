# Prompt file attachments: complete content or a usable reference

## Product rule

File selection, drag/drop, and file paste share one attachment path. A regular
UTF-8 text file may be added to the model input only when its **entire** content
fits the 64 Ki UTF-16-code-unit limit and the runtime's existing byte/token
budgets. No file prefix, truncated preview, or metadata-only placeholder counts
as a delivered attachment. Otherwise the Agent receives a reference to the
complete original bytes and decides whether and how to inspect them.

Pure text pasted into the editor at 15 Ki characters or more remains a
`clipboard-text` attachment and is **always** deferred, even if shorter than
64 Ki characters. This source kind must survive V4 upload, queueing, edit and
resume. Binary or invalid-UTF-8 files are never interpreted as text. Images
retain their media input behavior; other media formats use their existing
specialized path where supported, or an ordinary file reference.

Uploads without a usable local path have a 20 MiB single-file limit. Reject
oversized files before encoding and show a localized error. Zero-byte files are
valid. An existing local-path reference is not copied merely to impose this
upload limit. Neither paste nor send extracts an archive or writes into the
workspace.

## Ownership and interfaces

- The UI composer owns the transient File, object URL, pending upload, and
  optimistic attachment chip. It never persists the accepted queue. It sends
  the complete bytes through the existing V4 begin/chunk/commit transaction;
  `AttachmentRef` carries an optional, strictly validated `clipboard-text`
  source kind. The internal put input accepts the empty Base64 string for an
  empty file; no new wire command is introduced.
- On desktop, the Codex bridge owns the session-scoped committed blob and
  validates its manifest, checksum, and session on each use. For a deferred
  file it gives native Codex a trusted path to that blob as a text file
  reference, not raw Base64 or a client-supplied path. For a complete small
  text file it provides the full UTF-8 text in a bounded, self-delimiting
  native input envelope carrying the same owned file reference. The envelope
  identifies exactly the content span; neither it nor the content may be
  projected as user-typed text. History and queue projection remove verified
  attachment envelopes **before** checking the UI row budget; raw native
  model input is not the UI text row. The existing 1 MiB aggregate text budget is
  applied per file in order; files that do not fit become references rather
  than failing or sending prefixes. Empty files are reference-only: an empty
  text input is not an attachment delivery.
- In the CLI, the session artifact store owns uploaded content. A URI ref that
  cannot be inlined is materialized as the original bytes under a private,
  session-owned path on the Agent's machine, atomically and with bounded
  validation. A Base64/data-URL artifact file itself is **not** a usable
  reference. A local-path ref remains a local path. The core file resolver
  disables partial-read fallback for prompt attachments and chooses reference
  delivery whenever the complete text exceeds 64 Ki characters, the 256 KiB
  read bound, or the output-token budget.
- Native Codex owns turns and queue admission. The bridge projects its
  authoritative history/queue into the UI. Validated internal file-reference
  and inline-envelope markers in native input permit reconstruction of
  sent/queued attachment chips, including after restart; editing queue text
  re-resolves all retained refs together, in original order, so aggregate
  budget decisions and full inline bodies survive the replacement. Only
  canonical, session-owned content is retained. Missing or corrupt blobs
  fail clearly rather than presenting a fake usable attachment. Earlier
  already-sent unmarked inline text cannot be retroactively identified as
  an attachment; the new envelope applies to new submissions.

Declared MIME and filename are hints, not proof of textual bytes. A known
binary suffix or signature (including ZIP `PK` headers), NUL/control bytes,
or invalid UTF-8 prohibits text inlining even if MIME is `text/plain`. CLI
core and the bridge apply this rule independently at their existing file
resolution boundaries; neither keeps a second attachment state owner.

Native file-reference and inline-envelope headers display filenames and paths
as JSON strings. Escaping is presentation-only: parsing the marker must recover
the exact original path, including Windows drive, UNC and verbatim paths.
Tests compare the parsed path with the bridge-owned blob path, not raw path
inclusion in the escaped header. Malformed or noncanonical envelopes retain
their existing fail-closed behavior; no storage or protocol migration is needed.

```text
paste / select / drop -> composer File -> bounded upload -> bridge blob / CLI artifact
                                               |
                         complete small text -> full native/model text + owned envelope
                         all other files     -> Agent-readable file path
                                               |
                  native history/queue -> validated projection -> UI chip

queue edit -> native queue owner -> bridge re-resolves ordered refs
           -> canonical input replacement -> native snapshot -> UI projection

desktop-continuous: live snapshot --------------------+
                                                      +-- same Host/session owner
web-remote-replayable: snapshot + gap repair ---------+
```

The workspace isolation key remains `workspaceIdentity?.trim() ||
workspacePath`; `workspacePath` is for filesystem operations. No new
attachment owner is created for mobile. Upload completion precedes command
submission; an accepted command owns its refs. A stale upload result must not
attach to a different session; begin/chunk/commit and command IDs retain their
existing idempotency and recovery rules.

## Acceptance cases

1. An HTML, plain-text, source, or JSON file of at most 64 Ki characters that
   fits the full-input budgets is delivered completely, with no truncation
   notice. Multi-byte UTF-8 uses the character limit and actual byte budget.
   Its sent/queued chip remains after queue editing and a fresh bridge
   instance projects the same native history; the inline body is never
   mistaken for the typed message. Two small files whose combined model input
   exceeds the UI row budget still produce a valid history/queue snapshot.
2. A file one character above the limit, over the token budget, invalid UTF-8,
   or over the aggregate text budget sends **no prefix**: its original bytes
   remain readable through an Agent file tool.
3. Long pure-text paste is reference-only on both native and CLI paths. A
   64 Ki+ paste retains its final bytes; a local-path paste is not pre-read by
   the CLI core.
4. ZIP and other binary files upload and produce usable private file paths,
   including a ZIP misdeclared as `text/plain` and named `.txt`.
   The Agent may inspect them; no automatic extraction occurs. Missing or
   tampered refs, cross-session refs, and spoofed markers fail closed.
5. A sent or queued file keeps its chip across queue text edit, history edit,
   retry, restart and remote replay. Removing a chip from history edit removes
   its ref; a failed submission preserves the draft.
6. An empty `.txt` produces a valid file reference and chip rather than an
   empty model input, on both bridge and CLI paths. Exactly 20 MiB and
   over-20 MiB uploads have distinct outcomes. Small image and existing
   media behavior remains unchanged.
7. Reference-only and inline envelopes round-trip POSIX, Windows drive, UNC
   and verbatim paths unchanged on every test platform. Their headers use
   JSON-escaped paths and filenames, including spaces, Unicode and quotes.

The previous metadata-only and truncated artifact outputs are not migrated:
they do not contain recoverable original bytes. New uploads use the complete
content rule; existing local-path refs remain valid.

## Isolated E2E scenario

Use the repository's isolated desktop test environment and a disposable
workspace, not a live user session. Copy a four-byte ZIP fixture into the
system clipboard as a file, paste it into the focused composer, and observe a
ready file chip. Send a message requesting byte-level inspection: the
Agent-side file tool must read `50 4b 03 04` from its supplied path, while the
workspace gains no extracted files. Repeat with a 64 Ki+ character HTML file:
the native input must contain no prefix of the file, and a tool read must
recover its final sentinel. While a turn is busy, queue a ZIP, edit only the
queue text, let the turn drain, then reload: the chip and owned ref must still
be present. Run the same attachment through a mobile replayable connection to
the existing Host and verify its snapshot restores the same ref. Check a
20 MiB+ file shows a localized permanent error before encoding.
