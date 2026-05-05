// =============================================================================
// config.test.ts — cursor-monitor config loader 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. 기본값 (파일 + 환경변수 모두 없음)
//   2. 환경변수 우선 (PMATRIX_API_KEY, PMATRIX_SERVER_URL, PMATRIX_AGENT_ID, PMATRIX_DEBUG)
//   3. config.json 로드
//   4. ${ENV_VAR} reference 해석
//   5. partial config + DEFAULT 병합
//   6. 잘못된 JSON / 파일 미존재 → 기본값
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
import { loadConfig } from '../config';

let tempHome: string;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(jest.requireActual<typeof os>('os').tmpdir(), 'pmatrix-config-'));
  (globalThis as { __pmatrixTempHome?: string }).__pmatrixTempHome = tempHome;

  delete process.env['PMATRIX_API_KEY'];
  delete process.env['PMATRIX_SERVER_URL'];
  delete process.env['PMATRIX_AGENT_ID'];
  delete process.env['PMATRIX_DEBUG'];
});

afterEach(() => {
  delete (globalThis as { __pmatrixTempHome?: string }).__pmatrixTempHome;
  delete process.env['PMATRIX_API_KEY'];
  delete process.env['PMATRIX_SERVER_URL'];
  delete process.env['PMATRIX_AGENT_ID'];
  delete process.env['PMATRIX_DEBUG'];
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function writeConfig(content: unknown): void {
  const dir = path.join(tempHome, '.pmatrix');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(content),
    'utf-8'
  );
}

// =============================================================================
// 1. 기본값
// =============================================================================

describe('loadConfig — 파일/환경변수 없음 → 기본값', () => {
  test('serverUrl/agentId/apiKey 기본값', () => {
    const c = loadConfig();
    expect(c.serverUrl).toBe('https://api.pmatrix.io');
    expect(c.agentId).toBe('');
    expect(c.apiKey).toBe('');
    expect(c.debug).toBe(false);
    expect(c.dataSharing).toBe(false);
  });

  test('safetyGate / killSwitch / batch 기본값', () => {
    const c = loadConfig();
    expect(c.safetyGate.enabled).toBe(true);
    expect(c.safetyGate.serverTimeoutMs).toBe(2_500);
    expect(c.killSwitch.autoHaltOnRt).toBe(0.75);
    expect(c.batch.maxSize).toBe(10);
    expect(c.batch.flushIntervalMs).toBe(2_000);
    expect(c.batch.retryMax).toBe(3);
  });

  test('credentialProtection 기본값', () => {
    const c = loadConfig();
    expect(c.credentialProtection.enabled).toBe(true);
    expect(c.credentialProtection.customPatterns).toEqual([]);
  });

  test('frameworkTag 기본값 stable', () => {
    const c = loadConfig();
    expect(c.frameworkTag).toBe('stable');
  });
});

// =============================================================================
// 2. 환경변수 우선
// =============================================================================

describe('환경변수 우선', () => {
  test('PMATRIX_API_KEY > config.apiKey', () => {
    writeConfig({ apiKey: 'from-file' });
    process.env['PMATRIX_API_KEY'] = 'from-env';
    expect(loadConfig().apiKey).toBe('from-env');
  });

  test('PMATRIX_SERVER_URL > config.serverUrl', () => {
    writeConfig({ serverUrl: 'https://file.example' });
    process.env['PMATRIX_SERVER_URL'] = 'https://env.example';
    expect(loadConfig().serverUrl).toBe('https://env.example');
  });

  test('PMATRIX_AGENT_ID > config.agentId', () => {
    writeConfig({ agentId: 'file-agent' });
    process.env['PMATRIX_AGENT_ID'] = 'env-agent';
    expect(loadConfig().agentId).toBe('env-agent');
  });

  test('PMATRIX_DEBUG=1 → debug true', () => {
    process.env['PMATRIX_DEBUG'] = '1';
    expect(loadConfig().debug).toBe(true);
  });

  test('PMATRIX_DEBUG=0 → debug false (env=1만 활성)', () => {
    writeConfig({ debug: false });
    process.env['PMATRIX_DEBUG'] = '0';
    expect(loadConfig().debug).toBe(false);
  });
});

// =============================================================================
// 3. config.json 로드
// =============================================================================

describe('config.json 로드', () => {
  test('전체 설정 로드', () => {
    writeConfig({
      serverUrl: 'https://custom.io',
      agentId: 'custom-agent',
      apiKey: 'custom-key',
      dataSharing: true,
      debug: true,
      frameworkTag: 'beta',
    });
    const c = loadConfig();
    expect(c.serverUrl).toBe('https://custom.io');
    expect(c.agentId).toBe('custom-agent');
    expect(c.apiKey).toBe('custom-key');
    expect(c.dataSharing).toBe(true);
    expect(c.debug).toBe(true);
    expect(c.frameworkTag).toBe('beta');
  });

  test('partial config + DEFAULT 병합 (safetyGate)', () => {
    writeConfig({ safetyGate: { serverTimeoutMs: 5000 } });
    const c = loadConfig();
    expect(c.safetyGate.serverTimeoutMs).toBe(5000);
    expect(c.safetyGate.enabled).toBe(true); // 기본값
  });

  test('partial config + DEFAULT 병합 (batch)', () => {
    writeConfig({ batch: { retryMax: 5 } });
    const c = loadConfig();
    expect(c.batch.retryMax).toBe(5);
    expect(c.batch.maxSize).toBe(10);  // 기본값
    expect(c.batch.flushIntervalMs).toBe(2_000);
  });

  test('agreedAt 보존', () => {
    writeConfig({ agreedAt: '2026-04-27T00:00:00Z' });
    const c = loadConfig();
    expect(c.agreedAt).toBe('2026-04-27T00:00:00Z');
  });
});

// =============================================================================
// 4. ${ENV_VAR} reference
// =============================================================================

describe('${ENV_VAR} reference 해석', () => {
  test('apiKey ${ENV_REF} → process.env 값으로 해석', () => {
    process.env['MY_SECRET_KEY'] = 'resolved-secret';
    writeConfig({ apiKey: '${MY_SECRET_KEY}' });
    expect(loadConfig().apiKey).toBe('resolved-secret');
    delete process.env['MY_SECRET_KEY'];
  });

  test('정의되지 않은 ${UNDEFINED_VAR} → undefined → 기본값', () => {
    writeConfig({ apiKey: '${UNDEFINED_REF}' });
    expect(loadConfig().apiKey).toBe('');  // 기본값
  });

  test('일반 문자열 (${} 패턴 아님) → 그대로', () => {
    writeConfig({ apiKey: 'plain-key' });
    expect(loadConfig().apiKey).toBe('plain-key');
  });
});

// =============================================================================
// 5. 명시적 configPath
// =============================================================================

describe('명시적 configPath', () => {
  test('configPath 인자 → 해당 파일 로드', () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmatrix-custom-'));
    const customPath = path.join(customDir, 'my-config.json');
    fs.writeFileSync(customPath, JSON.stringify({ agentId: 'from-custom-path' }), 'utf-8');

    const c = loadConfig(customPath);
    expect(c.agentId).toBe('from-custom-path');

    fs.rmSync(customDir, { recursive: true, force: true });
  });
});

// =============================================================================
// 6. 잘못된 JSON / 파일 미존재
// =============================================================================

describe('Error handling', () => {
  test('config.json 없음 → 기본값', () => {
    expect(() => loadConfig()).not.toThrow();
    const c = loadConfig();
    expect(c.serverUrl).toBe('https://api.pmatrix.io');
  });

  test('손상된 JSON → 기본값 (silent fail)', () => {
    const dir = path.join(tempHome, '.pmatrix');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), '{not-valid', 'utf-8');

    expect(() => loadConfig()).not.toThrow();
    const c = loadConfig();
    expect(c.agentId).toBe('');  // 기본값
  });
});
