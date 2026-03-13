// =============================================================================
// @pmatrix/cursor-monitor — hooks/pre-compact.ts
// preCompact handler — 세션 복잡도 관찰 (observation-only, blocking no)
//
// 처리 흐름:
//   ① loadOrCreateState (conversation_id)
//   ② compactCount += 1
//   ③ dataSharing → signal (event_type: 'pre_compact', context_usage_percent, message_count)
//   ④ saveState
//
// context_usage_percent, message_count는 민감정보 아님 — 포함 허용
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { CursorPreCompactInput } from '../cursor-types';
import { PMatrixHttpClient } from '../client';
import {
  loadOrCreateState,
  saveState,
  PersistedSessionState,
} from '../state-store';

export async function handlePreCompact(
  event: CursorPreCompactInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<void> {
  const sessionId = event.conversation_id;
  const { trigger, context_usage_percent, message_count } = event;

  const state = loadOrCreateState(sessionId, config.agentId);

  // ② compactCount 증가
  state.compactCount += 1;

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] preCompact: trigger=${trigger} usage=${context_usage_percent}% messages=${message_count} count=${state.compactCount}\n`
    );
  }

  // ③ 신호 전송 (fire-and-forget)
  if (config.dataSharing) {
    const signal = buildSignal(state, sessionId, trigger, context_usage_percent, message_count, config.frameworkTag ?? 'stable');
    client.sendCritical(signal).catch(() => {});
  }

  // ④ 상태 저장
  saveState(state);
}

// ─── Signal builder ───────────────────────────────────────────────────────────

function buildSignal(
  state: PersistedSessionState,
  sessionId: string,
  trigger: string,
  contextUsagePercent: number,
  messageCount: number,
  frameworkTag: 'beta' | 'stable'
): SignalPayload {
  return {
    agent_id: state.agentId,
    baseline: 0,
    norm: 0,
    stability: 0.03,  // DEV_PLAN §6
    meta_control: 0,
    timestamp: new Date().toISOString(),
    signal_source: 'cursor_hook',
    framework: 'cursor',
    framework_tag: frameworkTag,
    schema_version: '0.3',
    metadata: {
      event_type: 'pre_compact',
      session_id: sessionId,
      trigger,
      context_usage_percent: contextUsagePercent,
      message_count: messageCount,
      priority: 'normal',
    },
    state_vector: null,
  };
}
