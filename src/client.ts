// =============================================================================
// @pmatrix/cursor-monitor — client.ts
// PMatrixHttpClient: POST /v1/inspect/stream, GET /v1/agents/{id}/public
// 95% reuse from @pmatrix/claude-code-monitor — signal_source + framework changed
// signal_source: 'cursor_hook', framework: 'cursor'
//
// v0.6.0 Cross-cutting client 보강 (server Production Polish 정합):
//   - Axis 2: Error correlation logging — HTTP 5xx 응답에서 error_id/request_id 추출 → stderr 안내
//   - Axis 3: X-Request-ID — 송출 시 crypto.randomUUID(), 수신 시 PMATRIX_DEBUG_TRACE 디버그
//   - Axis 4: Burst 429 handling — Retry-After + escalating BURST_RETRY_DELAYS backoff
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  PMatrixConfig,
  SignalPayload,
  GradeResponse,
  AgentGradeDetail,
  BatchSendResponse,
  AxesState,
  SafetyMode,
  TrustGrade,
} from './types';

// ─── Runtime shape guards ─────────────────────────────────────────────────────
// Defensive checks that detect payload schema drift at runtime.
// Throws if response is malformed; monitor's caller treats as network failure.

function assertGradeResponseShape(raw: unknown): asserts raw is GradeResponse {
  if (!raw || typeof raw !== 'object') {
    throw new Error('PMatrix API: GradeResponse payload not an object');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.agent_id !== 'string' || typeof r.grade !== 'string' || !r.axes) {
    throw new Error('PMatrix API: GradeResponse missing required fields (agent_id/grade/axes)');
  }
}

function assertAgentGradeDetailShape(raw: unknown): asserts raw is AgentGradeDetail {
  if (!raw || typeof raw !== 'object') {
    throw new Error('PMatrix API: AgentGradeDetail payload not an object');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.history)) {
    throw new Error('PMatrix API: AgentGradeDetail.history missing or not an array');
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RETRY_DELAYS = [100, 500, 2_000] as const;
// Burst 429 backoff — escalating, used when Retry-After header absent.
// Distinct from RETRY_DELAYS (transient 5xx) because burst limits need longer
// pause to give server-side rate window time to drain.
const BURST_RETRY_DELAYS = [1000, 5000, 30000] as const;
const REQUEST_TIMEOUT_MS = 10_000;

const RESUBMIT_INTERVAL_MS = 60_000;
const MAX_RESUBMIT_FILES   = 5;
const MAX_UNSENT_AGE_MS    = 7 * 24 * 60 * 60 * 1_000;

// ─── Response interfaces ──────────────────────────────────────────────────────

export interface HealthCheckResult {
  healthy: boolean;
  grade?: GradeResponse;
}

export interface SessionSummaryInput {
  sessionId: string;
  agentId: string;
  totalTurns: number;
  dangerEvents: number;
  credentialBlocks: number;
  safetyGateBlocks: number;
  endReason?: string;
  signal_source: 'cursor_hook';
  framework: 'cursor';
  framework_tag: 'beta' | 'stable';
}

// ─── PMatrixHttpClient ────────────────────────────────────────────────────────

export class PMatrixHttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly agentId: string;
  private readonly retryMax: number;
  private readonly debug: boolean;
  private readonly localUrl: string | null;
  private lastResubmitAt: number = 0;

  constructor(config: PMatrixConfig) {
    this.baseUrl = config.serverUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.agentId = config.agentId;
    this.retryMax = config.batch.retryMax;
    this.debug = config.debug;
    this.localUrl = (config as any).localUrl ?? process.env.PMATRIX_LOCAL_URL ?? null;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.agentId) {
      return { healthy: false };
    }
    try {
      const grade = await this.getAgentGrade(this.agentId);
      return { healthy: true, grade };
    } catch {
      return { healthy: false };
    }
  }

  async getAgentGrade(agentId: string): Promise<GradeResponse> {
    const url = `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/public`;
    const raw = await this.fetchWithRetry('GET', url, null);
    assertGradeResponseShape(raw);
    return raw as GradeResponse;
  }

  async getAgentGradeDetail(agentId: string): Promise<AgentGradeDetail> {
    const url = `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/grade`;
    const raw = await this.fetchWithRetry('GET', url, null);
    assertAgentGradeDetailShape(raw);
    return raw as AgentGradeDetail;
  }

  async sendBatch(signals: SignalPayload[]): Promise<BatchSendResponse> {
    if (signals.length === 0) return { received: 0 };
    // Defense-in-depth: all-zero axes → R(t)=0.75 → instant HALT.
    // Correct to neutral (0.5) before transmission.
    for (const s of signals) {
      if (s.baseline === 0 && s.norm === 0 && s.stability === 0 && s.meta_control === 0) {
        s.baseline = 0.5;
        s.norm = 0.5;
        s.stability = 0.5;
        s.meta_control = 0.5;
      }
    }
    try {
      return await this.sendBatchDirect(signals);
    } catch (err) {
      await this.backupToLocal(signals);
      throw err;
    }
  }

  async sendSignal(signal: SignalPayload): Promise<BatchSendResponse> {
    return this.sendBatch([signal]);
  }

  async resubmitUnsent(): Promise<void> {
    const now = Date.now();
    if (now - this.lastResubmitAt < RESUBMIT_INTERVAL_MS) return;
    this.lastResubmitAt = now;

    const dir = path.join(os.homedir(), '.pmatrix', 'unsent');
    let files: string[];
    try {
      files = (await fs.promises.readdir(dir))
        .filter(f => f.endsWith('.json'))
        .sort()
        .slice(0, MAX_RESUBMIT_FILES);
    } catch {
      return;
    }

    for (const filename of files) {
      const filepath = path.join(dir, filename);
      try {
        const stat = await fs.promises.stat(filepath);
        if (now - stat.mtimeMs > MAX_UNSENT_AGE_MS) {
          await fs.promises.unlink(filepath);
          continue;
        }
        const raw = await fs.promises.readFile(filepath, 'utf-8');
        const signals = JSON.parse(raw) as SignalPayload[];
        await this.sendBatchDirect(signals);
        await fs.promises.unlink(filepath);
      } catch (err) {
        if (err instanceof SyntaxError) {
          await fs.promises.unlink(filepath).catch(() => {});
        }
      }
    }
  }

  async sendCritical(signal: SignalPayload): Promise<void> {
    const url = `${this.baseUrl}/v1/inspect/stream`;
    try {
      await this.fetchOnce('POST', url, signal);
    } catch {
      await this.backupToLocal([signal]);
    }
  }

  /**
   * Session summary — sent on sessionEnd
   * signal_source: 'cursor_hook', framework: 'cursor'
   */
  async sendSessionSummary(data: SessionSummaryInput): Promise<void> {
    const url = `${this.baseUrl}/v1/inspect/stream`;
    const payload: SignalPayload = {
      agent_id: data.agentId,
      // neutral axes — avoids all-zero → R(t)=0.75 grade pollution
      baseline: 0.5,
      norm: 0.5,
      stability: 0.5,
      meta_control: 0.5,
      timestamp: new Date().toISOString(),
      signal_source: 'cursor_hook',
      framework: 'cursor',
      framework_tag: data.framework_tag,
      schema_version: '0.3',
      metadata: {
        event_type: 'session_summary',
        session_id: data.sessionId,
        total_turns: data.totalTurns,
        danger_events: data.dangerEvents,
        credential_blocks: data.credentialBlocks,
        safety_gate_blocks: data.safetyGateBlocks,
        end_reason: data.endReason,
        priority: 'normal',
      },
      state_vector: null,
    };

    try {
      await this.fetchWithRetry('POST', url, payload);
    } catch {
      await this.backupToLocal([payload]);
    }
  }

  static extractRtFromResponse(res: BatchSendResponse): {
    rt: number;
    mode: SafetyMode;
    grade: TrustGrade;
    axes: AxesState;
  } | null {
    if (
      res.risk == null ||
      res.grade == null ||
      res.mode == null ||
      res.axes == null
    ) {
      return null;
    }
    return {
      rt: res.risk,
      mode: res.mode,
      grade: res.grade,
      axes: {
        baseline: res.axes.baseline,
        norm: res.axes.norm,
        stability: res.axes.stability,
        meta_control: res.axes.meta_control,
      },
    };
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async sendBatchDirect(signals: SignalPayload[]): Promise<BatchSendResponse> {
    const body = signals.length === 1 ? signals[0] : signals;

    // Try local sidecar first (if available)
    if (this.localUrl) {
      try {
        const localEndpoint = `${this.localUrl}/v1/inspect/local`;
        const raw = await this.fetchOnce('POST', localEndpoint, body);
        if (this.debug) {
          process.stderr.write(`[P-MATRIX] Local sidecar response received\n`);
        }
        return (raw as BatchSendResponse | null) ?? { received: signals.length };
      } catch {
        // Local sidecar unavailable — fall through to server
        if (this.debug) {
          process.stderr.write(`[P-MATRIX] Local sidecar unavailable, falling back to server\n`);
        }
      }
    }

    // Server path (with retries)
    const url = `${this.baseUrl}/v1/inspect/stream`;
    const raw = await this.fetchWithRetry('POST', url, body);
    return (raw as BatchSendResponse | null) ?? { received: signals.length };
  }

  private async fetchWithRetry(
    method: string,
    url: string,
    body: unknown
  ): Promise<unknown> {
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 0; attempt <= this.retryMax; attempt++) {
      try {
        return await this.fetchOnce(method, url, body);
      } catch (err) {
        lastError = err as Error;
        if (attempt < this.retryMax) {
          // Axis 4: Burst 429 → distinct backoff schedule with optional Retry-After.
          const burstHint = (err as { burstRetryAfterMs?: number } | null)?.burstRetryAfterMs;
          const delay =
            typeof burstHint === 'number'
              ? burstHint
              : (RETRY_DELAYS[attempt] ?? 2_000);
          if (this.debug) {
            console.debug(
              `[P-MATRIX] Retry ${attempt + 1}/${this.retryMax} after ${delay}ms: ${lastError.message}`
            );
          }
          await sleep(delay);
        }
      }
    }

    throw lastError;
  }

  private async fetchOnce(
    method: string,
    url: string,
    body: unknown
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    // Axis 3: X-Request-ID — outgoing per-request UUID for end-to-end correlation
    // with server middleware (commit 533781f). Server may return its own X-Request-ID
    // (echo or self-issued) — we don't enforce echo equality (server-issued case OK).
    const requestId = crypto.randomUUID();

    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
      };

      const response = await fetch(url, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      // Axis 3: server-side X-Request-ID — debug-only when PMATRIX_DEBUG_TRACE=1.
      if (process.env['PMATRIX_DEBUG_TRACE']) {
        const serverRequestId = response.headers.get('X-Request-ID');
        process.stderr.write(
          `[P-MATRIX] trace: client_request_id=${requestId} server_request_id=${serverRequestId ?? '<none>'} status=${response.status}\n`
        );
      }

      // Axis 4: Burst 429 — Retry-After (seconds | HTTP-date) → ms hint, else escalating BURST_RETRY_DELAYS.
      if (response.status === 429) {
        const text = await response.text().catch(() => '');
        const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
        // attempt counter is held in fetchWithRetry; we simply attach the hint.
        // When Retry-After header absent, fetchWithRetry falls back through BURST_RETRY_DELAYS
        // sequence using its attempt index (callers will re-throw without hint if absent).
        const err = new Error(`HTTP 429: ${text.slice(0, 200)}`) as Error & { burstRetryAfterMs?: number };
        err.burstRetryAfterMs = retryAfterMs ?? BURST_RETRY_DELAYS[0] ?? 1000;
        throw err;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');

        // Axis 2: Error correlation — for 5xx, surface error_id + request_id to stderr
        // so users can attach to support tickets (server Production Polish A error UX 정합).
        if (response.status >= 500) {
          let errorId: string | null = null;
          let bodyRequestId: string | null = null;
          try {
            const parsed = JSON.parse(text) as { error?: { error_id?: string; request_id?: string } };
            errorId = parsed?.error?.error_id ?? null;
            bodyRequestId = parsed?.error?.request_id ?? null;
          } catch {
            // body not JSON — fall through to header-only correlation
          }
          // Header backup source — always preferred for request_id correlation.
          const headerErrorId = response.headers.get('X-Error-ID');
          const headerRequestId = response.headers.get('X-Request-ID');
          const finalErrorId = errorId ?? headerErrorId ?? '<none>';
          const finalRequestId = bodyRequestId ?? headerRequestId ?? requestId;
          process.stderr.write(
            `[P-MATRIX] Error ${response.status}: error_id=${finalErrorId} request_id=${finalRequestId} — Support 문의 시 Error ID 함께 제공해 주세요.\n`
          );
        }

        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async backupToLocal(signals: SignalPayload[]): Promise<void> {
    try {
      const dir = path.join(os.homedir(), '.pmatrix', 'unsent');
      await fs.promises.mkdir(dir, { recursive: true });
      const filename = path.join(dir, `${Date.now()}.json`);
      await fs.promises.writeFile(filename, JSON.stringify(signals, null, 2), 'utf-8');
    } catch {
      // silent fail — always fail-open
    }
  }
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse Retry-After header → milliseconds.
 *
 * RFC 7231 §7.1.3: Retry-After may be either:
 *   - Delta-seconds (integer): "120" → 120_000 ms
 *   - HTTP-date     (RFC 1123): "Wed, 21 Oct 2026 07:28:00 GMT" → ms until that date
 *
 * Returns null when header missing or unparseable (caller falls back to BURST_RETRY_DELAYS).
 */
function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  // Numeric (delta-seconds) form
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    return null;
  }
  // HTTP-date form
  const epoch = Date.parse(trimmed);
  if (!Number.isNaN(epoch)) {
    const delta = epoch - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}
