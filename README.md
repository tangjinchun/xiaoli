# xiaoli

[![CI](https://github.com/tangjinchun/xiaoli/actions/workflows/ci.yml/badge.svg)](https://github.com/tangjinchun/xiaoli/actions/workflows/ci.yml)

[English](README.en.md) | [日本語](README.ja.md)

> **先问完，再执行。** 一个住在终端里的 AI 同事。

xiaoli 不是“你一句我一句”的聊天助手。它会先读项目、生成追问、收束需求，再把需求编译成一份**可执行的计划**，等你确认后自主执行；中途 Ctrl+C 会保存进度，回来运行 `xiaoli continue` 接着干。

当前版本是一个**可运行的 vertical slice**：问答 → 计划 → 确认 → 执行 → 验收 → 暂停/恢复 已经打通，而不是停留在设计文档里。

---

## 现在能做什么

- **先问后做**：基于项目上下文生成追问；信息不足时追加追问，而不是直接猜。
- **可执行计划**：每一步都有 `tool` + `input` + `riskLevel` + `dependsOn` + 可选 `verify`，不是一段自然语言待办。
- **确认门**：展示完整计划，输入 `/confirm` 才执行；高危步骤会再次要求输入确认短语。
- **DAG 执行器**：按依赖顺序执行，失败真正重试，支持 fallback / rollback / 确定性验收。
- **暂停与恢复**：Ctrl+C 或 `/pause` 会保存每个步骤的状态；`xiaoli continue` 从断点继续。
- **统一安全策略**：路径限制在工作目录内，敏感文件拒绝访问，危险命令按 `ALLOW / WARN / ASK / STOP` 处理。
- **持久化**：任务、问答、步骤状态、计划、项目记忆都写入 SQLite。
- **可测试**：73 个单元测试 + 10 个离线运行时测评（10/10）。

---

## 30 秒演示

```bash
npm run demo
```

输出节选：

```text
🔨 任务 task-...
创建一个 hello.txt，内容为 hello xiaoli

🤔 生成追问...
📋 需要你确认 2 个问题。
  1. [目标定义] 要创建什么文件？
  2. [成功标准] 文件内容是什么？

> 1. hello.txt 2. hello xiaoli

📋 执行计划：创建 hello.txt
═══ 执行（1 步）═══
  ○ 🟡 写入 hello.txt
      工具: write_file  {"filePath":"hello.txt","content":"hello xiaoli"}

✅ 写入 hello.txt — 已写入 hello.txt (12 字节)
🎉 全部完成：1 成功 / 0 跳过，耗时 0s
```

> demo 使用脚本化 provider，不调用真实 API；验证的是问答、计划、执行链路。

---

## 快速开始

当前 npm 包尚未正式发布，先从源码安装：

```bash
git clone https://github.com/tangjinchun/xiaoli.git
cd xiaoli
npm install
npm run build
npm link

xiaoli config set api.key sk-xxx
xiaoli "修复订单查询慢的问题"
```

要求 Node.js >= 18。API 走 DeepSeek（OpenAI 兼容接口），默认模型：

- `deepseek-v4-pro`：追问、计划等推理任务
- `deepseek-flash`：追问收束等低延迟任务

也可以直接用环境变量：

```bash
export XIAOLI_API_KEY=sk-xxx
```

---

## 命令

| 命令 | 作用 |
|---|---|
| `xiaoli "任务描述"` | 启动新任务：分析上下文 → 追问 → 计划 → 确认 → 执行 |
| `xiaoli task "任务描述"` | 同上，显式写法 |
| `xiaoli status [taskId]` | 查看任务进度、问答、计划、当前步骤 |
| `xiaoli continue [taskId]` | 从暂停/失败/未完成处继续 |
| `xiaoli config set <key> <value>` | 修改配置，如 `api.key` |
| `xiaoli config get <key>` | 读取配置（API key 自动脱敏） |
| `xiaoli config list` | 列出全部配置 |
| `xiaoli config path` | 显示配置文件路径 |

任务执行中：

- `/confirm`：确认计划并执行
- `/reject`：放弃任务
- `/pause`：暂停（也可以 Ctrl+C）
- 高危步骤：输入完整的 `确认执行` 才继续

---

## 工作方式

```text
CLI (src/cli, src/commands)
  │
  └─ Orchestrator (src/engine/orchestrator.ts)
       ├─ L1 上下文构建：项目类型、技术栈、目录树、相关文件
       ├─ L2 追问生成：DeepSeek 结构化 JSON
       ├─ L3 追问收束：信息缺口检测 + AI 追加追问 + 启发式兜底
       ├─ 计划生成：自然语言需求 → Plan IR
       ├─ Plan Compiler：校验 tool/input、依赖、风险、verify、拓扑排序
       ├─ 确认门：/confirm /reject /pause
       └─ Executor：DAG + 安全策略 + 重试 + 验收 + SQLite checkpoint
```

几个关键设计：

- **计划是 IR，不是待办列表。** 模型必须输出具体工具和参数；执行器不再猜 `toolHints[0]` 是什么意思。
- **执行器不认识自然语言。** 它只通过 `tool-registry` 调用 `read_file / write_file / patch_file / terminal / git / ask_user`。
- **每一步都可恢复。** 执行前写 `running`，成功后写 `completed`，失败写 `failed`；`continue` 会重置失败/暂停步骤并从断点继续。
- **验收是确定性的。** 支持 `file_exists / file_not_exists / file_contains / stdout_contains / command`，不靠模型自评“我做完了”。

---

## 安全模型

所有工具调用先经过 `src/safety/policy.ts`：

| 判定 | 行为 |
|---|---|
| `ALLOW` | 直接执行 |
| `WARN` | 执行并记录审计日志 |
| `ASK` | 打断，要求用户确认 |
| `STOP` | 默认拒绝，不执行 |

当前策略包括：

- 文件读写限制在任务工作目录内；`../`、绝对路径越界直接拒绝。
- `.env`、SSH 私钥、`.npmrc`、`.git/config`、`.xiaoli` 等敏感路径拒绝访问。
- `rm -rf` 工作目录外、磁盘格式化、提权等直接 `STOP`。
- `rm -rf` 工作目录内、`git push --force`、`git reset --hard` 等要求确认。
- `DROP TABLE`、无条件 `DELETE`、`TRUNCATE` 默认拒绝。
- 命令先做 tokenize，不只用整串正则；`bash -c` / `cmd /c` 会递归检查。
- Git 写操作使用 `execFile` + 参数数组，避免 commit message / 分支名注入。
- 审计日志默认写入 `~/.xiaoli/audit.log`，敏感字段会脱敏。

**边界**：这是策略层，不是 OS 级沙箱。不要在没有隔离的机器上让它执行不可信任务；生产环境建议配合容器/虚拟机。

---

## 离线测评

```bash
npm run eval
```

10 个任务覆盖运行时关键路径：

| 任务 | 验证点 |
|---|---|
| `create-file` | 问答 → 计划 → 写文件 → 验收 |
| `patch-file` | 精确修改 + 内容验收 |
| `run-command` | 执行命令 + stdout 验收 |
| `reject-plan` | 拒绝计划，不落盘 |
| `pause-resume` | 执行到一半暂停，`continue` 恢复 |
| `blocked-rm-outside` | 工作目录外删除被拦截 |
| `high-risk-confirm` | 高危步骤确认后执行 |
| `ask-user` | 执行中提问 + 结果模板引用 |
| `retry` | 第一次失败，第二次成功 |
| `refinement` | 多轮追问后生成计划 |

当前结果：**10/10 通过**（脚本化模型，无网络、无 API 费用）。

> 这组测评验证的是运行时行为，不是模型质量。真实 DeepSeek 效果需要在配置 key 后跑 live eval；这是 roadmap 的一部分。

---

## 配置

配置文件：`~/.xiaoli/config.json`（可用 `XIAOLI_HOME` 覆盖目录）。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `api.key` | 空 | DeepSeek API key |
| `api.baseUrl` | `https://api.deepseek.com` | API 地址 |
| `api.modelPro` | `deepseek-v4-pro` | 推理模型 |
| `api.modelFlash` | `deepseek-flash` | 轻量模型 |
| `safety.maxAutoRetry` | `3` | 自动重试上限 |
| `safety.auditLogPath` | 空 | 自定义审计日志路径 |
| `ui.color` | `true` | 保留项 |
| `ui.progressBars` | `true` | 保留项 |

数据目录：

```text
~/.xiaoli/
├── config.json
├── data.db
└── audit.log
```

数据库表：`tasks`、`qa_exchanges`、`task_steps`、`project_memory`、`user_preferences`。

---

## 开发

```bash
npm run build       # TypeScript 编译
npm test            # 73 个单元测试
npm run typecheck   # tsc --noEmit
npm run eval        # 10 个离线运行时测评
npm run demo        # 离线演示
```

CI 在 Ubuntu + Windows、Node 20/22 上运行 build、typecheck、test、eval。

目录：

```text
src/
├── cli/            # 终端交互（readline + AbortSignal）
├── commands/       # task / status / continue / config
├── engine/         # orchestrator、计划编译器、工具注册表、执行器、验收
├── ai/             # DeepSeek provider、prompt、模型分流
├── safety/         # 统一策略、危险模式、审计
├── storage/        # SQLite、配置、路径
└── utils/          # shell / file / git
eval/               # 离线测评 + demo
tests/              # vitest 单元测试
```

---

## Roadmap

- [ ] 真实 DeepSeek 的 live eval（同一批任务，对比模型效果）
- [ ] `database` 工具
- [ ] 跨平台环境自愈（JDK / npm / 端口）
- [ ] LSP 诊断集成
- [ ] OS 级沙箱 / 容器隔离
- [ ] `.gitignore` 感知的上下文构建
- [ ] 流式输出与 token 成本统计

不做：网页、APP、IDE 插件。xiaoli 只有一个界面：终端。

---

## License

MIT
