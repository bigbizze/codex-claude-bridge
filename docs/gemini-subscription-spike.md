# Gemini subscription access and replay spike

**Status:** Proposed experiment, 2026-11-23. Access, model entitlement and end-to-end replay have yet to be demonstrated.

Run this spike before funding the [provider-neutral refactor](provider-neutral-refactor.md) on the strength of Gemini support. The intended experience is selecting Gemini 4 Neon or Carbon inside a Codex thread, consuming the user's subscription quota and letting Codex execute tools and persist the conversation. A Pi adapter is one possible implementation. Its suitability is a question for the spike.

## Prepare the spike machine

- Bring the chosen bridge revision and this brief. Record `git rev-parse HEAD`, `node --version`, `codex --version` and `agy --version`. Start with Node 22+ and the [routing fixture](../routing.integration.test.mjs). Run `CODEX_ROUTING_INTEGRATION=1 node --test routing.integration.test.mjs` before making changes. This uses real Codex with local mock inference and synthetic credentials. Add Pi if the selected transport needs it.
- Use Antigravity CLI (`agy`). Check `agy acp --help` and sign in interactively with the personal Google account whose subscription is being tested. For consumer accounts, Google lists standalone Neon on paid Pro (also on eligible premium-device trials) and Ultra; standalone Carbon requires Ultra. Start with whichever model the account already includes. Select the standalone model in `/model` and note the thinking level. Orchestrator can assign work to a second model. [Model availability](https://antigravity.google/docs/models)
- Record the sign-in method and `/usage` before and after the first approved short turn. The CLI reports remaining quota by model group. A small turn may leave the displayed value unchanged; record that observation and leave per-request attribution unknown if the client supplies no stronger evidence. [Quota command](https://antigravity.google/docs/cli/commands/usage)
- Probe the official ACP transport first. `agy acp` uses JSON-RPC over stdio and supports personal Google sign-in. Google documents agent-owned tools and resuming an Antigravity session by ID. Before writing a bridge adapter, test whether a client can execute a named tool, supply its result, and start a fresh upstream session with history supplied by Codex. Record what ACP actually exposes, including whether private part state is observable. [ACP guide](https://antigravity.google/docs/ide/extensions/acp)

## 1. Establish the subscription transport

Google's Gemini CLI maintainers explicitly cite “using Gemini CLI oAuth with third-party software” as a policy-violating use. Google also announced a transition to Antigravity CLI for individuals. Investigate the current Antigravity interfaces and terms for the specific integration. The existing Anthropic integration is precedent for the desired experience, not evidence of Google entitlement. [Maintainer announcement](https://github.com/google-gemini/gemini-cli/discussions/22970) · [CLI transition announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)

Record the supported invocation, plan, transport and client versions. Determine whether the interface lets the caller supply ordered history, receive structured tool calls, return results and resume after the process exits. A headless CLI that runs its own agent loop may answer prompts successfully while leaving Codex unable to execute the calls. If Pi is in the path, check the installed adapter's actual inputs and outputs.

For **Neon and Carbon separately**, record the requested and returned model IDs, account entitlement, and what establishes which quota is charged. Distinguish verified, unavailable and unknown. If the subscription route is unavailable or unresolved, stop the subscription experiment and record the evidence. A separately authorized API-key experiment can answer wire-format questions only. Obtain approval for live requests that consume quota or incur charges.

## 2. Exercise one real Codex turn

Use an isolated, disposable prototype in the existing repo. Hardcoding the target is fine. Keep the implementation small enough to discard. Start with the [real Codex routing fixture](../routing.integration.test.mjs) and inspect how [the existing response writer](../bridge.mjs) persists thinking and tool calls. Google's [thought-signature documentation](https://ai.google.dev/gemini-api/docs/thought-signatures) supplies cases to investigate. Verify what the chosen model and transport actually return.

1. Expose two harmless Codex-owned tools with distinct names, deterministic outputs and execution counters. Request both in one model turn. Record ordered response parts, call identities and which parts carry continuation state. If the transport cannot expose the required response, record that boundary explicitly.
2. Follow the output through the transport, any Pi normalization, the bridge's Responses stream, the persisted Codex thread and the reconstructed upstream request. Compare the original opaque values, part positions and call/result associations locally. Return results through Codex and verify that the target model accepts the continuation.
3. Restart the bridge and Codex, resume the same thread, switch to an existing provider for one turn and switch back. Verify portable tool history reaches the other provider, private state stays with its owner, the resumed target turn succeeds and each tool's counter is still one. Record which model and settings produced the evidence.
4. If replay fails, identify the first boundary where the state changed or disappeared. Retest the smallest correction there before drawing conclusions about the architecture. Record any account or model combination that remains untested.

## Evidence and decision

Keep a short access finding per model, the observed round-trip result, and a sanitized fixture with ordered parts, synthetic opaque values, call IDs and expected execution counts. Record presence and exact equality of live opaque values locally. Exclude credentials, raw tokens, live signatures and personal transcripts from committed evidence. Clearly distinguish results from a real model, a local mock and documentation alone.

| Outcome | Decision |
| --- | --- |
| Intended subscription route and replay both verified | Proceed with the in-place refactor for the demonstrated scope. Hand the implementer the standalone refactor brief and a synthetic regression fixture. |
| Access works but replay fails | Resolve or bound the failure at the identified boundary before designing a general adapter contract. |
| Only API access works, or subscription access remains unresolved | Evaluate the refactor on its value to the existing providers. Record subscription compatibility as unresolved or unavailable, according to the evidence. |

The handoff should describe the constraint in provider-neutral terms: an adapter can attach private state to an ordered response part, recover it after restart and keep it out of foreign projections. Keep provider names, login details and prototype code in the spike material. The refactor can then be implemented and reviewed independently.
