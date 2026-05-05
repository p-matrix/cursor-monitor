// =============================================================================
// client.test.ts — PMatrixHttpClient 자가 검증 (v0.6.0 cross-cutting 포함)
// =============================================================================
//
// 검증 범위:
//   1. extractRtFromResponse — 정적 메서드: 완전/부분 응답 처리
//   2. healthCheck — fail-open: 성공/실패/네트워크 에러/agentId 없음
//   3. sendBatch — 빈 배열 즉시 반환, 전송 성공, 전송 실패 → backupToLocal
//   4. all-zero axes 방어 (R(t)=0.75 instant HALT 방지)
//   5. v0.6.0 Axis 2 — 5xx error_id 추출 → stderr 안내
//   6. v0.6.0 Axis 3 — X-Request-ID 송출 + 수신
//   7. v0.6.0 Axis 4 — 429 Retry-After + BURST_RETRY_DELAYS
// =============================================================================

import * as fs from 'fs';
import { PMatrixHttpClient } from '../client';
import type { PMatrixConfig, BatchSendResponse, SignalPayload } from '../types';

// fs 모킹 — backupToLocal 검증
jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  promises: {
    readdir: jest.fn().mockRejectedValue({ code: 'ENOENT' }),
    stat: jest.fn(),
    readFile: jest.fn(),
    unlink: jest.fn(),
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
  },
}));

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'test-agent',
    apiKey: 'test-key',
    safetyGate: { enabled: true, serverTimeoutMs: 2_500 },
    credentialProtection: { enabled: true, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75 },
    dataSharing: true,
    batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 0 },
    debug: false,
    ...overrides,
  };
}

function makeSignal(): SignalPayload {
  return {
    agent_id: 'test-agent',
    baseline: 1.0,
    norm: 1.0,
    stability: 0.0,
    meta_control: 1.0,
    timestamp: new Date().toISOString(),
    signal_source: 'cursor_hook',
    framework: 'cursor',
    framework_tag: 'beta',
    schema_version: '0.3',
    metadata: { event_type: 'unit_test' },
    state_vector: null,
  };
}

interface MockResponseInit {
  ok?: boolean;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function mockResponse(init: MockResponseInit = {}): Response {
  const headers = new Map(Object.entries(init.headers ?? {}));
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: jest.fn().mockResolvedValue(
      typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? null)
    ),
    headers: {
      get: (key: string) => headers.get(key) ?? null,
    },
  } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env['PMATRIX_DEBUG_TRACE'];
});

// =============================================================================
// 1. extractRtFromResponse
// =============================================================================

describe('extractRtFromResponse', () => {
  test('완전 응답 → rt/grade/mode/axes 반환', () => {
    const res: BatchSendResponse = {
      received: 1,
      risk: 0.25,
      grade: 'B',
      mode: 'caution',
      axes: { baseline: 0.9, norm: 0.8, stability: 0.1, meta_control: 0.95 },
    };
    const r = PMatrixHttpClient.extractRtFromResponse(res);
    expect(r).not.toBeNull();
    expect(r!.rt).toBe(0.25);
    expect(r!.grade).toBe('B');
    expect(r!.mode).toBe('caution');
  });

  test('risk 없음 → null', () => {
    expect(PMatrixHttpClient.extractRtFromResponse({ received: 1 })).toBeNull();
  });

  test('grade 없음 → null', () => {
    const r: BatchSendResponse = {
      received: 1, risk: 0.2, mode: 'caution',
      axes: { baseline: 0, norm: 0, stability: 0, meta_control: 0 },
    };
    expect(PMatrixHttpClient.extractRtFromResponse(r)).toBeNull();
  });

  test('mode 없음 → null', () => {
    const r: BatchSendResponse = {
      received: 1, risk: 0.2, grade: 'A',
      axes: { baseline: 0, norm: 0, stability: 0, meta_control: 0 },
    };
    expect(PMatrixHttpClient.extractRtFromResponse(r)).toBeNull();
  });

  test('axes 없음 → null', () => {
    const r: BatchSendResponse = { received: 1, risk: 0.2, grade: 'A', mode: 'caution' };
    expect(PMatrixHttpClient.extractRtFromResponse(r)).toBeNull();
  });
});

// =============================================================================
// 2. healthCheck — fail-open
// =============================================================================

describe('healthCheck — fail-open', () => {
  const gradeData = {
    agent_id: 'test-agent',
    grade: 'B',
    p_score: 80,
    risk: 0.20,
    mode: 'caution',
    axes: { baseline: 0.9, norm: 0.8, stability: 0.1, meta_control: 0.95 },
    last_updated: new Date().toISOString(),
  };

  test('성공 → healthy: true', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse({ body: gradeData }));
    const c = new PMatrixHttpClient(makeConfig());
    const r = await c.healthCheck();
    expect(r.healthy).toBe(true);
    expect(r.grade!.grade).toBe('B');
  });

  test('503 → healthy: false', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      mockResponse({ ok: false, status: 503, body: 'unavail' })
    );
    const c = new PMatrixHttpClient(makeConfig());
    const r = await c.healthCheck();
    expect(r.healthy).toBe(false);
  });

  test('네트워크 에러 → healthy: false', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const c = new PMatrixHttpClient(makeConfig());
    const r = await c.healthCheck();
    expect(r.healthy).toBe(false);
  });

  test('agentId 빈 문자열 → 즉시 false, fetch 미호출', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const c = new PMatrixHttpClient(makeConfig({ agentId: '' }));
    const r = await c.healthCheck();
    expect(r.healthy).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 3. sendBatch
// =============================================================================

describe('sendBatch', () => {
  test('빈 배열 → received: 0, fetch 미호출', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const c = new PMatrixHttpClient(makeConfig());
    const r = await c.sendBatch([]);
    expect(r).toEqual({ received: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('1개 신호 → 정상 전송', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse({ body: { received: 1 } }));
    const c = new PMatrixHttpClient(makeConfig());
    const r = await c.sendBatch([makeSignal()]);
    expect(r.received).toBe(1);
  });

  test('500 → backupToLocal + 에러 재throw', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      mockResponse({ ok: false, status: 500, body: 'oops' })
    );
    const c = new PMatrixHttpClient(makeConfig());
    await expect(c.sendBatch([makeSignal()])).rejects.toThrow('HTTP 500');

    expect((fs.promises as jest.Mocked<typeof fs.promises>).mkdir).toHaveBeenCalledWith(
      expect.stringContaining('.pmatrix'),
      expect.objectContaining({ recursive: true })
    );
    expect((fs.promises as jest.Mocked<typeof fs.promises>).writeFile).toHaveBeenCalled();
  });

  test('retryMax=0 → 1회 시도 후 throw', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      mockResponse({ ok: false, status: 503 })
    );
    const c = new PMatrixHttpClient(makeConfig());
    await expect(c.sendBatch([makeSignal()])).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 4. all-zero axes 방어
// =============================================================================

describe('all-zero axes 방어', () => {
  test('all-zero → 0.5 자동 보정', async () => {
    let capturedBody: string | undefined;
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = init?.body as string;
      return mockResponse({ body: { received: 1 } });
    });

    const c = new PMatrixHttpClient(makeConfig());
    const sig = makeSignal();
    sig.baseline = 0; sig.norm = 0; sig.stability = 0; sig.meta_control = 0;
    await c.sendBatch([sig]);

    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.baseline).toBe(0.5);
    expect(parsed.norm).toBe(0.5);
    expect(parsed.stability).toBe(0.5);
    expect(parsed.meta_control).toBe(0.5);
  });
});

// =============================================================================
// 5. v0.6.0 Axis 2 — 5xx error_id correlation
// =============================================================================

describe('v0.6.0 Axis 2 — Error correlation logging', () => {
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  test('5xx + JSON body의 error.error_id → stderr 출력', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse({
      ok: false, status: 500,
      body: { error: { error_id: 'err_abc123', request_id: 'req_xyz789' } },
    }));
    const c = new PMatrixHttpClient(makeConfig());
    await expect(c.sendBatch([makeSignal()])).rejects.toThrow();

    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    const errorLog = calls.find(s => s.includes('Error 500'));
    expect(errorLog).toBeDefined();
    expect(errorLog).toContain('error_id=err_abc123');
    expect(errorLog).toContain('request_id=req_xyz789');
    expect(errorLog).toContain('Support 문의');
  });

  test('5xx + header backup (X-Error-ID, X-Request-ID)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse({
      ok: false, status: 503,
      body: 'plain text body',  // not JSON
      headers: { 'X-Error-ID': 'err_header_xyz', 'X-Request-ID': 'req_header_abc' },
    }));
    const c = new PMatrixHttpClient(makeConfig());
    await expect(c.sendBatch([makeSignal()])).rejects.toThrow();

    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    const errorLog = calls.find(s => s.includes('Error 503'));
    expect(errorLog).toBeDefined();
    expect(errorLog).toContain('err_header_xyz');
    expect(errorLog).toContain('req_header_abc');
  });

  test('5xx + body/header 모두 없음 → <none> 표시', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse({
      ok: false, status: 502, body: '',
    }));
    const c = new PMatrixHttpClient(makeConfig());
    await expect(c.sendBatch([makeSignal()])).rejects.toThrow();

    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    const errorLog = calls.find(s => s.includes('Error 502'));
    expect(errorLog).toBeDefined();
    expect(errorLog).toContain('error_id=<none>');
  });

  test('4xx (non-429) → error correlation log 없음', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse({
      ok: false, status: 400, body: 'bad request',
    }));
    const c = new PMatrixHttpClient(makeConfig());
    await expect(c.sendBatch([makeSignal()])).rejects.toThrow();

    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    const errorLog = calls.find(s => s.includes('Error 400'));
    // 4xx 는 5xx 기준 없으므로 'Error N' stderr 없음
    expect(errorLog).toBeUndefined();
  });
});

// =============================================================================
// 6. v0.6.0 Axis 3 — X-Request-ID 송출 + 수신
// =============================================================================

describe('v0.6.0 Axis 3 — X-Request-ID', () => {
  test('outgoing 헤더에 X-Request-ID 포함 (UUID v4)', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return mockResponse({ body: { received: 1 } });
    });

    const c = new PMatrixHttpClient(makeConfig());
    await c.sendBatch([makeSignal()]);

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!['X-Request-ID']).toBeDefined();
    // UUID v4 형식: 8-4-4-4-12 hex
    expect(capturedHeaders!['X-Request-ID']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  test('각 fetch 호출마다 새 UUID', async () => {
    const seen: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const h = init?.headers as Record<string, string>;
      seen.push(h['X-Request-ID']!);
      return mockResponse({ body: { received: 1 } });
    });

    const c = new PMatrixHttpClient(makeConfig());
    await c.sendBatch([makeSignal()]);
    await c.sendBatch([makeSignal()]);

    expect(seen.length).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);  // 매번 새 UUID
  });

  test('PMATRIX_DEBUG_TRACE=1 → server X-Request-ID stderr trace', async () => {
    process.env['PMATRIX_DEBUG_TRACE'] = '1';
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse({
      body: { received: 1 },
      headers: { 'X-Request-ID': 'server-issued-req-id' },
    }));
    const c = new PMatrixHttpClient(makeConfig());
    await c.sendBatch([makeSignal()]);

    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    const traceLog = calls.find(s => s.includes('trace:'));
    expect(traceLog).toBeDefined();
    expect(traceLog).toContain('server_request_id=server-issued-req-id');
    expect(traceLog).toContain('client_request_id=');

    stderrSpy.mockRestore();
  });

  test('PMATRIX_DEBUG_TRACE 미설정 → trace stderr 없음', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse({
      body: { received: 1 },
    }));
    const c = new PMatrixHttpClient(makeConfig());
    await c.sendBatch([makeSignal()]);

    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    const traceLog = calls.find(s => s.includes('trace:'));
    expect(traceLog).toBeUndefined();

    stderrSpy.mockRestore();
  });

  test('echo 검증 안 함 — server-issued request_id OK', async () => {
    // 서버가 자체 발급한 X-Request-ID 를 보낼 때 client 가 throw 하면 안 됨
    jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse({
      body: { received: 1 },
      headers: { 'X-Request-ID': 'completely-different-from-client' },
    }));
    const c = new PMatrixHttpClient(makeConfig());
    await expect(c.sendBatch([makeSignal()])).resolves.toEqual({ received: 1 });
  });
});

// =============================================================================
// 7. v0.6.0 Axis 4 — Burst 429
// =============================================================================

describe('v0.6.0 Axis 4 — Burst 429 handling', () => {
  test('429 → retry budget 안에서 재시도 후 결국 fail', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      mockResponse({ ok: false, status: 429, body: 'Too Many Requests' })
    );
    // retryMax=1 → 총 2회 시도
    const c = new PMatrixHttpClient(makeConfig({
      batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 1 },
    }));

    await expect(c.sendBatch([makeSignal()])).rejects.toThrow('HTTP 429');
    expect(fetchSpy).toHaveBeenCalledTimes(2);  // 1 initial + 1 retry
  }, 35_000);

  test('Retry-After: 초 형태 파싱 후 재시도', async () => {
    let attempt = 0;
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        return mockResponse({
          ok: false, status: 429, body: 'rate limit',
          headers: { 'Retry-After': '0' },  // 0 second → 즉시 재시도
        });
      }
      return mockResponse({ body: { received: 1 } });
    });

    const c = new PMatrixHttpClient(makeConfig({
      batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 1 },
    }));

    const r = await c.sendBatch([makeSignal()]);
    expect(r.received).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test('Retry-After: HTTP-date 파싱 (과거 → 0ms)', async () => {
    let attempt = 0;
    const past = new Date(Date.now() - 60_000).toUTCString();
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        return mockResponse({
          ok: false, status: 429,
          headers: { 'Retry-After': past },
        });
      }
      return mockResponse({ body: { received: 1 } });
    });

    const c = new PMatrixHttpClient(makeConfig({
      batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 1 },
    }));

    const r = await c.sendBatch([makeSignal()]);
    expect(r.received).toBe(1);
  });

  test('429 최종 fail → backupToLocal 호출', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse({
      ok: false, status: 429, body: 'still rate limited',
      headers: { 'Retry-After': '0' },
    }));

    const c = new PMatrixHttpClient(makeConfig());  // retryMax=0
    await expect(c.sendBatch([makeSignal()])).rejects.toThrow();

    expect((fs.promises as jest.Mocked<typeof fs.promises>).writeFile).toHaveBeenCalled();
  });

  test('Retry-After 없음 → BURST_RETRY_DELAYS fallback (즉시 재시도용 짧은 wait 없음을 확인)', async () => {
    let attempt = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        return mockResponse({ ok: false, status: 429 });  // Retry-After 헤더 없음
      }
      return mockResponse({ body: { received: 1 } });
    });

    const c = new PMatrixHttpClient(makeConfig({
      batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 1 },
    }));

    // BURST_RETRY_DELAYS[0] = 1000 ms — 1초 fallback 적용 확인
    const start = Date.now();
    const r = await c.sendBatch([makeSignal()]);
    const elapsed = Date.now() - start;

    expect(r.received).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(900);  // ~1s wait
    expect(elapsed).toBeLessThan(2000);
  }, 10_000);
});
