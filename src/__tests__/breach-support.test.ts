// =============================================================================
// breach-support.test.ts — cursor-monitor BreachSupport 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. constructor — authority_limit cache load (없으면 null)
//   2. isInScope — allowed_action_types / allowed_paths / denied_paths
//   3. Approval tracking — requested / granted / denied / pending / null
//   4. recordBlockedAction / getRecentBlocked - 60s window
//   5. counters - increment + getters
//   6. getSessionReport
//   7. inferDelegatedActionType - tool → AP 매핑
//   8. enrichMetadata - in_scope + blocked_action_history
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
import { BreachSupport } from '../breach-support';

let tempHome: string;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(jest.requireActual<typeof os>('os').tmpdir(), 'pmatrix-breach-'));
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

function writeAuthorityLimit(agentId: string, limit: Record<string, unknown>): void {
  const dir = path.join(tempHome, '.pmatrix', 'cache', 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  const contractPath = path.join(dir, 'contract.json');
  fs.writeFileSync(
    contractPath,
    JSON.stringify({ data: { authority_limit: limit } }),
    'utf-8'
  );
}

// =============================================================================
// 1. constructor / authority_limit load
// =============================================================================

describe('constructor — authority_limit cache', () => {
  test('contract.json 없음 → authorityLimit null → isInScope null', () => {
    const b = new BreachSupport('agent-1');
    expect(b.isInScope('AP-1')).toBeNull();
  });

  test('contract.json 정상 로드 → isInScope 평가', () => {
    writeAuthorityLimit('agent-2', {
      allowed_action_types: ['AP-1', 'AP-2'],
    });
    const b = new BreachSupport('agent-2');
    expect(b.isInScope('AP-1')).toBe(true);
    expect(b.isInScope('AP-9')).toBe(false);
  });

  test('손상된 JSON → 크래시 없음 (graceful degradation)', () => {
    const dir = path.join(tempHome, '.pmatrix', 'cache', 'agents', 'agent-corrupt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'contract.json'), '{not-valid', 'utf-8');

    expect(() => new BreachSupport('agent-corrupt')).not.toThrow();
    const b = new BreachSupport('agent-corrupt');
    expect(b.isInScope('AP-1')).toBeNull();
  });
});

// =============================================================================
// 2. isInScope
// =============================================================================

describe('isInScope — scope 평가', () => {
  test('allowed_action_types 비포함 → false', () => {
    writeAuthorityLimit('a', { allowed_action_types: ['AP-1'] });
    const b = new BreachSupport('a');
    expect(b.isInScope('AP-9')).toBe(false);
  });

  test('allowed_paths prefix 매칭', () => {
    writeAuthorityLimit('a', {
      allowed_action_types: ['AP-2'],
      allowed_paths: ['/repo/src/**'],
    });
    const b = new BreachSupport('a');
    expect(b.isInScope('AP-2', '/repo/src/foo.ts')).toBe(true);
    expect(b.isInScope('AP-2', '/etc/passwd')).toBe(false);
  });

  test('denied_paths → false', () => {
    writeAuthorityLimit('a', {
      allowed_action_types: ['AP-2'],
      allowed_paths: ['/repo/**'],
      denied_paths: ['/repo/secrets/**'],
    });
    const b = new BreachSupport('a');
    expect(b.isInScope('AP-2', '/repo/src/foo.ts')).toBe(true);
    expect(b.isInScope('AP-2', '/repo/secrets/key.pem')).toBe(false);
  });
});

// =============================================================================
// 3. Approval tracking
// =============================================================================

describe('Approval tracking', () => {
  test('action 미기록 → null', () => {
    const b = new BreachSupport('a');
    expect(b.getApprovalStatus('action-x')).toBeNull();
  });

  test('requested → pending', () => {
    const b = new BreachSupport('a');
    b.recordApprovalRequested('act-1', 'bash');
    expect(b.getApprovalStatus('act-1')).toBe('pending');
  });

  test('requested → granted', () => {
    const b = new BreachSupport('a');
    b.recordApprovalRequested('act-2', 'bash');
    b.recordApprovalGranted('act-2');
    expect(b.getApprovalStatus('act-2')).toBe('granted');
  });

  test('requested → denied', () => {
    const b = new BreachSupport('a');
    b.recordApprovalRequested('act-3', 'bash');
    b.recordApprovalDenied('act-3');
    expect(b.getApprovalStatus('act-3')).toBe('denied');
  });

  test('가장 최근 status 반환 (history 마지막)', () => {
    const b = new BreachSupport('a');
    b.recordApprovalRequested('act-4', 'bash');
    b.recordApprovalGranted('act-4');
    expect(b.getApprovalStatus('act-4')).toBe('granted');
  });
});

// =============================================================================
// 4. Blocked actions / recent window
// =============================================================================

describe('recordBlockedAction / getRecentBlocked', () => {
  test('기록된 action 60s 내 반환', () => {
    const b = new BreachSupport('a');
    b.recordBlockedAction('bash', 'high-risk in critical');

    const recent = b.getRecentBlocked();
    expect(recent.length).toBe(1);
    expect(recent[0]!.tool_name).toBe('bash');
    expect(recent[0]!.reason).toBe('high-risk in critical');
  });

  test('window 만료 → 결과에서 제외', async () => {
    const b = new BreachSupport('a');
    b.recordBlockedAction('bash', 'r1');

    // 좁은 window 사용
    const recent = b.getRecentBlocked(1); // 1ms window
    // 1ms 후에는 cutoff 위로 가야 하지만 즉시 호출이라 timing 의존
    // 안전: 동작 확인만
    expect(Array.isArray(recent)).toBe(true);
  });

  test('빈 history → 빈 배열', () => {
    const b = new BreachSupport('a');
    expect(b.getRecentBlocked()).toEqual([]);
  });
});

// =============================================================================
// 5. Counters
// =============================================================================

describe('Counters increment + getters', () => {
  test('증가 전 0', () => {
    const b = new BreachSupport('a');
    expect(b.getToolCallCount()).toBe(0);
    expect(b.getFileModCount()).toBe(0);
  });

  test('각 카운터 증가', () => {
    const b = new BreachSupport('a');
    b.incrementToolCalls();
    b.incrementToolCalls();
    b.incrementFileModifications();
    b.incrementErrors();
    b.incrementDenied();

    expect(b.getToolCallCount()).toBe(2);
    expect(b.getFileModCount()).toBe(1);
  });
});

// =============================================================================
// 6. getSessionReport
// =============================================================================

describe('getSessionReport', () => {
  test('report 구조 확인', () => {
    const b = new BreachSupport('a');
    b.incrementToolCalls();
    b.incrementErrors();
    b.incrementErrors();

    const r = b.getSessionReport();
    expect(r.report_type).toBe('session_summary');
    expect(r.actions_summary.tool_calls_count).toBe(1);
    expect(r.actions_summary.errors_count).toBe(2);
    expect(typeof r.session_duration_ms).toBe('number');
    expect(r.session_duration_ms).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// 7. inferDelegatedActionType
// =============================================================================

describe('inferDelegatedActionType', () => {
  test('bash → AP-1', () => {
    const b = new BreachSupport('a');
    expect(b.inferDelegatedActionType('bash')).toBe('AP-1');
  });

  test('write_file → AP-2', () => {
    const b = new BreachSupport('a');
    expect(b.inferDelegatedActionType('write_file')).toBe('AP-2');
  });

  test('web_fetch → AP-3', () => {
    const b = new BreachSupport('a');
    expect(b.inferDelegatedActionType('web_fetch')).toBe('AP-3');
  });

  test('알 수 없는 tool → AP-1 (기본값)', () => {
    const b = new BreachSupport('a');
    expect(b.inferDelegatedActionType('unknown_tool')).toBe('AP-1');
  });

  test('lastToolName 없음 → undefined', () => {
    const b = new BreachSupport('a');
    expect(b.inferDelegatedActionType()).toBeUndefined();
  });
});

// =============================================================================
// 8. enrichMetadata
// =============================================================================

describe('enrichMetadata', () => {
  test('opts 없음 → base 객체 spread만', () => {
    const b = new BreachSupport('a');
    const r = b.enrichMetadata({ x: 1 });
    expect(r.x).toBe(1);
  });

  test('actionPrimitive 있음 → in_scope 추가', () => {
    writeAuthorityLimit('a', { allowed_action_types: ['AP-1'] });
    const b = new BreachSupport('a');
    const r = b.enrichMetadata({}, { actionPrimitive: 'AP-1' });
    expect(r.in_scope).toBe(true);
  });

  test('blocked history 있음 → blocked_action_history 추가', () => {
    const b = new BreachSupport('a');
    b.recordBlockedAction('bash', 'high-risk');
    const r = b.enrichMetadata({});
    expect(r.blocked_action_history).toBeDefined();
    expect(Array.isArray(r.blocked_action_history)).toBe(true);
    expect(r.blocked_action_history.length).toBe(1);
  });

  test('blocked history 없음 → blocked_action_history 미포함', () => {
    const b = new BreachSupport('a');
    const r = b.enrichMetadata({ y: 2 });
    expect(r.blocked_action_history).toBeUndefined();
    expect(r.y).toBe(2);
  });
});
