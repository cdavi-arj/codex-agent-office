import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentStateStore } from '../../../agentStateStore.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../../../constants.js';
import { assignPaletteIfNeeded } from '../../../paletteAssigner.js';
import type { AgentState } from '../../../types.js';

const CODEX_AGENT_DIR = path.join(os.homedir(), '.codex', 'agents');

function tomlString(source: string, key: string): string | undefined {
  const match = source.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'));
  return match?.[1];
}

function codexAgentFiles(): string[] {
  try {
    return fs
      .readdirSync(CODEX_AGENT_DIR)
      .filter((file) => file.endsWith('.toml'))
      .map((file) => path.join(CODEX_AGENT_DIR, file))
      .sort();
  } catch {
    return [];
  }
}

function knownSessionIds(store: AgentStateStore): Set<string> {
  const ids = new Set<string>();
  for (const agent of store.values()) ids.add(agent.sessionId);
  return ids;
}

function createIdleCodexAgent(id: number, name: string): AgentState {
  return {
    id,
    sessionId: `codex-agent:${name}`,
    terminalRef: undefined,
    isExternal: true,
    projectDir: CODEX_AGENT_DIR,
    jsonlFile: '',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: true,
    permissionSent: false,
    hadToolsInTurn: false,
    hookDelivered: true,
    hooksOnly: true,
    providerId: 'codex',
    lastDataAt: Date.now(),
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    folderName: name,
    contextTokens: 0,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  };
}

export function seedCodexAgentRoster(store: AgentStateStore): number {
  const existing = knownSessionIds(store);
  let added = 0;

  for (const file of codexAgentFiles()) {
    let source = '';
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const name = tomlString(source, 'name') ?? path.basename(file, '.toml');
    const sessionId = `codex-agent:${name}`;
    if (existing.has(sessionId)) continue;

    const id = store.nextAgentId.current++;
    const agent = createIdleCodexAgent(id, name);
    assignPaletteIfNeeded(agent, store);
    store.set(id, agent);
    existing.add(sessionId);
    added++;
  }

  return added;
}
