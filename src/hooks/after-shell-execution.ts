// =============================================================================
// @pmatrix/cursor-monitor — hooks/after-shell-execution.ts
// afterShellExecution handler — 관찰 전용 (observation-only, blocking no)
//
// 처리 흐름:
//   ① loadOrCreateState (conversation_id)
//   ② dataSharing → signal (event_type: 'after_shell_execution', command_length, duration, sandbox)
//   ③ saveState (카운터 변경 없음 — shellCommandCount는 before에서 이미 증가)
//
// Privacy-first:
//   - command, output 원문 절대 포함 금지
//   - command_length + duration + sandbox만 메타데이터에 포함
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { CursorAfterShellExecutionInput } from '../cursor-types';
import { PMatrixHttpClient } from '../client';
import {
  loadOrCreateState,
  saveState,
  PersistedSessionState,
} from '../state-store';

export async function handleAfterShellExecution(
  event: CursorAfterShellExecutionInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<void> {
  const sessionId = event.conversation_id;
  const { command, duration, sandbox } = event;

  const state = loadOrCreateState(sessionId, config.agentId);

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] afterShellExecution: cmd_len=${command.length} duration=${duration}ms sandbox=${sandbox}\n`
    );
  }

  // ② 신호 전송 (fire-and-forget)
  if (config.dataSharing) {
    const signal = buildSignal(state, sessionId, command.length, duration, sandbox, config.frameworkTag ?? 'stable');
    client.sendCritical(signal).catch(() => {});
  }

  // ③ 상태 저장 (카운터 변경 없음)
  saveState(state);
}

// ─── Signal builder ───────────────────────────────────────────────────────────

function buildSignal(
  state: PersistedSessionState,
  sessionId: string,
  commandLength: number,
  duration: number,
  sandbox: boolean,
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
      event_type: 'after_shell_execution',
      session_id: sessionId,
      // command, output 원문 절대 미포함 — privacy-first (§5.4)
      command_length: commandLength,
      duration,
      sandbox,
      priority: 'normal',
    },
    state_vector: null,
  };
}
