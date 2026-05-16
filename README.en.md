# xiaoli (Xiao Li)

> An AI colleague living in your terminal. You assign tasks, answer follow-up questions, and it gets the work done.

[中文](README.md) | [日本語](README.ja.md)

## Overview

xiaoli is an npm global CLI tool that acts as your AI colleague in the terminal. Unlike traditional AI assistants, xiaoli **asks all questions first, then executes** — it won't touch a single line of code until all ambiguities are resolved.

**Core philosophy: Not a "time management" tool — a "time expansion" tool. Not an assistant — a colleague.**

## Features

- **Question-driven task handoff**: Describe your needs, xiaoli proactively asks clarifying questions, then gets to work
- **L4 Autonomous execution**: File operations, Git commits, database changes, environment config — all handled automatically
- **High-risk operation guard**: Dangerous commands (`rm -rf`, `DROP TABLE`, `git push --force`) require explicit confirmation
- **Task progress tracking**: Check where the current task stands at any time
- **Session memory**: Resume unfinished tasks from where you left off
- **Native Chinese**: All conversation output in Chinese (more languages planned)

## Quick Start

### Installation

```bash
npm install -g xiaoli
```

Requires Node.js >= 18.

### Configuration

```bash
# Set your DeepSeek API key (required)
xiaoli config set api-key sk-xxx
```

### Usage

```bash
# Start a new task
xiaoli "Fix the slow ERP order query"

# Check task progress
xiaoli status

# Resume the last task
xiaoli continue
```

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js >= 18 |
| Language | TypeScript 5.x (strict mode) |
| CLI Framework | Commander.js |
| AI SDK | openai (Node.js) → DeepSeek API |
| Database | better-sqlite3 (SQLite) |
| Testing | Vitest |

## Documentation

- [Product Positioning](docs/00_产品定位.md) (Chinese)
- [Interaction Flow Design](docs/01_交互流程设计.md) (Chinese)
- [Technical Architecture](docs/02_技术架构设计.md) (Chinese)
- [Competitive Analysis](docs/04_竞品分析.md) (Chinese)
- [Question & Execution Plan Design](docs/05_追问与执行计划设计.md) (Chinese)

## Development

This project uses a three-agent collaborative development model. See the [multi-agent development guide](docs/08_多Agent协作开发方案.md) (Chinese).

```bash
# Launch Claude Code with different agent identities
source scripts/agent-zhangsan.sh        # User interaction layer
source scripts/agent-lisi.sh            # Core engine layer
source scripts/agent-zhangchonglian.sh  # Infrastructure & coordination
```

## License

MIT
