# xiaoli（小李）

> 一个住在终端里的 AI Agent。你交代任务、回答追问，它自己干活。

[English](README.en.md) | [日本語](README.ja.md)
[![996.icu](https://img.shields.io/badge/link-996.icu-%23FF4D5B.svg?style=flat-square)](https://996.icu/#/zh_CN)

## 项目简介

xiaoli（小李）是一个 npm 全局安装的终端 AI Agent。与传统 AI 助手不同，xiaoli **先问完、后执行**——不回答完所有问题，它不动一行代码。

**核心定位：不是「时间管理」工具，是「时间扩展」工具。不是助手，是 AI Agent。**

## 主要功能

- **问答式任务交代**：你描述需求，xiaoli 主动追问，确认清楚后再动手
- **L4 自主执行**：文件操作、Git 提交、数据库变更、环境配置自己完成
- **高危操作拦截**：`rm -rf`、`DROP TABLE`、`git push --force` 等危险命令必须确认
- **任务进度追踪**：随时查看当前任务执行到哪一步
- **会话记忆**：支持继续上次未完成的任务
- **中文原生支持**：所有对话输出用中文

## 快速入门

### 安装

```bash
npm install -g xiaoli
```

要求 Node.js >= 18。

### 配置

```bash
# 设置 DeepSeek API key（必须）
xiaoli config set api-key sk-xxx
```

### 使用

```bash
# 启动新任务
xiaoli "修复ERP订单查询慢的问题"

# 查看当前任务进度
xiaoli status

# 继续上次未完成的任务
xiaoli continue
```

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Node.js >= 18 |
| 语言 | TypeScript 5.x (strict mode) |
| CLI 框架 | Commander.js |
| AI SDK | openai (Node.js) → DeepSeek API |
| 数据库 | better-sqlite3 (SQLite) |
| 测试 | Vitest |

## 文档

- [产品定位](docs/00_产品定位.md)
- [交互流程设计](docs/01_交互流程设计.md)
- [技术架构设计](docs/02_技术架构设计.md)
- [竞品分析](docs/04_竞品分析.md)
- [追问与执行计划设计](docs/05_追问与执行计划设计.md)

## 许可证

MIT
