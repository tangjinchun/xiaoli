/**
 * SQLite 数据库管理。
 *
 * 表：
 *   tasks            — 任务（描述、状态、计划 JSON、上下文）
 *   qa_exchanges     — 问答记录（问题先落库，回答后更新）
 *   task_steps       — 执行步骤日志
 *   project_memory   — 项目记忆（key-value）
 *   user_preferences — 用户偏好
 *
 * 存储路径：~/.xiaoli/data.db（可用 XIAOLI_HOME 覆盖）
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ExecutionPlan,
  QuestionSkeleton,
  TaskStatus,
} from '../engine/types.js';
import { getDbPath, ensureXiaoliHome } from './paths.js';

let db: Database.Database | null = null;

export interface TaskRow {
  id: string;
  description: string;
  status: TaskStatus;
  plan: string | null;
  plan_status: string | null;
  cwd: string;
  created_at: number;
  updated_at: number;
  summary: string | null;
  current_step_id: string | null;
  error: string | null;
  confirmed_at: number | null;
  completed_at: number | null;
  meta: string | null;
}

export interface QARow {
  id: number;
  task_id: string;
  question: string;
  answer: string | null;
  question_order: number;
  round: number;
  skipped: number;
  created_at: number;
}

export interface StepRow {
  id: number;
  task_id: string;
  phase_id: string;
  step_id: string;
  step_order: number;
  description: string;
  tool: string;
  status: string;
  result: string | null;
  error: string | null;
  recovery_attempts: number;
  started_at: number | null;
  completed_at: number | null;
}

export function getDb(): Database.Database {
  if (!db) {
    ensureXiaoliHome();
    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const instance = new Database(dbPath);
    instance.pragma('journal_mode = WAL');
    instance.pragma('foreign_keys = ON');
    db = instance;
    initTables(instance);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function initTables(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'questioning',
      plan TEXT,
      plan_status TEXT,
      cwd TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      summary TEXT,
      current_step_id TEXT,
      error TEXT,
      confirmed_at INTEGER,
      completed_at INTEGER,
      meta TEXT
    );

    CREATE TABLE IF NOT EXISTS qa_exchanges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT,
      question_order INTEGER NOT NULL,
      round INTEGER NOT NULL DEFAULT 1,
      skipped INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS task_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      phase_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      step_order INTEGER NOT NULL,
      description TEXT NOT NULL,
      tool TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      error TEXT,
      recovery_attempts INTEGER DEFAULT 0,
      started_at INTEGER,
      completed_at INTEGER,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS project_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_path, key)
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_qa_task ON qa_exchanges(task_id, question_order);
    CREATE INDEX IF NOT EXISTS idx_steps_task ON task_steps(task_id, step_order);
  `);

  // 兼容早期版本的数据库文件。
  ensureColumn(d, 'tasks', 'summary', 'TEXT');
  ensureColumn(d, 'tasks', 'current_step_id', 'TEXT');
  ensureColumn(d, 'tasks', 'error', 'TEXT');
  ensureColumn(d, 'tasks', 'confirmed_at', 'INTEGER');
  ensureColumn(d, 'tasks', 'completed_at', 'INTEGER');
  ensureColumn(d, 'tasks', 'meta', 'TEXT');
  ensureColumn(d, 'qa_exchanges', 'skipped', 'INTEGER NOT NULL DEFAULT 0');
}

function ensureColumn(
  d: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// ============================================================================
// 任务 CRUD
// ============================================================================

export function createTask(id: string, description: string, cwd: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO tasks (id, description, status, cwd, created_at, updated_at)
       VALUES (?, ?, 'questioning', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         description = excluded.description,
         cwd = excluded.cwd,
         updated_at = excluded.updated_at`,
    )
    .run(id, description, cwd, now, now);
}

export function getTask(id: string): TaskRow | null {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  return row ?? null;
}

export function getLatestTask(): TaskRow | null {
  const row = getDb()
    .prepare('SELECT * FROM tasks ORDER BY updated_at DESC, created_at DESC, rowid DESC LIMIT 1')
    .get() as TaskRow | undefined;
  return row ?? null;
}

export function getLatestResumableTask(): TaskRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE status IN ('questioning', 'planning', 'plan_ready', 'executing', 'paused', 'failed')
       ORDER BY updated_at DESC, created_at DESC, rowid DESC LIMIT 1`,
    )
    .get() as TaskRow | undefined;
  return row ?? null;
}

export function listTasks(limit = 10): TaskRow[] {
  return getDb()
    .prepare('SELECT * FROM tasks ORDER BY updated_at DESC, created_at DESC, rowid DESC LIMIT ?')
    .all(limit) as TaskRow[];
}

export function updateTaskStatus(
  id: string,
  status: TaskStatus,
  plan?: ExecutionPlan,
  error?: string | null,
): void {
  const updates: string[] = ['status = ?', 'updated_at = ?'];
  const values: unknown[] = [status, Date.now()];

  if (plan) {
    updates.push('plan = ?', 'plan_status = ?');
    values.push(JSON.stringify(plan), plan.status);
  }
  if (error !== undefined) {
    updates.push('error = ?');
    values.push(error);
  }
  if (status === 'executing') {
    updates.push('confirmed_at = COALESCE(confirmed_at, ?)');
    values.push(Date.now());
  }
  if (status === 'questioning' || status === 'planning' || status === 'plan_ready' || status === 'executing' || status === 'paused') {
    updates.push('completed_at = NULL');
  }
  if (status === 'completed' || status === 'failed' || status === 'rejected') {
    updates.push('completed_at = ?');
    values.push(Date.now());
  }

  values.push(id);
  getDb()
    .prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`)
    .run(...values);
}

export function updateTaskMeta(id: string, meta: Record<string, unknown>): void {
  getDb()
    .prepare('UPDATE tasks SET meta = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(meta), Date.now(), id);
}

export function getTaskMeta(id: string): Record<string, unknown> {
  const row = getTask(id);
  if (!row?.meta) return {};
  try {
    return JSON.parse(row.meta) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function getTaskPlan(id: string): ExecutionPlan | null {
  const row = getTask(id);
  if (!row?.plan) return null;
  try {
    return JSON.parse(row.plan) as ExecutionPlan;
  } catch {
    return null;
  }
}

// ============================================================================
// 问答记录
// ============================================================================

export function saveQA(
  taskId: string,
  question: string,
  answer: string | null,
  order: number,
  round: number,
  skipped = false,
): number {
  const result = getDb()
    .prepare(
      `INSERT INTO qa_exchanges (task_id, question, answer, question_order, round, skipped, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(taskId, question, answer, order, round, skipped ? 1 : 0, Date.now());
  return Number(result.lastInsertRowid);
}

/**
 * 一次性把一轮问题落库。返回的问题 id 会被替换为数据库行 ID。
 * 如果同一轮已经有同文本的问题（例如恢复后重复生成），复用旧行。
 */
export function saveQuestions(
  taskId: string,
  questions: QuestionSkeleton[],
  round: number,
): QuestionSkeleton[] {
  const d = getDb();
  const select = d.prepare(
    'SELECT id FROM qa_exchanges WHERE task_id = ? AND round = ? AND question = ? LIMIT 1',
  );
  const insert = d.prepare(
    `INSERT INTO qa_exchanges (task_id, question, answer, question_order, round, skipped, created_at)
     VALUES (?, ?, NULL, ?, ?, 0, ?)`,
  );

  const transaction = d.transaction(() => {
    return questions.map((q, index) => {
      const existing = select.get(taskId, round, q.question) as { id: number } | undefined;
      const id = existing
        ? existing.id
        : Number(
            insert.run(taskId, q.question, index, round, Date.now()).lastInsertRowid,
          );
      return { ...q, id: String(id), round };
    });
  });

  return transaction();
}

export function updateQAAnswer(id: number, answer: string, skipped = false): void {
  getDb()
    .prepare('UPDATE qa_exchanges SET answer = ?, skipped = ? WHERE id = ?')
    .run(answer, skipped ? 1 : 0, id);
}

export function getQA(taskId: string): QARow[] {
  return getDb()
    .prepare(
      'SELECT * FROM qa_exchanges WHERE task_id = ? ORDER BY question_order ASC, id ASC',
    )
    .all(taskId) as QARow[];
}

export function getPendingQA(taskId: string): QARow[] {
  return getDb()
    .prepare(
      `SELECT * FROM qa_exchanges
       WHERE task_id = ? AND answer IS NULL AND skipped = 0
       ORDER BY question_order ASC, id ASC`,
    )
    .all(taskId) as QARow[];
}

// ============================================================================
// 步骤日志
// ============================================================================

export function upsertStep(
  taskId: string,
  phaseId: string,
  stepId: string,
  order: number,
  description: string,
  tool: string,
): void {
  const existing = getDb()
    .prepare('SELECT id FROM task_steps WHERE task_id = ? AND step_id = ?')
    .get(taskId, stepId) as { id: number } | undefined;

  if (existing) {
    getDb()
      .prepare(
        `UPDATE task_steps SET phase_id = ?, step_order = ?, description = ?, tool = ?
         WHERE task_id = ? AND step_id = ?`,
      )
      .run(phaseId, order, description, tool, taskId, stepId);
  } else {
    getDb()
      .prepare(
        `INSERT INTO task_steps (task_id, phase_id, step_id, step_order, description, tool, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(taskId, phaseId, stepId, order, description, tool);
  }
}

export function updateStepStatus(
  taskId: string,
  stepId: string,
  status: string,
  result?: string,
  error?: string,
): void {
  const updates: string[] = ['status = ?'];
  const values: unknown[] = [status];

  if (status === 'running') {
    updates.push('started_at = ?');
    values.push(Date.now());
  }
  if (status === 'pending' || status === 'running' || status === 'paused') {
    updates.push('completed_at = NULL', 'result = NULL', 'error = NULL');
  }
  if (status === 'completed' || status === 'failed' || status === 'skipped') {
    updates.push('completed_at = ?');
    values.push(Date.now());
  }
  if (status === 'completed') {
    updates.push('error = NULL');
  }
  if (result !== undefined) {
    updates.push('result = ?');
    values.push(result);
  }
  if (error !== undefined) {
    updates.push('error = ?');
    values.push(error);
  }

  values.push(taskId, stepId);
  getDb()
    .prepare(`UPDATE task_steps SET ${updates.join(', ')} WHERE task_id = ? AND step_id = ?`)
    .run(...values);
}

export function incrementStepRecovery(taskId: string, stepId: string): void {
  getDb()
    .prepare(
      'UPDATE task_steps SET recovery_attempts = recovery_attempts + 1 WHERE task_id = ? AND step_id = ?',
    )
    .run(taskId, stepId);
}

export function getSteps(taskId: string): StepRow[] {
  return getDb()
    .prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY step_order ASC')
    .all(taskId) as StepRow[];
}

export function resetStepsForResume(taskId: string): void {
  getDb()
    .prepare(
      `UPDATE task_steps
       SET status = 'pending', error = NULL, completed_at = NULL
       WHERE task_id = ?
         AND (
           status IN ('running', 'failed', 'paused')
           OR (status = 'skipped' AND error LIKE '%用户拒绝%')
         )`,
    )
    .run(taskId);
}

// ============================================================================
// 项目记忆
// ============================================================================

export function setProjectMemory(projectPath: string, key: string, value: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO project_memory (project_path, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_path, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(projectPath, key, value, now);
}

export function getProjectMemory(projectPath: string, key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM project_memory WHERE project_path = ? AND key = ?')
    .get(projectPath, key) as { value: string } | undefined;
  return row?.value ?? null;
}

// ============================================================================
// 用户偏好
// ============================================================================

export function setPreference(key: string, value: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO user_preferences (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, now);
}

export function getPreference(key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM user_preferences WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
