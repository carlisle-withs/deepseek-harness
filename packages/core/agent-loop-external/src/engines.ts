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
 * The session's durable sandbox mode maps to each engine's permission flags
 * ({@link engineConfigForSession}); an explicit `_ARGS` override replaces
 * that derivation entirely.
 *
 * @module dsh-agent-loop-external/engines
 */

import type { LlmModelInfo, LlmProviderInfo, StreamChunk, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { EngineHarnessConfig, EngineTurnEvents, EngineTurnOutcome } from './process-turn.ts'
import { ClaudeCodeTurn } from './claude.ts'
import { PiTurn } from './pi.ts'
import { OpencodeTurn } from './opencode.ts'

const execFileAsync = promisify(execFile)

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
  /** Permission flags per dsh sandbox mode, replacing the engine's own default
   * permission behavior. One-shot children cannot ask, so the approval knob
   * has no mapping: `ask` collapses into each mode's least-privilege flags.
   * An omitted mode (pi) keeps the engine's own configuration.
   */
  readonly permissionArgs: Partial<Record<SandboxModeLike, readonly string[]>>
  /**
   * The engine's own model-list invocation: args appended to the command,
   * with a stdout parser. Oitted engines (claude: interactive listing) offer
   * only the `default` model in the picker.
   */
  readonly listModels?: {
    readonly args: readonly string[]
    readonly parse: (stdout: string) => readonly { id: string; name: string; provider?: string }[]
  }
  /** Build one live engine child. */
  readonly createTurn: (
    config: EngineHarnessConfig,
    cwd: string,
    events: EngineTurnEvents,
  ) => { start(prompt: string, resumeSessionId: string | null): Promise<EngineTurnOutcome>; stop(): void }
}

/**
 * The dsh sandbox mode engines treat as their default when the session never
 * overrode the permission knobs (the composition default preset).
 */
const DEFAULT_SANDBOX: SandboxModeLike = 'workspace-write'

/** The engines this loop drives, in picker order. */
export const ENGINES: readonly EngineDescriptor[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    envPrefix: 'CLAUDE',
    permissionArgs: {
      'danger-full-access': ['--permission-mode', 'bypassPermissions'],
      'workspace-write': ['--permission-mode', 'acceptEdits'],
      // default mode auto-denies unapproved write/exec tools in -p runs,
      // which is the closest one-shot equivalent of read-only.
      'read-only': ['--permission-mode', 'default'],
    },
    createTurn: (config, cwd, events) => new ClaudeCodeTurn(config, cwd, events),
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    envPrefix: 'OPENCODE',
    permissionArgs: {
      'danger-full-access': ['--auto'],
      'workspace-write': ['--auto'],
      // without --auto, unapproved operations are denied in run mode.
      'read-only': [],
    },
    // `opencode models` prints one `provider/model` id per line.
    listModels: {
      args: ['models'],
      parse: stdout => stdout.split('\n')
        .map(line => line.trim())
        .filter(line => line.includes('/'))
        .map((line) => {
          const at = line.lastIndexOf('/')
          return { id: line, name: line.slice(at + 1), provider: line.slice(0, at) }
        }),
    },
    createTurn: (config, cwd, events) => new OpencodeTurn(config, cwd, events),
  },
  {
    id: 'pi',
    name: 'Pi',
    command: 'pi',
    envPrefix: 'PI',
    permissionArgs: {},
    // `pi --list-models` prints a whitespace table: provider model context…
    listModels: {
      args: ['--list-models'],
      parse: stdout => stdout.split('\n')
        .map(line => line.trim().match(/^(\S+)\s+(\S+)\s/))
        .filter((match): match is RegExpMatchArray => match !== null && match[1] !== 'provider')
        .map((match) => {
          const engineProvider = match[1] ?? ''
          const modelId = match[2] ?? ''
          return { id: `${engineProvider}/${modelId}`, name: modelId, provider: engineProvider }
        }),
    },
    createTurn: (config, cwd, events) => new PiTurn(config, cwd, events),
  },
]

/** Provider ids of every drivable engine. */
export const ENGINE_PROVIDER_IDS: readonly string[] = ENGINES.map(engine => engine.id)

/** The engine used before any selection: `ENGINE_LOOP_ENGINE`, else claude. */
export const DEFAULT_ENGINE_ID = envDefaultEngine()

/** dsh sandbox modes the driver reads from the session's permission state. */
export type SandboxModeLike = 'read-only' | 'workspace-write' | 'danger-full-access'

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
 * Read one engine's raw env invocation (command, args, model) without any
 * permission derivation.
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
    extraArgs: (args ?? '').split(/\s+/).filter(Boolean),
    ...(model === undefined || model === '' ? {} : { model }),
  }
}

/**
 * Resolve one engine's invocation for a session turn: the env command and
 * model pins, plus permission flags derived from the session's durable
 * sandbox mode. An explicit `ENGINE_LOOP_<PREFIX>_ARGS` override replaces the
 * permission derivation entirely — the caller pinned the CLI surface.
 * @param engineId - provider id of the engine.
 * @param sandbox - the session's `permissions` projection sandbox knob, or
 *   null when the log never overrode it (the composition default applies).
 * @param env - environment to read; defaults to the process environment.
 */
export function engineConfigForSession(
  engineId: string,
  sandbox: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): EngineHarnessConfig {
  const config = engineConfigFromEnv(engineId, env)
  const engine = ENGINES.find(candidate => candidate.id === engineId)
  if (env[`ENGINE_LOOP_${engine?.envPrefix ?? engineId.toUpperCase()}_ARGS`] !== undefined) {
    return config
  }
  const mode = sandbox === null || sandbox === undefined || sandbox === '' ? DEFAULT_SANDBOX : sandbox
  const permission = engine?.permissionArgs[mode as SandboxModeLike]
  return { ...config, extraArgs: [...(permission ?? []), ...config.extraArgs] }
}

/** Back-compat alias for the phase-② claude env config. */
export const claudeConfigFromEnv = (env?: NodeJS.ProcessEnv): EngineHarnessConfig =>
  engineConfigFromEnv('claude-code', env)

/** Cache lifetime for one engine's CLI model list. */
const MODEL_LIST_TTL_MS = 60_000
/** One model-list invocation's hard timeout. */
const MODEL_LIST_TIMEOUT_MS = 10_000

/**
 * Catalog adapter for the engine providers: lists each engine as a picker
 * group whose `default` model defers to the CLI's own configuration. Engines
 * with a model-list command (`opencode models`, `pi --list-models`) populate
 * their real selectable ids, fetched once per TTL with a stale-while-
 * revalidate cache and a timeout fallback to the default-only listing. Model
 * calls never route through it — the external loop drives the CLIs directly.
 */
export class EngineCatalogAdapter extends LlmAdapter {
  private readonly cache = new Map<string, { at: number; models: readonly LlmModelInfo[] }>()
  private readonly pending = new Map<string, Promise<readonly LlmModelInfo[]>>()

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: ENGINES.find(engine => engine.id === provider)?.name ?? provider }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const engine = ENGINES.find(candidate => candidate.id === provider)
    const listing = engine === undefined ? undefined : engine.listModels
    if (engine === undefined || listing === undefined) {
      return Promise.resolve(this.defaultModels(provider))
    }
    const cached = this.cache.get(provider)
    if (cached !== undefined && Date.now() - cached.at < MODEL_LIST_TTL_MS) return cached.models
    let pending = this.pending.get(provider)
    if (pending === undefined) {
      pending = this.listFromCli(provider, engine.command, listing.args, listing.parse)
        .catch(() => this.defaultModels(provider))
        .then((models) => {
          this.cache.set(provider, { at: Date.now(), models })
          return models
        })
      this.pending.set(provider, pending)
      void pending.then(() => { this.pending.delete(provider) }, () => { this.pending.delete(provider) })
    }
    return cached?.models ?? pending
  }

  /** The always-offered fallback listing: the CLI's own default model. */
  private defaultModels(provider: string): readonly LlmModelInfo[] {
    const pinned = engineConfigFromEnv(provider).model
    const models: LlmModelInfo[] = [
      { provider, id: ENGINE_DEFAULT_MODEL, name: '引擎默认模型' },
    ]
    if (pinned !== undefined && pinned !== ENGINE_DEFAULT_MODEL) {
      models.push({ provider, id: pinned, name: pinned })
    }
    return models
  }

  /** Spawn one engine's model-list command and parse its stdout. */
  private async listFromCli(
    provider: string,
    command: string,
    args: readonly string[],
    parse: (stdout: string) => readonly { id: string; name: string; provider?: string }[],
  ): Promise<readonly LlmModelInfo[]> {
    const { stdout } = await execFileAsync(command, [...args], {
      timeout: MODEL_LIST_TIMEOUT_MS,
      windowsHide: true,
      // npm-installed CLIs are .cmd shims only spawnable through a shell.
      shell: process.platform === 'win32',
      maxBuffer: 4 * 1024 * 1024,
    })
    const listed = parse(stdout)
      .filter(model => model.id !== ENGINE_DEFAULT_MODEL)
      .map(model => ({
        provider,
        id: model.id,
        name: model.name,
        ...(model.provider === undefined ? {} : { description: model.provider }),
      }))
    const fallback = this.defaultModels(provider)[0]
    return fallback === undefined ? listed : [fallback, ...listed]
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('engine providers are driven by the external agent loop, not the llm stream API')
  }
}
