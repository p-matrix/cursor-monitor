# Changelog

All notable changes to `@pmatrix/cursor-monitor` will be documented in this file.

---

## [0.6.0] — 2026-04-27

### Added (Cross-cutting client 보강 — server Production Polish 정합)

- **Cross-cutting A — Error correlation logging**: HTTP 5xx 응답 body 의 error_id 추출 → stderr 안내 메시지. server Production Polish A error UX 정합.
- **Cross-cutting B — X-Request-ID 헤더**: outgoing request 마다 crypto.randomUUID() 송출 + response echo 수신. server middleware (commit 533781f) 정합.
- **Cross-cutting C — Burst 429 handling**: Retry-After + escalating backoff (BURST_RETRY_DELAYS). server burst_rate_limit middleware 정합.

### Tests

- 신규 10 test files (`src/__tests__/`): safety-gate, state-store, credential-scanner, breach-support, client (cross-cutting 검증 포함), config, formatter, pre-tool-use, post-tool-use, session.

---

## [0.5.0] — 2026-04-27

### Changed (BREAKING — Mode literal rename)

- **Phase R-5 Mode naming Gen1 → Gen2 names** (server-side parity per Spec §❷):
  `'A+1'` → `'normal'` / `'A+0'` → `'caution'` / `'A-1'` → `'alert'` /
  `'A-2'` → `'critical'` / `'A-0'` → `'halt'`
- **Affected APIs**: `SafetyMode` union type (`src/types.ts`), `rtToMode()`
  return values + Safety Gate matrix mode comparisons (`src/safety-gate.ts`),
  state-store mode field defaults, MCP `status` tool output
- **Migration**: consumers must update mode string comparisons
  (`mode === 'A-0'` → `mode === 'halt'` 등). Server protocol output 도
  Gen2 names 로 통합 (Backend Spec v1.53)

### Fixed (Phase R-6 SDK build hygiene)

- **breach-support.ts**: `getApprovalStatus()` 의 `noUncheckedIndexedAccess`
  TypeScript narrowing 부재 → `Object is possibly 'undefined'` 3건 fix
  (explicit local const + null check pattern)
- **field-node-runtime dependency**: `node_modules/@pmatrix/field-node-runtime`
  symlink 정합 (`npm install` 로 npm registry 0.2.0 정상 fetch)

---

## [0.4.0] — 2026-03-15

### Added

- **4.0 Field Integration** — FieldNode + IPC poller + degraded SV (neutral 0.5 axes)
- `pmatrix_field_status` MCP tool (connected, peerCount, myPosture, fieldId)
- SIGTERM/SIGINT graceful shutdown (FieldNode.stop)

### Changed

- `@pmatrix/field-node-runtime@^0.2.0` 의존성 추가

## [0.3.1] — 2026-03-13 — Documentation fix

### Fixed

- **README**: Safety Gate instant block rules corrected to match actual implementation
  - `sudo` → `sudo rm` / `sudo mkfs` / `sudo dd` (only destructive sudo commands are instant-blocked)
  - Added `base64 --decode ... | sh` obfuscated RCE pattern
  - Added `chmod 777 /` with correct META_CONTROL delta (-0.15)
  - Plain `sudo <cmd>` is HIGH-risk (blocked at R(t) ≥ 0.15), not an instant block

---

## [0.3.0] — 2026-03-12 — Initial GA Release

### Added

- **16 Cursor hook handlers** (Sprint 1–6)
  - `sessionStart` / `sessionEnd` — session lifecycle, state file creation
  - `beforeShellExecution` — Safety Gate T1: shell command analysis + deny (production-verified)
  - `beforeMCPExecution` — Safety Gate T2: MCP tool gate (best-effort)
  - `preToolUse` — Safety Gate T3: code implemented (pending upstream support)
  - `beforeSubmitPrompt` — Credential scan: 16 pattern types, blocks before submission
  - `postToolUse` — tool completion observation (NORM axis)
  - `postToolUseFailure` — failure pattern → STABILITY nudge (+0.05)
  - `afterFileEdit` — file change volume → STABILITY nudge (+0.02–0.05)
  - `afterShellExecution` — shell result observation (metadata only)
  - `afterMCPExecution` — MCP result observation (metadata only)
  - `preCompact` — context compression frequency → STABILITY nudge (+0.03)
  - `subagentStart` — spawn tracking → STABILITY nudge (+0.03)
  - `subagentStop` — subagent completion observation
  - `beforeReadFile` — read observation
  - `stop` — Grade report via `followup_message` (status=completed only)

- **MCP server** (`pmatrix-cursor mcp`)
  - `pmatrix_status` — show Grade / R(t) / Mode / session counters
  - `pmatrix_grade` — show Trust Grade + P-score + history
  - `pmatrix_halt` — global Kill Switch (creates `~/.pmatrix/HALT`)

- **Setup CLI** (`pmatrix-cursor setup`)
  - Auto-installs `~/.cursor/hooks.json` (version: 1, 16 hooks, camelCase keys)
  - Auto-installs `~/.cursor/mcp.json` (pmatrix MCP server entry)
  - Idempotent — safe to run multiple times
  - `--agent-id` / `--api-key` flags write to `~/.pmatrix/config.json`

- **Kill Switch**
  - `~/.pmatrix/HALT` file — blocks all tool execution when present
  - Auto-HALT when R(t) ≥ `killSwitch.autoHaltOnRt` (default: 0.75)
  - Manual trigger via `pmatrix_halt` MCP tool

- **Privacy-first design (§5.4)**
  - Shell command text, file paths, file contents, MCP results, and prompt text are never transmitted
  - Only metadata (lengths, counts, durations, types) is sent to the server

### Known Limitations

- Some deny-capable hooks depend on upstream platform support for full enforcement
- Windows project-level hooks: not supported (global-only for this release)
