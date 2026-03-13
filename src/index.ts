#!/usr/bin/env node
// =============================================================================
// @pmatrix/cursor-monitor — index.ts
// pmatrix-cursor CLI entry point
//
// Sprint 1: session-start, session-end
// Sprint 2: before-shell-execution (Safety Gate T1)
// Sprint 3: before-submit-prompt (Credential Scanner) + before-mcp-execution (T2) + pre-tool-use (T3)
// Sprint 4: post-tool-use + post-tool-use-failure + after-file-edit
//           + after-shell-execution + after-mcp-execution + pre-compact
// Sprint 5: subagent-start + subagent-stop + before-read-file + stop
// Sprint 6: MCP server + Setup CLI
//
// 서브커맨드: session-start | session-end | before-shell-execution
//             before-submit-prompt | before-mcp-execution | pre-tool-use
//             post-tool-use | post-tool-use-failure | after-file-edit
//             after-shell-execution | after-mcp-execution | pre-compact
//             subagent-start | subagent-stop | before-read-file | stop
//             mcp | setup
// stdin:     Cursor hook JSON
// stdout:    Cursor hook response JSON (blocking 훅만 — fail-open)
// =============================================================================

import { loadConfig } from './config';
import { PMatrixHttpClient } from './client';
import {
  CursorSessionStartInput,
  CursorSessionEndInput,
  CursorBeforeShellExecutionInput,
  CursorBeforeSubmitPromptInput,
  CursorBeforeMCPExecutionInput,
  CursorPreToolUseInput,
  CursorPostToolUseInput,
  CursorPostToolUseFailureInput,
  CursorAfterFileEditInput,
  CursorAfterShellExecutionInput,
  CursorAfterMCPExecutionInput,
  CursorPreCompactInput,
  CursorSubagentStartInput,
  CursorSubagentStopInput,
  CursorBeforeReadFileInput,
  CursorStopInput,
} from './cursor-types';
import { handleSessionStart, handleSessionEnd } from './hooks/session';
import { handleBeforeShellExecution } from './hooks/before-shell-execution';
import { handleBeforeSubmitPrompt } from './hooks/before-submit-prompt';
import { handleBeforeMCPExecution } from './hooks/before-mcp-execution';
import { handlePreToolUse } from './hooks/pre-tool-use';
import { handlePostToolUse } from './hooks/post-tool-use';
import { handlePostToolUseFailure } from './hooks/post-tool-use-failure';
import { handleAfterFileEdit } from './hooks/after-file-edit';
import { handleAfterShellExecution } from './hooks/after-shell-execution';
import { handleAfterMCPExecution } from './hooks/after-mcp-execution';
import { handlePreCompact } from './hooks/pre-compact';
import { handleSubagentStart, handleSubagentStop } from './hooks/subagent';
import { handleBeforeReadFile } from './hooks/before-read-file';
import { handleStop } from './hooks/stop';
import { runMcpServer } from './mcp/server';
import { runSetup } from './cli/setup';

async function main(): Promise<void> {
  const subcommand = process.argv[2];

  // Sprint 6 — MCP server + Setup CLI
  if (subcommand === 'mcp') { await runMcpServer(); return; }
  if (subcommand === 'setup') { await runSetup(); process.exit(0); return; }

  const rawInput = await readStdin();
  if (!rawInput.trim()) { process.exit(0); return; }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawInput) as Record<string, unknown>;
  } catch {
    // stdin parse error — fail-open
    process.exit(0); return;
  }

  const config = loadConfig();
  if (!config.agentId || !config.apiKey) {
    // 미설정 상태 — 신호 전송 건너뜀, exit 0
    process.exit(0); return;
  }
  const client = new PMatrixHttpClient(config);

  // 서브커맨드 우선, 없으면 hook_event_name fallback
  const hookName = subcommand ?? (event['hook_event_name'] as string | undefined);

  try {
    switch (hookName) {
      case 'session-start':
      case 'sessionStart':
        await handleSessionStart(event as unknown as CursorSessionStartInput, config, client);
        break;

      case 'session-end':
      case 'sessionEnd':
        await handleSessionEnd(event as unknown as CursorSessionEndInput, config, client);
        break;

      case 'before-shell-execution':
      case 'beforeShellExecution': {
        const output = await handleBeforeShellExecution(
          event as unknown as CursorBeforeShellExecutionInput,
          config,
          client
        );
        process.stdout.write(JSON.stringify(output) + '\n');
        break;
      }

      case 'before-submit-prompt':
      case 'beforeSubmitPrompt': {
        const output = await handleBeforeSubmitPrompt(
          event as unknown as CursorBeforeSubmitPromptInput,
          config,
          client
        );
        process.stdout.write(JSON.stringify(output) + '\n');
        break;
      }

      case 'before-mcp-execution':
      case 'beforeMCPExecution': {
        const output = await handleBeforeMCPExecution(
          event as unknown as CursorBeforeMCPExecutionInput,
          config,
          client
        );
        process.stdout.write(JSON.stringify(output) + '\n');
        break;
      }

      case 'pre-tool-use':
      case 'preToolUse': {
        const output = await handlePreToolUse(
          event as unknown as CursorPreToolUseInput,
          config
        );
        process.stdout.write(JSON.stringify(output) + '\n');
        break;
      }

      // ── Sprint 4: observation-only (stdout 없음) ───────────────────────────

      case 'post-tool-use':
      case 'postToolUse':
        await handlePostToolUse(event as unknown as CursorPostToolUseInput, config, client);
        break;

      case 'post-tool-use-failure':
      case 'postToolUseFailure':
        await handlePostToolUseFailure(event as unknown as CursorPostToolUseFailureInput, config, client);
        break;

      case 'after-file-edit':
      case 'afterFileEdit':
        await handleAfterFileEdit(event as unknown as CursorAfterFileEditInput, config, client);
        break;

      case 'after-shell-execution':
      case 'afterShellExecution':
        await handleAfterShellExecution(event as unknown as CursorAfterShellExecutionInput, config, client);
        break;

      case 'after-mcp-execution':
      case 'afterMCPExecution':
        await handleAfterMCPExecution(event as unknown as CursorAfterMCPExecutionInput, config, client);
        break;

      case 'pre-compact':
      case 'preCompact':
        await handlePreCompact(event as unknown as CursorPreCompactInput, config, client);
        break;

      // ── Sprint 5: META_CONTROL + stop (stdout 필수) ────────────────────────

      case 'subagent-start':
      case 'subagentStart': {
        const output = await handleSubagentStart(event as unknown as CursorSubagentStartInput, config, client);
        process.stdout.write(JSON.stringify(output) + '\n');
        break;
      }

      case 'subagent-stop':
      case 'subagentStop': {
        const output = await handleSubagentStop(event as unknown as CursorSubagentStopInput, config, client);
        process.stdout.write(JSON.stringify(output) + '\n');
        break;
      }

      case 'before-read-file':
      case 'beforeReadFile': {
        const output = await handleBeforeReadFile(event as unknown as CursorBeforeReadFileInput, config, client);
        process.stdout.write(JSON.stringify(output) + '\n');
        break;
      }

      case 'stop': {
        const output = await handleStop(event as unknown as CursorStopInput, config, client);
        process.stdout.write(JSON.stringify(output) + '\n');
        break;
      }

      default:
        // 미구현 훅 — fail-open, 아무것도 하지 않음
        break;
    }
    process.exit(0);
  } catch {
    // 모든 예외 — fail-open
    process.exit(0);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

main().catch(() => process.exit(0));
