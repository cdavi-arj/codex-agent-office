#!/usr/bin/env node

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

function arg(name, fallback = undefined) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

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

function stableSessionId() {
  const agent = arg('agent');
  if (agent) return `codex-agent:${agent}`;
  return (
    process.env.CODEX_PIXEL_SESSION_ID ||
    process.env.CODEX_SESSION_ID ||
    process.env.CODEX_THREAD_ID ||
    `codex-${process.ppid}-${path.basename(process.cwd())}`
  );
}

function payloadFor() {
  const event = arg('event', 'ToolStart');
  const tool = arg('tool', 'Codex');
  const explicitToolId = arg('tool-id');
  const toolId = explicitToolId ?? `codex-${Date.now()}`;
  const cmd = arg('cmd');
  const status = arg('status');
  const payload = {
    session_id: arg('session', stableSessionId()),
    hook_event_name: event,
    source: 'codex',
    cwd: arg('cwd', process.cwd()),
  };

  if (status) payload.status = status;
  if (event.toLowerCase().includes('tool') || status === 'working') {
    if (!event.toLowerCase().includes('end') || explicitToolId) payload.tool_id = toolId;
    payload.tool_name = tool;
    payload.tool_input = cmd ? { cmd } : {};
  }
  if (event === 'TurnEnd' && arg('awaiting-input')) payload.awaitingInput = true;
  return payload;
}

async function post(config, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
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
        timeout: 1200,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode && res.statusCode < 400));
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end(body);
  });
}

const config = latestServerConfig();
if (!config) process.exit(0);
const payload = payloadFor();
if (payload.hook_event_name === 'ToolStart') {
  await post(config, {
    session_id: payload.session_id,
    hook_event_name: 'SessionStart',
    source: 'codex',
    cwd: payload.cwd,
  });
}
const ok = await post(config, payload);
process.exit(ok ? 0 : 1);
