# Canonical conversation history, version 1

`history.mjs` defines the history shared by the provider adapters. Neither Claude
nor OpenAI is the canonical format. Imports normalize their messages, reasoning,
tools, and results into the same records while retaining the complete source.

The live paths are:

```text
Codex Responses history -> canonical history -> OpenAI Responses request
                                            -> Anthropic context through Pi

Anthropic Messages history -> canonical history -> either provider adapter
```

Codex still owns its session files and stores the Responses wire format expected
by its client. On each request, the bridge imports that active history into the
canonical representation. Provider projections never replace the canonical
history or rewrite the session. This preserves both providers' reasoning when
new turns are appended or a client is restarted.

## Request history

The JSON-serializable envelope contains:

| Field | Meaning |
| --- | --- |
| `version` | Schema version, currently `1`. |
| `scope` | `request` for active, ordered model input. |
| `source.format` | `responses` or `anthropic-messages`. |
| `source.value` | Complete original input, including unknown fields. |
| `entries` | Ordered canonical records consumed by the adapters. |

Every entry has an `id`, a `kind`, and an `origin` path into `source.value`.
Native IDs are retained in the source. Canonical IDs use the source format, kind,
and native identity or a content hash; identical records get occurrence suffixes.
Appending turns does not change existing IDs. IDs without a native identity are
not guaranteed to survive edits, reordering, or compaction.

| Kind | Canonical fields |
| --- | --- |
| `message` | `role`, ordered `content` containing text, images, or opaque parts. |
| `reasoning` | `summaries` and a provider-specific `state` with provider, model when known, encoding, and value. |
| `tool_call` | `callId`, tool name, namespace, arguments encoded as JSON or raw text. |
| `tool_result` | Matching `callId`, tool kind, content, and `isError`. |
| `tool_definitions` | Role and tool declarations from Responses `additional_tools` items. |
| `artifact` | Provider-owned items such as compaction records and unknown future item types. |

Provider-specific state includes OpenAI encrypted reasoning, Claude signed and
redacted thinking, and the bridge's encrypted `pi1` reasoning. Native metadata
such as annotations, token usage, tool callers, status, opaque fields, and source
IDs remains in the source envelope even when the other provider cannot receive it.
Unknown content is represented explicitly rather than discarded during import.

The canonical fields control projected semantics. For example, changing a
canonical message's text changes both providers' projected messages; the original
source remains available for audit and recovery. Compatible native extension
fields are carried through the OpenAI adapter without overriding canonical fields.

## Adapters

```js
const canonical = fromResponses(responsesInput);
const openaiInput = toOpenAI(canonical);
const anthropicContext = toAnthropic(canonical, piModel, { codec, toolName });

const importedClaude = fromAnthropic(anthropicMessages, { model: 'claude-model-id' });
const openaiFromClaude = toOpenAI(importedClaude);
const restoredOriginal = restoreSource(importedClaude);
```

`toAnthropic` produces the context message format consumed by Pi's Anthropic
transport. Pi handles Anthropic's final wire serialization and cross-model
signature normalization. The adapter retains the original Claude model identity;
unknown identity is not replaced with the destination model.

`toOpenAI` preserves OpenAI reasoning state and projects foreign reasoning as
readable historical summaries when available. It gives tool items the ID prefix
required by their target type and keeps `callId` associations intact. This also
handles older bridge custom-tool items with `fc_` IDs. Tool failures imported from
Anthropic remain explicitly marked as failures in the OpenAI result text.

`toAnthropic` restores Claude reasoning with its original signature and model,
and projects OpenAI reasoning summaries as text. Opaque OpenAI state remains in
canonical storage and is not sent to Anthropic. The bridge key is required to
decode `pi1` state. A missing key or invalid signature fails explicitly.

Codex can retain `additional_tools` in compacted history after using Responses
Lite. OpenAI projection preserves these items. Anthropic message projection
omits the declarations from messages; the bridge uses them as tools only when
the request has no top-level `tools` field. Later inline declarations replace
earlier declarations with the same namespace and name. An explicit top-level
tool list, including an empty list, is authoritative, so historical tools do not
restore capabilities that Codex has removed. Custom tools and namespace mapping
use the same conversion as top-level tools. Restart the bridge and resume the
existing session to load this support; no transcript edits are needed.

Lossless storage does not imply that every provider accepts every item type.
For example, a document attachment can be retained canonically while a destination
adapter rejects it as unsupported. Such failures do not discard the original.
Provider-native compaction and other opaque artifacts are not invented or decoded
for a foreign provider.

## Saved transcript archives

`fromTranscript('codex-jsonl', text)` and
`fromTranscript('claude-code-jsonl', text)` import saved histories read-only.
Archives have `scope: 'archive'`, retain the exact original text in `source.value`,
and expose records with line numbers, source IDs, parent IDs, complete metadata,
and canonical conversation records where applicable.

This retains lifecycle events, interrupted turns, branches, sidechains,
compaction boundaries, usage, file snapshots, and unknown records. Serializing
the canonical archive to JSON and calling `restoreSource` recovers the original
JSONL bytes, including whitespace and line endings.

An archive is not automatically a valid active conversation: it can contain
rolled-back turns and multiple branches. Provider adapters reject archive scope.
Selecting a branch and materializing active history is a separate operation;
the live bridge uses the active history supplied by Codex instead of flattening
the entire archive into a prompt.

Importing is not a bulk migration. Existing histories and credentials are not
rewritten, and no canonical sidecars are created automatically. A canonical
archive contains conversation data, including potentially sensitive tool output,
and must be protected like its source transcript.

## Verification

Tests cover exact source recovery after JSON serialization, canonical-field
authority, unknown data, multimodal content, signed/redacted reasoning, tool
errors and identity, and repeated projections without canonical mutation. Real
Codex integration tests switch a persisted thread in both directions, resume it,
and exercise API-key and ChatGPT authentication against local mock inference.

Run `node --test history.test.mjs` for canonical tests. Run the full suite with
`CODEX_ROUTING_INTEGRATION=1 CODEX_HANDOFF_INTEGRATION=1 node --test *.test.mjs`.
On macOS, the older handoff integration fixture requires a canonical temporary
path, for example `TMPDIR=/private/tmp`, to avoid a symlink-path comparison error.
