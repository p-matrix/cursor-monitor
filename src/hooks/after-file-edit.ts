// =============================================================================
// @pmatrix/cursor-monitor — hooks/after-file-edit.ts
// afterFileEdit handler — STABILITY 관찰 (observation-only, blocking no)
//
// 처리 흐름:
//   ① loadOrCreateState (conversation_id)
//   ② fileEditCount += 1
//   ③ edits.length 기반 stability 계산:
//        edits.length <= 3  → stability: 0.02
//        edits.length > 3   → stability: 0.05
//   ④ dataSharing → signal (event_type: 'file_edit', edit_count)
//   ⑤ saveState
//
// Privacy-first:
//   - file_path, old_string, new_string 절대 미포함
//   - edit_count(개수)만 메타데이터에 포함
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { CursorAfterFileEditInput } from '../cursor-types';
import { PMatrixHttpClient } from '../client';
import {
  loadOrCreateState,
  saveState,
  PersistedSessionState,
} from '../state-store';

export async function handleAfterFileEdit(
  event: CursorAfterFileEditInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<void> {
  const sessionId = event.conversation_id;
  const editCount = event.edits.length;

  const state = loadOrCreateState(sessionId, config.agentId);

  // ② fileEditCount 증가
  state.fileEditCount += 1;

  // ③ edit 규모 비례 stability
  const stability = editCount <= 3 ? 0.02 : 0.05;

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] afterFileEdit: edits=${editCount} stability=${stability} count=${state.fileEditCount}\n`
    );
  }

  // ④ 신호 전송 (fire-and-forget)
  if (config.dataSharing) {
    const signal = buildSignal(state, sessionId, editCount, stability, config.frameworkTag ?? 'stable');
    client.sendCritical(signal).catch(() => {});
  }

  // ⑤ 상태 저장
  saveState(state);
}

// ─── Signal builder ───────────────────────────────────────────────────────────

function buildSignal(
  state: PersistedSessionState,
  sessionId: string,
  editCount: number,
  stability: number,
  frameworkTag: 'beta' | 'stable'
): SignalPayload {
  return {
    agent_id: state.agentId,
    baseline: 0,
    norm: 0,
    stability,
    meta_control: 0,
    timestamp: new Date().toISOString(),
    signal_source: 'cursor_hook',
    framework: 'cursor',
    framework_tag: frameworkTag,
    schema_version: '0.3',
    metadata: {
      event_type: 'file_edit',
      session_id: sessionId,
      // file_path, old_string, new_string 절대 미포함 — privacy-first (§5.4)
      edit_count: editCount,
      priority: 'normal',
    },
    state_vector: null,
  };
}
