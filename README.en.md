# xiaoli

[![CI](https://github.com/tangjinchun/xiaoli/actions/workflows/ci.yml/badge.svg)](https://github.com/tangjinchun/xiaoli/actions/workflows/ci.yml)

> **Ask first, then execute.** An AI teammate that lives in your terminal.

xiaoli is not a turn-by-turn chat assistant. It reads the project, asks clarifying questions, turns the requirements into an **executable plan**, waits for your confirmation, and then executes it. Ctrl+C saves progress; `xiaoli continue` resumes from the last completed step.

This is a working vertical slice: question → plan → confirm → execute → verify → pause/resume. It is no longer just a design document.

[中文 README](README.md) | [日本語](README.ja.md)

## What works

- **Clarify first**: context-aware questions, with a refinement round when information gaps remain.
- **Executable plan IR**: every step has `tool`, `input`, `riskLevel`, `dependsOn`, and an optional deterministic `verify`.
- **Confirmation gate**: `/confirm` to execute, `/reject` to cancel, `/pause` to stop. High-risk steps require the exact phrase `确认执行`.
- **DAG executor**: dependency-aware order, real retries, fallback/rollback, deterministic verification.
- **Pause/resume**: every step is checkpointed to SQLite. Kill the process and continue later.
- **Unified safety policy**: path confinement, sensitive-file denial, `ALLOW / WARN / ASK / STOP` decisions, audit log.
- **Tests**: 73 unit tests + 10 offline runtime eval tasks (10/10).

## Demo

```bash
npm run demo
```

The demo uses a scripted AI provider, so it needs no API key and no network. It exercises the real orchestration, planning, and execution path.

## Quick start

The npm package is not published yet. Install from source:

```bash
git clone https://github.com/tangjinchun/xiaoli.git
cd xiaoli
npm install
npm run build
npm link

xiaoli config set api.key sk-xxx
xiaoli "fix the slow order query"
```

Requires Node.js >= 18. The API uses DeepSeek through the OpenAI-compatible endpoint.

## Commands

| Command | Purpose |
|---|---|
| `xiaoli "task"` | Start a task: context → questions → plan → confirm → execute |
| `xiaoli status [taskId]` | Show progress, Q&A, plan, and current step |
| `xiaoli continue [taskId]` | Resume a paused/failed/unfinished task |
| `xiaoli config set <key> <value>` | Update config (e.g. `api.key`) |
| `xiaoli config get <key>` | Read config (API key is masked) |
| `xiaoli config list` | List config |
| `xiaoli config path` | Show config file path |

## How it works

```text
CLI
 └─ Orchestrator
     ├─ L1 project context (type, stack, tree, relevant files)
     ├─ L2 question generation (structured JSON)
     ├─ L3 gap-driven refinement (AI + heuristic fallback)
     ├─ Plan generation → Plan IR
     ├─ Plan compiler (tool/input validation, dependencies, risk, verify, topo sort)
     ├─ Confirmation gate
     └─ Executor (DAG + policy + retries + verification + SQLite checkpoint)
```

The plan is an IR, not a natural-language to-do list. The executor only calls tools through the tool registry: `read_file`, `write_file`, `patch_file`, `terminal`, `git`, `ask_user`.

## Safety

Every tool call goes through `src/safety/policy.ts`:

- Paths are confined to the task working directory; sensitive files (`.env`, SSH keys, `.npmrc`, `.git/config`, `.xiaoli`) are denied.
- `rm -rf` outside the workspace, disk formatting, and privilege escalation are hard `STOP`.
- `rm -rf` inside the workspace, `git push --force`, and `git reset --hard` require confirmation.
- `DROP TABLE`, unconditional `DELETE`, and `TRUNCATE` are denied by default.
- Commands are tokenized; `bash -c` / `cmd /c` wrappers are checked recursively.
- Git writes use `execFile` with argument arrays to avoid message/branch injection.
- Audit logs go to `~/.xiaoli/audit.log` with secret redaction.

This is a policy layer, not an OS sandbox. Do not run untrusted tasks without container/VM isolation.

## Offline eval

```bash
npm run eval
```

10 tasks cover the runtime: create/patch files, run commands, reject plans, pause/resume, block dangerous commands, confirm high-risk steps, ask the user mid-execution, retry failures, and multi-round refinement. Current result: **10/10**.

The eval uses a scripted provider to verify runtime behavior, not model quality. A live-model eval is on the roadmap.

## Development

```bash
npm run build
npm test
npm run typecheck
npm run eval
npm run demo
```

CI runs build, typecheck, tests, and eval on Ubuntu + Windows with Node 20/22.

## Limitations / roadmap

- Live DeepSeek eval
- `database` tool
- Cross-platform environment self-healing
- LSP diagnostics
- OS-level sandbox
- `.gitignore`-aware context building
- Streaming and token-cost accounting

Not planned: GUI, mobile app, IDE plugin. The terminal is the only interface.

## License

MIT
