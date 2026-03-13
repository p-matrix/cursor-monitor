// =============================================================================
// @pmatrix/cursor-monitor — hooks/after-mcp-execution.ts
// afterMCPExecution handler — 관찰 전용 (observation-only, blocking no)
//
// 처리 흐름:
//   ① loadOrCreateState (conversation_id)
//   ② dataSharing → signal (event_type: 'after_mcp_execution', tool_name_length, duration)
//   ③ saveState (카운터 변경 없음)
//
// Privacy-first:
//   - result_json 절대 포함 금지
//   - tool_name_length + duration만 메타데이터에 포함
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { CursorAfterMCPExecutionInput } from '../cursor-types';
import { PMatrixHttpClient } from '../client';
import {
  loadOrCreateState,
  saveState,
  PersistedSessionState,
} from '../state-store';

export async function handleAfterMCPExecution(
  event: CursorAfterMCPExecutionInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<void> {
  const sessionId = event.conversation_id;
  const { tool_name, duration } = event;

  const state = loadOrCreateState(sessionId, config.agentId);

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] afterMCPExecution: tool="${tool_name}" duration=${duration}ms\n`
    );
  }

  // ② 신호 전송 (fire-and-forget)
  if (config.dataSharing) {
    const signal = buildSignal(state, sessionId, tool_name, duration, config.frameworkTag ?? 'stable');
    client.sendCritical(signal).catch(() => {});
  }

  // ③ 상태 저장 (카운터 변경 없음)
  saveState(state);
}

// ─── Signal builder ───────────────────────────────────────────────────────────

function buildSignal(
  state: PersistedSessionState,
  sessionId: string,
  toolName: string,
  duration: number,
  frameworkTag: 'beta' | 'stable'
): SignalPayload {
  return {
    agent_id: state.agentId,
    baseline: 0,
    norm: 0,
    stability: 0,
    meta_control: 0,
    timestamp: new Date().toISOString(),
    signal_source: 'cursor_hook',
    framework: 'cursor',
    framework_tag: frameworkTag,
    schema_version: '0.3',
    metadata: {
      event_type: 'after_mcp_execution',
      session_id: sessionId,
      // result_json 절대 미포함 — privacy-first (§5.4)
      tool_name_length: toolName.length,
      duration,
      priority: 'normal',
    },
    state_vector: null,
  };
}
