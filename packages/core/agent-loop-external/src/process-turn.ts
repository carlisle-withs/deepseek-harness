/**
 * Shared child-process shell for one-shot JSONL streaming engines: the prompt
 * travels on stdin (UTF-8), stdout is parsed line by line into JSON events,
 * stderr is retained for diagnostics, and {@link JsonlProcessTurn.stop} tears
 * down the whole Windows process tree. Engine parsers subclass this shell and
 * settle exactly one terminal {@link EngineTurnOutcome}.
 *
 * @module dsh-agent-loop-external/process-turn
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/** One parsed JSONL record, already narrowed to an object. */
export type EngineRecord = Record<string, unknown>

/**
 * Loose JSON shape of one assistant content block, normalized across engines
 * to claude's vocabulary (`text`, `thinking`, `tool_use` with `input`).
 */
export interface EngineContentBlock {
  readonly type: string
  readonly text?: string
  readonly thinking?: string
  readonly id?: string
  readonly name?: string
  readonly input?: unknown
}

/** Token accounting mapped from an engine's terminal event. */
export interface EngineTurnUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * Streaming events one external turn folds into its durable log. The indexes
 * of the delta callbacks are content-block indexes for stream assembly; an
 * engine without block structure may use one fixed index per stream kind.
 */
export interface EngineTurnEvents {
  /** Engine thread identity; the driver stores it for later resume. */
  onSessionId(sessionId: string): void
  /** Model id the engine reported, for assistant attribution. */
  onModel(model: string): void
  /** One assistant text delta. */
  onTextDelta(index: number, text: string): void
  /** One assistant thinking delta; the driver maps it to reasoning. */
  onThinkingDelta(index: number, text: string): void
  /** Tool-arguments JSON fragment for an open tool call. */
  onToolUseDelta(index: number, id: string, name: string, argumentsDelta: string): void
  /**
   * One complete internal model round, when the engine reports message
   * boundaries; engines without them omit this and the driver commits the
   * streamed round at the terminal outcome.
   */
  onAssistantMessage(content: readonly EngineContentBlock[]): void
  /** One completed tool invocation. */
  onToolResult(callId: string, text: string, isError: boolean): void
}

/** Terminal outcome of one engine child. */
export interface EngineTurnOutcome {
  /** `success`, an engine error subtype, or a local `error_*`/`interrupted` marker. */
  subtype: string
  /** Final assistant text; empty on local failures. */
  text: string
  /** Engine thread identity seen this turn, for a later resume. */
  sessionId: string | null
  /** Token accounting from the terminal event, when one arrived. */
  usage: EngineTurnUsage | null
  /** Whether {@link JsonlProcessTurn.stop} ended the child before its result. */
  interrupted: boolean
  /** Tail of stderr, for diagnostics on abnormal exits. */
  stderrTail: string
}

/** The outcome fields every terminal path supplies; the shell attaches stderr. */
export type EngineTurnOutcomeInput = Omit<EngineTurnOutcome, 'stderrTail'>

/** How to invoke one engine CLI child. */
export interface EngineHarnessConfig {
  /** Executable name or path; resolved through the shell on Windows. */
  command: string
  /** Extra arguments appended after the engine's fixed flags. */
  extraArgs: readonly string[]
  /** Model override passed as the engine's model flag, omitted when absent. */
  model?: string
}

/** Characters of stderr retained for failure diagnostics. */
const STDERR_TAIL_CHARS = 2000

/**
 * One live engine child over its JSONL protocol. Subclasses translate engine
 * events into {@link EngineTurnEvents}; the outcome settles once, whether from
 * a terminal engine event or a local failure.
 */
export abstract class JsonlProcessTurn {
  private child: ChildProcess | undefined
  /** Whether {@link stop} was requested; subclasses read it for interrupted outcomes. */
  protected stopped = false
  private settled = false
  private stderrTail = ''
  private readonly done = Promise.withResolvers<EngineTurnOutcome>()

  constructor(protected readonly config: EngineHarnessConfig, private readonly cwd: string) {}

  /** Engine label for local error messages. */
  protected abstract get engineLabel(): string

  /** The argv for one engine child, including its resume continuation. */
  protected abstract buildCommand(resumeSessionId: string | null): { command: string; args: string[] }

  /** Fold one parsed stdout JSON line into events or a terminal outcome. */
  protected abstract consume(event: EngineRecord): void

  /** One non-JSON stdout line; engines that interleave plain text override it. */
  protected consumeText(_line: string): void {}

  /** Fallback outcome when the process exits without settling; default is a local error. */
  protected onProcessExit(code: number | null): void {
    this.finish(this.errorOutcome(this.stderrTail.trim() || `exit ${code}`))
  }

  /** The local failure outcome for this engine. */
  protected errorOutcome(message: string): EngineTurnOutcomeInput {
    return {
      subtype: this.stopped ? 'interrupted' : 'error_local',
      text: `${this.engineLabel}: ${message}`,
      sessionId: null,
      usage: null,
      interrupted: this.stopped,
    }
  }

  /** Record the first terminal outcome; later candidates are dropped. */
  protected finish(outcome: EngineTurnOutcomeInput): void {
    if (this.settled) return
    this.settled = true
    this.done.resolve({ ...outcome, stderrTail: this.stderrTail })
  }

  /**
   * Spawn the child and run one prompt to its terminal outcome.
   * @param prompt - the turn's input text, written to stdin as UTF-8.
   * @param resumeSessionId - an engine thread id to continue, or null.
   * @returns the terminal outcome; never rejects — local failures resolve
   *   with an `error_*` subtype.
   */
  start(prompt: string, resumeSessionId: string | null): Promise<EngineTurnOutcome> {
    const { command, args } = this.buildCommand(resumeSessionId)
    const child = this.child = spawn(command, args, {
      cwd: this.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // npm-installed CLIs are .cmd shims only spawnable through a shell.
      shell: process.platform === 'win32',
    })
    const { stdin, stdout, stderr } = child
    stdin.on('error', () => {
      // An early exit closes the pipe before the prompt finishes writing.
    })
    stdin.write(prompt, 'utf8')
    stdin.end()
    const lines = createInterface({ input: stdout, crlfDelay: Infinity })
    lines.on('line', (line: string) => { this.consumeLine(line) })
    stderr.setEncoding('utf8')
    stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
    })
    child.on('error', (error: Error) => {
      this.finish({
        subtype: 'error_local',
        text: `${this.engineLabel} CLI failed to start: ${error.message}`,
        sessionId: null,
        usage: null,
        interrupted: false,
      })
    })
    child.on('close', (code: number | null) => {
      if (!this.settled) this.onProcessExit(code)
    })
    return this.done.promise
  }

  /** Tear the child down; the awaiting {@link start} settles as interrupted. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    const child = this.child
    if (child === undefined || child.exitCode !== null) return
    if (process.platform !== 'win32') {
      child.kill()
      return
    }
    // shell:true wraps the CLI in cmd.exe; killing only the wrapper orphans
    // the engine. taskkill /T removes the whole tree, falling back to a
    // direct kill when taskkill itself cannot start.
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.on('error', () => { child.kill() })
  }

  /** Parse one stdout line as JSON when possible and dispatch it. */
  private consumeLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      this.consumeText(trimmed)
      return
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      this.consume(parsed as EngineRecord)
    }
  }
}
