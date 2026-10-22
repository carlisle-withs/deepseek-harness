/**
 * External-harness agent-loop plugin: the default `dsh-agent-loop` factory
 * with its driver replaced by {@link ExternalAgent}, which runs each turn
 * through an external CLI engine — claude, opencode, or pi (see ./engines.ts)
 * — instead of the in-process LLM React loop.
 *
 * Mount this package in place of `@deepseek-ai/dsh-agent-loop` (the bundle row
 * keeps id `agent-loop`); everything else — projections, registry publication,
 * teardown, config schema, `setFactory` registration — is inherited unchanged.
 * The engines also register as catalog providers, so the unchanged model
 * picker offers them as selectable routes.
 *
 * @module @deepseek-ai/dsh-agent-loop-external
 */
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { AgentDriver } from '@deepseek-ai/dsh-agent-loop'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ExternalAgent } from './agent.ts'
import { ENGINE_PROVIDER_IDS, EngineCatalogAdapter } from './engines.ts'

export { ExternalAgent }

/**
 * The default agent-loop factory driving dsh sessions through an external CLI
 * engine. Inherits {@link AgentLoop}'s constructor — including its
 * `ctx.agents.setFactory(this)` effect, which registers this same Service
 * instance — so ONLY driver construction is replaced, plus the engine catalog
 * registration that lists the engines in the model picker.
 */
export class ExternalAgentLoop extends AgentLoop {
  constructor(ctx: Context, config: ConstructorParameters<typeof AgentLoop>[1]) {
    super(ctx, config)
    ctx.effect(() => {
      // A picker registration conflict (another adapter already owns one of
      // the engine ids) must not take the agent factory down: engines keep
      // running, only their picker entries are missing.
      try {
        const unregister = ctx.llm.registerAdapter([...ENGINE_PROVIDER_IDS], new EngineCatalogAdapter())
        return () => { unregister() }
      } catch (error: unknown) {
        ctx.logger.warn(`agent-loop-external: engine catalog registration failed: ${String(error)}`)
        return () => {}
      }
    }, 'agent-loop-external.registerEngineCatalog()')
  }

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
