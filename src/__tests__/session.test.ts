// =============================================================================
// session.test.ts — sessionStart / sessionEnd handler 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. sessionStart — Cursor 메타데이터 저장 (conversationId, cursorVersion, etc.)
//   2. sessionStart — dataSharing=true → session_start signal 전송
//   3. sessionStart — cleanupStaleStates 호출 (오래된 세션 청소)
//   4. sessionEnd — sendSessionSummary 호출
//   5. sessionEnd — deleteState (세션 파일 삭제)
//   6. sessionEnd — session_report breach signal 전송
// =============================================================================

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return {
    ...actual,
    homedir: jest.fn(() => (globalThis as { __pmatrixTempHome?: string }).__pmatrixTempHome ?? actual.homedir()),
  };
});

// field-node-runtime 모킹 — deleteFieldState 가 실제 fs 호출하지 않도록
jest.mock('@pmatrix/field-node-runtime', () => ({
  deleteFieldState: jest.fn(),
  isField4Enabled: jest.fn().mockReturnValue(false),
  writeFieldState: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleSessionStart, handleSessionEnd } from '../hooks/session';
import { PMatrixHttpClient } from '../client';
import { loadOrCreateState, loadState } from '../state-store';
import type { PMatrixConfig } from '../types';
import type { CursorSessionStartInput, CursorSessionEndInput } from '../cursor-types';

let tempHome: string;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(jest.requireActual<typeof os>('os').tmpdir(), 'pmatrix-session-'));
  (globalThis as { __pmatrixTempHome?: string }).__pmatrixTempHome = tempHome;
});

afterEach(() => {
  delete (globalThis as { __pmatrixTempHome?: string }).__pmatrixTempHome;
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

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

function makeStartEvent(overrides: Partial<CursorSessionStartInput> = {}): CursorSessionStartInput {
  return {
    conversation_id: 'conv-start-1',
    generation_id: 'gen-1',
    model: 'gpt-4',
    hook_event_name: 'sessionStart',
    cursor_version: '0.42.0',
    workspace_roots: ['/repo/main'],
    user_email: null,
    transcript_path: null,
    session_id: 'sess-1',
    is_background_agent: false,
    composer_mode: 'agent',
    ...overrides,
  };
}

function makeEndEvent(overrides: Partial<CursorSessionEndInput> = {}): CursorSessionEndInput {
  return {
    conversation_id: 'conv-start-1',
    generation_id: 'gen-1',
    model: 'gpt-4',
    hook_event_name: 'sessionEnd',
    cursor_version: '0.42.0',
    workspace_roots: ['/repo/main'],
    user_email: null,
    transcript_path: null,
    session_id: 'sess-1',
    reason: 'completed',
    duration_ms: 60_000,
    is_background_agent: false,
    final_status: 'success',
    ...overrides,
  };
}

function makeMockClient(): PMatrixHttpClient {
  const c = new PMatrixHttpClient(makeConfig());
  jest.spyOn(c, 'sendCritical').mockResolvedValue();
  jest.spyOn(c, 'sendSessionSummary').mockResolvedValue();
  jest.spyOn(c, 'resubmitUnsent').mockResolvedValue();
  return c;
}

// =============================================================================
// 1. sessionStart — Cursor 메타데이터 저장
// =============================================================================

describe('handleSessionStart', () => {
  test('Cursor 메타데이터 저장 (conversationId, cursorVersion, model, ...)', async () => {
    const client = makeMockClient();
    await handleSessionStart(
      makeStartEvent({
        conversation_id: 'conv-meta-1',
        cursor_version: '1.2.3',
        model: 'claude-3.5-sonnet',
        workspace_roots: ['/my/repo'],
        is_background_agent: true,
        composer_mode: 'edit',
      }),
      makeConfig({ dataSharing: false }),
      client
    );

    const state = loadOrCreateState('conv-meta-1', 'test-agent');
    expect(state.conversationId).toBe('conv-meta-1');
    expect(state.cursorVersion).toBe('1.2.3');
    expect(state.model).toBe('claude-3.5-sonnet');
    expect(state.workspaceRoot).toBe('/my/repo');
    expect(state.isBackgroundAgent).toBe(true);
    expect(state.composerMode).toBe('edit');
  });

  test('workspace_roots 비어있음 → workspaceRoot=""', async () => {
    const client = makeMockClient();
    await handleSessionStart(
      makeStartEvent({ workspace_roots: [] }),
      makeConfig({ dataSharing: false }),
      client
    );

    const state = loadOrCreateState('conv-start-1', 'test-agent');
    expect(state.workspaceRoot).toBe('');
  });

  test('composer_mode 없음 → "agent" 기본값', async () => {
    const client = makeMockClient();
    const event = makeStartEvent();
    delete event.composer_mode;
    await handleSessionStart(event, makeConfig({ dataSharing: false }), client);

    const state = loadOrCreateState('conv-start-1', 'test-agent');
    expect(state.composerMode).toBe('agent');
  });

  test('dataSharing=true → session_start signal 전송', async () => {
    const client = makeMockClient();
    const sendSpy = client.sendCritical as jest.Mock;

    await handleSessionStart(makeStartEvent(), makeConfig({ dataSharing: true }), client);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = sendSpy.mock.calls[0]![0];
    expect(sent.metadata.event_type).toBe('session_start');
    expect(sent.signal_source).toBe('cursor_hook');
    expect(sent.framework).toBe('cursor');
  });

  test('dataSharing=false → 신호 미전송', async () => {
    const client = makeMockClient();
    const sendSpy = client.sendCritical as jest.Mock;

    await handleSessionStart(makeStartEvent(), makeConfig({ dataSharing: false }), client);

    expect(sendSpy).not.toHaveBeenCalled();
  });

  test('resubmitUnsent 호출 (60s throttle 자체는 client 책임)', async () => {
    const client = makeMockClient();
    const resubmitSpy = client.resubmitUnsent as jest.Mock;

    await handleSessionStart(makeStartEvent(), makeConfig(), client);

    expect(resubmitSpy).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 2. sessionEnd
// =============================================================================

describe('handleSessionEnd', () => {
  test('sendSessionSummary 호출 (dataSharing=true)', async () => {
    const client = makeMockClient();
    const summarySpy = client.sendSessionSummary as jest.Mock;

    // 먼저 세션 시작 + state 일부 갱신
    await handleSessionStart(makeStartEvent(), makeConfig({ dataSharing: false }), client);

    await handleSessionEnd(makeEndEvent({ reason: 'completed' }), makeConfig(), client);

    expect(summarySpy).toHaveBeenCalledTimes(1);
    const summary = summarySpy.mock.calls[0]![0];
    expect(summary.sessionId).toBe('conv-start-1');
    expect(summary.endReason).toBe('completed');
    expect(summary.signal_source).toBe('cursor_hook');
    expect(summary.framework).toBe('cursor');
  });

  test('dataSharing=false → sendSessionSummary 미호출', async () => {
    const client = makeMockClient();
    const summarySpy = client.sendSessionSummary as jest.Mock;

    await handleSessionEnd(makeEndEvent(), makeConfig({ dataSharing: false }), client);

    expect(summarySpy).not.toHaveBeenCalled();
  });

  test('세션 파일 삭제 (deleteState)', async () => {
    const client = makeMockClient();

    // 먼저 sessionStart 로 파일 생성
    await handleSessionStart(makeStartEvent(), makeConfig({ dataSharing: false }), client);
    expect(loadState('conv-start-1')).not.toBeNull();

    // sessionEnd → 삭제
    await handleSessionEnd(makeEndEvent(), makeConfig({ dataSharing: false }), client);
    expect(loadState('conv-start-1')).toBeNull();
  });

  test('session_report breach signal 전송 (dataSharing=true)', async () => {
    const client = makeMockClient();
    const sendSpy = client.sendCritical as jest.Mock;

    await handleSessionEnd(makeEndEvent(), makeConfig(), client);

    // sendCritical 으로 session_report breach signal 전송됨
    expect(sendSpy).toHaveBeenCalled();
    const reportCall = sendSpy.mock.calls.find(
      c => (c[0] as { metadata?: { event_type?: string } })?.metadata?.event_type === 'session_report'
    );
    expect(reportCall).toBeDefined();
  });

  test('end_reason 종류별 정상 처리', async () => {
    const client = makeMockClient();
    const summarySpy = client.sendSessionSummary as jest.Mock;

    for (const reason of ['completed', 'aborted', 'error', 'window_close', 'user_close'] as const) {
      summarySpy.mockClear();
      await handleSessionEnd(makeEndEvent({ reason }), makeConfig(), client);
      expect(summarySpy).toHaveBeenCalledTimes(1);
      expect(summarySpy.mock.calls[0]![0].endReason).toBe(reason);
    }
  });
});
