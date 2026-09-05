import * as os from 'os';
import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../../constants.js';

const CODEX_TERMINAL_NAME_PREFIX = 'Codex';

function stringField(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function objectField(raw: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return {};
}

function eventNameFor(raw: Record<string, unknown>): string | undefined {
  return stringField(raw, 'hook_event_name', 'hookEventName', 'event', 'type');
}

function sessionIdFor(raw: Record<string, unknown>): string | undefined {
  return stringField(raw, 'session_id', 'sessionId', 'thread_id', 'threadId', 'task_id', 'taskId');
}

function toolNameFor(raw: Record<string, unknown>): string {
  return stringField(raw, 'tool_name', 'toolName', 'tool', 'action', 'skill') ?? 'Codex';
}

function toolIdFor(raw: Record<string, unknown>): string {
  return (
    stringField(raw, 'tool_id', 'toolId', 'command_id', 'commandId') ?? `codex-hook-${Date.now()}`
  );
}

function normalizeStatus(
  raw: Record<string, unknown>,
  sessionId: string,
): {
  sessionId: string;
  event: AgentEvent;
} | null {
  const status = stringField(raw, 'status')?.toLowerCase();
  if (!status) return null;

  if (status === 'working' || status === 'running' || status === 'active') {
    const input = objectField(raw, 'tool_input', 'toolInput', 'input');
    return {
      sessionId,
      event: {
        kind: 'toolStart',
        toolId: toolIdFor(raw),
        toolName: toolNameFor(raw),
        input: Object.keys(input).length > 0 ? input : raw,
      },
    };
  }

  if (status === 'waiting' || status === 'blocked') {
    return { sessionId, event: { kind: 'turnEnd', awaitingInput: true } };
  }

  if (status === 'done' || status === 'idle' || status === 'complete' || status === 'completed') {
    return { sessionId, event: { kind: 'turnEnd' } };
  }

  return null;
}

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const sessionId = sessionIdFor(raw);
  if (!sessionId) return null;

  const statusEvent = normalizeStatus(raw, sessionId);
  if (statusEvent) return statusEvent;

  const eventName = eventNameFor(raw);
  if (!eventName) return null;

  switch (eventName) {
    case 'SessionStart':
    case 'sessionStart':
    case 'session_start':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: stringField(raw, 'source') ?? 'codex',
          transcriptPath: stringField(raw, 'transcript_path', 'transcriptPath'),
          cwd: stringField(raw, 'cwd', 'workspace', 'workspacePath') ?? process.cwd(),
        },
      };

    case 'PreToolUse':
    case 'ToolStart':
    case 'toolStart':
    case 'tool_start':
    case 'CommandStart':
    case 'commandStart':
    case 'command_start': {
      const input = objectField(raw, 'tool_input', 'toolInput', 'input');
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: toolIdFor(raw),
          toolName: toolNameFor(raw),
          input,
          runInBackground: raw.run_in_background === true || raw.runInBackground === true,
        },
      };
    }

    case 'PostToolUse':
    case 'ToolEnd':
    case 'toolEnd':
    case 'tool_end':
    case 'CommandEnd':
    case 'commandEnd':
    case 'command_end':
      return {
        sessionId,
        event: {
          kind: 'toolEnd',
          toolId: stringField(raw, 'tool_id', 'toolId', 'command_id', 'commandId') ?? 'current',
        },
      };

    case 'PermissionRequest':
    case 'permissionRequest':
    case 'permission_request':
      return { sessionId, event: { kind: 'permissionRequest' } };

    case 'Stop':
    case 'TurnEnd':
    case 'turnEnd':
    case 'turn_end':
      return {
        sessionId,
        event: {
          kind: 'turnEnd',
          awaitingInput: raw.awaiting_input === true || raw.awaitingInput === true,
        },
      };

    case 'SubagentStart':
    case 'subagentStart':
    case 'subagent_start':
      return {
        sessionId,
        event: {
          kind: 'subagentStart',
          parentToolId: stringField(raw, 'parent_tool_id', 'parentToolId') ?? 'current',
          toolId: toolIdFor(raw),
          toolName: toolNameFor(raw),
          input: objectField(raw, 'tool_input', 'toolInput', 'input'),
          runInBackground: raw.run_in_background === true || raw.runInBackground === true,
        },
      };

    case 'SubagentEnd':
    case 'subagentEnd':
    case 'subagent_end':
      return {
        sessionId,
        event: {
          kind: 'subagentEnd',
          parentToolId: stringField(raw, 'parent_tool_id', 'parentToolId') ?? 'current',
          toolId: stringField(raw, 'tool_id', 'toolId', 'command_id', 'commandId') ?? 'current',
        },
      };

    case 'SessionEnd':
    case 'sessionEnd':
    case 'session_end':
      return { sessionId, event: { kind: 'sessionEnd', reason: stringField(raw, 'reason') } };

    default:
      return null;
  }
}

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  const lower = toolName.toLowerCase();

  if (lower === 'read') return `Reading ${base(inp.file_path ?? inp.path ?? inp.file)}`;
  if (lower === 'edit' || lower === 'write' || lower === 'apply_patch') {
    return `Editing ${base(inp.file_path ?? inp.path ?? inp.file)}`;
  }
  if (lower === 'rg' || lower === 'grep' || lower === 'search' || lower === 'find') {
    return 'Searching code';
  }
  if (lower === 'bash' || lower === 'shell' || lower === 'command' || lower === 'exec_command') {
    const cmd = String(inp.command ?? inp.cmd ?? '');
    return cmd
      ? `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? `${cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH)}...` : cmd}`
      : 'Running command';
  }
  if (lower === 'task' || lower === 'agent' || lower === 'subagent') {
    const desc = typeof inp.description === 'string' ? inp.description : '';
    return desc
      ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? `${desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH)}...` : desc}`
      : 'Running subtask';
  }

  return `Working on ${toolName}`;
}

async function installHooks(_serverUrl: string, _authToken: string): Promise<void> {
  // Codex Desktop does not expose a durable hook settings file here. External
  // bridges can POST compact lifecycle events to /api/hooks/codex instead.
}

async function uninstallHooks(): Promise<void> {
  // No durable install to remove.
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(false);
}

function consentDisclosure(): { headline: string; disclosure: string } {
  return {
    headline: 'Enable Codex event bridge',
    disclosure:
      'Pixel Agents can receive compact Codex lifecycle events over the local hook endpoint. This provider does not edit Codex settings from here and does not send prompts, responses, diffs, or transcripts by default.',
  };
}

function getAllSessionRoots(): string[] {
  return [path.join(os.homedir(), '.codex')];
}

export const codexProvider: HookProvider = {
  kind: 'hook',
  id: 'codex',
  displayName: 'Codex',
  protocolVersion: 1,

  normalizeHookEvent,
  installHooks,
  uninstallHooks,
  areHooksInstalled,
  consentDisclosure,

  formatToolStatus,
  permissionExemptTools: new Set(['Read', 'Search', 'Find', 'rg', 'grep']),
  subagentToolNames: new Set(['Task', 'Agent', 'Subagent']),
  readingTools: new Set(['Read', 'Search', 'Find', 'rg', 'grep', 'Glob', 'List']),
  terminalNamePrefix: CODEX_TERMINAL_NAME_PREFIX,
  getAllSessionRoots,
};
