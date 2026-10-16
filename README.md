# Codex Claude Bridge

Run Codex with Anthropic models authenticated through Pi and OpenAI models
using your Codex login. Switch between them with `/model` in the same session. This is an
independent integration, not an official OpenAI or Anthropic product.
Defaults: `anthropic/claude-opus-5-5`, medium reasoning effort.

## Installation

Requirements: Node.js 22 or newer, the `codex` and `pi` CLIs on `PATH`, and
Anthropic access configured in Pi, and OpenAI access configured with `codex login`.
The combined model picker and routing are tested with Codex 0.163.0 and Pi 0.87.1.

Install those CLI versions if they are not already available:

```bash
npm install -g @openai/codex@0.163.0 @earendil-works/pi-coding-agent@0.87.1
```

Clone this repository and enter its directory:

```bash
git clone https://github.com/bigbizze/codex-claude-bridge.git
cd codex-claude-bridge
```

This project has no npm dependencies, so it does not need `npm install`.
Start `pi` and run `/login anthropic` to configure authentication, then exit Pi.
Credentials stay in Pi's auth store; do not copy them into this checkout.

From the checkout, run:

```bash
node --test bridge.test.mjs
node launch.mjs --check
node launch.mjs
```

To use `codex-claude` from any directory, add an alias to `~/.bashrc` with the
absolute path to your checkout. Replace the example path below:

```bash
alias codex-claude='node "/absolute/path/to/codex-claude-bridge/launch.mjs"'
```

Open a new Bash shell or run `source ~/.bashrc` to load the alias. Moving the
checkout requires updating this alias. The bridge does not require a separate
OpenAI API key when using your ChatGPT login. Anthropic usage is billed through
Pi's configured account; OpenAI usage uses your Codex account or API key.

## Usage

```bash
codex-claude
codex-claude exec 'Explain this project'
codex-claude -c model_reasoning_effort='"high"'
codex-claude -c model_reasoning_effort='"xhigh"'
codex-claude -c model_reasoning_effort='"max"'
codex-claude --check
```

`--check` starts the bridge and asks Codex to parse both model catalogs. It makes no model inference request. `CODEX_CLAUDE_MODEL` selects another authenticated `anthropic/` starting model. Normal Codex sandbox and approval settings still apply.

The effort picker includes extra high (`xhigh`) and `max` when Pi's model metadata
maps those values to native provider levels. Claude Opus 5.5 supports both.
Medium remains the default. Restart the bridge to load an updated picker.

## Switch providers

Use `/model` and choose an OpenAI model such as `gpt-6-astra`, or choose an
`anthropic/` model to switch back. Finish or interrupt the current turn first.
The bridge routes the next request to the selected provider without creating
a new conversation. OpenAI model names, context limits, instructions, and effort
choices come from the installed Codex binary's bundled catalog. Upgrade Codex
and restart the bridge to update that list.

For an existing bridge conversation, exit its old client and resume through the
updated launcher, then use `/model`:

```bash
codex-claude resume <session-id>
```

The saved session retains both providers' original reasoning items. Each outgoing
request omits the other provider's encrypted reasoning and keeps readable
summaries as historical text. Legacy Claude custom-tool item IDs are normalized
to OpenAI's `ctc_` prefix on outgoing requests; tool call/result associations and
saved IDs are preserved. Switching back reuses the original reasoning items
still present in the active history, including after a restart; no positional
patch or separate sidecar is needed. Claude model associations are retained so
Pi can normalize reasoning when changing between different Claude models.
Normal Codex compaction can still replace old active context with a summary.
The native session is not rewritten by the bridge, and the archival handoff's
12 MiB limit does not apply to `/model` switching.

OpenAI requests use Codex's authentication and refresh handling. The bridge sends
them to the ChatGPT Codex endpoint for a ChatGPT login, or the OpenAI API for an
API key. It does not inherit a custom OpenAI proxy/base URL from Codex config.
Keep launching mixed sessions through `codex-claude`; plain `codex resume` does
not perform this request conversion.

### Archival handoff commands

The older commands below remain available when you want a separate continuation
and a private archive. They are not needed for `/model` switching.

Finish the current turn and exit its client, then use its session UUID:

```bash
codex-claude switch-to-codex <session-id>
codex-claude switch-to-claude <session-id>
```

Each command creates a new continuation and opens it in the terminal. It keeps
the source working directory and does not modify the source session or project
files. Switch back using the new continuation's ID, not the old source ID, to
include the intervening work. This is an explicit handoff, not an in-session
`/model` provider switch.

`switch-to-codex` uses normal Codex configuration for the provider, model, effort,
authentication, and permissions. It does not start Pi or install the bridge's
model catalog. `switch-to-claude` uses the bridge defaults: `CODEX_CLAUDE_MODEL`
if set, otherwise Claude Opus 5.5, with medium effort. The source's model, effort,
and permission settings are not copied to the destination. Neither command
accepts model overrides; configure the destination before switching.

The handoff builds a shared history from the saved conversation:

- User messages, assistant answers, and inline images are preserved.
- Readable reasoning summaries are preserved as historical text. Encrypted
  reasoning stays in the archive and is not replayed, even when switching back.
- Tool calls and results become historical text records. They retain the saved
  arguments and readable results, but are not executable calls in the new thread.
  Calls without results from explicitly aborted turns are retained with an
  unknown-outcome notice; they do not block the handoff.
- Destination instructions are loaded afresh. Source system/developer setup,
  runtime settings, and opaque provider fields are archived, not imported.
- Available messages from before compaction and readable compaction summaries
  are retained. No model-generated summary or automatic truncation is performed.

Each transfer writes a private directory under
`${XDG_STATE_HOME:-~/.local/state}/codex-claude-bridge/handoffs/` containing
`source.jsonl` (the original bytes), `state.json` (the shared history), and
`receipt.json` (source/destination IDs and the source hash). Directories use mode
0700 and files use 0600. These files contain conversation data, possibly including
sensitive tool output; protect them like your Codex history. They do not belong
in this repository. A failed transfer can leave an archive and an incomplete new
thread; the error identifies them, and that thread is not launched automatically.

Handoffs require Codex App Server's experimental `thread/inject_items` method and
are validated with Codex 0.159.0. They currently support standalone local JSONL
histories, including the local paginated format. Forked histories, rollbacks,
unfinished tool calls/turns, remote histories, audio, file-ID/remote images, and
unknown item types fail explicitly. Close the source client first: a separate
App Server cannot reliably detect an idle client that may write again later.
The command also checks that the source bytes have not changed during transfer.

The archive limit is 128 MiB; projected history is limited to 12 MiB. The target
model's context limit still applies, and Codex may compact that target session.
An archive cannot recover history that Codex removed before the handoff. Imported
records are model-visible context; they may not appear as old turns in the TUI.

Tests for the shared state and failure paths run with `node --test *.test.mjs`. To also test
persistence, resume, and both request directions with the installed Codex and a
loopback-only mock model endpoint (no account or paid inference):

```bash
CODEX_HANDOFF_INTEGRATION=1 node --test handoff.integration.test.mjs
CODEX_ROUTING_INTEGRATION=1 node --test routing.integration.test.mjs launch.integration.test.mjs
```

## Runtime

Each launch starts one Pi RPC process with only this project's `extension.ts` enabled. That extension serves the Responses API directly on an OS-assigned loopback port. The Codex process receives a random per-launch token in a separate `x-codex-bridge-token` header, leaving its normal OpenAI authorization header intact. The bridge token is never forwarded to OpenAI. Ports and services are never shared between launches. The launcher stops its Pi process and removes its temporary catalogs when Codex exits.

Pi owns Anthropic authentication and token refresh. Claude requests use `ctx.modelRegistry.streamSimple()` with reasoning effort supplied directly. OpenAI requests and responses retain the native Responses protocol, including tool records and OpenAI reasoning state. Codex owns OpenAI authentication and refresh; the bridge does not read or write its credential store. There are no runtime npm dependencies in this project, no edits to installed packages, and no patch-package step.

The launcher generates a Codex model catalog using Pi's model names, input modalities, reasoning support, and context limits. This avoids the model metadata fallback warning. `codex-instructions.md` preserves Codex's generic coding instructions, copied from OpenAI Codex tag `rust-v0.156.1`, `codex-rs/models-manager/prompt.md`. Its obsolete shell-based apply_patch example was replaced with the custom tool input format. See `LICENSE.codex` for the source license.

Thinking blocks and provider signatures are encrypted into Responses reasoning items so tool loops can continue after a restart. The encryption key is stored at `${XDG_STATE_HOME:-~/.local/state}/codex-claude-bridge/reasoning.key` with mode 0600. Keep this key if you need to resume bridge sessions. Pi OAuth credentials remain in Pi's own auth store.

## Supported and unsupported operations

Supported: text, base64 images, developer instructions, streamed output, namespace/function/custom tools (including apply_patch), tool results, reasoning effort, reasoning signature replay, cache-aware token usage, cancellation, and full-history resume.

For Claude, unsupported requests fail explicitly: provider-hosted tools, remote image URLs, input files, Responses compaction items, background Responses jobs, previous_response_id continuation, and forced tool selection. Codex's native web search stays disabled for mixed sessions so their histories can return to Claude. Local/MCP tools can still run through Codex. Claude custom grammar tools are adapted to a JSON string argument; the provider does not enforce the original grammar.

The request limit is 16 MiB. Model requests time out after 10 minutes without
provider activity. Each provider event resets this timer; local SSE heartbeats
do not. An active response can run longer than 10 minutes. Network errors and
interrupted/incomplete responses remain errors. A simple successful prompt does
not establish compatibility with every Codex feature.

## Updates and troubleshooting

To update the bridge, exit any running bridge sessions and run these commands
from your repository checkout:

```bash
git pull --ff-only
node --test bridge.test.mjs
node launch.mjs --check
```

Restart `codex-claude` after the update. Your existing alias still works.
The bridge adds a user continuation message when a retry ends with retained
assistant text. It omits unfinished thinking-only assistant turns from provider
requests, because Claude rejects those turns. Existing conversation files are
preserved. Pi can retry failed connection attempts twice before response
streaming starts. It does not repeat a response after streaming starts.
This updates only the bridge, not Codex or Pi. If Git reports local changes or
divergent history, resolve those before retrying; do not discard your changes.

Validated with Codex 0.156.1, Pi 0.87.1, and Node 24.21.0. The earlier Codex 0.156.0 to 0.156.1 upgrade did not break model calls.

| Change | What to check |
| --- | --- |
| Codex upgrade | Run `codex-claude --check`, then a small tool call. Responses events, tool schemas, catalog fields, and the generic coding prompt can change. |
| Pi upgrade | Run `codex-claude --check`. The extension API, model catalog, and authentication transport can change. |
| Claude access error | Run `pi auth check --provider anthropic`; use `/login anthropic` in Pi if needed. Subscription limits and model availability still apply. |
| OpenAI access error | Run `codex login`, then restart the bridge. OpenAI access uses Codex credentials, not Pi credentials. |
| OpenAI models missing from `/model` | Exit the old bridge process, resume with the updated `codex-claude`, and run `codex-claude --check` if the list is still missing. |
| New Claude model/client-version error | Update Pi; its provider transport owns the client version. Updating Claude Code alone does not update Pi's transport. |
| Node/PATH change | Ensure `node`, `pi`, and `codex` are available in the same shell. The alias depends on this project remaining at its current path. |
| Existing old session | Exit and relaunch it. A running Node process keeps its already-loaded implementation. |

Run `npm test` for local protocol tests. Set `CODEX_PI_DEBUG=1` for provider completion/error diagnostics on stderr; the bridge does not write prompt or credential logs.

## License

The bridge code is licensed under MIT; see `LICENSE`.
`codex-instructions.md` is derived from OpenAI Codex and retains its Apache-2.0
license; see `LICENSE.codex` and `NOTICE`. Its source and modification are
described above. The package metadata identifies this combination as
`MIT AND Apache-2.0`.
