# Codex Claude Bridge

Run Codex with an Anthropic model authenticated through Pi. This is an
independent integration, not an official OpenAI or Anthropic product.
Defaults: `anthropic/claude-opus-5-5`, medium reasoning effort.

## Installation

Requirements: Node.js 22 or newer, the `codex` and `pi` CLIs on `PATH`, and
Anthropic access configured in Pi. Linux and Bash are the validated environment.
The validated CLI versions are Codex 0.156.1 and Pi 0.87.1.

Install those CLI versions if they are not already available:

```bash
npm install -g @openai/codex@0.156.1 @earendil-works/pi-coding-agent@0.87.1
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
OpenAI API key. Provider access and usage limits are determined by Pi's
configured Anthropic account.

## Usage

```bash
codex-claude
codex-claude exec 'Explain this project'
codex-claude -c model_reasoning_effort='"high"'
codex-claude --check
```

`--check` starts the bridge and asks Codex to parse the model catalog. It makes no model inference request. `CODEX_CLAUDE_MODEL` selects another authenticated `anthropic/` model. Normal Codex sandbox and approval settings still apply.

## Runtime

Each launch starts one Pi RPC process with only this project's `extension.ts` enabled. That extension serves the Responses API directly on an OS-assigned loopback port. The Codex process receives a random per-launch bearer token. Ports and services are never shared between launches. The launcher stops its Pi process and removes its temporary catalog when Codex exits.

Pi owns subscription authentication and token refresh. The bridge uses `ctx.modelRegistry.streamSimple()` and supplies reasoning effort directly. There are no runtime npm dependencies in this project, no edits to installed packages, and no patch-package step.

The launcher generates a Codex model catalog using Pi's model names, input modalities, reasoning support, and context limits. This avoids the model metadata fallback warning. `codex-instructions.md` preserves Codex's generic coding instructions, copied from OpenAI Codex tag `rust-v0.156.1`, `codex-rs/models-manager/prompt.md`. Its obsolete shell-based apply_patch example was replaced with the custom tool input format. See `LICENSE.codex` for the source license.

Thinking blocks and provider signatures are encrypted into Responses reasoning items so tool loops can continue after a restart. The encryption key is stored at `${XDG_STATE_HOME:-~/.local/state}/codex-claude-bridge/reasoning.key` with mode 0600. Keep this key if you need to resume bridge sessions. Pi OAuth credentials remain in Pi's own auth store.

## Supported and unsupported operations

Supported: text, base64 images, developer instructions, streamed output, namespace/function/custom tools (including apply_patch), tool results, reasoning effort, reasoning signature replay, cache-aware token usage, cancellation, and full-history resume.

Unsupported requests fail explicitly: provider-hosted tools, remote image URLs, input files, Responses compaction items, background Responses jobs, previous_response_id continuation, and forced tool selection. Codex's native web search is disabled for this provider. Local/MCP tools can still run through Codex. Custom grammar tools are adapted to a JSON string argument; the provider does not enforce the original grammar.

The request limit is 16 MiB and the model request timeout is 10 minutes. Network errors and interrupted/incomplete responses remain errors. A simple successful prompt does not establish compatibility with every Codex feature.

## Updates and troubleshooting

Validated with Codex 0.156.1, Pi 0.87.1, and Node 24.21.0. The earlier Codex 0.156.0 to 0.156.1 upgrade did not break model calls.

| Change | What to check |
| --- | --- |
| Codex upgrade | Run `codex-claude --check`, then a small tool call. Responses events, tool schemas, catalog fields, and the generic coding prompt can change. |
| Pi upgrade | Run `codex-claude --check`. The extension API, model catalog, and authentication transport can change. |
| Claude access error | Run `pi auth check --provider anthropic`; use `/login anthropic` in Pi if needed. Subscription limits and model availability still apply. |
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
