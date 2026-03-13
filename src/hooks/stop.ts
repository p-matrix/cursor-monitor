// =============================================================================
// @pmatrix/cursor-monitor — hooks/stop.ts
// stop handler — 세션 종료 + Grade 리포트 (non-blocking, followup_message 반환)
//
// 처리 흐름:
//   ① loadOrCreateState (conversation_id)
//   ② state.loopCount = event.loop_count  ← 최종값 덮어쓰기 (누적 아님)
//   ③ sendSessionSummary (fire-and-forget)
//   ④ R(t) 최종 조회 (캐시 만료 여부 무관 — 한 번만 호출, 실패 시 state.currentRt 사용)
//   ⑤ grade = state.grade ?? 'N/A'
//   ⑥ status='completed' 시에만 followup_message 구성
//   ⑦ saveState
//   ⑧ return { followup_message? }
//
// followup_message 형식 (status='completed' 시):
//   📊 P-MATRIX Grade: {grade} | R(t): {rt} | Loop: {loop_count}
//   Safety Gate: {safetyGateBlocks} blocks | Shell cmds: {shellCommandCount}
//   View full report: https://app.pmatrix.io/agents/{agentId}
//
// status='aborted' | 'error': return {} (followup_message 없음)
// sendSessionSummary 실패해도 followup_message는 반환
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { CursorStopInput, CursorStopOutput } from '../cursor-types';
import { PMatrixHttpClient, SessionSummaryInput } from '../client';
import {
  loadOrCreateState,
  saveState,
  buildRtCacheExpiry,
  PersistedSessionState,
} from '../state-store';

export async function handleStop(
  event: CursorStopInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<CursorStopOutput> {
  const sessionId = event.conversation_id;
  const { status, loop_count } = event;

  const state = loadOrCreateState(sessionId, config.agentId);

  // ② loopCount 최종값 덮어쓰기
  state.loopCount = loop_count;

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] stop: status=${status} loop=${loop_count} grade=${state.grade ?? 'N/A'} rt=${state.currentRt.toFixed(3)}\n`
    );
  }

  // ③ sendSessionSummary (fire-and-forget — 실패해도 followup_message 반환)
  if (config.dataSharing) {
    const summaryInput: SessionSummaryInput = {
      sessionId,
      agentId: config.agentId,
      totalTurns: state.promptTurnCount,
      dangerEvents: state.dangerEvents,
      credentialBlocks: state.credentialBlocks,
      safetyGateBlocks: state.safetyGateBlocks,
      endReason: status,
      signal_source: 'cursor_hook',
      framework: 'cursor',
      framework_tag: config.frameworkTag ?? 'stable',
    };
    client.sendSessionSummary(summaryInput).catch(() => {});
  }

  // ④ R(t) 최종 조회 (fail-open — 실패 시 캐시값 사용)
  await fetchRtFinal(state, sessionId, config, client);

  // ⑤ grade
  const grade = state.grade ?? 'N/A';
  const rt = state.currentRt;

  // ⑦ saveState
  saveState(state);

  // ⑥/⑧ status='completed' 시에만 followup_message
  if (status !== 'completed') {
    return {};
  }

  const followup_message =
    `📊 P-MATRIX Grade: ${grade} | R(t): ${rt.toFixed(2)} | Loop: ${loop_count}\n` +
    `Safety Gate: ${state.safetyGateBlocks} blocks | Shell cmds: ${state.shellCommandCount}\n` +
    `View full report: https://app.pmatrix.io/agents/${config.agentId}`;

  return { followup_message };
}

// ─── R(t) final fetch (캐시 만료 여부 무관, 한 번만 시도) ────────────────────

async function fetchRtFinal(
  state: PersistedSessionState,
  sessionId: string,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<void> {
  const signal: SignalPayload = {
    agent_id: state.agentId,
    baseline: 0,
    norm: 0,  // DEV_PLAN §6-1: stop은 4축 영향 없음
    stability: 0,
    meta_control: 0,
    timestamp: new Date().toISOString(),
    signal_source: 'cursor_hook',
    framework: 'cursor',
    framework_tag: config.frameworkTag ?? 'stable',
    schema_version: '0.3',
    metadata: {
      event_type: 'stop',
      session_id: sessionId,
      priority: 'normal',
    },
    state_vector: null,
  };

  try {
    const response = await withTimeout(
      client.sendSignal(signal),
      config.safetyGate.serverTimeoutMs
    );
    const rtData = PMatrixHttpClient.extractRtFromResponse(response);
    if (rtData) {
      state.currentRt = rtData.rt;
      state.currentMode = rtData.mode;
      state.grade = rtData.grade;
      state.rtCacheExpiry = buildRtCacheExpiry();

      if (config.debug) {
        process.stderr.write(
          `[P-MATRIX] stop R(t)=${rtData.rt.toFixed(3)} grade=${rtData.grade}\n`
        );
      }
    }
  } catch {
    // fail-open: 캐시값 그대로 사용
    if (config.debug) {
      process.stderr.write(
        `[P-MATRIX] stop R(t) fetch failed — cached R(t)=${state.currentRt.toFixed(3)}\n`
      );
    }
  }
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout after ${ms}ms`)),
      ms
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}
