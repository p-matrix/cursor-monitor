// =============================================================================
// @pmatrix/cursor-monitor — hooks/pre-tool-use.ts
// Safety Gate T3: preToolUse pass-through handler
//
// Cursor 제약: preToolUse deny는 실제로 무시됨 — 항상 allow 반환
// 목적: pass-through only (카운터 없음)
//
// ⚠ toolCallCount는 postToolUse(정상 완료 기준)에서 증가 — DEV_PLAN §5
// ⚠ HALT / isHalted 체크 없음 — deny가 Cursor에서 무시되므로 의미 없음
// ⚠ R(t) 조회 없음 — T3는 pure pass-through
// =============================================================================

import { PMatrixConfig } from '../types';
import { CursorPreToolUseInput, CursorPreToolUseOutput } from '../cursor-types';

export async function handlePreToolUse(
  event: CursorPreToolUseInput,
  config: PMatrixConfig
): Promise<CursorPreToolUseOutput> {
  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] preToolUse: tool="${event.tool_name}" (pass-through)\n`
    );
  }

  // 항상 allow (T3 pass-through — deny는 Cursor에서 무시됨)
  return { permission: 'allow' };
}
