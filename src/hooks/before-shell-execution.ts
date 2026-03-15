// =============================================================================
// @pmatrix/cursor-monitor — hooks/before-shell-execution.ts
// Safety Gate T1: beforeShellExecution handler
//
// Cursor 핵심 우위: command 원문 직접 분석 (claude-code-monitor는 tool_name만 가능)
//
// 처리 흐름:
//   ① HALT 파일 → deny (전역 Kill Switch)
//   ② safetyGate.enabled 체크 → false면 allow
//   ③ state.isHalted 체크 → deny
//   ④ shellCommandCount 증가 (관찰, ALLOW/DENY 무관)
//   ⑤ meta_control 규칙 → command 원문 직접 분석
//   ⑥ R(t) 조회 (fail-open — 서버 실패 시 캐시값 사용)
//   ⑦ classifyShellCommandRisk + evaluateSafetyGate → 매트릭스 판정
//   ⑧ stdout: Cursor 공식 JSON 포맷
//
// stdout 포맷 (Cursor 공식):
//   { "continue": true, "permission": "allow"|"deny", "userMessage"?: "..." }
//   ⚠ continue: true 는 deny 시에도 반드시 포함 (Dev Plan §3-2)
//   ⚠ continue: false 는 beforeSubmitPrompt에서만 사용
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { CursorBeforeShellExecutionInput, CursorShellHookOutput } from '../cursor-types';
import { PMatrixHttpClient } from '../client';
import {
  classifyShellCommandRisk,
  evaluateSafetyGate,
  checkMetaControlRules,
} from '../safety-gate';
import {
  loadOrCreateState,
  saveState,
  buildRtCacheExpiry,
  isRtCacheValid,
  isHaltActive,
  PersistedSessionState,
} from '../state-store';
import { isField4Enabled, writeFieldState } from '@pmatrix/field-node-runtime';

/** Write field state partial for MCP IPC poller (fail-open, no-op if 4.0 not enabled) */
function syncFieldState(sessionId: string, state: PersistedSessionState): void {
  if (!isField4Enabled()) return;
  writeFieldState(sessionId, {
    currentRt: state.currentRt,
    currentMode: state.currentMode,
    totalTurns: state.shellCommandCount,
  });
}

export async function handleBeforeShellExecution(
  event: CursorBeforeShellExecutionInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<CursorShellHookOutput> {

  // ① HALT 파일 — 전역 Kill Switch (상태 로드 전 체크)
  if (isHaltActive()) {
    return deny('P-MATRIX Kill Switch active. All commands blocked. Remove ~/.pmatrix/HALT to resume.');
  }

  // ② Safety Gate 비활성화 시 — 관찰 없이 통과
  if (!config.safetyGate.enabled) {
    return allow();
  }

  // conversation_id를 통일 키로 사용 (session.ts와 동일)
  const sessionId = event.conversation_id;
  const { command } = event;
  const agentId = config.agentId;

  const state = loadOrCreateState(sessionId, agentId);

  // ③ 세션 수준 Kill Switch
  if (state.isHalted) {
    state.safetyGateBlocks += 1;
    saveState(state);
    return deny(`P-MATRIX Kill Switch active: ${state.haltReason ?? 'R(t) ≥ 0.75'}`);
  }

  // ④ shellCommandCount 증가 (ALLOW/DENY 무관)
  state.shellCommandCount += 1;

  if (config.debug) {
    process.stderr.write(`[P-MATRIX] beforeShellExecution: cmd="${command.slice(0, 80)}"\n`);
  }

  // ⑤ meta_control 규칙 — command 원문 직접 분석
  const mcBlock = checkMetaControlRules(command, null);
  if (mcBlock !== null) {
    const signal = buildShellSignal(state, sessionId, command, {
      event_type: 'meta_control_block',
      priority: 'critical',
      meta_control_delta: mcBlock.metaControlDelta,
    }, config.frameworkTag ?? 'stable', 0.05);
    client.sendCritical(signal).catch(() => {});

    state.shellDenyCount += 1;
    state.safetyGateBlocks += 1;
    state.dangerEvents += 1;
    saveState(state);

    if (config.debug) {
      process.stderr.write(`[P-MATRIX] Shell meta_control block: ${mcBlock.reason}\n`);
    }
    return deny(`P-MATRIX Safety Gate: ${mcBlock.reason}`);
  }

  // ⑥ R(t) 조회 (fail-open)
  const rt = await fetchRtWithFailOpen(state, sessionId, command, config, client);

  // ⑦ Shell 명령 위험 분류 + 매트릭스 판정
  const shellRisk = classifyShellCommandRisk(command, config.safetyGate.customToolRisk);
  const gateResult = evaluateSafetyGate(rt, shellRisk);

  if (gateResult.action === 'BLOCK') {
    const blockSignal = buildShellSignal(state, sessionId, command, {
      event_type: 'safety_gate_block',
      priority: 'critical',
    }, config.frameworkTag ?? 'stable', 0.05);
    client.sendCritical(blockSignal).catch(() => {});

    state.shellDenyCount += 1;
    state.safetyGateBlocks += 1;
    state.dangerEvents += 1;

    // auto-HALT: R(t) ≥ 0.75
    if (rt >= config.killSwitch.autoHaltOnRt) {
      state.isHalted = true;
      state.haltReason = `R(t) ${rt.toFixed(2)} ≥ ${config.killSwitch.autoHaltOnRt}`;
    }
    saveState(state);

    return deny(`P-MATRIX Safety Gate: ${gateResult.reason}`);
  }

  // ⑧ ALLOW
  saveState(state);
  syncFieldState(sessionId, state);
  return allow();
}

// ─── stdout builders ──────────────────────────────────────────────────────────

function allow(): CursorShellHookOutput {
  return { continue: true, permission: 'allow' };
}

function deny(userMessage: string): CursorShellHookOutput {
  return { continue: true, permission: 'deny', userMessage };
}

// ─── R(t) fetch with fail-open ────────────────────────────────────────────────

async function fetchRtWithFailOpen(
  state: PersistedSessionState,
  sessionId: string,
  command: string,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<number> {
  // 캐시 유효 시 서버 호출 스킵
  if (isRtCacheValid(state)) {
    return state.currentRt;
  }

  const signal = buildShellSignal(state, sessionId, command, {
    event_type: 'before_shell_execution',
    priority: 'normal',
  }, config.frameworkTag ?? 'stable');

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
          `[P-MATRIX] R(t)=${rtData.rt.toFixed(3)} mode=${rtData.mode} grade=${rtData.grade}\n`
        );
      }
    }
  } catch {
    // fail-open: 서버 실패/타임아웃 → 캐시값 사용, 절대 block 안 함
    if (config.debug) {
      process.stderr.write(
        `[P-MATRIX] Server call failed/timeout — fail-open, cached R(t)=${state.currentRt.toFixed(3)}\n`
      );
    }
  }

  return state.currentRt;
}

// ─── Signal builder ───────────────────────────────────────────────────────────

function buildShellSignal(
  state: PersistedSessionState,
  sessionId: string,
  command: string,
  metadata: Record<string, unknown>,
  frameworkTag: 'beta' | 'stable',
  normDelta: number = 0.0,
): SignalPayload {
  return {
    agent_id: state.agentId,
    baseline: 0,
    // event-based fixed delta — deny=0.05, allow/observe=0.0
    norm: normDelta,
    stability: 0,
    meta_control: 0,
    timestamp: new Date().toISOString(),
    signal_source: 'cursor_hook',
    framework: 'cursor',
    framework_tag: frameworkTag,
    schema_version: '0.3',
    metadata: {
      session_id: sessionId,
      // command 원문은 저장하지 않음 — privacy-first (§5.4)
      // 명령 길이와 위험 분류만 기록
      command_length: command.length,
      ...metadata,
    },
    state_vector: null,
  };
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
