/**
 * SQLite 数据库管理
 *
 * 表：
 *   tasks            — 任务（id, description, status, plan, ...）
 *   qa_exchanges     — 问答记录
 *   task_steps       — 执行步骤日志
 *   project_memory   — 项目记忆（key-value）
 *   user_preferences — 用户偏好
 *
 * 存储路径：~/.xiaoli/data.db
 */

import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import type { ExecutionPlan } from '../engine/types';

// ============================================================================
// 初始化
// ============================================================================

const DATA_DIR = path.join(os.homedir(), '.xiaoli');
const DB_PATH = path.join(DATA_DIR, 'data.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables();
  }
  return db;
}

// ============================================================================
// 建表
// ============================================================================

function initTables(): void {
  const d = getDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'questioning',
      plan TEXT,
      plan_status TEXT,
      cwd TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS qa_exchanges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT,
      question_order INTEGER NOT NULL,
      round INTEGER NOT NULL DEFAULT 1,
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
  `);
}

// ============================================================================
// 任务 CRUD
// ============================================================================

export function createTask(
  id: string,
  description: string,
  cwd: string,
): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO tasks (id, description, status, cwd, created_at, updated_at)
       VALUES (?, ?, 'questioning', ?, ?, ?)`,
    )
    .run(id, description, cwd, now, now);
}

export function updateTaskStatus(
  id: string,
  status: string,
  plan?: ExecutionPlan,
): void {
  const updates: string[] = ['status = ?', 'updated_at = ?'];
  const values: any[] = [status, Date.now()];

  if (plan) {
    updates.push('plan = ?', 'plan_status = ?');
    values.push(JSON.stringify(plan), plan.status);
  }

  values.push(id);
  getDb()
    .prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`)
    .run(...values);
}

export function getTask(id: string): any | null {
  return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) ?? null;
}

export function getLatestTask(): any | null {
  return getDb()
    .prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 1')
    .get() ?? null;
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
): void {
  getDb()
    .prepare(
      `INSERT INTO qa_exchanges (task_id, question, answer, question_order, round, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(taskId, question, answer, order, round, Date.now());
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
    .get(taskId, stepId);

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
  const values: any[] = [status];

  if (status === 'running') {
    updates.push('started_at = ?');
    values.push(Date.now());
  }
  if (status === 'completed' || status === 'failed') {
    updates.push('completed_at = ?');
    values.push(Date.now());
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
    .prepare(
      `UPDATE task_steps SET ${updates.join(', ')} WHERE task_id = ? AND step_id = ?`,
    )
    .run(...values);
}

export function incrementStepRecovery(taskId: string, stepId: string): void {
  getDb()
    .prepare(
      'UPDATE task_steps SET recovery_attempts = recovery_attempts + 1 WHERE task_id = ? AND step_id = ?',
    )
    .run(taskId, stepId);
}

// ============================================================================
// 项目记忆
// ============================================================================

export function setProjectMemory(
  projectPath: string,
  key: string,
  value: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO project_memory (project_path, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_path, key) DO UPDATE SET value = ?, updated_at = ?`,
    )
    .run(projectPath, key, value, Date.now(), value, Date.now());
}

export function getProjectMemory(
  projectPath: string,
  key: string,
): string | null {
  const row = getDb()
    .prepare(
      'SELECT value FROM project_memory WHERE project_path = ? AND key = ?',
    )
    .get(projectPath, key) as any;
  return row?.value ?? null;
}

// ============================================================================
// 用户偏好
// ============================================================================

export function setPreference(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO user_preferences (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`,
    )
    .run(key, value, Date.now(), value, Date.now());
}

export function getPreference(key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM user_preferences WHERE key = ?')
    .get(key) as any;
  return row?.value ?? null;
}
