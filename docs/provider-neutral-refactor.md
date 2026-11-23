# Provider-neutral bridge refactor

**Status:** Proposed implementation brief, 2026-11-23.

Refactor the existing repository in place. A model provider should be addable by registering an adapter at startup. The shared routing and history code should work unchanged. Use the two existing routes as compatibility baselines and a synthetic third adapter as the acceptance test. Preserve the existing launcher, model slugs, authentication paths and on-disk sessions throughout the migration.

## What persists today

Codex owns the thread and sends active Responses history on each request. The bridge imports that input into canonical entries, retaining the complete source, then projects it for the selected model. The canonical representation is rebuilt on the next request. A field lost while writing the response to Codex cannot be recovered by improving the importer. See [the history contract](../HISTORY.md) and [the response writer](../bridge.mjs).

Keep three operations distinct: projecting a live thread when the user switches models, restoring an exact source archive, and explicitly handing off to a new thread. Handoff deliberately turns historical tool calls into text so they cannot execute again. See [handoff.mjs](../handoff.mjs).

## Ownership and data flow

| Boundary | Responsibility |
| --- | --- |
| Codex integration | Parse Responses input, emit valid response items and stream events, expose the model picker, interpret rollout and compaction metadata. Own the means of carrying adapter state through Codex persistence. |
| Pure core | Consume explicit values to resolve model ownership, represent ordered history and decide whether a retry or fallback is eligible. Depend on adapter contracts. Keep vendor identifiers in registration and adapter code. |
| Provider and transport adapters | Describe models and their capabilities, project history, interpret provider output and limits, select credentials and determine replay compatibility. Pi is a transport used by an adapter. Native OpenAI forwarding can project the input and stream the upstream response body directly. |
| Imperative shell | Read credentials and sessions, call upstreams, generate IDs and encryption randomness, handle clocks, timers, cancellation, backpressure and writes. Keep mutable per-request resources scoped to the operation that owns them. |

For translated requests, structure the logic as import, project and encode stages with immutable values between them. Local mutation of a fresh array or map is fine when it makes a linear pass clearer. Repeated projections with identical inputs should produce equivalent values and leave the source intact. Pass time or IDs into a projection when they affect output. Keep streams incremental. A useful initial slice is an interrupted signed-thinking turn with a tool call: the current mapper reads the clock, then the caller reorders blocks and removes unfinished messages. Make each decision visible in the projection that needs it.

## Replay and compatibility

Preserve ordered messages and parts, call/result identity, namespaces, custom-tool inputs, errors, original source fields and readable reasoning summaries. Allow an adapter to associate opaque continuation state with a specific part, including a tool call. Retain its origin, position and model identity when known. The owning adapter decides when to replay it. Another adapter can consume the portable history without receiving that state or changing what the owner can recover later.

Existing signed and redacted Claude thinking must resume with the original bridge key, including legacy `pi1.` items. Preserve native OpenAI encrypted reasoning and current cross-provider summary behavior. Invalid state must retain the existing explicit failure behavior. Choose the encoding for new state only after proving what real Codex persists. Do not require a bulk migration to reopen a thread.

## Inventory the fixes before moving them

Start with code, regression tests and the history of the affected paths. For each workaround record its triggering input, observed failure, owner, applicable transport/model/protocol condition, regression coverage and any unknown scope. “Observed on one transport” is a valid finding. Where two adapters share a constraint, let each opt into the same pure projection or validator. Use a capability value when a shared algorithm actually consumes it. Avoid a central matrix of vendor names and patch flags.

| Existing example | Decomposition |
| --- | --- |
| Case-insensitive tool-name collisions | Validate at tool projection for transports that fold case. Test that a case-sensitive synthetic transport preserves both names. |
| Interrupted response ending in signed thinking alone | Retain the complete source. Omit the unfinished assistant turn only from the projection that upstream accepts. |
| Inline tool declarations after compaction | The Codex importer recognizes declarations. Projection respects top-level tool precedence, including an explicitly empty list. |
| Previous-model compaction hits a rate limit | The adapter recognizes the upstream condition. Pure policy decides if the selected model may be tried once before output starts. The shell observes connection state and performs the retry. |

These are starting examples. Also trace model discovery, effort mapping, stream completion and partial failures, usage reporting, limit resets and launcher defaults. For each extracted fix, identify a positive case and, where scope matters, an unaffected path.

## Migration and acceptance

1. Capture current behavior with the [history](../history.test.mjs), [routing](../routing.integration.test.mjs), [handoff](../handoff.integration.test.mjs) and [compaction](../compaction.integration.test.mjs) suites. Record versions, flags and any skipped integrations.
2. Extract history replay through one working vertical slice. Check the emitted Responses items, what Codex persists and what each existing upstream receives after resume. Preserve source recovery and legacy decoding.
3. Extract provider registration, model discovery, routing and retry policy in independently verifiable changes. Keep the native forwarding path's credential boundaries, status, permitted headers and streamed response behavior.
4. Register a synthetic adapter through the normal composition point. Have it emit two harmless tool calls in one turn with distinct IDs and a known opaque value on just one call. Complete both, restart real Codex, resume the thread, switch to an existing adapter and switch back. Assert that the foreign adapter sees portable calls and results, the owner recovers the value on the correct call in order, and execution counts remain one per call. Mock upstream inference so this runs locally.
5. Rerun the existing integration paths and the synthetic scenario. Acceptance requires the third adapter to work without changes to core routing or history logic. Report observed results separately from skipped checks. No production third-provider implementation is part of this brief.
