// =============================================================================
// post-tool-use.test.ts — postToolUse handler 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. toolCallCount 증가 (정상 완료 기준)
//   2. dataSharing=true → client.sendCritical 호출
//   3. dataSharing=false → client 호출 없음
//   4. tool_name 원문 미포함 (tool_name_length만)
//   5. saveState 호출
// =============================================================================

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return {
    ...actual,
    homedir: jest.fn(() => (globalThis as { __pmatrixTempHome?: string }).__pmatrixTempHome ?? actual.homedir()),
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handlePostToolUse } from '../hooks/post-tool-use';
import { PMatrixHttpClient } from '../client';
import { loadOrCreateState } from '../state-store';
import type { PMatrixConfig } from '../types';
import type { CursorPostToolUseInput } from '../cursor-types';

let tempHome: string;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(jest.requireActual<typeof os>('os').tmpdir(), 'pmatrix-post-'));
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

function makeEvent(overrides: Partial<CursorPostToolUseInput> = {}): CursorPostToolUseInput {
  return {
    conversation_id: 'conv-post-1',
    generation_id: 'gen-1',
    model: 'gpt-4',
    hook_event_name: 'postToolUse',
    cursor_version: '0.42.0',
    workspace_roots: ['/repo'],
    user_email: null,
    transcript_path: null,
    tool_name: 'bash',
    tool_use_id: 'tu-1',
    tool_input: { command: 'ls' },
    cwd: '/repo',
    tool_output: 'file1.txt\nfile2.txt',
    duration: 100,
    ...overrides,
  };
}

function makeMockClient(): PMatrixHttpClient {
  const c = new PMatrixHttpClient(makeConfig());
  jest.spyOn(c, 'sendCritical').mockResolvedValue();
  return c;
}

// =============================================================================
// 1. toolCallCount 증가
// =============================================================================

describe('toolCallCount', () => {
  test('호출 시 1 증가', async () => {
    const client = makeMockClient();
    await handlePostToolUse(makeEvent(), makeConfig({ dataSharing: false }), client);

    const state = loadOrCreateState('conv-post-1', 'test-agent');
    expect(state.toolCallCount).toBe(1);
  });

  test('두 번 호출 → 2', async () => {
    const client = makeMockClient();
    const cfg = makeConfig({ dataSharing: false });
    await handlePostToolUse(makeEvent(), cfg, client);
    await handlePostToolUse(makeEvent(), cfg, client);

    const state = loadOrCreateState('conv-post-1', 'test-agent');
    expect(state.toolCallCount).toBe(2);
  });
});

// =============================================================================
// 2. dataSharing 분기
// =============================================================================

describe('dataSharing', () => {
  test('dataSharing=true → sendCritical 호출', async () => {
    const client = makeMockClient();
    const sendSpy = client.sendCritical as jest.Mock;

    await handlePostToolUse(makeEvent(), makeConfig({ dataSharing: true }), client);

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  test('dataSharing=false → sendCritical 호출 없음', async () => {
    const client = makeMockClient();
    const sendSpy = client.sendCritical as jest.Mock;

    await handlePostToolUse(makeEvent(), makeConfig({ dataSharing: false }), client);

    expect(sendSpy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 3. Privacy-first: tool_name 원문 미포함
// =============================================================================

describe('Privacy-first', () => {
  test('signal metadata 에 tool_name 미포함, tool_name_length 포함', async () => {
    const client = makeMockClient();
    const sendSpy = client.sendCritical as jest.Mock;

    await handlePostToolUse(
      makeEvent({ tool_name: 'sensitive_tool_name' }),
      makeConfig(),
      client
    );

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sentSignal = sendSpy.mock.calls[0]![0];
    expect(sentSignal.metadata.tool_name).toBeUndefined();
    expect(sentSignal.metadata.tool_name_length).toBe('sensitive_tool_name'.length);
  });

  test('event_type=post_tool_use', async () => {
    const client = makeMockClient();
    const sendSpy = client.sendCritical as jest.Mock;

    await handlePostToolUse(makeEvent(), makeConfig(), client);

    const sentSignal = sendSpy.mock.calls[0]![0];
    expect(sentSignal.metadata.event_type).toBe('post_tool_use');
    expect(sentSignal.metadata.priority).toBe('normal');
  });

  test('signal_source=cursor_hook, framework=cursor', async () => {
    const client = makeMockClient();
    const sendSpy = client.sendCritical as jest.Mock;

    await handlePostToolUse(makeEvent(), makeConfig(), client);

    const sent = sendSpy.mock.calls[0]![0];
    expect(sent.signal_source).toBe('cursor_hook');
    expect(sent.framework).toBe('cursor');
  });

  test('duration 포함', async () => {
    const client = makeMockClient();
    const sendSpy = client.sendCritical as jest.Mock;

    await handlePostToolUse(makeEvent({ duration: 1234 }), makeConfig(), client);

    const sent = sendSpy.mock.calls[0]![0];
    expect(sent.metadata.duration).toBe(1234);
  });
});

// =============================================================================
// 4. observation-only — axes 모두 0
// =============================================================================

describe('observation-only signal', () => {
  test('정상 완료는 stability/baseline/norm/meta_control 모두 0', async () => {
    const client = makeMockClient();
    const sendSpy = client.sendCritical as jest.Mock;

    await handlePostToolUse(makeEvent(), makeConfig(), client);

    const sent = sendSpy.mock.calls[0]![0];
    expect(sent.baseline).toBe(0);
    expect(sent.norm).toBe(0);
    expect(sent.stability).toBe(0);
    expect(sent.meta_control).toBe(0);
  });
});

// =============================================================================
// 5. fire-and-forget — sendCritical 실패가 propagate 안 됨
// =============================================================================

describe('fire-and-forget', () => {
  test('sendCritical 실패해도 handlePostToolUse 정상 완료', async () => {
    const client = makeMockClient();
    (client.sendCritical as jest.Mock).mockRejectedValueOnce(new Error('network'));

    await expect(
      handlePostToolUse(makeEvent(), makeConfig(), client)
    ).resolves.toBeUndefined();

    // 카운터는 여전히 증가
    const state = loadOrCreateState('conv-post-1', 'test-agent');
    expect(state.toolCallCount).toBe(1);
  });
});
