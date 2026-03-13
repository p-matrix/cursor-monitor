// =============================================================================
// @pmatrix/cursor-monitor — cli/setup.ts
// Setup command: writes P-MATRIX hooks to ~/.cursor/hooks.json
//                and MCP server to ~/.cursor/mcp.json
//
// Usage:
//   pmatrix-cursor setup
//   pmatrix-cursor setup --agent-id <id> --api-key <key>
//
// What it does:
//   1. Resolves the path to the pmatrix-cursor binary
//   2. Reads/creates ~/.cursor/hooks.json
//   3. Merges in the P-MATRIX hook configuration (16 hooks, camelCase keys)
//   4. Reads/creates ~/.cursor/mcp.json
//   5. Merges in the pmatrix MCP server entry
//   6. Saves both files
//   7. Prints confirmation with next steps
//
// Hook events configured (16, camelCase):
//   sessionStart / sessionEnd / beforeSubmitPrompt / preToolUse /
//   beforeShellExecution / beforeMCPExecution / postToolUse /
//   postToolUseFailure / afterFileEdit / afterShellExecution /
//   afterMCPExecution / preCompact / subagentStart / subagentStop /
//   beforeReadFile / stop
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Cursor hooks.json shape ──────────────────────────────────────────────────

interface CursorHookEntry {
  command: string;
  timeout?: number;
}

interface CursorHooksJson {
  version: 1;
  hooks: Record<string, CursorHookEntry[]>;
  [key: string]: unknown;
}

// ─── Cursor mcp.json shape ────────────────────────────────────────────────────

interface CursorMcpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface CursorMcpJson {
  mcpServers?: Record<string, CursorMcpServerEntry>;
  [key: string]: unknown;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runSetup(): Promise<void> {
  // Resolve binary path
  const binaryPath = resolveBinaryPath();

  // Parse CLI flags (--agent-id, --api-key)
  const args = process.argv.slice(3);
  const agentId = getFlag(args, '--agent-id');
  const apiKey = getFlag(args, '--api-key');

  // Update ~/.pmatrix/config.json if flags provided
  if (agentId || apiKey) {
    updatePMatrixConfig({ agentId, apiKey });
  }

  // ── hooks.json ────────────────────────────────────────────────────────────

  const hooksPath = path.join(os.homedir(), '.cursor', 'hooks.json');
  const hooksJson = readJsonOrEmpty<CursorHooksJson>(hooksPath);

  // Ensure structure
  if (!hooksJson.version) hooksJson.version = 1;
  if (!hooksJson.hooks) hooksJson.hooks = {};

  // Build & merge hook config
  const hookConfig = buildHookConfig(binaryPath);
  hooksJson.hooks = mergeHooks(hooksJson.hooks, hookConfig);

  const cursorDir = path.join(os.homedir(), '.cursor');
  fs.mkdirSync(cursorDir, { recursive: true });
  fs.writeFileSync(hooksPath, JSON.stringify(hooksJson, null, 2) + '\n', 'utf-8');

  // ── mcp.json ─────────────────────────────────────────────────────────────

  const mcpPath = path.join(cursorDir, 'mcp.json');
  const mcpJson = readJsonOrEmpty<CursorMcpJson>(mcpPath);
  if (!mcpJson.mcpServers) mcpJson.mcpServers = {};
  mcpJson.mcpServers = mergeMcpServers(mcpJson.mcpServers);
  fs.writeFileSync(mcpPath, JSON.stringify(mcpJson, null, 2) + '\n', 'utf-8');

  // ── Print confirmation ────────────────────────────────────────────────────

  console.log('');
  console.log('✓ P-MATRIX Cursor Monitor hooks registered');
  console.log(`  Hooks config : ${hooksPath}`);
  console.log(`  MCP config   : ${mcpPath}`);
  console.log(`  Binary       : ${binaryPath}`);
  console.log('');
  console.log('Hooks registered (16):');
  console.log('  • sessionStart / sessionEnd     → Session lifecycle');
  console.log('  • beforeShellExecution          → Safety Gate T1 (shell-level analysis)');
  console.log('  • beforeMCPExecution            → Safety Gate T2 (MCP gate)');
  console.log('  • preToolUse                    → Safety Gate T3 (broken — awaiting fix)');
  console.log('  • beforeSubmitPrompt            → Credential scan');
  console.log('  • postToolUse                   → Tool completion observation');
  console.log('  • postToolUseFailure            → STABILITY signal');
  console.log('  • afterFileEdit                 → File change pattern');
  console.log('  • afterShellExecution           → Shell result observation');
  console.log('  • afterMCPExecution             → MCP result observation');
  console.log('  • preCompact                    → Context compression frequency');
  console.log('  • subagentStart / subagentStop  → Subagent tree observation');
  console.log('  • beforeReadFile                → Read observation (deny broken)');
  console.log('  • stop                          → Grade report followup_message');
  console.log('');
  console.log('MCP server registered:');
  console.log('  pmatrix → pmatrix-cursor mcp  (pmatrix_status / pmatrix_grade / pmatrix_halt)');
  console.log('');

  if (!agentId) {
    console.log('Next step: set your Agent ID');
    console.log('  pmatrix-cursor setup --agent-id <YOUR_AGENT_ID>');
    console.log('  or: PMATRIX_AGENT_ID=<id> in your shell');
    console.log('');
  }

  if (!apiKey) {
    console.log('Next step: set your API key');
    console.log('  pmatrix-cursor setup --api-key <YOUR_API_KEY>');
    console.log('  or: export PMATRIX_API_KEY=<key> in your shell');
    console.log('');
  }

  console.log('Restart Cursor to activate monitoring.');
  console.log('Dashboard: https://app.pmatrix.io');
  console.log('');
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function buildHookConfig(binaryPath: string): Record<string, CursorHookEntry[]> {
  return {
    // Sprint 1 — session lifecycle
    sessionStart: [
      { command: `${binaryPath} session-start` },
    ],
    sessionEnd: [
      { command: `${binaryPath} session-end` },
    ],

    // Sprint 3 — blocking hooks
    beforeSubmitPrompt: [
      { command: `${binaryPath} before-submit-prompt`, timeout: 5 },
    ],
    preToolUse: [
      { command: `${binaryPath} pre-tool-use`, timeout: 5 },
    ],

    // Sprint 2 — Safety Gate T1/T2
    beforeShellExecution: [
      { command: `${binaryPath} before-shell-execution`, timeout: 10 },
    ],
    beforeMCPExecution: [
      { command: `${binaryPath} before-mcp-execution`, timeout: 5 },
    ],

    // Sprint 4 — observation-only
    postToolUse: [
      { command: `${binaryPath} post-tool-use` },
    ],
    postToolUseFailure: [
      { command: `${binaryPath} post-tool-use-failure` },
    ],
    afterFileEdit: [
      { command: `${binaryPath} after-file-edit` },
    ],
    afterShellExecution: [
      { command: `${binaryPath} after-shell-execution` },
    ],
    afterMCPExecution: [
      { command: `${binaryPath} after-mcp-execution` },
    ],
    preCompact: [
      { command: `${binaryPath} pre-compact` },
    ],

    // Sprint 5 — META_CONTROL + stop
    subagentStart: [
      { command: `${binaryPath} subagent-start`, timeout: 5 },
    ],
    subagentStop: [
      { command: `${binaryPath} subagent-stop` },
    ],
    beforeReadFile: [
      { command: `${binaryPath} before-read-file`, timeout: 5 },
    ],
    stop: [
      { command: `${binaryPath} stop` },
    ],
  };
}

function mergeHooks(
  existing: Record<string, CursorHookEntry[]>,
  newHooks: Record<string, CursorHookEntry[]>
): Record<string, CursorHookEntry[]> {
  const result = { ...existing };

  for (const [event, entries] of Object.entries(newHooks)) {
    if (!result[event]) {
      result[event] = entries;
      continue;
    }

    // Check if pmatrix-cursor hook already present (idempotent)
    const existingList = result[event]!;
    const alreadyInstalled = existingList.some((h) =>
      /pmatrix-cursor\s/.test(h.command)
    );

    if (!alreadyInstalled) {
      result[event] = [...existingList, ...entries];
    }
  }

  return result;
}

function mergeMcpServers(
  existing: Record<string, CursorMcpServerEntry>
): Record<string, CursorMcpServerEntry> {
  // Idempotent: only add if not already present
  if (existing['pmatrix']) return existing;

  return {
    ...existing,
    pmatrix: {
      command: 'pmatrix-cursor',
      args: ['mcp'],
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveBinaryPath(): string {
  const scriptPath = process.argv[1];

  if (scriptPath) {
    const binName = path.basename(scriptPath);
    if (binName === 'pmatrix-cursor') {
      return 'pmatrix-cursor';  // rely on PATH
    }

    // npx / direct node invocation
    const distDir = path.dirname(scriptPath);
    const candidate = path.join(path.dirname(distDir), 'node_modules', '.bin', 'pmatrix-cursor');
    if (fs.existsSync(candidate)) return candidate;
  }

  return 'pmatrix-cursor';
}

function readJsonOrEmpty<T>(filePath: string): T {
  try {
    if (!fs.existsSync(filePath)) return {} as T;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

function updatePMatrixConfig(updates: { agentId?: string; apiKey?: string }): void {
  const configPath = path.join(os.homedir(), '.pmatrix', 'config.json');
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonOrEmpty<Record<string, unknown>>(configPath);

  if (updates.agentId) existing['agentId'] = updates.agentId;
  if (updates.apiKey)  existing['apiKey']  = updates.apiKey;

  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  console.log(`  Saved config: ${configPath}`);
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}
