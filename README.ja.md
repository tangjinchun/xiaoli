# xiaoli

[![CI](https://github.com/tangjinchun/xiaoli/actions/workflows/ci.yml/badge.svg)](https://github.com/tangjinchun/xiaoli/actions/workflows/ci.yml)

> **まず質問し、それから実行する。** ターミナルに住む AI の同僚。

xiaoli は一問一答のチャットアシスタントではありません。プロジェクトを読み、追加質問を生成し、要件を**実行可能な計画**にコンパイルします。ユーザーが確認した後で自動実行し、Ctrl+C で進捗を保存して `xiaoli continue` で再開できます。

現在は動く vertical slice です：質問 → 計画 → 確認 → 実行 → 検証 → 一時停止/再開。

[中文 README](README.md) | [English](README.en.md)

## できること

- **先に質問する**：プロジェクト文脈を読んで質問を生成し、情報不足なら追加質問する。
- **実行可能な計画 IR**：各ステップに `tool`、`input`、`riskLevel`、`dependsOn`、任意の `verify` を持たせる。
- **確認ゲート**：`/confirm` で実行、`/reject` で破棄、`/pause` で停止。高危険ステップは `确认执行` の入力が必要。
- **DAG 実行器**：依存順に実行し、実際にリトライ、fallback/rollback、決定的な検証を行う。
- **一時停止/再開**：各ステップを SQLite に保存。プロセスを終了しても `continue` で再開できる。
- **統一安全ポリシー**：作業ディレクトリ内にパスを制限し、機密ファイルを拒否。`ALLOW / WARN / ASK / STOP` で判定。
- **テスト**：73 個のユニットテスト + 10 個のオフライン実行評価（10/10）。

## デモ

```bash
npm run demo
```

デモはスクリプト化された AI provider を使うため、API key もネットワークも不要です。実際のオーケストレーション、計画、実行経路を通ります。

## クイックスタート

npm パッケージは未公開です。ソースからインストールします：

```bash
git clone https://github.com/tangjinchun/xiaoli.git
cd xiaoli
npm install
npm run build
npm link

xiaoli config set api.key sk-xxx
xiaoli "注文検索が遅い問題を修正して"
```

Node.js >= 18 が必要です。API は DeepSeek（OpenAI 互換）を使います。

## コマンド

| コマンド | 役割 |
|---|---|
| `xiaoli "タスク"` | 文脈 → 質問 → 計画 → 確認 → 実行 |
| `xiaoli status [taskId]` | 進捗、Q&A、計画、現在のステップを表示 |
| `xiaoli continue [taskId]` | 一時停止/失敗/未完了のタスクを再開 |
| `xiaoli config set <key> <value>` | 設定を変更（例：`api.key`） |
| `xiaoli config get <key>` | 設定を表示（API key はマスク） |
| `xiaoli config list` | 設定一覧 |
| `xiaoli config path` | 設定ファイルのパス |

## 仕組み

```text
CLI
 └─ Orchestrator
     ├─ L1 プロジェクト文脈
     ├─ L2 質問生成（構造化 JSON）
     ├─ L3 情報ギャップに基づく追加質問（AI + ヒューリスティック）
     ├─ 計画生成 → Plan IR
     ├─ Plan Compiler（tool/input、依存、リスク、verify、トポロジカルソート）
     ├─ 確認ゲート
     └─ Executor（DAG + ポリシー + リトライ + 検証 + SQLite checkpoint）
```

計画は自然言語の TODO ではなく IR です。実行器は `read_file / write_file / patch_file / terminal / git / ask_user` を tool registry 経由でのみ呼びます。

## 安全モデル

すべてのツール呼び出しは `src/safety/policy.ts` を通ります：

- パスは作業ディレクトリ内に制限。`.env`、SSH 秘密鍵、`.npmrc`、`.git/config`、`.xiaoli` は拒否。
- 作業ディレクトリ外の `rm -rf`、ディスクフォーマット、権限昇格は `STOP`。
- 作業ディレクトリ内の `rm -rf`、`git push --force`、`git reset --hard` は確認要求。
- `DROP TABLE`、WHERE なし `DELETE`、`TRUNCATE` はデフォルト拒否。
- コマンドを tokenize し、`bash -c` / `cmd /c` を再帰的に検査。
- Git の書き込みは `execFile` + 引数配列で、メッセージ/ブランチ名のインジェクションを防ぐ。
- 監査ログは `~/.xiaoli/audit.log` に保存し、機密情報をマスク。

これは OS レベルのサンドボックスではありません。信頼できないタスクはコンテナ/VM で実行してください。

## オフライン評価

```bash
npm run eval
```

10 個のタスクで、ファイル作成/修正、コマンド実行、計画拒否、一時停止/再開、危険コマンド遮断、高危険確認、実行中の質問、リトライ、複数ラウンドの追加質問を検証します。現在 **10/10**。

評価はスクリプト化 provider による実行時検証であり、モデル品質の評価ではありません。live eval は roadmap です。

## 開発

```bash
npm run build
npm test
npm run typecheck
npm run eval
npm run demo
```

CI は Ubuntu + Windows、Node 20/22 で build、typecheck、test、eval を実行します。

## 制限 / roadmap

- 実際の DeepSeek を使った live eval
- `database` ツール
- クロスプラットフォームの環境自動修復
- LSP 診断
- OS レベルサンドボックス
- `.gitignore` を考慮した文脈構築
- ストリーミングと token コスト管理

GUI、モバイルアプリ、IDE プラグインは作りません。インターフェースはターミナルだけです。

## License

MIT
