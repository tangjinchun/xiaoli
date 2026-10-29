/**
 * Prompt 模板统一出口。
 *
 * 具体模板放在 src/ai/prompts/ 下，业务代码从这里导入。
 */

export {
  buildQuestionGenSystemPrompt,
  parseQuestionGenResponse,
} from './prompts/question-gen.js';
export { buildPlanPrompt } from './prompts/plan-gen.js';
export {
  REFINEMENT_SYSTEM_PROMPT,
  buildRefinementContext,
  buildRefinementPrompt,
} from './prompts/refinement.js';
