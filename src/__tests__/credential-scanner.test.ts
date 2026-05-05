// =============================================================================
// credential-scanner.test.ts — cursor-monitor credential detection 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. CREDENTIAL_PATTERNS 16종 - 각 패턴 hit
//   2. TEST_EXCLUSIONS - placeholder/test 값 무시
//   3. removeCodeBlocks - inline / triple backtick / tilde block 제거
//   4. customPatterns - 추가 패턴 + invalid pattern 무시
//   5. 빈 / null 입력
// =============================================================================

import { scanCredentials } from '../credential-scanner';

describe('scanCredentials — 16 패턴 hit', () => {
  test('OpenAI Project Key', () => {
    const r = scanCredentials('here is sk-proj-abc123def456ghi789jklmnop my key');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]!.name).toBe('OpenAI Project Key');
    expect(r[0]!.count).toBe(1);
  });

  test('OpenAI Legacy Key', () => {
    const r = scanCredentials('use sk-1234567890ABCDEFGHIJKL for auth');
    expect(r.find(x => x.name === 'OpenAI Legacy Key')).toBeDefined();
  });

  test('Anthropic Key', () => {
    const r = scanCredentials('sk-ant-abcd1234567890abcd1234567890abcd1234567890');
    expect(r.find(x => x.name === 'Anthropic Key')).toBeDefined();
  });

  test('AWS Access Key', () => {
    // EXAMPLE 포함 → 제외 (TEST_EXCLUSIONS)
    const rExcluded = scanCredentials('AKIAIOSFODNN7EXAMPLE is the key');
    expect(rExcluded.find(x => x.name === 'AWS Access Key')).toBeUndefined();
    // 정확 4+16=20 chars 패턴
    const r2 = scanCredentials('AKIAIOSFODNN7ABCDEFG');
    expect(r2.find(x => x.name === 'AWS Access Key')).toBeDefined();
  });

  test('GitHub Token (ghp_)', () => {
    const r = scanCredentials('token=ghp_abcdef1234567890ABCDEF1234567890abcdef');
    expect(r.find(x => x.name === 'GitHub Token')).toBeDefined();
  });

  test('Private Key PEM', () => {
    const r = scanCredentials('-----BEGIN RSA PRIVATE KEY-----\nMII...');
    expect(r.find(x => x.name === 'Private Key (PEM)')).toBeDefined();
  });

  test('Database URL', () => {
    const r = scanCredentials('postgresql://user:secretpass@host/db');
    expect(r.find(x => x.name === 'Database URL')).toBeDefined();
  });

  test('Bearer Token', () => {
    const r = scanCredentials('Authorization: Bearer abc123def456ghi789jklmnop');
    expect(r.find(x => x.name === 'Bearer Token')).toBeDefined();
  });

  test('Google AI Key', () => {
    const r = scanCredentials('AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567');
    expect(r.find(x => x.name === 'Google AI Key')).toBeDefined();
  });

  test('Stripe Secret Key', () => {
    const r = scanCredentials('sk_live_abcdefghij1234567890ABCD');
    expect(r.find(x => x.name === 'Stripe Secret Key')).toBeDefined();
  });

  test('npm Token', () => {
    const r = scanCredentials('npm_ABCDEF1234567890abcdef1234567890ABCDEF');
    expect(r.find(x => x.name === 'npm Token')).toBeDefined();
  });
});

describe('TEST_EXCLUSIONS — placeholder 무시', () => {
  test('sk-test- → 무시', () => {
    const r = scanCredentials('sk-test-1234567890abcdefghij');
    expect(r.find(x => x.name === 'OpenAI Legacy Key')).toBeUndefined();
  });

  test('your-api-key-here → 무시', () => {
    const r = scanCredentials('apiKey: your-api-key-here-1234567890');
    expect(r).toEqual([]);
  });

  test('EXAMPLE → 무시', () => {
    const r = scanCredentials('AKIAIOSFODNN7EXAMPLE');
    expect(r.find(x => x.name === 'AWS Access Key')).toBeUndefined();
  });

  test('placeholder → 무시', () => {
    const r = scanCredentials('sk-proj-placeholder1234567890abcdefghij');
    expect(r).toEqual([]);
  });
});

describe('removeCodeBlocks — 코드 블록 무시', () => {
  test('inline backtick code 무시', () => {
    const r = scanCredentials('use the key `sk-proj-abc123def456ghi789jklmno` here');
    expect(r).toEqual([]);
  });

  test('triple backtick code block 무시', () => {
    const text = 'example:\n```\nsk-proj-abc123def456ghi789jklmno\n```\nend';
    const r = scanCredentials(text);
    expect(r).toEqual([]);
  });

  test('tilde block 무시', () => {
    const text = '~~~\nsk-ant-abcd1234567890abcd1234567890abcd1234567890\n~~~';
    const r = scanCredentials(text);
    expect(r).toEqual([]);
  });

  test('코드 블록 밖의 키는 검출', () => {
    const text = 'real key sk-proj-abc123def456ghi789jklmno1\nexample: `not-a-key`';
    const r = scanCredentials(text);
    expect(r.find(x => x.name === 'OpenAI Project Key')).toBeDefined();
  });
});

describe('customPatterns', () => {
  test('유효한 커스텀 패턴 매치', () => {
    const r = scanCredentials('CUSTOM_TOKEN_xyz123', ['CUSTOM_TOKEN_[a-z0-9]+']);
    expect(r.find(x => x.name === 'Custom Pattern')).toBeDefined();
  });

  test('잘못된 정규식은 스킵 (크래시 없음)', () => {
    expect(() => scanCredentials('test', ['[invalid(regex'])).not.toThrow();
  });

  test('빈 customPatterns 배열', () => {
    expect(() => scanCredentials('hello', [])).not.toThrow();
  });
});

describe('빈 / 안전 입력', () => {
  test('빈 문자열 → 빈 배열', () => {
    expect(scanCredentials('')).toEqual([]);
  });

  test('credential 없는 일반 텍스트 → 빈 배열', () => {
    expect(scanCredentials('hello world, just normal text')).toEqual([]);
  });

  test('동일 패턴 다중 hit → count 누적', () => {
    const r = scanCredentials(
      'first sk-proj-aaaaaaaaaaaaaaaaaaaaa1 then sk-proj-bbbbbbbbbbbbbbbbbbbbb2'
    );
    const found = r.find(x => x.name === 'OpenAI Project Key');
    expect(found).toBeDefined();
    expect(found!.count).toBe(2);
  });
});
