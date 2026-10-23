# Codex Desktop Native Diagnostics

## Native stderr bounded summary

The desktop bridge owns the native Codex app-server process and its stderr. It
must never copy native stderr into logs because that stream can contain user
prompts, paths, credentials, URLs, or stack text. The transport consumes stderr
streaming and retains only a bounded aggregate:

- physical line count and byte count;
- whether any line exceeded the internal classification prefix limit;
- the highest recognized logging level (`trace`, `debug`, `info`, `warn`,
  `error`, otherwise `unknown`);
- one restricted Rust tracing target associated with that highest level;
- closed categories selected only from `panic`, `permission-denied`,
  `not-found`, `connection`, `timeout`, `tls`, `out-of-memory`, and `error`.

No message, command, path, prompt, URL, token, raw stack, or other original
stderr text may leave the transport. A long line is truncated for classification
only; counters continue to reflect all bytes. The summarizer may not
concatenate chunks into an unbounded line buffer. A caller diagnostic callback
throw is swallowed and cannot affect request correlation or the terminal
transport state.

The aggregate is delivered at most once, after process exit and stderr drain. It
includes the process exit code and signal when available so consumers can relate
it to the existing process-close diagnostic without replacing that diagnostic.
Empty stderr produces a zero-valued aggregate but the bridge emits no production
warning.

The bridge production boundary emits one fixed-format warning only when stderr
was non-empty. The Host treats bridge stderr as untrusted input and accepts the
warning only when every field matches its closed parser; accepted values enter
the existing production `warn` channel. Unknown or extra fields are dropped and
never copied to logs.

## Event order

```text
native stderr chunks -> transport summarizer (bounded state)
child exit + stdio drain -> summary callback once
    -> bridge fixed-format stderr warning (non-empty stderr only)
    -> Host closed-vocabulary parser -> production warn
```
