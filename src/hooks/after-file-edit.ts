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
import { BreachSupport } from '../breach-support';
import { getBreachSupport } from '../breach-singleton';

export async function handleAfterFileEdit(
  event: CursorAfterFileEditInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<void> {
  const sessionId = event.conversation_id;
  const filePath = event.file_path;
  const editCount = event.edits.length;

  const state = loadOrCreateState(sessionId, config.agentId);

  // Breach Taxonomy: file modification tracking
  const breach = getBreachSupport(config.agentId);
  breach.incrementFileModifications();

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
    const signal = buildSignal(state, sessionId, filePath, editCount, stability, breach, config.frameworkTag ?? 'stable');
    client.sendCritical(signal).catch(() => {});
  }

  // ⑤ 상태 저장
  saveState(state);
}

// ─── Signal builder ───────────────────────────────────────────────────────────

function buildSignal(
  state: PersistedSessionState,
  sessionId: string,
  filePath: string,
  editCount: number,
  stability: number,
  breach: BreachSupport,
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
      event_type: 'file_write',
      session_id: sessionId,
      // file_path 상대 경로 — Breach Taxonomy AP-2 file_write 식별 목적
      file_path: filePath,
      edit_count: editCount,
      in_scope: breach.isInScope('AP-2', filePath),
      priority: 'normal',
    },
    state_vector: null,
  };
}
