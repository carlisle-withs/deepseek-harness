/**
 * External-harness agent-loop plugin: the default `dsh-agent-loop` factory
 * with its driver replaced by {@link ExternalAgent}, which runs each turn
 * through an external CLI harness (Phase ②: the Claude Code CLI bridge in
 * ./claude.ts) instead of the in-process LLM React loop.
 *
 * Mount this package in place of `@deepseek-ai/dsh-agent-loop` (the bundle row
 * keeps id `agent-loop`); everything else — projections, registry publication,
 * teardown, config schema, `setFactory` registration — is inherited unchanged.
 *
 * @module @deepseek-ai/dsh-agent-loop-external
 */
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { AgentDriver } from '@deepseek-ai/dsh-agent-loop'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ExternalAgent } from './agent.ts'

export { ExternalAgent }

/**
 * The default agent-loop factory driving dsh sessions through an external CLI
 * harness. Inherits {@link AgentLoop}'s constructor — including its
 * `ctx.agents.setFactory(this)` effect, which registers this same Service
 * instance — so ONLY driver construction is replaced.
 */
export class ExternalAgentLoop extends AgentLoop {
  /** Construct one {@link ExternalAgent} instead of the in-process React loop. */
  protected override createDriver(
    loopCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
  ): AgentDriver {
    return new ExternalAgent(loopCtx, id, options, session)
  }
}

export default ExternalAgentLoop
