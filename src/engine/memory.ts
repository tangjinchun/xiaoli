/**
 * 项目记忆。
 *
 * 只保存低风险、可复用的项目事实：技术栈、上次任务、常用命令。
 * 不保存密钥、数据库密码或源码内容。
 */

import { getProjectMemory, setProjectMemory } from '../storage/db.js';
import type { ProjectContext } from './context-builder.js';

export function rememberProjectContext(cwd: string, ctx: ProjectContext, task: string): void {
  try {
    setProjectMemory(cwd, 'techStack', JSON.stringify(ctx.techStack));
    setProjectMemory(cwd, 'projectType', ctx.projectType);
    setProjectMemory(cwd, 'lastTask', task);
  } catch {
    // 记忆失败不影响主流程
  }
}

export interface ProjectMemorySummary {
  projectType?: string;
  lastTask?: string;
}

export function recallProjectContext(cwd: string): ProjectMemorySummary {
  try {
    return {
      projectType: getProjectMemory(cwd, 'projectType') ?? undefined,
      lastTask: getProjectMemory(cwd, 'lastTask') ?? undefined,
    };
  } catch {
    return {};
  }
}
