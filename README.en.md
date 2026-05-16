# xiaoli

> An AI Agent living in your terminal. You assign tasks, answer follow-up questions, and it gets the work done.

[中文](README.md) | [日本語](README.ja.md)
[![996.icu](https://img.shields.io/badge/link-996.icu-%23FF4D5B.svg?style=flat-square)](https://996.icu/#/en_US)

## Overview

xiaoli is an npm global CLI tool that acts as an AI Agent in your terminal. Unlike traditional AI assistants, xiaoli **asks all questions first, then executes** — it won't touch a single line of code until all ambiguities are resolved.

**Core philosophy: Not a "time management" tool — a "time expansion" tool. Not an assistant — an AI Agent.**

## Features

- **Question-driven task handoff**: Describe your needs, xiaoli proactively asks clarifying questions, then gets to work
- **L4 Autonomous execution**: File operations, Git commits, database changes, environment config — all handled automatically
- **High-risk operation guard**: Dangerous commands (`rm -rf`, `DROP TABLE`, `git push --force`) require explicit confirmation
- **Task progress tracking**: Check where the current task stands at any time
- **Session memory**: Resume unfinished tasks from where you left off
- **Native Chinese**: All conversation output in Chinese

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

## License

MIT
