# AGENTS.md

AI 代理在 xiaoli 项目中工作时必须遵守的规则和上下文。

## 项目概述

xiaoli（小李）是一个 npm 全局安装的终端 AI 同事。用户交代任务 → xiaoli 提问 → 用户确认 → xiaoli 自主干活。

**核心定位：不是「时间管理」工具，是「时间扩展」工具。不是助手，是同事。**

## 产品原则（不可违背）

1. **先问完、后执行** — 不回答完所有问题，xiaoli 不动一行代码。这是和 Claude Code 最本质的区别。
2. **只有终端，没有 GUI** — 不做网页、不做 APP、不做 IDE 插件。
3. **L4 自主 + 高危拦截** — 文件/Git/数据库/环境自己搞，但高危操作（rm -rf、DROP TABLE、git push --force）必须打断要求确认。
4. **中文对话** — xiaoli 所有输出用中文，简洁、非拟人化。
5. **DeepSeek API 唯一大脑** — 不用其他 AI 服务商。

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Node.js >= 18 |
| 语言 | TypeScript 5.x (strict mode) |
| CLI 框架 | Commander.js |
| AI SDK | openai (Node.js) → base_url 指向 api.deepseek.com |
| 数据库 | better-sqlite3 (SQLite) |
| 包分发 | npm (npm install -g xiaoli) |
| 测试 | Vitest |

## 项目结构

```
src/
├── main.ts           # CLI 入口、命令注册
├── commands/         # 命令处理器（task/status/continue/config）
├── engine/           # 对话引擎、执行器、记忆
├── ai/               # DeepSeek 客户端、Prompt 模板、模型分流
├── safety/           # 危险模式扫描、审计
├── storage/          # SQLite 数据库、配置文件
└── utils/            # Shell/File/Git/Env 工具封装
```

## 阶段一开发规范

1. 所有新增代码必须有对应的 TypeScript 类型定义
2. 数据库操作通过 `src/storage/db.ts` 统一入口
3. 所有 Shell/File/Git 操作必须经过 safety scanner
4. Prompt 模板统一放在 `src/ai/prompt.ts`，不在业务代码里硬编码
5. 配置读写通过 `src/storage/config.ts`，不直接读 process.env

## 产品设计文档

- `docs/00_产品定位.md` — 为什么做、做什么、不做什么
- `docs/01_交互流程设计.md` — 问答阶段 + 执行阶段的完整交互
- `docs/02_技术架构设计.md` — 技术选型、架构分层、SQLite 表设计

