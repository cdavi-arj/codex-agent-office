#!/usr/bin/env node

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS_ROOT = path.join(CODEX_HOME, 'sessions');
const AGENTS_ROOT = path.join(CODEX_HOME, 'agents');
const LOCKS_ROOT = path.join(CODEX_HOME, 'thread-writer-locks');
const POLL_MS = Number(process.env.CODEX_PIXEL_WATCH_POLL_MS || 1200);
const IDLE_MS = Number(process.env.CODEX_PIXEL_WATCH_IDLE_MS || 30_000);
const ACTIVE_FILE_MS = Number(process.env.CODEX_PIXEL_WATCH_ACTIVE_FILE_MS || 30 * 60 * 1000);
const MAX_READ_BYTES = 512 * 1024;

const files = new Map();
const liveAgents = new Map();
const agentNames = loadAgentNames();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function latestServerConfig() {
  const root = path.join(os.homedir(), '.pixel-agents');
  const direct = readJson(path.join(root, 'server.json'));
  if (direct?.port && direct?.token) return direct;

  const serversDir = path.join(root, 'servers');
  let entries = [];
  try {
    entries = fs
      .readdirSync(serversDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => readJson(path.join(serversDir, file)))
      .filter((entry) => entry?.port && entry?.token);
  } catch {
    return null;
  }
  entries.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return entries[0] ?? null;
}

function loadAgentNames() {
  try {
    return fs
      .readdirSync(AGENTS_ROOT)
      .filter((file) => file.endsWith('.toml'))
      .map((file) => {
        const source = fs.readFileSync(path.join(AGENTS_ROOT, file), 'utf8');
        return source.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? path.basename(file, '.toml');
      })
      .sort((a, b) => b.length - a.length);
  } catch {
    return ['demand-developer'];
  }
}

function walkJsonl(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(full, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function sessionIdFromFile(file) {
  return path.basename(file, '.jsonl').split('-').slice(-5).join('-');
}

function threadIdFromFile(file) {
  const name = path.basename(file, '.jsonl');
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match?.[1];
}

function hasRecentLock(file) {
  const threadId = threadIdFromFile(file);
  if (!threadId) return false;
  try {
    const stat = fs.statSync(path.join(LOCKS_ROOT, `${threadId}.lock`));
    return Date.now() - stat.mtimeMs <= ACTIVE_FILE_MS;
  } catch {
    return false;
  }
}

function safePost(payload) {
  const config = latestServerConfig();
  if (!config) return;
  const body = JSON.stringify(payload);
  const req = http.request(
    {
      method: 'POST',
      hostname: '127.0.0.1',
      port: config.port,
      path: '/api/hooks/codex',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 900,
    },
    (res) => res.resume(),
  );
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(body);
}

function send(agent, event, extra = {}) {
  safePost({
    session_id: `codex-agent:${agent}`,
    hook_event_name: event,
    source: 'codex-watch',
    cwd: extra.cwd || process.cwd(),
    ...extra,
  });
}

function inferAgent(record, rawLine, previous) {
  for (const name of agentNames) {
    if (rawLine.includes(name)) return name;
  }

  const payload = record.payload || {};
  const toolName = String(payload.name || payload.type || '').toLowerCase();
  const haystack = `${toolName} ${JSON.stringify(payload).slice(0, 3000)}`.toLowerCase();

  if (/browser|screenshot|playwright|chrome|accessib|console|network/.test(haystack)) {
    return 'browser-qa';
  }
  if (/salesforce|\\bsf\\b|apex|lwc|soql|metadata|deploy/.test(haystack)) {
    return 'salesforce-implementer';
  }
  if (/web_search|webfetch|firecrawl|search_query|scrape|github|http/.test(haystack)) {
    return 'web-researcher';
  }
  if (/doc|pdf|markdown|requirement|demanda|refinamento/.test(haystack)) {
    return 'docs-analyst';
  }
  if (/review|lint|test|validate|check/.test(haystack)) {
    return 'demand-validator';
  }
  if (/apply_patch|edit|write|exec|command|shell|bash|npm|node|rg|read/.test(haystack)) {
    return 'demand-developer';
  }

  return previous || 'demand-developer';
}

function toolNameFor(payload) {
  const type = String(payload.type || 'codex');
  const name = String(payload.name || '');
  if (name) return name;
  if (type === 'custom_tool_call') return 'custom_tool';
  if (type === 'function_call') return 'function_call';
  if (type === 'task_started') return 'Codex';
  return type;
}

function statusInputFor(payload) {
  const type = String(payload.type || '');
  const name = String(payload.name || '');
  if (name.includes('exec_command')) return { cmd: 'shell command' };
  if (name.includes('apply_patch') || type.includes('patch')) return { cmd: 'code edit' };
  if (name.includes('web') || name.includes('search')) return { cmd: 'research' };
  return {};
}

function recentFileSnapshot(file, stat) {
  const length = Math.min(stat.size, MAX_READ_BYTES);
  if (length <= 0) return '';
  try {
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    fs.closeSync(fd);
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

function parseSnapshot(file, chunk, fallbackAgent) {
  const snapshot = {
    agent: fallbackAgent || 'demand-developer',
    cwd: undefined,
    lastSignal: 'unknown',
    lastTool: undefined,
    lastToolId: undefined,
    sawWork: false,
  };

  for (const line of chunk.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = record.payload || {};
    const payloadType = payload.type;
    snapshot.agent = inferAgent(record, line, snapshot.agent);
    if (record.type === 'turn_context' && payload.cwd) snapshot.cwd = payload.cwd;

    if (record.type === 'event_msg' && payloadType === 'task_started') {
      snapshot.sawWork = true;
      snapshot.lastSignal = 'active';
      snapshot.lastTool = 'Codex';
      snapshot.lastToolId = `watch-${sessionIdFromFile(file)}-bootstrap`;
    } else if (
      record.type === 'response_item' &&
      (payloadType === 'function_call' || payloadType === 'custom_tool_call')
    ) {
      snapshot.sawWork = true;
      snapshot.lastSignal = 'active';
      snapshot.lastTool = toolNameFor(payload);
      snapshot.lastToolId =
        payload.call_id || payload.id || `watch-${sessionIdFromFile(file)}-tool`;
    } else if (
      (record.type === 'response_item' &&
        (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output')) ||
      (record.type === 'event_msg' && payloadType === 'patch_apply_end')
    ) {
      snapshot.lastSignal = 'tool-ended';
    } else if (record.type === 'event_msg' && payloadType === 'task_complete') {
      snapshot.lastSignal = 'complete';
    }
  }

  return snapshot;
}

function markAgentActive(agent, file, snapshot, reason) {
  const now = Date.now();
  if (!liveAgents.has(agent)) {
    send(agent, 'SessionStart', { cwd: snapshot.cwd || process.cwd() });
    liveAgents.set(agent, { active: false, last: now });
  }
  const live = liveAgents.get(agent);
  live.active = true;
  live.last = now;
  send(agent, 'SessionStart', { cwd: snapshot.cwd || process.cwd() });
  send(agent, 'ToolStart', {
    tool_id: snapshot.lastToolId || `watch-${sessionIdFromFile(file)}-${now}`,
    tool_name: snapshot.lastTool || 'Codex',
    tool_input: { cmd: reason },
    cwd: snapshot.cwd || process.cwd(),
  });
}

function bootstrapRecentActivity(file, stat) {
  const locked = hasRecentLock(file);
  if (!locked && Date.now() - stat.mtimeMs > ACTIVE_FILE_MS) return;
  const state = files.get(file);
  if (!state) return;
  if (state.lastBootstrappedMtime >= stat.mtimeMs && state.lastBootstrappedLock === locked) return;

  const snapshot = parseSnapshot(file, recentFileSnapshot(file, stat), state.agent);
  state.agent = snapshot.agent;
  state.cwd = snapshot.cwd || state.cwd;

  const looksActive =
    snapshot.sawWork &&
    (snapshot.lastSignal === 'active' || locked || stat.mtimeMs > Date.now() - IDLE_MS);
  if (!looksActive) return;

  const live = liveAgents.get(snapshot.agent);
  if (live?.active && Date.now() - live.last < IDLE_MS) return;
  state.lastBootstrappedMtime = stat.mtimeMs;
  state.lastBootstrappedLock = locked;
  markAgentActive(
    snapshot.agent,
    file,
    snapshot,
    locked ? 'active Codex writer lock' : 'active Codex session',
  );
}

function handleRecord(file, line, record) {
  const state = files.get(file);
  const payload = record.payload || {};
  const payloadType = payload.type;
  const agent = inferAgent(record, line, state.agent);
  const now = Date.now();
  state.agent = agent;

  if (!liveAgents.has(agent)) {
    send(agent, 'SessionStart', { cwd: state.cwd || process.cwd() });
    liveAgents.set(agent, { active: false, last: now });
  }

  const live = liveAgents.get(agent);
  live.last = now;

  if (record.type === 'turn_context') {
    state.cwd = payload.cwd || state.cwd;
    return;
  }

  if (record.type === 'event_msg' && payloadType === 'task_started') {
    send(agent, 'SessionStart', { cwd: state.cwd || process.cwd() });
    live.active = true;
    send(agent, 'ToolStart', {
      tool_id: `watch-${sessionIdFromFile(file)}-${now}`,
      tool_name: 'Codex',
      tool_input: { cmd: 'processing turn' },
      cwd: state.cwd || process.cwd(),
    });
    return;
  }

  if (
    record.type === 'response_item' &&
    (payloadType === 'function_call' || payloadType === 'custom_tool_call')
  ) {
    live.active = true;
    send(agent, 'ToolStart', {
      tool_id: payload.call_id || payload.id || `watch-${now}`,
      tool_name: toolNameFor(payload),
      tool_input: statusInputFor(payload),
      cwd: state.cwd || process.cwd(),
    });
    return;
  }

  if (
    (record.type === 'response_item' &&
      (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output')) ||
    (record.type === 'event_msg' && payloadType === 'patch_apply_end')
  ) {
    send(agent, 'ToolEnd', {
      tool_id: payload.call_id || payload.id || 'current',
      cwd: state.cwd || process.cwd(),
    });
    return;
  }

  if (record.type === 'event_msg' && payloadType === 'task_complete') {
    live.active = false;
    send(agent, 'ToolEnd', { tool_id: 'current', cwd: state.cwd || process.cwd() });
    send(agent, 'TurnEnd', { cwd: state.cwd || process.cwd() });
  }
}

function registerFile(file, startAtEnd = true) {
  if (files.has(file)) return;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  files.set(file, {
    size: startAtEnd ? stat.size : 0,
    agent: undefined,
    cwd: undefined,
    bootstrappedAt: 0,
    lastBootstrappedMtime: 0,
    lastBootstrappedLock: false,
  });
  bootstrapRecentActivity(file, stat);
}

function processFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    files.delete(file);
    return;
  }

  const state = files.get(file);
  if (!state || stat.size <= state.size) return;

  const start = Math.max(state.size, stat.size - MAX_READ_BYTES);
  const length = stat.size - start;
  let chunk = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    fs.closeSync(fd);
    chunk = buffer.toString('utf8');
  } catch {
    state.size = stat.size;
    return;
  }

  state.size = stat.size;
  for (const line of chunk.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      handleRecord(file, line, JSON.parse(line));
    } catch {
      // Ignore partial lines while Codex is still writing.
    }
  }
}

function refreshRecentActivity() {
  const now = Date.now();
  for (const [file, state] of files) {
    if (now - state.bootstrappedAt < IDLE_MS) continue;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    state.bootstrappedAt = now;
    bootstrapRecentActivity(file, stat);
  }
}

function sweepIdle() {
  const now = Date.now();
  for (const [agent, live] of liveAgents) {
    if (live.active && now - live.last > IDLE_MS) {
      live.active = false;
      send(agent, 'ToolEnd', { tool_id: 'current' });
      send(agent, 'TurnEnd');
    }
  }
}

function tick() {
  for (const file of walkJsonl(SESSIONS_ROOT)) registerFile(file, true);
  for (const file of files.keys()) processFile(file);
  refreshRecentActivity();
  sweepIdle();
}

for (const file of walkJsonl(SESSIONS_ROOT)) registerFile(file, true);
console.log(
  `[codex-agent-watch] watching ${files.size} Codex session file(s); ${agentNames.length} configured agent(s)`,
);
setInterval(tick, POLL_MS);
tick();
