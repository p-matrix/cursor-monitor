// =============================================================================
// @pmatrix/cursor-monitor — hooks/before-read-file.ts
// beforeReadFile handler — 관찰 전용, 항상 allow (blocking no)
//
// 처리 흐름:
//   ① loadOrCreateState (conversation_id)
//   ② debug 로그: file_path.length
//   ③ dataSharing → signal (stability: 0, file_path_length)
//   ④ saveState
//   ⑤ return { continue: true, permission: 'allow' }  ← 항상 allow (deny broken)
//
// stdout 타입: CursorShellHookOutput 재사용
//
// Privacy-first:
//   - file_path 원문 및 content 절대 미포함
//   - file_path_length만 메타데이터에 포함
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { CursorBeforeReadFileInput, CursorShellHookOutput } from '../cursor-types';
import { PMatrixHttpClient } from '../client';
import {
  loadOrCreateState,
  saveState,
  PersistedSessionState,
} from '../state-store';

export async function handleBeforeReadFile(
  event: CursorBeforeReadFileInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<CursorShellHookOutput> {
  const sessionId = event.conversation_id;
  const { file_path } = event;

  const state = loadOrCreateState(sessionId, config.agentId);

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] beforeReadFile: path_len=${file_path.length}\n`
    );
  }

  // ③ 신호 전송 (fire-and-forget)
  if (config.dataSharing) {
    const signal = buildSignal(state, sessionId, file_path.length, config.frameworkTag ?? 'stable');
    client.sendCritical(signal).catch(() => {});
  }

  // ④ 상태 저장
  saveState(state);

  // ⑤ 항상 allow (deny는 broken)
  return { continue: true, permission: 'allow' };
}

// ─── Signal builder ───────────────────────────────────────────────────────────

function buildSignal(
  state: PersistedSessionState,
  sessionId: string,
  filePathLength: number,
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
      event_type: 'before_read_file',
      session_id: sessionId,
      // file_path 원문 및 content 절대 미포함 — privacy-first (§5.4)
      file_path_length: filePathLength,
      priority: 'normal',
    },
    state_vector: null,
  };
}
