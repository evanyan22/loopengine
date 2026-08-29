// Aggregates every system tool into one place, the same one-file-per-tool
// + index.ts convention agents/file-agent/tools/index.ts already follows.
// systemTools is the *static* set (fixed closures, no per-call state
// needed) that run-agent.ts spreads directly into every agent's tools —
// see its own doc comment there for the merge/precedence rules. Not every
// system tool fits that shape, though: ask_user needs a fresh instance
// per runAgent() call (its onPending hook closes over that call's own
// onEvent — see ask_user.ts's own doc comment), so its *builder* is
// re-exported here instead of an instance.
import { readFile } from './read_file.js'
import type { ToolDefinition } from '../agent-config.js'

export const systemTools: ToolDefinition[] = [readFile]

export {
  createAskUserTool,
  listQuestions,
  answerQuestion,
  findQuestion,
  CliQuestionHandler,
  WebQuestionHandler,
  DurableWebQuestionHandler,
  isDurableQuestionHandler,
  type PendingQuestion,
} from './ask_user.js'
