// =============================================================================
// @pmatrix/cursor-monitor — hooks/post-tool-use.ts
// postToolUse handler — NORM 축 관찰 (observation-only, blocking no)
//
// 처리 흐름:
//   ① loadOrCreateState (conversation_id)
//   ② toolCallCount += 1  ← 정상 완료 기준 카운터 (DEV_PLAN §5)
//   ③ dataSharing → signal (event_type: 'post_tool_use', tool_name_length, duration)
//   ④ saveState
//
// Privacy-first:
//   - tool_name, tool_output, tool_input 원문 절대 포함 금지
//   - tool_name_length + duration만 메타데이터에 포함
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { CursorPostToolUseInput } from '../cursor-types';
import { PMatrixHttpClient } from '../client';
import {
  loadOrCreateState,
  saveState,
  PersistedSessionState,
} from '../state-store';

export async function handlePostToolUse(
  event: CursorPostToolUseInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<void> {
  const sessionId = event.conversation_id;
  const { tool_name, duration } = event;

  const state = loadOrCreateState(sessionId, config.agentId);

  // ② toolCallCount 증가 (정상 완료 기준)
  state.toolCallCount += 1;

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] postToolUse: tool="${tool_name}" duration=${duration}ms count=${state.toolCallCount}\n`
    );
  }

  // ③ 신호 전송 (fire-and-forget)
  if (config.dataSharing) {
    const signal = buildSignal(state, sessionId, tool_name, duration, config.frameworkTag ?? 'stable');
    client.sendCritical(signal).catch(() => {});
  }

  // ④ 상태 저장
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
    stability: 0,  // 정상 완료 자체는 불안정 없음
    meta_control: 0,
    timestamp: new Date().toISOString(),
    signal_source: 'cursor_hook',
    framework: 'cursor',
    framework_tag: frameworkTag,
    schema_version: '0.3',
    metadata: {
      event_type: 'post_tool_use',
      session_id: sessionId,
      // tool_name 원문 미포함 — privacy-first (§5.4)
      tool_name_length: toolName.length,
      duration,
      priority: 'normal',
    },
    state_vector: null,
  };
}
