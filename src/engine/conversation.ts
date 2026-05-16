/**
 * 对话引擎
 *
 * 状态机：
 *   IDLE → QUESTIONING → WAITING_ANSWER → ... → PLAN_READY
 *        → WAITING_CONFIRM → EXECUTING → COMPLETED / STUCK
 *
 * 职责：
 *   1. 接收用户任务描述
 *   2. 调用 AI 生成提问列表
 *   3. 逐个展示问题，收集用户回答
 *   4. 全部回答后 → 调用 AI 生成执行计划
 *   5. 用户确认 → 将计划转为步骤列表 → 交给执行器
 */

// TODO: 实现对话状态机
