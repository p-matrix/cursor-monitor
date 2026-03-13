// =============================================================================
// @pmatrix/cursor-monitor — hooks/post-tool-use-failure.ts
// postToolUseFailure handler — STABILITY 관찰 (observation-only, blocking no)
//
// 기반: @pmatrix/claude-code-monitor hooks/post-tool-use-failure.ts
// 변경:
//   - session_id → event.conversation_id
//   - failureCount += 1 추가 (Cursor 전용 카운터)
//   - 메타데이터에 failure_type, is_interrupt 추가
//   - signal_source: 'cursor_hook', framework: 'cursor'
//
// 처리 흐름:
//   ① loadOrCreateState (conversation_id)
//   ② failureCount += 1
//   ③ dangerEvents += 1
//   ④ dataSharing → signal (stability: 0.05, failure_type 포함)
//   ⑤ saveState
//
// Privacy-first: error_message 원문 미포함
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { CursorPostToolUseFailureInput } from '../cursor-types';
import { PMatrixHttpClient } from '../client';
import {
  loadOrCreateState,
  saveState,
  PersistedSessionState,
} from '../state-store';

export async function handlePostToolUseFailure(
  event: CursorPostToolUseFailureInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<void> {
  const sessionId = event.conversation_id;
  const { tool_name, failure_type, is_interrupt, duration } = event;

  const state = loadOrCreateState(sessionId, config.agentId);

  // ② failureCount 증가 (Cursor 전용)
  state.failureCount += 1;

  // ③ dangerEvents 증가
  state.dangerEvents += 1;

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] postToolUseFailure: tool="${tool_name}" type=${failure_type} interrupt=${is_interrupt}\n`
    );
  }

  // ④ 신호 전송 (fire-and-forget)
  if (config.dataSharing) {
    const signal = buildSignal(state, sessionId, tool_name, failure_type, is_interrupt, duration, config.frameworkTag ?? 'stable');
    client.sendCritical(signal).catch(() => {});
  }

  // ⑤ 상태 저장
  saveState(state);
}

// ─── Signal builder ───────────────────────────────────────────────────────────

function buildSignal(
  state: PersistedSessionState,
  sessionId: string,
  toolName: string,
  failureType: string,
  isInterrupt: boolean,
  duration: number,
  frameworkTag: 'beta' | 'stable'
): SignalPayload {
  return {
    agent_id: state.agentId,
    baseline: 0,
    norm: 0,
    stability: 0.05,  // 도구 실패 = 소규모 STABILITY 상승 (claude-code-monitor 동일)
    meta_control: 0,
    timestamp: new Date().toISOString(),
    signal_source: 'cursor_hook',
    framework: 'cursor',
    framework_tag: frameworkTag,
    schema_version: '0.3',
    metadata: {
      event_type: 'tool_failure',
      session_id: sessionId,
      tool_name_length: toolName.length,
      failure_type: failureType,
      is_interrupt: isInterrupt,
      duration,
      priority: 'normal',
      // error_message 원문 미포함 — privacy-first (§5.4)
    },
    state_vector: null,
  };
}
