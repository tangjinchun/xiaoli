/**
 * 执行计划终端渲染。
 */

import type { ExecutionPlan, ExecutionStep, RiskLevel } from './types.js';

function riskIcon(risk: RiskLevel): string {
  return risk === 'high' ? '🔴' : risk === 'medium' ? '🟡' : '🟢';
}

function statusIcon(status: ExecutionStep['status']): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'failed':
      return '✗';
    case 'skipped':
      return '⏭';
    case 'running':
      return '▶';
    case 'paused':
      return '⏸';
    default:
      return '○';
  }
}

function inputSummary(step: ExecutionStep): string {
  const raw = JSON.stringify(step.input);
  return raw.length > 140 ? `${raw.slice(0, 137)}...` : raw;
}

export function renderPlan(plan: ExecutionPlan): string {
  const lines: string[] = [];
  lines.push(`📋 执行计划：${plan.summary || plan.taskDescription}`);
  lines.push(`   共 ${plan.totalSteps} 步 · 计划 ID: ${plan.id}`);
  lines.push('');

  for (const phase of plan.phases) {
    lines.push(`═══ ${phase.name}（${phase.steps.length} 步）═══`);
    if (phase.purpose) lines.push(`   ${phase.purpose}`);
    for (const step of phase.steps) {
      lines.push(
        `  ${statusIcon(step.status)} ${riskIcon(step.riskLevel)} ${step.description}`,
      );
      lines.push(`      工具: ${step.tool}  ${inputSummary(step)}`);
      if (step.riskLevel === 'high' && step.riskReason) {
        lines.push(`      风险: ${step.riskReason.split('\n')[0]}`);
      }
      if (step.dependsOn.length > 0) {
        lines.push(`      依赖: ${step.dependsOn.join(', ')}`);
      }
      if (step.verify) {
        lines.push(`      验收: ${JSON.stringify(step.verify)}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function renderStepProgress(step: ExecutionStep, index: number, total: number): string {
  return `[${index + 1}/${total}] ${riskIcon(step.riskLevel)} ${step.description} (${step.tool})`;
}
