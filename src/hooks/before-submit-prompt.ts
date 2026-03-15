// =============================================================================
// @pmatrix/cursor-monitor — hooks/before-submit-prompt.ts
// beforeSubmitPrompt handler — Credential Scanner (Safety Gate Credential)
//
// 처리 흐름:
//   ① promptTurnCount 증가 (항상)
//   ② credentialProtection.enabled 체크 → false면 allow
//   ③ scanCredentials(user_message) → hits
//   ④ hits 있으면:
//      - credentialBlocks (API payload) + credentialBlockCount (Cursor stat) 동시 증가
//      - dangerEvents 증가
//      - sendCritical (credential_detected 신호)
//      - return { continue: false, user_message: ... }
//   ⑤ hits 없으면:
//      - return { continue: true }
//
// stdout 포맷 (Cursor 공식):
//   { "continue": false, "user_message": "..." }  ← 차단 시
//   { "continue": true }                           ← 통과 시
//
// ⚠ continue: false 는 beforeSubmitPrompt에서만 허용 (Dev Plan §3-2)
// ⚠ user_message: snake_case (Cursor 공식 필드명)
// ⚠ 프롬프트 원문은 저장·전송하지 않음 (privacy-first §5.4)
//    credential_count / credential_types 만 신호에 포함
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { CursorBeforeSubmitPromptInput, CursorBeforeSubmitPromptOutput } from '../cursor-types';
import { PMatrixHttpClient } from '../client';
import {
  loadOrCreateState,
  saveState,
  PersistedSessionState,
} from '../state-store';
import { scanCredentials } from '../credential-scanner';
import { isField4Enabled, writeFieldState } from '@pmatrix/field-node-runtime';

/** Write field state partial for MCP IPC poller (fail-open, no-op if 4.0 not enabled) */
function syncFieldState(sessionId: string, state: PersistedSessionState): void {
  if (!isField4Enabled()) return;
  writeFieldState(sessionId, {
    currentRt: state.currentRt,
    currentMode: state.currentMode,
    totalTurns: state.promptTurnCount,
  });
}

export async function handleBeforeSubmitPrompt(
  event: CursorBeforeSubmitPromptInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<CursorBeforeSubmitPromptOutput> {
  const sessionId = event.conversation_id;
  const { prompt } = event;

  const state = loadOrCreateState(sessionId, config.agentId);

  // ① promptTurnCount 증가 (항상 — 차단 여부 무관)
  state.promptTurnCount += 1;

  // ② credentialProtection 비활성화 시 — 통과
  if (!config.credentialProtection.enabled) {
    saveState(state);
    return { continue: true };
  }

  // ③ Credential 스캔
  const hits = prompt ? scanCredentials(prompt, config.credentialProtection.customPatterns) : [];

  if (hits.length > 0) {
    // ④ 카운터 증가 (두 곳 동시 — PM 확정 설계)
    state.credentialBlocks += 1;        // API payload 필드
    state.credentialBlockCount += 1;    // Cursor stat 필드
    state.dangerEvents += 1;

    const credentialTypes = hits.map(h => h.name).join(', ');
    const totalCount = hits.reduce((sum, h) => sum + h.count, 0);

    if (config.debug) {
      process.stderr.write(
        `[P-MATRIX] beforeSubmitPrompt: credential detected — ${credentialTypes} (count=${totalCount})\n`
      );
    }

    // 신호 전송 (type/count만 — 프롬프트 원문 미포함 §5.4)
    if (config.dataSharing) {
      const signal = buildCredentialSignal(state, sessionId, totalCount, credentialTypes, config.frameworkTag ?? 'stable');
      client.sendCritical(signal).catch(() => {});
    }

    saveState(state);

    return {
      continue: false,
      user_message: `[P-MATRIX] Credential detected in prompt (${credentialTypes}).\nPlease remove sensitive data before submitting.\n`,
    };
  }

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] beforeSubmitPrompt: turn=${state.promptTurnCount} session=${sessionId}\n`
    );
  }

  saveState(state);
  syncFieldState(sessionId, state);
  return { continue: true };
}

// ─── Signal builder ───────────────────────────────────────────────────────────

function buildCredentialSignal(
  state: PersistedSessionState,
  sessionId: string,
  credentialCount: number,
  credentialTypes: string,
  frameworkTag: 'beta' | 'stable'
): SignalPayload {
  return {
    agent_id: state.agentId,
    baseline: 0,
    norm: 0,
    stability: 0.10,
    meta_control: 0,
    timestamp: new Date().toISOString(),
    signal_source: 'cursor_hook',
    framework: 'cursor',
    framework_tag: frameworkTag,
    schema_version: '0.3',
    metadata: {
      event_type: 'credential_detected',
      session_id: sessionId,
      credential_count: credentialCount,
      // credential_types = pattern names only — never matched values (§5.4)
      credential_types: credentialTypes,
      priority: 'critical',
    },
    state_vector: null,
  };
}
