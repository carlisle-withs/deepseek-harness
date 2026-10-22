/**
 * Engine registry: the CLI harnesses this loop can drive, each identified by
 * the provider id the dsh model picker selects. Every engine also registers
 * as a catalog provider through {@link EngineCatalogAdapter}, so the unchanged
 * model picker lists them as selectable routes; picking one routes that
 * session's turns to the engine (its `default` model id defers to the CLI's
 * own configured model).
 *
 * Per-engine env overrides: `ENGINE_LOOP_<PREFIX>_COMMAND`, `_ARGS`, and
 * `_MODEL` (prefixes: CLAUDE, OPENCODE, PI). `ENGINE_LOOP_ENGINE` sets the
 * engine used before any selection, for headless runs and default routing.
 *
 * @module dsh-agent-loop-external/engines
 */

import type { LlmModelInfo, LlmProviderInfo, StreamChunk, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { EngineHarnessConfig, EngineTurnEvents, EngineTurnOutcome } from './process-turn.ts'
import { ClaudeCodeTurn } from './claude.ts'
import { PiTurn } from './pi.ts'
import { OpencodeTurn } from './opencode.ts'

/** The model id that defers model choice to the engine CLI's own configuration. */
export const ENGINE_DEFAULT_MODEL = 'default'

/** One drivable engine and its catalog identity. */
interface EngineDescriptor {
  /** Provider id used in selections and the catalog. */
  readonly id: string
  /** Display name in the model picker. */
  readonly name: string
  /** Executable invoked when no `ENGINE_LOOP_<PREFIX>_COMMAND` override exists. */
  readonly command: string
  /** Env prefix for this engine's overrides (`ENGINE_LOOP_<PREFIX>_…`). */
  readonly envPrefix: string
  /** Default extra args appended to the engine's fixed flags. */
  readonly defaultArgs: string
  /** Build one live engine child. */
  readonly createTurn: (
    config: EngineHarnessConfig,
    cwd: string,
    events: EngineTurnEvents,
  ) => { start(prompt: string, resumeSessionId: string | null): Promise<EngineTurnOutcome>; stop(): void }
}

/** The engines this loop drives, in picker order. */
export const ENGINES: readonly EngineDescriptor[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    envPrefix: 'CLAUDE',
    defaultArgs: '--permission-mode acceptEdits',
    createTurn: (config, cwd, events) => new ClaudeCodeTurn(config, cwd, events),
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    envPrefix: 'OPENCODE',
    defaultArgs: '--auto',
    createTurn: (config, cwd, events) => new OpencodeTurn(config, cwd, events),
  },
  {
    id: 'pi',
    name: 'Pi',
    command: 'pi',
    envPrefix: 'PI',
    defaultArgs: '',
    createTurn: (config, cwd, events) => new PiTurn(config, cwd, events),
  },
]

/** Provider ids of every drivable engine. */
export const ENGINE_PROVIDER_IDS: readonly string[] = ENGINES.map(engine => engine.id)

/** The engine used before any selection: `ENGINE_LOOP_ENGINE`, else claude. */
export const DEFAULT_ENGINE_ID = envDefaultEngine()

function envDefaultEngine(env: NodeJS.ProcessEnv = process.env): string {
  const requested = env.ENGINE_LOOP_ENGINE?.trim()
  if (requested !== undefined && requested !== '') {
    const match = ENGINES.find(engine => engine.id === requested)
    if (match !== undefined) return match.id
  }
  return 'claude-code'
}

/** Whether a provider id names a drivable engine. */
export function isEngineProviderId(provider: string): boolean {
  return ENGINES.some(engine => engine.id === provider)
}

/**
 * Read one engine's invocation from its `ENGINE_LOOP_<PREFIX>_*` overrides.
 * @param engineId - provider id of the engine.
 * @param env - environment to read; defaults to the process environment.
 */
export function engineConfigFromEnv(
  engineId: string,
  env: NodeJS.ProcessEnv = process.env,
): EngineHarnessConfig {
  const engine = ENGINES.find(candidate => candidate.id === engineId)
  const prefix = engine === undefined ? engineId.toUpperCase().replace(/-/g, '_') : engine.envPrefix
  const command = env[`ENGINE_LOOP_${prefix}_COMMAND`]?.trim()
  const args = env[`ENGINE_LOOP_${prefix}_ARGS`]
  const model = env[`ENGINE_LOOP_${prefix}_MODEL`]?.trim()
  return {
    command: command === undefined || command === '' ? (engine?.command ?? engineId) : command,
    extraArgs: (args ?? engine?.defaultArgs ?? '').split(/\s+/).filter(Boolean),
    ...(model === undefined || model === '' ? {} : { model }),
  }
}

/** Back-compat alias for the phase-② claude env config. */
export const claudeConfigFromEnv = (env?: NodeJS.ProcessEnv): EngineHarnessConfig =>
  engineConfigFromEnv('claude-code', env)

/**
 * Catalog adapter for the engine providers: lists each engine as a picker
 * group whose `default` model defers to the CLI's own configuration (an env
 * model pin also appears as a concrete selectable id). Model calls never
 * route through it — the external loop drives the CLIs directly.
 */
export class EngineCatalogAdapter extends LlmAdapter {
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: ENGINES.find(engine => engine.id === provider)?.name ?? provider }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const pinned = engineConfigFromEnv(provider).model
    const models: LlmModelInfo[] = [
      { provider, id: ENGINE_DEFAULT_MODEL, name: '引擎默认模型' },
    ]
    if (pinned !== undefined && pinned !== ENGINE_DEFAULT_MODEL) {
      models.push({ provider, id: pinned, name: pinned })
    }
    return Promise.resolve(models)
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('engine providers are driven by the external agent loop, not the llm stream API')
  }
}
