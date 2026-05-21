// =============================================================================
// @pmatrix/cursor-monitor — types.ts
// R-X.3 migration: shared types re-exported from @pmatrix/core-sdk.
// Cursor-narrowed SignalPayload preserves 'cursor_hook' / 'cursor' literals.
//
// signal_source: 'cursor_hook', framework: 'cursor'
// host_surface: 'ide' (Cursor IDE extension, not CLI)
//
// Sources:
//   - PMATRIX_CURSOR_MONITOR_RESEARCH_v1_2.md §1-2
//   - PMATRIX_CURSOR_MONITOR_DEV_PLAN_v1_1.md §6
//   - @pmatrix/core-sdk v0.1.0+ (shared substance)
// =============================================================================

// ─── Re-export shared types from @pmatrix/core-sdk ─────────────────────────

export type {
  SafetyMode,
  TrustGrade,
  ToolRiskTier,
  GateAction,
  AxesState,
  SignalMetadata,
  BatchSendResponse,
  GradeResponse,
  AgentGradeDetail,
  AgentGradeHistoryItem,
  HealthCheckResult,
  SafetyGateConfig,
  CredentialProtectionConfig,
  KillSwitchConfig,
  BatchConfig,
  PMatrixConfig,
} from '@pmatrix/core-sdk';

import type { SignalPayload as CoreSignalPayload } from '@pmatrix/core-sdk';

// ─── Cursor-narrowed SignalPayload ─────────────────────────────────────────
//
// Cursor is the only IDE adapter in our 6 SDK (others are CLI). Narrowed type
// is structurally a subtype of core's generic — PMatrixHttpClient accepts.
//
// Server-side framework enum: claude_code | openclaw | cursor | gemini | codex | hermes

export interface SignalPayload extends Omit<CoreSignalPayload, 'signal_source' | 'framework'> {
  signal_source: 'cursor_hook';
  framework: 'cursor';
}
