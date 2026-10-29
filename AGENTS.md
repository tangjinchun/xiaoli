# AGENTS.md

AI 代理在 xiaoli 项目中工作时必须遵守的规则和上下文。

## 项目概述

xiaoli（小李）是一个 npm 全局安装的终端 AI 同事。用户交代任务 → xiaoli 追问 → 用户确认计划 → xiaoli 自主执行；中途可暂停，之后 `continue` 恢复。

**核心定位：不是「时间管理」工具，是「时间扩展」工具。不是助手，是同事。**

当前版本是可运行的 vertical slice：CLI、上下文、追问、收束、计划编译、确认门、DAG 执行、验收、安全策略、SQLite 持久化、暂停/恢复均已落地。

## 产品原则（不可违背）

1. **先问完、后执行** — 不回答完所有问题、不确认计划，xiaoli 不动一行代码。
2. **只有终端，没有 GUI** — 不做网页、APP、IDE 插件。
3. **计划内自动执行 + 高危拦截** — 高危操作必须打断要求确认；工作目录外和不可逆操作默认拒绝。
4. **中文对话** — 所有用户输出用中文，简洁、非拟人化。
5. **DeepSeek API 唯一大脑** — 默认 provider 是 DeepSeek；测试/测评可注入脚本化 provider。

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Node.js >= 18 |
| 语言 | TypeScript 5.x (strict mode) |
| CLI 框架 | Commander.js |
| AI SDK | openai (Node.js) → base_url 指向 api.deepseek.com |
| 数据库 | better-sqlite3 (SQLite) |
| 包分发 | npm（发布后 `npm install -g xiaoli`；当前用 `npm link`） |
| 测试 | Vitest + 离线运行时测评 |

## 当前架构

```text
src/
├── main.ts                  # Commander CLI 入口
├── cli/io.ts                # readline + AbortSignal 交互层
├── commands/task.ts         # task/status/continue/config 处理器
├── engine/
│   ├── orchestrator.ts      # 问答 → 收束 → 计划 → 确认 → 执行 编排
│   ├── context-builder.ts   # L1 项目上下文
│   ├── question-generator.ts# L2 追问生成（DeepSeek）
│   ├── question-refiner.ts  # L3 信息缺口 + AI 追加追问 + 启发式兜底
│   ├── question-collector.ts# 追问收集、落库、多轮
│   ├── plan-generator.ts    # 调用 AI 生成 RawPlan
│   ├── plan-compiler.ts     # RawPlan → 可执行 IR（校验/拓扑排序/风险）
│   ├── tool-registry.ts     # 工具 schema + 参数校验 + 执行器
│   ├── executor.ts          # DAG 执行、重试、确认、暂停/恢复、checkpoint
│   ├── verifier.ts          # 确定性验收
│   ├── plan-renderer.ts     # 计划终端渲染
│   ├── conversation.ts      # 任务状态机
│   └── memory.ts            # 项目记忆
├── ai/
│   ├── provider.ts          # ChatProvider 抽象 + DeepSeekProvider
│   ├── client.ts            # chat/chatJson、重试、token 统计、provider 注入
│   ├── router.ts            # pro/flash 模型分流
│   └── prompts/             # question-gen / plan-gen / refinement
├── safety/
│   ├── policy.ts            # 统一安全策略（唯一判定入口）
│   ├── scanner.ts           # 旧 API 兼容层
│   ├── patterns.ts          # 危险模式数据
│   └── audit.ts             # 审计日志 + 脱敏
├── storage/
│   ├── paths.ts             # XIAOLI_HOME / 配置 / DB / 日志路径
│   ├── config.ts            # 配置读写
│   └── db.ts                # SQLite CRUD
└── utils/                   # shell / file / git / env
eval/                        # 10 个离线测评 + demo
tests/                       # Vitest 单元测试
```

## 命令

```bash
xiaoli "任务描述"              # 启动任务
xiaoli task "任务描述"         # 显式写法
xiaoli status [taskId]        # 查看进度
xiaoli continue [taskId]      # 继续暂停/失败的任务
xiaoli config set api.key sk-xxx
xiaoli config get api.key
xiaoli config list
xiaoli config path
```

开发命令：

```bash
npm run build
npm test
npm run typecheck
npm run eval
npm run demo
```

## 开发规范

1. **计划必须是 IR**：每个 step 必须有 `tool` 和具体 `input`；禁止让执行器从自然语言猜参数。
2. **所有外部操作走工具注册表**：`read_file / write_file / patch_file / terminal / git / ask_user`；不要在业务代码里直接 `exec` 或写任意路径。
3. **所有工具调用先过 `safety/policy.ts`**：路径默认限制在 cwd；高危操作返回 `ASK` 或 `STOP`。
4. **状态必须落库**：任务、问答、步骤状态、计划 JSON 写入 SQLite；执行器的每个 checkpoint 要支持 `continue`。
5. **失败要真重试**：不要只改状态；重试必须重新执行工具。验收失败也按步骤失败处理。
6. **Prompt 模板放在 `src/ai/prompts/`**，通过 `src/ai/prompt.ts` 统一导出。
7. **AI 调用通过 `src/ai/client.ts`**；测试用 `setChatProvider()` 注入脚本化 provider，不要在单元测试里发网络请求。
8. **配置读写通过 `src/storage/config.ts`**，路径通过 `src/storage/paths.ts`；不要直接读 `process.env` 拼路径。
9. **新增行为必须有测试**；改核心链路后跑 `npm run build && npm test && npm run eval`。
10. **中文输出**；类型使用 strict mode；避免 `any` 和非空断言。

## 数据目录

默认 `~/.xiaoli`，可用 `XIAOLI_HOME` 覆盖（测试/测评必须隔离）：

```text
~/.xiaoli/
├── config.json
├── data.db
└── audit.log
```

SQLite 表：`tasks`、`qa_exchanges`、`task_steps`、`project_memory`、`user_preferences`。

## 已知边界

- `database` 工具尚未实现。
- 环境自愈（JDK/npm/端口）代码保留在 `utils/env.ts`，但未接入执行器；跨平台仍需完善。
- 安全策略不是 OS 级沙箱；生产/不可信任务需要容器或虚拟机。
- 离线测评使用脚本化模型，验证运行时行为，不衡量模型质量。
- 上下文构建尚未读取 `.gitignore`，大仓库可能浪费 token。

## 产品设计文档

- `docs/00_产品定位.md` — 为什么做、做什么、不做什么
- `docs/01_交互流程设计.md` — 问答阶段 + 执行阶段
- `docs/02_技术架构设计.md` — 技术选型、架构分层、SQLite 表设计
- `docs/04_竞品分析.md` — 竞品与差异化
- `docs/05_追问与执行计划设计.md` — 追问与计划引擎设计
- `README.md` — 当前实现状态、命令、测评结果
