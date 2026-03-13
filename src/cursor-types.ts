// =============================================================================
// @pmatrix/cursor-monitor — cursor-types.ts
// Cursor hooks.json 공식 스키마 기반 타입 정의
//
// Sources:
//   - PMATRIX_CURSOR_MONITOR_RESEARCH_v1_2.md §1-2, §1-3
//   - PMATRIX_CURSOR_MONITOR_DEV_PLAN_v1_1.md §3
//
// Sprint 1: sessionStart, sessionEnd (2종)
// Sprint 2~5: 나머지 훅 타입을 이 파일에 계속 추가
// =============================================================================

// ─── Cursor Hook 공통 stdin base ─────────────────────────────────────────────

export interface CursorHookBase {
  conversation_id: string;
  generation_id: string;
  model: string;
  hook_event_name: string;
  cursor_version: string;
  workspace_roots: string[];
  user_email: string | null;
  transcript_path: string | null;
}

// ─── sessionStart ─────────────────────────────────────────────────────────────

export interface CursorSessionStartInput extends CursorHookBase {
  hook_event_name: 'sessionStart';
  session_id: string;
  is_background_agent: boolean;
  composer_mode?: string;
}

export interface CursorSessionStartOutput {
  env?: Record<string, string>;
  additional_context?: string;
}

// ─── sessionEnd ───────────────────────────────────────────────────────────────

export interface CursorSessionEndInput extends CursorHookBase {
  hook_event_name: 'sessionEnd';
  session_id: string;
  reason: 'completed' | 'aborted' | 'error' | 'window_close' | 'user_close';
  duration_ms: number;
  is_background_agent: boolean;
  final_status: string;
  error_message?: string;
}

// ─── beforeShellExecution ─────────────────────────────────────────────────────

export interface CursorBeforeShellExecutionInput extends CursorHookBase {
  hook_event_name: 'beforeShellExecution';
  command: string;    // 실제 셸 명령 원문 — Safety Gate T1 핵심
  cwd: string;
  sandbox: boolean;
}

export interface CursorShellHookOutput {
  continue: true;
  permission: 'allow' | 'deny' | 'ask';
  userMessage?: string;
  agentMessage?: string;
}

// ─── beforeSubmitPrompt ───────────────────────────────────────────────────────

export interface CursorBeforeSubmitPromptInput extends CursorHookBase {
  hook_event_name: 'beforeSubmitPrompt';
  prompt: string;           // 사용자가 제출하려는 프롬프트 원문 (Research §1-3 공식 스키마)
  attachments: unknown[];   // 첨부 파일 목록
}

export interface CursorBeforeSubmitPromptOutput {
  continue: boolean;        // false = 제출 차단 (이 훅에서만 허용)
  user_message?: string;    // 차단 시 사용자에게 보여줄 메시지 (snake_case)
}

// ─── beforeMCPExecution ───────────────────────────────────────────────────────

export interface CursorBeforeMCPExecutionInput extends CursorHookBase {
  hook_event_name: 'beforeMCPExecution';
  tool_name: string;        // MCP 도구 이름
  server_name: string;      // MCP 서버 이름
  tool_input: unknown;      // MCP 도구 입력 파라미터
}

// stdout: CursorShellHookOutput 재사용 (continue: true 고정, permission: allow|deny)

// ─── preToolUse ───────────────────────────────────────────────────────────────

export interface CursorPreToolUseInput extends CursorHookBase {
  hook_event_name: 'preToolUse';
  tool_name: string;        // Cursor 내장 도구 이름
  tool_input: unknown;      // 도구 입력 파라미터
}

export interface CursorPreToolUseOutput {
  permission: 'allow' | 'deny';   // deny는 Cursor에서 무시됨 (T3 pass-through)
}

// ─── postToolUse ──────────────────────────────────────────────────────────────

export interface CursorPostToolUseInput extends CursorHookBase {
  hook_event_name: 'postToolUse';
  tool_name: string;
  tool_use_id: string;
  tool_input: unknown;   // privacy-first: 미사용
  cwd: string;
  tool_output: unknown;  // privacy-first: 미사용
  duration: number;      // ms
}

// ─── postToolUseFailure ───────────────────────────────────────────────────────

export interface CursorPostToolUseFailureInput extends CursorHookBase {
  hook_event_name: 'postToolUseFailure';
  tool_name: string;
  tool_input: unknown;   // privacy-first: 미사용
  tool_use_id: string;
  cwd: string;
  error_message: string;
  failure_type: 'error' | 'timeout' | 'permission_denied';
  duration: number;
  is_interrupt: boolean;
}

// ─── afterFileEdit ────────────────────────────────────────────────────────────

export interface CursorAfterFileEditInput extends CursorHookBase {
  hook_event_name: 'afterFileEdit';
  file_path: string;
  edits: { old_string: string; new_string: string }[];
}

// ─── afterShellExecution ──────────────────────────────────────────────────────

export interface CursorAfterShellExecutionInput extends CursorHookBase {
  hook_event_name: 'afterShellExecution';
  command: string;    // privacy-first: 미전송
  output: string;     // privacy-first: 미전송
  duration: number;
  sandbox: boolean;
}

// ─── afterMCPExecution ────────────────────────────────────────────────────────

export interface CursorAfterMCPExecutionInput extends CursorHookBase {
  hook_event_name: 'afterMCPExecution';
  tool_name: string;
  result_json: unknown;  // privacy-first: 미전송
  duration: number;
}

// ─── preCompact ───────────────────────────────────────────────────────────────

export interface CursorPreCompactInput extends CursorHookBase {
  hook_event_name: 'preCompact';
  trigger: 'auto' | 'manual';
  context_usage_percent: number;  // 0–100
  context_tokens: number;
  context_window_size: number;
  message_count: number;
  messages_to_compact: number;
}

// ─── subagentStart ────────────────────────────────────────────────────────────

export interface CursorSubagentStartInput extends CursorHookBase {
  hook_event_name: 'subagentStart';
  subagent_id: string;
  subagent_type: string;
  task: string;              // privacy-first: 원문 미전송, task.length만 사용
  parent_conversation_id: string;
  tool_call_id: string;
  subagent_model: string;
  is_parallel_worker: boolean;
  git_branch?: string;
}

export interface CursorSubagentStartOutput {
  permission: 'allow' | 'deny';  // 항상 allow (broken — 코드 구현만)
  user_message?: string;
}

// ─── subagentStop ─────────────────────────────────────────────────────────────

export interface CursorSubagentStopInput extends CursorHookBase {
  hook_event_name: 'subagentStop';
  subagent_type: string;
  status: 'completed' | 'error' | 'aborted';
  task: string;                    // privacy-first: 미사용
  description: string;             // privacy-first: 미사용
  summary: string;                 // privacy-first: 미사용
  duration_ms: number;
  message_count: number;
  tool_call_count: number;
  loop_count: number;
  modified_files: string[];
  agent_transcript_path: string | null;
}

// stdout: {} (followup_message 없음 — Sprint 5)

// ─── beforeReadFile ───────────────────────────────────────────────────────────

export interface CursorBeforeReadFileInput extends CursorHookBase {
  hook_event_name: 'beforeReadFile';
  file_path: string;    // privacy-first: 원문 미전송, file_path.length만
  content?: string;     // privacy-first: 절대 미사용
}

// stdout: CursorShellHookOutput 재사용 (항상 allow)

// ─── stop ─────────────────────────────────────────────────────────────────────

export interface CursorStopInput extends CursorHookBase {
  hook_event_name: 'stop';
  status: 'completed' | 'aborted' | 'error';
  loop_count: number;
}

export interface CursorStopOutput {
  followup_message?: string;  // status='completed' 시에만 반환
}
