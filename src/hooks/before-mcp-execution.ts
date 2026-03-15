// =============================================================================
// @pmatrix/cursor-monitor — hooks/before-mcp-execution.ts
// Safety Gate T2: beforeMCPExecution handler
//
// 처리 흐름:
//   ① HALT 파일 → deny (전역 Kill Switch — safetyGate.enabled 체크 전 최우선)
//   ② safetyGate.enabled 체크 → false면 allow
//   ③ mcpCallCount 증가 (항상)
//   ④ pmatrix_ prefix → 즉시 allow (재귀 방지, 신호 전송 생략)
//   ⑤ state.isHalted 체크 → deny
//   ⑥ R(t) 조회 (fail-open — 캐시 우선)
//   ⑦ classifyToolRisk(tool_name) + evaluateSafetyGate → 매트릭스 판정
//   ⑧ stdout: CursorShellHookOutput (continue: true 고정)
//
// ⚠ continue: true 는 deny 시에도 반드시 포함 (Dev Plan §3-2)
// ⚠ tool_input 원문 저장·전송 금지 (privacy-first §5.4)
//    tool_name_length 만 metadata에 포함
//
// ⚠ T2 신뢰도 주의:
//    Cursor beforeMCPExecution deny가 실제로 MCP 실행을 막는지 미검증.
//    현재 스펙 상 T1(beforeShellExecution)만 신뢰 가능.
//    T2는 best-effort 관찰 용도로 운영.
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { CursorBeforeMCPExecutionInput, CursorShellHookOutput } from '../cursor-types';
import { PMatrixHttpClient } from '../client';
import {
  classifyToolRisk,
  evaluateSafetyGate,
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
    totalTurns: state.mcpCallCount,
  });
}

export async function handleBeforeMCPExecution(
  event: CursorBeforeMCPExecutionInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<CursorShellHookOutput> {

  // ① HALT 파일 — 전역 Kill Switch (safetyGate.enabled 체크 전 최우선)
  if (isHaltActive()) {
    return deny('P-MATRIX Kill Switch active. All MCP calls blocked. Remove ~/.pmatrix/HALT to resume.');
  }

  // ② Safety Gate 비활성화 시 — 통과
  if (!config.safetyGate.enabled) {
    return allow();
  }

  const sessionId = event.conversation_id;
  const { tool_name } = event;

  const state = loadOrCreateState(sessionId, config.agentId);

  // ③ mcpCallCount 증가 (항상 — ALLOW/DENY 무관)
  state.mcpCallCount += 1;

  // ④ pmatrix_ prefix → 즉시 allow (재귀 방지)
  if (tool_name.toLowerCase().startsWith('pmatrix_')) {
    saveState(state);
    return allow();
  }

  // ⑤ 세션 수준 Kill Switch
  if (state.isHalted) {
    state.safetyGateBlocks += 1;
    saveState(state);
    return deny(`P-MATRIX Kill Switch active: ${state.haltReason ?? 'R(t) ≥ 0.75'}`);
  }

  if (config.debug) {
    process.stderr.write(`[P-MATRIX] beforeMCPExecution: tool="${tool_name}"\n`);
  }

  // ⑥ R(t) 조회 (fail-open)
  const rt = await fetchRtWithFailOpen(state, sessionId, tool_name, config, client);

  // ⑦ 도구 위험 분류 + 매트릭스 판정
  const toolRisk = classifyToolRisk(tool_name, config.safetyGate.customToolRisk);
  const gateResult = evaluateSafetyGate(rt, toolRisk);

  if (gateResult.action === 'BLOCK') {
    const blockSignal = buildMCPSignal(state, sessionId, tool_name, {
      event_type: 'safety_gate_block',
      priority: 'critical',
    }, config.frameworkTag ?? 'stable', 0.05);
    client.sendCritical(blockSignal).catch(() => {});

    state.safetyGateBlocks += 1;
    state.dangerEvents += 1;

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
  toolName: string,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<number> {
  if (isRtCacheValid(state)) {
    return state.currentRt;
  }

  const signal = buildMCPSignal(state, sessionId, toolName, {
    event_type: 'before_mcp_execution',
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
    // fail-open: 서버 실패/타임아웃 → 캐시값 사용
    if (config.debug) {
      process.stderr.write(
        `[P-MATRIX] Server call failed/timeout — fail-open, cached R(t)=${state.currentRt.toFixed(3)}\n`
      );
    }
  }

  return state.currentRt;
}

// ─── Signal builder ───────────────────────────────────────────────────────────

function buildMCPSignal(
  state: PersistedSessionState,
  sessionId: string,
  toolName: string,
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
      // tool_input 원문 저장 금지 — privacy-first (§5.4)
      // 도구 이름 길이와 위험 분류만 기록
      tool_name_length: toolName.length,
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
