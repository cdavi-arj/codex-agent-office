# Codex Agent Office Instructions

This repository is Davi's Codex-focused fork of Pixel Agents.

## Project Intent

- Keep the upstream Pixel Agents office experience intact.
- Add local Codex visibility without exposing prompts, responses, diffs, logs,
  secrets, cookies, or customer data.
- Prefer compact deterministic events over LLM-generated status summaries.
- Keep the fork easy to rebase against `pixel-agents-hq/pixel-agents`.

## Codex Integration Files

- `server/src/providers/hook/codex/codex.ts`: Codex event normalization.
- `server/src/providers/hook/codex/codexRoster.ts`: idle roster from
  `~/.codex/agents`.
- `scripts/codex-pixel-event.mjs`: manual event publisher.
- `scripts/codex-agent-watch.mjs`: local session watcher.
- `docs/codex-agent-office.md`: operating documentation.

## Development Notes

- Run `npm run check-types` before committing provider changes.
- Run `npm run build` before publishing or using `dist/cli.js`.
- Do not commit local server tokens from `~/.pixel-agents`.
- Do not commit Codex session JSONL files from `~/.codex`.
- Keep watcher events compact: agent, event, tool/status, cwd, and session id are
  enough.
