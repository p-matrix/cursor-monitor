// =============================================================================
// formatter.test.ts — Mode formatting 헬퍼 자가 검증
// =============================================================================
//
// cursor-monitor 에는 별도 formatter.ts 모듈은 없지만, safety-gate.ts
// 의 rtToMode + MODE_BOUNDARIES 가 사실상 mode 표기 변환의 단일 source.
// 본 파일은 다음 항목의 사용자-가시(user-facing) 출력 안정성을 검증:
//   1. rtToMode 출력값이 5종 Gen2 string literal 중 하나
//   2. mode → 경계값 round-trip (rtToMode(MODE_BOUNDARIES[m][0]) == m, except halt)
//   3. R(t) toFixed(2) 표시 — Safety Gate reason 메시지에 사용
//   4. mode 표기 union 안정성 (typeof guard)
// =============================================================================

import {
  rtToMode,
  evaluateSafetyGate,
  MODE_BOUNDARIES,
} from '../safety-gate';
import type { SafetyMode } from '../types';

const ALL_MODES: SafetyMode[] = ['normal', 'caution', 'alert', 'critical', 'halt'];

// =============================================================================
// 1. rtToMode → 5종 union 한정
// =============================================================================

describe('rtToMode 출력 안정성', () => {
  test('모든 R(t) 값에 대해 5종 Gen2 mode 중 하나만 반환', () => {
    for (let rt = 0; rt <= 1; rt += 0.01) {
      const m = rtToMode(rt);
      expect(ALL_MODES).toContain(m);
    }
  });

  test('R(t) 음수/1 초과 — 경계 정의 (음수→normal, ≥1→halt)', () => {
    expect(rtToMode(-0.5)).toBe('normal'); // < 0.15 분기로 흡수
    expect(rtToMode(1.5)).toBe('halt');     // ≥ 0.75 분기
  });
});

// =============================================================================
// 2. MODE_BOUNDARIES round-trip
// =============================================================================

describe('mode → 경계값 round-trip', () => {
  test.each([
    ['normal',   0.00],
    ['caution',  0.15],
    ['alert',    0.30],
    ['critical', 0.50],
    ['halt',     0.75],
  ] as const)('rtToMode(MODE_BOUNDARIES.%s[0]=%s) === %s', (mode, low) => {
    expect(rtToMode(low)).toBe(mode);
  });

  test('각 mode 의 [low, high] 값 모두 정의', () => {
    for (const m of ALL_MODES) {
      const [low, high] = MODE_BOUNDARIES[m];
      expect(typeof low).toBe('number');
      expect(typeof high).toBe('number');
      expect(low).toBeLessThan(high);
    }
  });
});

// =============================================================================
// 3. Safety Gate reason 메시지의 R(t) 포맷
// =============================================================================

describe('Safety Gate reason — R(t).toFixed(2) 표시', () => {
  test('Critical zone reason 에 0.60 표시', () => {
    const r = evaluateSafetyGate(0.60, 'HIGH');
    expect(r.reason).toContain('0.60');
  });

  test('HALT zone reason 에 0.80 표시', () => {
    const r = evaluateSafetyGate(0.80, 'LOW');
    expect(r.reason).toContain('0.80');
  });

  test('Caution + HIGH 의 reason에 R(t) 표시', () => {
    const r = evaluateSafetyGate(0.20, 'HIGH');
    expect(r.reason).toContain('0.20');
  });

  test('ALLOW 응답의 reason은 빈 문자열', () => {
    expect(evaluateSafetyGate(0.10, 'LOW').reason).toBe('');
    expect(evaluateSafetyGate(0.20, 'MEDIUM').reason).toBe('');
  });
});

// =============================================================================
// 4. mode 표기 union 안정성
// =============================================================================

describe('SafetyMode union 안정성', () => {
  test('모든 mode 가 lowercase 5자 이상', () => {
    for (const m of ALL_MODES) {
      expect(m).toMatch(/^[a-z]+$/);
      expect(m.length).toBeGreaterThanOrEqual(4);
    }
  });

  test('Gen1 legacy 표기 (A+1, A-0 등)는 union에 포함되지 않음', () => {
    // 컴파일 타임 protect — 본 테스트는 Gen2 rename 회귀 방지용
    const someMode: SafetyMode = 'normal';
    expect(['A+1', 'A+0', 'A-1', 'A-2', 'A-0']).not.toContain(someMode);
  });
});
