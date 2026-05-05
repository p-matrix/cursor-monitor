// =============================================================================
// @pmatrix/cursor-monitor — hooks/subagent.ts
// subagentStart / subagentStop handlers
//
// 기반: @pmatrix/claude-code-monitor hooks/subagent.ts (75% 재사용)
// 변경:
//   - session_id → event.conversation_id
//   - SubagentStartInput → CursorSubagentStartInput (반환값 CursorSubagentStartOutput)
//   - SubagentStopInput  → CursorSubagentStopInput  (반환값 {})
//   - subagentStart: subagent_type, is_parallel_worker, task_length 메타데이터
//   - subagentStop:  status, tool_call_count, modified_files_count 메타데이터
//   - signal_source: 'cursor_hook', framework: 'cursor'
//
// handleSubagentStart: stdout 필수 (blocking 훅) → { permission: 'allow' }
// handleSubagentStop:  stdout 필수 (followup_message 지원) → {} (Sprint 5에서는 빈 객체)
//
// ⚠ subagentStart deny는 broken (preToolUse와 동일 원인) — 항상 allow 반환
// ⚠ task, description, summary, modified_files 원문 절대 미포함 (privacy-first §5.4)
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import {
  CursorSubagentStartInput,
  CursorSubagentStartOutput,
  CursorSubagentStopInput,
} from '../cursor-types';
import { PMatrixHttpClient } from '../client';
import {
  loadOrCreateState,
  saveState,
  PersistedSessionState,
} from '../state-store';
import { getBreachSupport } from '../breach-singleton';

// ─── handleSubagentStart ──────────────────────────────────────────────────────

export async function handleSubagentStart(
  event: CursorSubagentStartInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<CursorSubagentStartOutput> {
  const sessionId = event.conversation_id;
  const { subagent_type, is_parallel_worker, task } = event;

  const state = loadOrCreateState(sessionId, config.agentId);

  // ② subagentSpawnCount 증가
  state.subagentSpawnCount += 1;

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] subagentStart: type=${subagent_type} parallel=${is_parallel_worker} spawn=${state.subagentSpawnCount}\n`
    );
  }

  // Breach Taxonomy: delegated action type inference
  const breach = getBreachSupport(config.agentId);
  const delegatedActionType = breach.inferDelegatedActionType(subagent_type);

  // ③ 신호 전송 (fire-and-forget)
  if (config.dataSharing) {
    const signal = buildSignal(state, sessionId, 0.03, {
      event_type: 'subagent_start',
      event_subtype: 'delegation',
      subagent_type,
      is_parallel_worker,
      task_length: task.length,           // task 원문 미포함 — privacy-first (§5.4)
      subagent_spawn_count: state.subagentSpawnCount,
      delegated_action_type: delegatedActionType,
      priority: 'normal',
    }, config.frameworkTag ?? 'stable');
    client.sendCritical(signal).catch(() => {});
  }

  saveState(state);

  // ⑥ 항상 allow (deny는 broken)
  return { permission: 'allow' };
}

// ─── handleSubagentStop ───────────────────────────────────────────────────────

export async function handleSubagentStop(
  event: CursorSubagentStopInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<Record<string, never>> {
  const sessionId = event.conversation_id;
  const { status, duration_ms, tool_call_count, modified_files } = event;

  const state = loadOrCreateState(sessionId, config.agentId);

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] subagentStop: status=${status} duration=${duration_ms}ms tools=${tool_call_count}\n`
    );
  }

  // ③ 신호 전송 (fire-and-forget)
  if (config.dataSharing) {
    const signal = buildSignal(state, sessionId, 0, {
      event_type: 'subagent_stop',
      event_subtype: 'delegation_complete',
      status,
      duration_ms,
      tool_call_count,
      modified_files_count: modified_files.length,  // 목록 원문 미포함 — privacy-first (§5.4)
      priority: 'normal',
    }, config.frameworkTag ?? 'stable');
    client.sendCritical(signal).catch(() => {});
  }

  saveState(state);

  // ⑤ 빈 객체 반환 (followup_message 없음 — Sprint 5)
  return {};
}

// ─── Signal builder ───────────────────────────────────────────────────────────

function buildSignal(
  state: PersistedSessionState,
  sessionId: string,
  stability: number,
  metadata: Record<string, unknown>,
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
      session_id: sessionId,
      ...metadata,
    },
    state_vector: null,
  };
}
