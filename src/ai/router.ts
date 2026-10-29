/**
 * 模型分流。
 *
 * reasoning：追问生成、计划生成、代码分析、错误诊断（高推理任务）
 * fast：追问收束、摘要、简单分类（低延迟任务）
 */

import { loadConfig } from '../storage/config.js';

export type ModelKind = 'reasoning' | 'fast';

export function modelFor(kind: ModelKind = 'reasoning'): string {
  const config = loadConfig();
  return kind === 'fast' ? config.api.modelFlash : config.api.modelPro;
}
