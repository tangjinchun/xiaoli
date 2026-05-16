# xiaoli

> ターミナルに住んでいる AI Agent。あなたがタスクを伝え、質問に答えると、あとは自分で作業します。

[中文](README.md) | [English](README.en.md)
[![996.icu](https://img.shields.io/badge/link-996.icu-%23FF4D5B.svg?style=flat-square)](https://996.icu/#/zh_CN)

## 概要

xiaoli は npm でグローバルインストールする CLI ツールで、ターミナル内の AI Agent として動作します。従来の AI アシスタントと異なり、xiaoli は**すべての質問を先に行い、その後に実行**します。曖昧さが解消されるまでコードに一切手を付けません。

**基本理念：「時間管理」ツールではなく「時間拡張」ツール。アシスタントではなくAI Agent。**

## 主な機能

- **対話型タスク指示**：要件を伝えると、xiaoli が積極的に質問し、明確になったら作業開始
- **L4 自律実行**：ファイル操作、Git コミット、データベース変更、環境設定を自動で実行
- **危険操作の防止**：危険なコマンド（`rm -rf`、`DROP TABLE`、`git push --force`）は明示的な確認が必要
- **タスク進捗の追跡**：現在のタスクの進行状況をいつでも確認可能
- **セッション記憶**：未完了のタスクを中断箇所から再開可能
- **中国語ネイティブ対応**：すべての会話出力が中国語

## クイックスタート

### インストール

```bash
npm install -g xiaoli
```

Node.js >= 18 が必要です。

### 設定

```bash
# DeepSeek API キーを設定（必須）
xiaoli config set api-key sk-xxx
```

### 使い方

```bash
# 新しいタスクを開始
xiaoli "ERPの注文検索が遅い問題を修正して"

# タスクの進捗を確認
xiaoli status

# 前回のタスクを再開
xiaoli continue
```

## 技術スタック

| レイヤー | 選定 |
|---|---|
| ランタイム | Node.js >= 18 |
| 言語 | TypeScript 5.x (strict mode) |
| CLI フレームワーク | Commander.js |
| AI SDK | openai (Node.js) → DeepSeek API |
| データベース | better-sqlite3 (SQLite) |
| テスト | Vitest |

## ドキュメント

- [製品ポジショニング](docs/00_产品定位.md)（中国語）
- [インタラクションフロー設計](docs/01_交互流程设计.md)（中国語）
- [技術アーキテクチャ設計](docs/02_技术架构设计.md)（中国語）
- [競合分析](docs/04_竞品分析.md)（中国語）
- [質問と実行計画の設計](docs/05_追问与执行计划设计.md)（中国語）

## ライセンス

MIT
