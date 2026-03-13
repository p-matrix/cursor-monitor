# @pmatrix/cursor-monitor

Runtime safety governance for Cursor — **20-hook observability + shell-level enforcement.**

Analyzes shell commands before execution, detects credential leaks in prompts, and continuously measures agent risk with live Trust Grade (A–E).

> Requires a P-MATRIX account and API key.

---

## What it does

### Core Protection

- **Safety Gate T1** (`beforeShellExecution`) — Shell command analysis before execution.
  Blocks based on current risk level R(t) and instant-block rules (rm -rf, curl|sh, sudo).
  The only production-verified enforcement path in Cursor 2.6.18.
- **Safety Gate T2** (`beforeMCPExecution`) — MCP tool gate (best-effort, unverified in Cursor 2.6.18).
- **Safety Gate T3** (`preToolUse`) — Code implemented; deny currently broken in Cursor (auto-activates when Cursor fixes the bug).
- **Credential Protection** (`beforeSubmitPrompt`) — Detects and blocks 11 types of API keys and secrets before they reach the agent.
- **Kill Switch** — Automatically halts when R(t) ≥ 0.75. Manually via `pmatrix_halt` MCP tool. Creates `~/.pmatrix/HALT` to block all sessions.

### Behavioral Intelligence

- **20 Cursor hooks → 4-axis signal mapping** (BASELINE / NORM / STABILITY / META_CONTROL)
- **Grade report** (`stop.followup_message`) — Automatic session summary with Trust Grade, R(t), and block count
- **Subagent tracking** — spawn count, task duration, modified files count
- **File edit patterns** — edit count and volume as STABILITY signal
- **Context compression tracking** — `preCompact` as session complexity indicator

---

## Requirements

| Requirement | Version |
|-------------|---------|
| Node.js | >= 18 |
| Cursor | 2.6.18+ |
| P-MATRIX server | v1.0.0+ |

---

## Installation

```bash
npm install -g @pmatrix/cursor-monitor

# Get your API key at app.pmatrix.io → Settings → API Keys
pmatrix-cursor setup --api-key <YOUR_API_KEY>
```

Restart Cursor to activate monitoring.

---

## Privacy

**Content-Agnostic:** P-MATRIX never collects, parses, or stores your prompts, file contents, shell output, or MCP results.

When data sharing is enabled, only numerical metadata is transmitted — lengths, counts, types, and axis deltas. Your agent's content stays local.

- `beforeShellExecution` — sends `command_length` only (never command text)
- `beforeSubmitPrompt` — credential scanning runs locally; only detection counts are sent (never prompt content)
- `afterFileEdit` — sends `edit_count` only (never file path or diff content)
- `afterShellExecution` — sends `command_length + duration` only (never output)
- Subagent hooks — sends `task_length + spawn_count` only (never task content)

Pattern-based instant blocks (sudo, rm -rf, curl|sh) and credential scanning run entirely on-device with no network dependency.

---

## Advanced Configuration

Edit `~/.pmatrix/config.json` (created by the setup command):

```json
{
  "serverUrl": "https://api.pmatrix.io",
  "agentId": "cur_YOUR_AGENT_ID",
  "apiKey": "pm_live_xxxxxxxxxxxx",

  "safetyGate": {
    "enabled": true,
    "serverTimeoutMs": 2500,
    "customToolRisk": {}
  },

  "credentialProtection": {
    "enabled": true,
    "customPatterns": []
  },

  "killSwitch": {
    "autoHaltOnRt": 0.75
  },

  "dataSharing": false,

  "debug": false
}
```

Or set your API key as an environment variable:

```bash
export PMATRIX_API_KEY=pm_live_xxxxxxxxxxxx
```

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `pmatrix_status` | Show current Grade, R(t), mode, and session counters |
| `pmatrix_grade` | Show behavioral grade and recent history |
| `pmatrix_halt` | Manually trigger Kill Switch (creates `~/.pmatrix/HALT`) |

> To resume from halt: `rm ~/.pmatrix/HALT`

---

## Safety Gate

The T1 Safety Gate (`beforeShellExecution`) analyzes shell commands before execution:

| Risk Level | Mode | HIGH-risk | MEDIUM-risk | LOW-risk |
|-----------|------|-----------|-------------|----------|
| < 0.15 | Normal | Allow | Allow | Allow |
| 0.15–0.30 | Caution | **Block** | Allow | Allow |
| 0.30–0.50 | Alert | **Block** | Allow | Allow |
| 0.50–0.75 | Critical | **Block** | **Block** | Allow |
| >= 0.75 | Halt | **Block** | **Block** | **Block** |

**Instant block rules** (regardless of R(t)):
- `sudo rm` / `sudo mkfs` / `sudo dd` — privilege escalation + destructive (META_CONTROL -0.25)
- `chmod 777 /` — dangerous permission change (META_CONTROL -0.15)
- `rm -rf <non-tmp path>` — destructive deletion (META_CONTROL -0.30)
- `curl ... | sh` — remote code execution (META_CONTROL -0.20)
- `base64 --decode ... | sh` — obfuscated RCE (META_CONTROL -0.25)

> Note: Instant block rules are enforced independently of `safetyGate.enabled`.

---

## Known Limitations (Cursor 2.6.18)

| Issue | Cause | Status |
|-------|-------|--------|
| `preToolUse` deny ignored | Cursor bug | Code implemented — activates when Cursor fixes |
| `subagentStart` deny ignored | Same cause | Same |
| `beforeReadFile` deny ignored | Cursor bug | Observation only |
| `beforeShellExecution` allow-list bypass | Cursor bug | Awaiting Cursor fix |

---

## Credential Protection

Detects and blocks 11 credential types before submission:

- OpenAI API keys (`sk-proj-...`)
- Anthropic API keys (`sk-ant-...`)
- AWS Access Keys (`AKIA...`)
- GitHub tokens (`ghp_...`, `github_pat_...`)
- Private keys (`-----BEGIN PRIVATE KEY-----`)
- Database URLs (`postgresql://user:pass@...`)
- Passwords (`password: "..."`)
- Bearer tokens
- Google AI keys (`AIza...`)
- Stripe keys (`sk_live_...`, `sk_test_...`)

Code blocks in messages are excluded from scanning to prevent false positives.

---

## R(t) Formula

```
R(t) = 1 - (BASELINE + NORM + STABILITY + META_CONTROL) / 4
```

| Axis | Meaning |
|------|---------|
| BASELINE | Initial config integrity — higher = safer |
| NORM | Behavioral normalcy — higher = safer |
| STABILITY | Trajectory stability — lower = more drift |
| META_CONTROL | Self-control capacity — higher = safer |

P-Score = `round(100 * (1 - R(t)), 2)`
Trust Grade: A (≥80) · B (≥60) · C (≥40) · D (≥20) · E (<20)

---

## Server-side Setup

The monitor sends signals to `POST /v1/inspect/stream` on your P-MATRIX server.

Production server: `https://api.pmatrix.io`

Dashboard: `https://app.pmatrix.io`

- **Story tab** — R(t) trajectory timeline, mode transitions, tool block events
- **Analytics tab** — Grade history, stability trends
- **Logs tab** — Live session events, audit trail, META_CONTROL incidents

---

## Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `serverUrl` | string | — | P-MATRIX server URL |
| `agentId` | string | — | Agent ID from P-MATRIX dashboard |
| `apiKey` | string | — | API key (`pm_live_...`). Use env var. |
| `safetyGate.enabled` | boolean | `true` | Enable Safety Gate |
| `safetyGate.serverTimeoutMs` | number | `2500` | Server query timeout (fail-open) |
| `safetyGate.customToolRisk` | object | `{}` | Override tool risk tier |
| `credentialProtection.enabled` | boolean | `true` | Enable credential scanning |
| `credentialProtection.customPatterns` | string[] | `[]` | Additional regex patterns |
| `killSwitch.autoHaltOnRt` | number | `0.75` | Auto-halt R(t) threshold |
| `dataSharing` | boolean | `false` | Send safety signals to P-MATRIX server (opt-in) |
| `debug` | boolean | `false` | Verbose logging |

---

## Offline / Server-Down Behavior

- **No cache (initial)**: R(t) = 0.0 (fail-open, no blocking before first connection)
- **Cache exists + server down**: Last known R(t) is kept — Safety Gate continues using it
- **Server timeout (> 2,500 ms)**: Fail-open — shell command is allowed
- **`~/.pmatrix/HALT` exists**: All shell commands blocked regardless of server state

Credential scanning and instant block rules always work offline — they have no server dependency.

---

## License

Apache-2.0 © 2026 P-MATRIX
