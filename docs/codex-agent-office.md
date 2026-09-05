# Codex Agent Office

Codex Agent Office is a local fork of Pixel Agents tailored for Davi's Codex
workflow. The goal is to keep the "agents in an office" interface from Pixel
Agents, while reflecting local Codex activity with compact, privacy-preserving
signals.

## Runtime Shape

The app still follows the upstream Pixel Agents architecture:

- `core/`: typed provider and message contracts.
- `server/`: Fastify server, WebSocket transport, runtime state, providers, and
  standalone CLI.
- `webview-ui/`: React and Canvas UI for the animated office.
- `adapters/vscode/`: upstream VS Code extension adapter.

This fork adds:

- `server/src/providers/hook/codex/codex.ts`: Codex hook provider. It accepts
  compact event payloads posted to `/api/hooks/codex` and turns them into runtime
  events such as `sessionStart`, `toolStart`, `toolEnd`, `turnEnd`, and
  `permissionRequest`.
- `server/src/providers/hook/codex/codexRoster.ts`: startup roster seeding from
  `~/.codex/agents/*.toml`, so every configured local Codex agent can appear in
  the office even before a task starts.
- `scripts/codex-pixel-event.mjs`: one-shot event publisher for explicit Codex
  lifecycle updates.
- `scripts/codex-agent-watch.mjs`: resident watcher that tails local Codex
  session files and thread writer locks to infer active work.

## What The Game Shows

Each configured Codex agent is represented by an office character. When the
runtime receives a real work signal, the matching character leaves idle state and
shows activity such as reading, editing, searching, running commands, validating,
or waiting for input.

The UI does not receive prompts, responses, diffs, full commands, stdout, stderr,
cookies, API keys, or customer data. The bridge sends only compact lifecycle
metadata: agent name, event kind, short tool/status label, workspace directory,
and local session identity.

## How Real-Time Tracking Works

There are two local signal paths:

1. Explicit events from Codex tasks:

   ```bash
   node scripts/codex-pixel-event.mjs --agent demand-developer --event SessionStart
   node scripts/codex-pixel-event.mjs --agent demand-developer --event ToolStart --tool exec_command --cmd "npm run check-types"
   node scripts/codex-pixel-event.mjs --agent demand-developer --event TurnEnd
   ```

2. Resident watcher:

   ```bash
   node scripts/codex-agent-watch.mjs
   ```

The watcher reads local Codex session metadata from:

- `~/.codex/agents`
- `~/.codex/sessions`
- `~/.codex/thread-writer-locks`

It posts compact events to the currently running Pixel Agents server registered
under `~/.pixel-agents/`.

## Running Locally

```bash
npm install
npm run build
node dist/cli.js --host 127.0.0.1 --port 3100
```

For mobile testing on a trusted local network, bind to all interfaces:

```bash
node dist/cli.js --host 0.0.0.0 --port 3100
```

Then open the printed URL from the phone using the Mac's local network IP
address. Keep the token private.

## Optional Background Watcher On macOS

A LaunchAgent can keep the watcher alive while the server is running. Use the
template at `scripts/launchd/com.davi.codex-pixel-watch.plist.example`, replace
`/absolute/path/to/codex-agent-office` with the clone path, then load it:

```bash
cp scripts/launchd/com.davi.codex-pixel-watch.plist.example ~/Library/LaunchAgents/com.davi.codex-pixel-watch.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.davi.codex-pixel-watch.plist
```

Unload it before deleting or moving the clone:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.davi.codex-pixel-watch.plist
rm ~/Library/LaunchAgents/com.davi.codex-pixel-watch.plist
```

## Privacy And Token Use

The office should not ask language models to summarize every step. That would
consume tokens and risk leaking unnecessary context. This integration instead
uses deterministic local signals:

- file timestamps and writer locks for "working now";
- tool names for "what kind of work";
- configured agent names for identity;
- short status strings for display.

That keeps the game cheap to run and makes it observational rather than another
agent in the workflow.

## Future Improvements

- Add a first-class Codex hook installer if Codex exposes stable hook settings.
- Improve role inference using structured local agent metadata instead of string
  matching.
- Add a local event log view that explains exactly why an agent changed state.
- Add BI panels fed by explicit project metrics, not generated filler data.
- Add room routing rules so QA, development, documentation, and Salesforce work
  move agents to specialized areas.
