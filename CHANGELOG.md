# Changelog

All notable changes to `@pmatrix/cursor-monitor` will be documented in this file.

---

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
