#!/usr/bin/env node

/**
 * xiaoli CLI — 主入口
 *
 * 完整管线: L1(上下文) → L2(追问生成) → L3(追问收束) → 计划生成 → 计划确认 → 执行
 */

import { buildContext, formatContextForPrompt } from "./engine/context-builder.js";
import { generateQuestions } from "./engine/question-generator.js";
import { collectAnswers } from "./engine/question-collector.js";
import { generateRefinementQuestions } from "./engine/question-refiner.js";
import { generatePlan } from "./engine/plan-generator.js";

async function main(): Promise<void> {
  const task = process.argv.slice(2).join(" ") || "帮我优化项目";

  console.log(`\n🔨 xiaoli 收到了任务: "${task}"\n`);

  // ─── L1: 上下文注入 ───
  console.log("📖 L1: 分析项目上下文...");
  const ctx = buildContext(task);
  console.log(`   项目类型: ${ctx.projectType}`);
  console.log(`   技术栈: ${ctx.techStack.framework || ctx.techStack.language}`);
  console.log(`   文件总数: ${ctx.fileCount}`);
  if (ctx.relevantFiles.length > 0) {
    console.log(`   相关文件: ${ctx.relevantFiles.slice(0, 5).join(", ")}`);
  }
  console.log("");

  // ─── L2: 追问生成 ───
  console.log("🤔 L2: 生成追问...");
  const projectContextStr = formatContextForPrompt(ctx);
  const questions = await generateQuestions(task);
  console.log(`   生成了 ${questions.length} 个追问\n`);

  // ─── L3: 追问收集 + 收束 ───
  const maxRefineRounds = 3;
  let allAnswered = await runCollectAndRefine(questions, maxRefineRounds, task);

  // ─── 计划生成 ───
  console.log("📋 生成执行计划...");
  try {
    const plan = await generatePlan(allAnswered, task);
    console.log(`\n✅ 执行计划已生成: ${plan.id}`);
    console.log(`   阶段数: ${plan.phases.length}`);
    console.log(`   步骤数: ${plan.steps.length}\n`);

    for (const phase of plan.phases) {
      console.log(`  📌 ${phase.name} — ${phase.purpose}`);
      for (const step of phase.steps) {
        const riskEmoji = step.riskLevel === "high" ? "🔴" : step.riskLevel === "medium" ? "🟡" : "🟢";
        console.log(`     ${riskEmoji} ${step.id}: ${step.description}`);
      }
      console.log("");
    }

    console.log("  ══════════════════════════════════════");
    console.log("  xiaoli: 计划如上。输入 /confirm 开始执行，或 /reject 放弃。");
    console.log("  ══════════════════════════════════════\n");
    console.log("  (计划确认门 — 执行器待后续版本接入)\n");
  } catch (err) {
    console.error(`  ❌ 计划生成失败: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * 追问收集 + 梯度追收束，最多 maxRounds 轮
 */
async function runCollectAndRefine(
  initialQuestions: any[],
  maxRounds: number,
  _task: string
): Promise<any[]> {
  let allAnswered: any[] = [];
  let currentQuestions = initialQuestions;
  let previousRemainingGaps: number[] = [];

  for (let round = 0; round < maxRounds; round++) {
    // 收集回答
    const result = await collectAnswers(currentQuestions);
    allAnswered = allAnswered.concat(result.answered);

    if (result.skipped.length === currentQuestions.length && result.answered.length === 0) {
      // 用户跳过了本轮所有问题
      console.log("  ⏭️ 本轮全部跳过。");
      break;
    }

    // 检测缺口
    const refinement = generateRefinementQuestions(allAnswered, currentQuestions);

    if (refinement.canTerminate) {
      console.log(
        refinement.remainingGaps === 0
          ? "  ✅ 信息缺口已闭合，追问结束。"
          : `  ⏹️ 追问终止（${refinement.remainingGaps} 个缺口，收敛/达上限）。`
      );
      break;
    }

    if (refinement.newQuestions.length === 0) {
      console.log("  ✅ 无新增追问。");
      break;
    }

    console.log(`  🔄 还有 ${refinement.remainingGaps} 个信息缺口，补充追问 (${refinement.newQuestions.length} 个)：\n`);
    previousRemainingGaps.push(refinement.remainingGaps);
    currentQuestions = refinement.newQuestions;
  }

  return allAnswered;
}

main().catch((err) => {
  console.error("xiaoli 运行失败:", err);
  process.exit(1);
});
