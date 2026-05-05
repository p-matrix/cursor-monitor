// =============================================================================
// @pmatrix/cursor-monitor — mcp/tools/status.ts
// pmatrix_status MCP tool
//
// Shows current P-MATRIX safety status for the active session:
//   Grade / R(t) / Mode / 4-axis values / session counters
//
// Data sources:
//   1. Local state file (~/.pmatrix/sessions/{session_id}.json)  — counters
//   2. Server GET /v1/agents/{id}/public                          — live grade
//   3. ~/.pmatrix/HALT file                                       — halt status
// =============================================================================

import { PMatrixConfig } from '../../types';
import { PMatrixHttpClient } from '../../client';
import {
  findActiveSession,
  loadState,
  isHaltActive,
  PersistedSessionState,
} from '../../state-store';
import { rtToMode } from '../../safety-gate';
import { McpToolResult, ok, err } from '../types';

export async function handleStatusTool(
  args: Record<string, unknown>,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<McpToolResult> {
  // Validate prerequisites
  if (!config.agentId) {
    return err('P-MATRIX not configured. Run: pmatrix-cursor setup --agent-id <id> --api-key <key>');
  }

  // Resolve session: use provided session_id or find most recent active session
  const sessionId =
    typeof args['session_id'] === 'string' ? args['session_id'] : null;

  const state: PersistedSessionState | null = sessionId
    ? loadState(sessionId)
    : findActiveSession('cursor');

  // HALT file check
  const haltActive = isHaltActive();

  // Fetch live grade from server (best-effort — fail gracefully)
  let serverGrade: string | null = null;
  let serverRt: number | null = null;
  let serverMode: string | null = null;
  let serverAxes: { baseline: number; norm: number; stability: number; meta_control: number } | null = null;

  try {
    const gradeRes = await client.getAgentGrade(config.agentId);
    serverGrade = gradeRes.grade;
    serverRt = gradeRes.risk;
    serverMode = gradeRes.mode;
    serverAxes = gradeRes.axes;
  } catch {
    // server unavailable — use local state values
  }

  // Build output
  const lines: string[] = [];

  lines.push('─── P-MATRIX Status ──────────────────────');

  if (haltActive) {
    lines.push('⛔ HALT ACTIVE — all tool calls blocked');
    lines.push('   Resume: rm ~/.pmatrix/HALT');
    lines.push('');
  }

  // Grade / R(t) / Mode (server takes precedence over local cache)
  const displayGrade = serverGrade ?? state?.grade ?? '?';
  const displayRt = serverRt ?? state?.currentRt ?? 0;
  const displayMode = serverMode ?? state?.currentMode ?? rtToMode(displayRt);
  const modeLabel = modeDescription(displayMode);

  lines.push(`Grade  : ${displayGrade}`);
  lines.push(`R(t)   : ${displayRt.toFixed(3)}`);
  lines.push(`Mode   : ${displayMode}  ${modeLabel}`);

  if (serverAxes) {
    lines.push('');
    lines.push('4-Axis :');
    lines.push(`  BASELINE     ${serverAxes.baseline.toFixed(3)}`);
    lines.push(`  NORM         ${serverAxes.norm.toFixed(3)}`);
    lines.push(`  STABILITY    ${serverAxes.stability.toFixed(3)}`);
    lines.push(`  META_CONTROL ${serverAxes.meta_control.toFixed(3)}`);
  }

  if (state) {
    lines.push('');
    lines.push('Session :');
    lines.push(`  Prompt turns      ${state.promptTurnCount}`);
    lines.push(`  Tool calls        ${state.toolCallCount}`);
    lines.push(`  Shell cmds        ${state.shellCommandCount}`);
    lines.push(`  Safety gate blks  ${state.safetyGateBlocks}`);
    lines.push(`  Credential blks   ${state.credentialBlocks}`);
    lines.push(`  Danger events     ${state.dangerEvents}`);
    lines.push(`  Subagent spawns   ${state.subagentSpawnCount}`);
    lines.push(`  Compact count     ${state.compactCount}`);
    lines.push(`  Session ID        ${state.sessionId}`);
    lines.push(`  Started           ${state.startedAt}`);
  } else {
    lines.push('');
    lines.push('No active session found.');
    lines.push('Run Cursor with pmatrix-cursor hooks installed to start monitoring.');
  }

  lines.push('');
  lines.push(`Dashboard : https://app.pmatrix.io`);
  if (config.agentId) {
    lines.push(`Agent     : ${config.agentId}`);
  }
  lines.push('─────────────────────────────────────────');

  return ok(lines.join('\n'));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function modeDescription(mode: string): string {
  const map: Record<string, string> = {
    'normal': '(Normal)',
    'caution': '(Caution)',
    'alert': '(Alert)',
    'critical': '(Critical)',
    'halt': '(Halt)',
  };
  return map[mode] ?? '';
}

