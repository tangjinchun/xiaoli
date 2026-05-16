/**
 * 执行计划生成 Prompt 模板
 *
 * 对应设计文档 §5.2
 * 职责：基于追问结果，生成分阶段、可验证、有风险标注的执行计划
 */

/**
 * 构建执行计划生成的完整 Prompt
 * plan-generator.ts 调用此函数
 *
 * @param qaContext - 格式化后的问答上下文（问→答）
 * @param taskDescription - 用户原始任务描述
 * @returns 完整 Prompt 字符串
 */
export function buildPlanPrompt(qaContext: string, taskDescription: string): string {
  return `你是一个技术主管，需要根据用户的需求和追问结果，生成一份可执行的开发计划。

## 用户的原始任务
${taskDescription}

## 追问结果（用户已回答的问题）
${qaContext || "（无追问信息）"}

## 规则
1. **Phase 顺序**：诊断 → 方案 → 实现 → 验证 → 收尾
2. **每个 Step 必须是原子操作**
3. **第一步必须是「无害探测」**（只读）
4. **每个 Step 推荐工具**（toolHints）：read_file | write_file | terminal | git | database | ask_user
5. **每步有验收标准**（acceptanceCriteria）
6. **每个 Step 强制标注风险等级**（riskLevel）：
   - "high"：删除操作、数据库 DDL、git push --force、生产环境操作
   - "medium"：修改代码文件、git commit、配置文件修改
   - "low"：只读操作、查询、状态检查
7. 风险标为 "high" 的 Step 需要用户确认后才执行
8. **每步标注依赖**（dependsOn）：引用前置步骤的 stepId
9. **每步估算耗时**（estimatedTime）

请只返回 JSON，不要包含任何其他文字：
{
  "summary": "一句话描述整个计划",
  "phases": [
    {
      "phaseId": "phase-1",
      "name": "Phase 1: 诊断分析",
      "purpose": "这个阶段的目标是什么",
      "steps": [
        {
          "stepId": "phase-1-step-1",
          "description": "做什么操作",
          "toolHints": ["read_file", "shell"],
          "riskLevel": "low",
          "riskReason": "只读操作，无风险",
          "dependsOn": [],
          "acceptanceCriteria": "如何判断这一步做完了",
          "estimatedTime": "5分钟"
        }
      ]
    }
  ]
}`;
}
