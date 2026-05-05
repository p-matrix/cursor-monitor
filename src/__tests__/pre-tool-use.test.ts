// =============================================================================
// pre-tool-use.test.ts — preToolUse pass-through 자가 검증
// =============================================================================
//
// Cursor 제약: preToolUse deny는 무시됨 — 항상 'allow' 반환.
// 검증 범위:
//   - 항상 { permission: 'allow' } 반환
//   - debug=true 시 stderr 로그 (toolName 포함)
//   - debug=false 시 stderr 무음
//   - tool_input 무관 (privacy-first)
// =============================================================================

import { handlePreToolUse } from '../hooks/pre-tool-use';
import type { PMatrixConfig } from '../types';
import type { CursorPreToolUseInput } from '../cursor-types';

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'test-agent',
    apiKey: 'test-key',
    safetyGate: { enabled: true, serverTimeoutMs: 2_500 },
    credentialProtection: { enabled: true, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75 },
    dataSharing: false,
    batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 0 },
    debug: false,
    ...overrides,
  };
}

function makeEvent(toolName: string): CursorPreToolUseInput {
  return {
    conversation_id: 'conv-1',
    generation_id: 'gen-1',
    model: 'gpt-4',
    hook_event_name: 'preToolUse',
    cursor_version: '0.42.0',
    workspace_roots: ['/repo'],
    user_email: null,
    transcript_path: null,
    tool_name: toolName,
    tool_input: { foo: 'bar' },
  };
}

describe('handlePreToolUse — pass-through', () => {
  test('항상 { permission: "allow" } 반환', async () => {
    const r = await handlePreToolUse(makeEvent('bash'), makeConfig());
    expect(r).toEqual({ permission: 'allow' });
  });

  test('HIGH 위험 도구도 allow (deny는 Cursor에서 무시되므로)', async () => {
    const r = await handlePreToolUse(makeEvent('exec'), makeConfig());
    expect(r.permission).toBe('allow');
  });

  test('알 수 없는 도구 → allow', async () => {
    const r = await handlePreToolUse(makeEvent('unknown_xyz'), makeConfig());
    expect(r.permission).toBe('allow');
  });

  test('debug=true → stderr 로그 (tool_name 포함)', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await handlePreToolUse(makeEvent('bash'), makeConfig({ debug: true }));

    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    const log = calls.find(s => s.includes('preToolUse'));
    expect(log).toBeDefined();
    expect(log).toContain('bash');

    stderrSpy.mockRestore();
  });

  test('debug=false → stderr 무음', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await handlePreToolUse(makeEvent('bash'), makeConfig({ debug: false }));

    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    const log = calls.find(s => s.includes('preToolUse'));
    expect(log).toBeUndefined();

    stderrSpy.mockRestore();
  });

  test('동기 비동기 일관성 — 항상 Promise<allow>', async () => {
    const result = handlePreToolUse(makeEvent('write'), makeConfig());
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual({ permission: 'allow' });
  });
});
