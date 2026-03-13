// =============================================================================
// @pmatrix/cursor-monitor — safety-gate.ts
// Safety Gate pure logic — Shell command risk classification + gate matrix
//
// 기반: @pmatrix/claude-code-monitor safety-gate.ts
// 변경:
//   - HIGH_RISK_TOOLS / MEDIUM_RISK_TOOLS → 셸 명령 위험 분류 패턴으로 교체
//   - classifyToolRisk() 제거 → classifyShellCommandRisk() 신규 추가
//   - checkMetaControlRules() — command 원문 직접 분석으로 변경 (Cursor 핵심 우위)
//   - META_CONTROL_RULES — rm-rf/sudo/curl|sh + base64 decode RCE 패턴 추가
//   - evaluateSafetyGate(), rtToMode(), GateResult — 변경 없음 (100% 재사용)
//
// Shell unknown → LOW (빌드 명령 노이즈 방지)
// Tool unknown  → MEDIUM (기존 claude-code-monitor의 보수적 기본값 유지)
// =============================================================================

import { ToolRiskTier, GateAction, SafetyMode } from './types';

// ─── MCP / Built-in Tool Risk classification ──────────────────────────────────
// classifyToolRisk: MCP 도구 및 Cursor 내장 도구 위험 분류
// claude-code-monitor safety-gate.ts에서 100% 복사 (unknown → MEDIUM 보수적 기본값 유지)

const HIGH_RISK_TOOLS = new Set([
  'exec',
  'bash',
  'shell',
  'run',
  'apply_patch',
  'browser',
  'computer',
  'terminal',
  'code_interpreter',
  'write',         // Cursor: Write tool (file creation)
  'edit',          // Cursor: Edit tool (file modification)
  'multiedit',     // Cursor: MultiEdit
]);

const MEDIUM_RISK_TOOLS = new Set([
  'web_fetch',
  'http_request',
  'fetch',
  'request',
  'curl',
  'wget',
  'webfetch',      // Cursor: WebFetch tool
  'websearch',     // Cursor: WebSearch tool
  'task',          // Cursor: Task (subagent spawning)
]);

const LOW_TOOL_PREFIXES = [
  'pmatrix_',
  'file_read',
  'list_files',
  'search',
  'read',
  'glob',
  'grep',
  'ls',
  'find',
  'cat',
  'head',
  'tail',
  'todoread',
  'todowrite',
];

export function classifyToolRisk(
  toolName: string,
  customToolRisk?: Record<string, ToolRiskTier>
): ToolRiskTier {
  if (customToolRisk) {
    const custom = customToolRisk[toolName];
    if (custom) return custom;
  }

  const lower = toolName.toLowerCase();

  if (HIGH_RISK_TOOLS.has(lower)) return 'HIGH';
  if (MEDIUM_RISK_TOOLS.has(lower)) return 'MEDIUM';

  if (LOW_TOOL_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return 'LOW';
  }

  return 'MEDIUM';  // conservative default (MCP: unknown → MEDIUM)
}

// ─── R(t) → Mode boundaries (Server constants.py, §14-4) ─────────────────────

export const MODE_BOUNDARIES: Readonly<Record<SafetyMode, readonly [number, number]>> = {
  'A+1': [0.00, 0.15],  // Normal
  'A+0': [0.15, 0.30],  // Caution
  'A-1': [0.30, 0.50],  // Alert
  'A-2': [0.50, 0.75],  // Critical
  'A-0': [0.75, 1.00],  // Halt
} as const;

export function rtToMode(rt: number): SafetyMode {
  if (rt < 0.15) return 'A+1';
  if (rt < 0.30) return 'A+0';
  if (rt < 0.50) return 'A-1';
  if (rt < 0.75) return 'A-2';
  return 'A-0';
}

// ─── Shell Command Risk classification ────────────────────────────────────────

const HIGH_RISK_SHELL_PATTERNS: readonly RegExp[] = [
  /rm\s+-rf/i,
  /sudo\s+rm/i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
  />>\s*\/etc\/passwd/i,
  /(?:curl|wget)\s+[^\|]+\|\s*(?:ba)?sh\b/i,         // curl|sh, wget|bash
  /base64\s+.*--decode.*\|\s*(?:ba)?sh\b/i,            // base64 decode | sh
  /base64\s+-d\s+.*\|\s*(?:ba)?sh\b/i,
] as const;

const MEDIUM_RISK_SHELL_PATTERNS: readonly RegExp[] = [
  /\bsudo\b/i,
  /chmod\s+[0-7]*7[0-7]{2}/i,   // chmod 777, chmod 775 등
  /chown\s+root/i,
  /\bsystemctl\b/i,
  /kill\s+-9/i,
  /\biptables\b/i,
  /\bcrontab\b/i,
] as const;

export function classifyShellCommandRisk(
  command: string,
  customShellRisk?: Record<string, ToolRiskTier>
): ToolRiskTier {
  // 커스텀 오버라이드 (prefix 매칭)
  if (customShellRisk) {
    for (const [prefix, tier] of Object.entries(customShellRisk)) {
      if (command.toLowerCase().startsWith(prefix.toLowerCase())) return tier;
    }
  }

  // pmatrix-cursor 자가 명령 — LOW (재귀 방지)
  if (command.trimStart().startsWith('pmatrix-cursor')) return 'LOW';

  if (HIGH_RISK_SHELL_PATTERNS.some(p => p.test(command))) return 'HIGH';
  if (MEDIUM_RISK_SHELL_PATTERNS.some(p => p.test(command))) return 'MEDIUM';

  return 'LOW';   // 일반 명령은 LOW (git, npm, pip 등) — claude-code-monitor와 달리 보수적 기본값 사용 안 함
}

// ─── Safety Gate matrix (§3-1) ────────────────────────────────────────────────

export interface GateResult {
  action: GateAction;
  reason: string;
}

/**
 * Safety Gate 판정 매트릭스 (§3-1)
 *
 * | R(t)       | Mode     | HIGH    | MEDIUM  | LOW   |
 * |------------|----------|---------|---------|-------|
 * | < 0.15     | Normal   | ALLOW   | ALLOW   | ALLOW |
 * | 0.15~0.30  | Caution  | BLOCK   | ALLOW   | ALLOW |
 * | 0.30~0.50  | Alert    | BLOCK   | ALLOW   | ALLOW |
 * | 0.50~0.75  | Critical | BLOCK   | BLOCK   | ALLOW |
 * | ≥ 0.75     | Halt     | BLOCK   | BLOCK   | BLOCK |
 */
export function evaluateSafetyGate(
  rt: number,
  toolRisk: ToolRiskTier
): GateResult {
  const mode = rtToMode(rt);
  const rtStr = rt.toFixed(2);

  if (mode === 'A-0') {
    return {
      action: 'BLOCK',
      reason: `HALT: R(t) ${rtStr} ≥ 0.75 — all commands blocked`,
    };
  }

  if (mode === 'A-2') {
    if (toolRisk === 'HIGH' || toolRisk === 'MEDIUM') {
      return {
        action: 'BLOCK',
        reason: `Critical zone R(t) ${rtStr} — ${toolRisk.toLowerCase()}-risk command blocked`,
      };
    }
    return { action: 'ALLOW', reason: '' };
  }

  if (mode === 'A-1' || mode === 'A+0') {
    if (toolRisk === 'HIGH') {
      return {
        action: 'BLOCK',
        reason: `Elevated R(t) ${rtStr} — high-risk command blocked`,
      };
    }
    return { action: 'ALLOW', reason: '' };
  }

  return { action: 'ALLOW', reason: '' };
}

// ─── meta_control special rules (§3-1) ───────────────────────────────────────
// Cursor 핵심 우위: command 원문 직접 분석 (claude-code-monitor는 tool_name만 가능)

export interface MetaControlBlockResult {
  reason: string;
  metaControlDelta: number;
}

interface MetaControlRule {
  pattern: RegExp;
  reason: string;
  metaControlDelta: number;
}

const META_CONTROL_RULES: readonly MetaControlRule[] = [
  {
    pattern: /rm\s+-rf\s+(\/(?!tmp|var\/tmp)[^\s]*|~)/i,
    reason: 'Destructive deletion detected (rm -rf)',
    metaControlDelta: -0.30,
  },
  {
    pattern: /\bsudo\b.*rm|sudo\s+mkfs|sudo\s+dd/i,
    reason: 'Privilege escalation + destructive command',
    metaControlDelta: -0.25,
  },
  {
    pattern: /(?:curl|wget)\s+[^\|]+\|\s*(?:ba)?sh\b/i,
    reason: 'Remote code execution pattern (curl/wget | sh)',
    metaControlDelta: -0.20,
  },
  {
    pattern: /base64\s+(?:--decode|-d)\s+.*\|\s*(?:ba)?sh\b/i,
    reason: 'Obfuscated RCE pattern (base64 decode | sh)',
    metaControlDelta: -0.25,
  },
  {
    pattern: /chmod\s+777\s+\//i,
    reason: 'Dangerous permission change (chmod 777 /)',
    metaControlDelta: -0.15,
  },
] as const;

/**
 * checkMetaControlRules — command 원문 직접 분석
 *
 * claude-code-monitor와의 차이:
 *   - claude-code-monitor: checkMetaControlRules(toolName, params) — params=null (privacy-first)
 *   - cursor-monitor:      checkMetaControlRules(command, null)    — command 원문 직접 분석
 *
 * command 파라미터에 셸 명령 원문을 그대로 전달.
 * 두 번째 파라미터(params)는 호환성 유지를 위해 보존하되 cursor에서는 사용하지 않음.
 */
export function checkMetaControlRules(
  command: string,
  _params: unknown
): MetaControlBlockResult | null {
  for (const rule of META_CONTROL_RULES) {
    if (rule.pattern.test(command)) {
      return {
        reason: rule.reason,
        metaControlDelta: rule.metaControlDelta,
      };
    }
  }
  return null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function serializeParams(params: unknown): string {
  if (params == null) return '';
  if (typeof params === 'string') return params;
  try {
    return JSON.stringify(params);
  } catch {
    return String(params);
  }
}
