// =============================================================================
// @pmatrix/cursor-monitor — hooks/session.ts
// sessionStart / sessionEnd lifecycle handlers
//
// 기반: @pmatrix/claude-code-monitor hooks/session.ts
// 변경:
//   - SessionStartInput → CursorSessionStartInput (cursor-types.ts)
//   - SessionEndInput   → CursorSessionEndInput   (cursor-types.ts)
//   - end_reason → reason (Cursor 필드명)
//   - Cursor 전용 메타데이터 state 저장 (conversationId, cursorVersion, etc.)
//   - signal_source: 'cursor_hook', framework: 'cursor'
//
// [Sprint 2 bugfix] 상태 파일 키 통일:
//   - sessionStart.session_id → conversation_id (CursorHookBase 공통 필드)
//   - 이유: beforeShellExecution 등 나머지 훅 base에는 session_id 없음,
//     conversation_id만 존재. 키 불일치 시 상태 파일 미탐색 발생.
//   - 이후 모든 훅에서 conversation_id를 상태 파일 키로 통일.
//
// sessionStart:
//   - Create/restore session state
//   - Cursor 메타데이터 저장
//   - Send session_start signal (fire-and-forget)
//   - Cleanup stale session files
//   - No stdout output required (command hook, no gate decision)
//
// sessionEnd:
//   - Send session_summary signal
//   - Delete session state file
// =============================================================================

import {
  PMatrixConfig,
  SignalPayload,
} from '../types';
import {
  CursorSessionStartInput,
  CursorSessionEndInput,
} from '../cursor-types';
import { PMatrixHttpClient, SessionSummaryInput } from '../client';
import {
  loadOrCreateState,
  saveState,
  deleteState,
  cleanupStaleStates,
  PersistedSessionState,
} from '../state-store';
import { deleteFieldState } from '@pmatrix/field-node-runtime';
import { BreachSupport } from '../breach-support';
import { getBreachSupport } from '../breach-singleton';

// ─── sessionStart ─────────────────────────────────────────────────────────────

export async function handleSessionStart(
  event: CursorSessionStartInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<void> {
  // conversation_id를 기본 키로 사용 — CursorHookBase 공통 필드
  // (session_id는 sessionStart 전용이므로 나머지 훅과 키가 불일치함)
  const sessionId = event.conversation_id;
  const agentId = config.agentId;

  // Cleanup stale sessions opportunistically (non-blocking)
  cleanupStaleStates();

  // Load or create session state
  const state = loadOrCreateState(sessionId, agentId);

  // Cursor 전용 메타데이터 저장
  state.conversationId = event.conversation_id;
  state.cursorVersion = event.cursor_version;
  state.workspaceRoot = event.workspace_roots[0] ?? '';
  state.composerMode = event.composer_mode ?? 'agent';
  state.isBackgroundAgent = event.is_background_agent;
  state.model = event.model;

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] sessionStart: key=${sessionId} agent=${agentId} ` +
      `cursor=${event.cursor_version} model=${event.model}\n`
    );
  }

  // Send session_start signal (fire-and-forget)
  if (config.dataSharing) {
    const signal = buildSessionSignal(state, sessionId, {
      event_type: 'session_start',
      priority: 'normal',
    }, config.frameworkTag ?? 'stable');
    client.sendCritical(signal).catch(() => {});
  }

  // Retry unsent backlog from previous sessions (60s throttle, fail-open)
  client.resubmitUnsent().catch(() => {});

  saveState(state);
}

// ─── sessionEnd ───────────────────────────────────────────────────────────────

export async function handleSessionEnd(
  event: CursorSessionEndInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<void> {
  // conversation_id 통일 키 사용
  const sessionId = event.conversation_id;
  const { reason } = event;
  const agentId = config.agentId;

  const state = loadOrCreateState(sessionId, agentId);

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] sessionEnd: key=${sessionId} turns=${state.promptTurnCount} ` +
      `grade=${state.grade ?? 'N/A'} halted=${state.isHalted} reason=${reason}\n`
    );
  }

  // Breach Taxonomy: emit session_report observation
  const breach = getBreachSupport(agentId);
  if (config.dataSharing) {
    const reportSignal = buildSessionSignal(state, sessionId, {
      event_type: 'session_report',
      priority: 'normal',
      ...breach.getSessionReport(),
    }, config.frameworkTag ?? 'stable');
    client.sendCritical(reportSignal).catch(() => {});
  }

  // Send session summary (dataSharing required — §11)
  if (config.dataSharing) {
    const summaryInput: SessionSummaryInput = {
      sessionId,
      agentId,
      totalTurns: state.promptTurnCount,
      dangerEvents: state.dangerEvents,
      credentialBlocks: state.credentialBlocks,
      safetyGateBlocks: state.safetyGateBlocks,
      endReason: reason,
      signal_source: 'cursor_hook',
      framework: 'cursor',
      framework_tag: config.frameworkTag ?? 'stable',
    };
    await client.sendSessionSummary(summaryInput).catch(() => {});
  }

  // Clean up session state
  deleteState(sessionId);
  deleteFieldState(sessionId);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSessionSignal(
  state: PersistedSessionState,
  sessionId: string,
  metadata: Record<string, unknown>,
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
      session_id: sessionId,
      ...metadata,
    },
    state_vector: null,
  };
}
