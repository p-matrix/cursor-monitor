// =============================================================================
// @pmatrix/cursor-monitor — mcp/tools/halt.ts
// pmatrix_halt MCP tool
//
// Global Kill Switch: immediately blocks all tool execution across all sessions.
//
// Mechanism:
//   1. Create ~/.pmatrix/HALT file (checked by preToolUse / beforeShellExecution hooks)
//   2. Send stability=1.0 critical signal to server (best-effort)
//
// Resume: rm ~/.pmatrix/HALT
//
// ⚠️ This is a GLOBAL halt — affects all Cursor sessions on this machine.
//    Session-selective halt is a v1.x roadmap item.
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../../types';
import { PMatrixHttpClient } from '../../client';
import { activateHalt, isHaltActive, findActiveSession } from '../../state-store';
import { McpToolResult, ok } from '../types';

export async function handleHaltTool(
  args: Record<string, unknown>,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<McpToolResult> {
  const reason =
    typeof args['reason'] === 'string' ? args['reason'] : 'Manual halt via MCP tool';

  // Already halted?
  const alreadyHalted = isHaltActive();

  // Step 1: Create HALT file
  activateHalt(reason);

  // Step 2: Send stability=1.0 signal to server (best-effort, fire-and-forget)
  if (config.agentId && config.apiKey) {
    const session = findActiveSession('cursor');
    const signal: SignalPayload = {
      agent_id: config.agentId,
      // only stability elevated — matches CC monitor halt pattern
      baseline: 0.5,
      norm: 0.5,
      stability: 1.0,
      meta_control: 0.5,
      timestamp: new Date().toISOString(),
      signal_source: 'cursor_hook',
      framework: 'cursor',
      framework_tag: config.frameworkTag ?? 'stable',
      schema_version: '0.3',
      metadata: {
        event_type: 'halt_activated',
        reason,
        session_id: session?.sessionId,
        priority: 'critical',
      },
      state_vector: null,
    };
    client.sendCritical(signal).catch(() => {});
  }

  const lines: string[] = [];

  if (alreadyHalted) {
    lines.push('⛔ HALT already active — all tool calls remain blocked.');
  } else {
    lines.push('⛔ HALT activated — all tool calls are now blocked.');
  }

  if (reason && reason !== 'Manual halt via MCP tool') {
    lines.push(`Reason : ${reason}`);
  }

  lines.push('');
  lines.push('All Cursor sessions on this machine are now blocked.');
  lines.push('Tool calls will receive a deny response until HALT is removed.');
  lines.push('');
  lines.push('To resume:');
  lines.push('  rm ~/.pmatrix/HALT');
  lines.push('');
  lines.push(`Dashboard : https://app.pmatrix.io`);

  return ok(lines.join('\n'));
}

