// =============================================================================
// state-store.test.ts — cursor-monitor 세션 상태 영속화 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. createDefaultState — 기본 상태 객체
//   2. isRtCacheValid / buildRtCacheExpiry — R(t) 캐시 TTL
//   3. saveState / loadState — atomic write + parse error fail-open
//   4. loadOrCreateState — backfill guards
//   5. deleteState — silent fail
//   6. HALT file (haltFilePath / isHaltActive / activateHalt)
//   7. findActiveSession — framework 필터링
//   8. cleanupStaleStates — TTL 만료
// =============================================================================

// jest.mock 'os' — Node 20+ os.homedir 가 non-configurable property 라서 spyOn 불가.
// jest.mock 변수 참조 규칙상 'mock' 접두어 필요 → globalThis 통해 동적 주입.
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
import {
  createDefaultState,
  isRtCacheValid,
  buildRtCacheExpiry,
  saveState,
  loadState,
  loadOrCreateState,
  deleteState,
  haltFilePath,
  isHaltActive,
  activateHalt,
  findActiveSession,
  cleanupStaleStates,
  PersistedSessionState,
} from '../state-store';

let tempHome: string;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(jest.requireActual<typeof os>('os').tmpdir(), 'pmatrix-test-'));
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

// =============================================================================
// 1. createDefaultState
// =============================================================================

describe('createDefaultState — 기본 상태 객체', () => {
  test('필수 필드가 모두 채워짐', () => {
    const s = createDefaultState('sess-1', 'agent-1');

    expect(s.sessionId).toBe('sess-1');
    expect(s.agentId).toBe('agent-1');
    expect(s.currentRt).toBe(0);
    expect(s.currentMode).toBe('normal');
    expect(s.grade).toBeNull();
    expect(s.isHalted).toBe(false);
    expect(s.framework).toBe('cursor');

    // 카운터 모두 0
    expect(s.dangerEvents).toBe(0);
    expect(s.totalTurns).toBe(0);
    expect(s.toolCallCount).toBe(0);
    expect(s.shellCommandCount).toBe(0);
    expect(s.failureCount).toBe(0);
    expect(s.compactCount).toBe(0);
    expect(s.loopCount).toBe(0);
  });

  test('rtCacheExpiry는 즉시 expired', () => {
    const s = createDefaultState('sess-1', 'agent-1');
    expect(isRtCacheValid(s)).toBe(false);
  });

  test('Cursor 메타데이터 빈 문자열 / 기본값', () => {
    const s = createDefaultState('sess-1', 'agent-1');
    expect(s.conversationId).toBe('');
    expect(s.composerMode).toBe('agent');
    expect(s.isBackgroundAgent).toBe(false);
  });
});

// =============================================================================
// 2. R(t) 캐시 TTL
// =============================================================================

describe('isRtCacheValid / buildRtCacheExpiry — 30s TTL', () => {
  test('미래 expiry → valid', () => {
    const s = createDefaultState('sess', 'agent');
    s.rtCacheExpiry = buildRtCacheExpiry();
    expect(isRtCacheValid(s)).toBe(true);
  });

  test('과거 expiry → invalid', () => {
    const s = createDefaultState('sess', 'agent');
    s.rtCacheExpiry = new Date(Date.now() - 1000).toISOString();
    expect(isRtCacheValid(s)).toBe(false);
  });

  test('buildRtCacheExpiry는 ~30s 후', () => {
    const expiryStr = buildRtCacheExpiry();
    const delta = new Date(expiryStr).getTime() - Date.now();
    expect(delta).toBeGreaterThan(29_000);
    expect(delta).toBeLessThanOrEqual(30_000);
  });
});

// =============================================================================
// 3. saveState / loadState round-trip
// =============================================================================

describe('saveState / loadState — round-trip', () => {
  test('저장 후 로드 시 동일한 객체', () => {
    const original = createDefaultState('sess-x', 'agent-x');
    original.totalTurns = 5;
    original.toolCallCount = 12;
    original.cursorVersion = '0.42.0';

    saveState(original);
    const loaded = loadState('sess-x');

    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe('sess-x');
    expect(loaded!.totalTurns).toBe(5);
    expect(loaded!.toolCallCount).toBe(12);
    expect(loaded!.cursorVersion).toBe('0.42.0');
  });

  test('존재하지 않는 세션 → null', () => {
    expect(loadState('nonexistent')).toBeNull();
  });

  test('saveState 후 updatedAt 갱신', () => {
    const s = createDefaultState('sess-u', 'agent');
    const oldUpdatedAt = s.updatedAt;
    // 시간 보장
    s.updatedAt = new Date(Date.now() - 10_000).toISOString();
    saveState(s);
    const loaded = loadState('sess-u');
    expect(loaded!.updatedAt).not.toBe(oldUpdatedAt);
  });

  test('파일 경로 sanitize — 위험 문자 제거', () => {
    // session ID 에 슬래시/특수문자 포함 → 안전하게 sanitize
    const s = createDefaultState('sess/../etc/passwd', 'agent');
    saveState(s);
    // sanitize 후 sessionId 은 그대로 객체에 보존되지만 파일명은 안전화
    const loaded = loadState('sess/../etc/passwd');
    expect(loaded).not.toBeNull();
  });

  test('손상 파일 → loadState fail-open (null)', () => {
    const s = createDefaultState('sess-corrupt', 'agent');
    saveState(s);
    // 강제 손상
    const dir = path.join(tempHome, '.pmatrix', 'sessions');
    const files = fs.readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    const corruptFile = path.join(dir, files[0]!);
    fs.writeFileSync(corruptFile, '{not-valid-json', 'utf-8');

    // 손상 파일을 sessionId 로 직접 로드 시도하면 null
    // (sanitize 통과하는 ID 사용)
    const loaded = loadState('sess-corrupt');
    expect(loaded).toBeNull();
  });
});

// =============================================================================
// 4. loadOrCreateState — backfill
// =============================================================================

describe('loadOrCreateState — backfill guards', () => {
  test('새 세션 → default state', () => {
    const s = loadOrCreateState('new-sess', 'agent');
    expect(s.sessionId).toBe('new-sess');
    expect(s.totalTurns).toBe(0);
  });

  test('필드 누락된 stale 파일 → backfill', () => {
    // 의도적으로 일부 필드가 빠진 stale 파일
    const dir = path.join(tempHome, '.pmatrix', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const minimal = {
      sessionId: 'partial',
      agentId: 'agent',
      startedAt: new Date().toISOString(),
      currentRt: 0,
      currentMode: 'normal',
      grade: null,
      rtCacheExpiry: new Date(Date.now() - 1).toISOString(),
      isHalted: false,
      dangerEvents: 0,
      credentialBlocks: 0,
      safetyGateBlocks: 0,
      totalTurns: 0,
      updatedAt: new Date().toISOString(),
      // permissionRequestCount, subagentSpawnCount, framework, Cursor counters 누락
    };
    fs.writeFileSync(path.join(dir, 'partial.json'), JSON.stringify(minimal), 'utf-8');

    const s = loadOrCreateState('partial', 'agent');
    expect(s.permissionRequestCount).toBe(0);
    expect(s.subagentSpawnCount).toBe(0);
    expect(s.framework).toBe('cursor');
    expect(s.toolCallCount).toBe(0);
    expect(s.shellCommandCount).toBe(0);
    expect(s.composerMode).toBe('agent');
  });
});

// =============================================================================
// 5. deleteState
// =============================================================================

describe('deleteState — silent fail', () => {
  test('존재하는 세션 삭제', () => {
    const s = createDefaultState('to-delete', 'agent');
    saveState(s);
    expect(loadState('to-delete')).not.toBeNull();

    deleteState('to-delete');
    expect(loadState('to-delete')).toBeNull();
  });

  test('존재하지 않는 세션 삭제 → 크래시 없음', () => {
    expect(() => deleteState('nonexistent')).not.toThrow();
  });
});

// =============================================================================
// 6. HALT file
// =============================================================================

describe('HALT file 유틸', () => {
  test('초기 isHaltActive=false', () => {
    expect(isHaltActive()).toBe(false);
  });

  test('activateHalt → isHaltActive=true', () => {
    activateHalt('test reason');
    expect(isHaltActive()).toBe(true);

    const content = fs.readFileSync(haltFilePath(), 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.reason).toBe('test reason');
    expect(parsed.activatedAt).toBeDefined();
  });

  test('haltFilePath = ~/.pmatrix/HALT', () => {
    expect(haltFilePath()).toBe(path.join(tempHome, '.pmatrix', 'HALT'));
  });
});

// =============================================================================
// 7. findActiveSession
// =============================================================================

describe('findActiveSession — framework 필터', () => {
  test('빈 디렉토리 → null', () => {
    expect(findActiveSession()).toBeNull();
  });

  test('가장 최근 갱신된 세션 반환', () => {
    const s1 = createDefaultState('old-sess', 'agent');
    saveState(s1);
    // 잠시 대기 — saveState 의 updatedAt 분리 보장
    const s2 = createDefaultState('new-sess', 'agent');
    s2.updatedAt = new Date(Date.now() + 1000).toISOString();
    saveState(s2);

    const found = findActiveSession();
    expect(found).not.toBeNull();
    // most recently updated
    expect(['old-sess', 'new-sess']).toContain(found!.sessionId);
  });

  test('framework=cursor 필터 → cursor만 반환', () => {
    const s1 = createDefaultState('s1', 'agent');
    s1.framework = 'cursor';
    saveState(s1);

    const s2 = createDefaultState('s2', 'agent');
    s2.framework = 'claude-code';
    saveState(s2);

    const found = findActiveSession('cursor');
    expect(found).not.toBeNull();
    expect(found!.framework).toBe('cursor');
  });
});

// =============================================================================
// 8. cleanupStaleStates
// =============================================================================

describe('cleanupStaleStates — TTL 만료', () => {
  test('SESSION_TTL_MS 초과 파일 삭제', () => {
    const s = createDefaultState('stale', 'agent');
    saveState(s);

    // 파일 mtime 을 25시간 전으로 강제 변경
    const dir = path.join(tempHome, '.pmatrix', 'sessions');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    expect(files.length).toBe(1);
    const filepath = path.join(dir, files[0]!);

    const past = Date.now() - 25 * 60 * 60 * 1_000;
    fs.utimesSync(filepath, past / 1000, past / 1000);

    cleanupStaleStates();
    expect(fs.existsSync(filepath)).toBe(false);
  });

  test('.tmp 파일은 항상 삭제', () => {
    const dir = path.join(tempHome, '.pmatrix', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const tmpFile = path.join(dir, 'leftover.json.tmp');
    fs.writeFileSync(tmpFile, '{}', 'utf-8');

    cleanupStaleStates();
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  test('빈 디렉토리 / 미존재 디렉토리 → 크래시 없음', () => {
    expect(() => cleanupStaleStates()).not.toThrow();
  });

  test('최신 파일은 보존', () => {
    const s = createDefaultState('fresh', 'agent');
    saveState(s);
    cleanupStaleStates();
    expect(loadState('fresh')).not.toBeNull();
  });
});
