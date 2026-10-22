/**
 * Claude Code CLI bridge: one spawned `claude -p --output-format
 * stream-json` child per external turn, translating its JSONL event stream
 * into driver callbacks. Turn continuity rides the CLI's own session
 * persistence — the first turn captures `session_id` from `system/init`,
 * later turns pass `--resume <id>` so prior context is never re-sent.
 *
 * The parsing logic is ported from the engine-shim prototype (battle-tested
 * against Claude Code 2.x). The invocation is env-overridable via
 * `ENGINE_LOOP_CLAUDE_COMMAND`, `ENGINE_LOOP_CLAUDE_ARGS` (default
 * `--permission-mode acceptEdits`), and `ENGINE_LOOP_CLAUDE_MODEL`.
 *
 * @module dsh-agent-loop-external/claude
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/** One parsed JSONL record, already narrowed to an object. */
type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asIndex(value: unknown): number {
  const index = Number(value)
  return Number.isSafeInteger(index) && index >= 0 ? index : -1
}

/** How to invoke the external claude CLI. */
export interface ClaudeHarnessConfig {
  /** Executable name or path; resolved through the shell on Windows. */
  command: string
  /** Extra arguments appended after the fixed streaming flags. */
  extraArgs: readonly string[]
  /** `--model` override, omitted when absent. */
  model?: string
}

/**
 * Read the harness invocation from `ENGINE_LOOP_CLAUDE_*` overrides.
 * @param env - environment to read; defaults to the process environment.
 * @returns the resolved invocation with sensible defaults.
 */
export function claudeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ClaudeHarnessConfig {
  const model = env.ENGINE_LOOP_CLAUDE_MODEL?.trim()
  return {
    command: env.ENGINE_LOOP_CLAUDE_COMMAND?.trim() || 'claude',
    extraArgs: (env.ENGINE_LOOP_CLAUDE_ARGS ?? '--permission-mode acceptEdits')
      .split(/\s+/)
      .filter(Boolean),
    ...(model === undefined || model === '' ? {} : { model }),
  }
}

/** Loose JSON shape of one claude assistant content block. */
export interface ClaudeContentBlock {
  readonly type: string
  readonly text?: string
  readonly thinking?: string
  readonly id?: string
  readonly name?: string
  readonly input?: unknown
}

/** Content blocks of one claude assistant message, already narrowed. */
function contentBlocks(message: unknown): readonly ClaudeContentBlock[] {
  const content = asRecord(message)?.['content']
  if (!Array.isArray(content)) return []
  return content.filter((block): block is ClaudeContentBlock => asRecord(block) !== undefined)
}

/** Token accounting mapped from the terminal `result` event's `usage`. */
export interface ClaudeTurnUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Streaming events one external turn folds into its durable log. */
export interface ClaudeTurnEvents {
  /** Session identity from `system/init`; the driver stores it for `--resume`. */
  onSessionId(sessionId: string): void
  /** Model id from `system/init`. */
  onModel(model: string): void
  /** One assistant text delta (`stream_event` `content_block_delta`). */
  onTextDelta(index: number, text: string): void
  /** One assistant thinking delta; the driver maps it to reasoning. */
  onThinkingDelta(index: number, text: string): void
  /** One tool-arguments JSON fragment for an open `tool_use` block. */
  onToolUseDelta(index: number, id: string, name: string, argumentsDelta: string): void
  /** One complete internal model round (claude `assistant` event). */
  onAssistantMessage(content: readonly ClaudeContentBlock[]): void
  /** One completed tool invocation (a `tool_result` block of a `user` event). */
  onToolResult(callId: string, text: string, isError: boolean): void
}

/** Terminal outcome of one claude child, from its `result` event or exit. */
export interface ClaudeTurnOutcome {
  /** `success`, a claude error subtype, or a local `error_*`/`interrupted` marker. */
  subtype: string
  /** Final assistant text (claude `result.result`); empty on local failures. */
  text: string
  /** Session identity seen this turn, for a later `--resume`. */
  sessionId: string | null
  /** Token accounting from the `result` event, when one arrived. */
  usage: ClaudeTurnUsage | null
  /** Whether {@link ClaudeCodeTurn.stop} ended the child before its result. */
  interrupted: boolean
  /** Tail of stderr, for diagnostics on abnormal exits. */
  stderrTail: string
}

/** The unresolved outcome fields every terminal path supplies. */
type OutcomeInput = Omit<ClaudeTurnOutcome, 'stderrTail'>

/** One accumulating `tool_use` content block between its start and stop. */
interface BlockAccumulator {
  kind: string
  toolCallId?: string
  toolName?: string
  inputJson: string
}

/** Characters of stderr retained for failure diagnostics. */
const STDERR_TAIL_CHARS = 2000

/**
 * One live `claude -p` child. The prompt travels on stdin — a Windows shell
 * argument list cannot carry multiline text, while `claude -p` reads a piped
 * stdin as its prompt. Stdout JSONL is parsed line by line into
 * {@link ClaudeTurnEvents}; `stop()` tears down the whole process tree so a
 * cancelled turn closes immediately instead of waiting for the engine.
 */
export class ClaudeCodeTurn {
  private child: ChildProcess | undefined
  private stopped = false
  private settled = false
  private stderrTail = ''
  private knownSessionId: string | null = null
  private outcome: ClaudeTurnOutcome | undefined
  private readonly blocks = new Map<number, BlockAccumulator>()
  private readonly done = Promise.withResolvers<ClaudeTurnOutcome>()

  constructor(
    private readonly config: ClaudeHarnessConfig,
    private readonly cwd: string,
    private readonly events: ClaudeTurnEvents,
  ) {}

  /**
   * Spawn the child and run one prompt to its terminal event.
   * @param prompt - the turn's input text, written to stdin as UTF-8.
   * @param resumeSessionId - a captured session id to resume, or null.
   * @returns the terminal outcome; never rejects — local failures resolve
   *   with an `error_*` subtype.
   */
  start(prompt: string, resumeSessionId: string | null): Promise<ClaudeTurnOutcome> {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      // 2.x emits per-delta stream_event frames only with this flag.
      '--include-partial-messages',
      ...this.config.extraArgs,
    ]
    if (this.config.model !== undefined) args.push('--model', this.config.model)
    if (resumeSessionId !== null) args.push('--resume', resumeSessionId)
    const child = this.child = spawn(this.config.command, args, {
      cwd: this.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // The npm-installed claude is a .cmd shim only spawnable through a shell.
      shell: process.platform === 'win32',
    })
    const { stdin, stdout, stderr } = child
    stdin.on('error', () => {
      // An early exit closes the pipe before the prompt finishes writing.
    })
    stdin.write(prompt, 'utf8')
    stdin.end()

    const lines = createInterface({ input: stdout, crlfDelay: Infinity })
    lines.on('line', (line) => { this.consume(line) })
    stderr.setEncoding('utf8')
    stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
    })
    child.on('error', (error: Error) => {
      this.finish({
        subtype: 'error_local',
        text: `claude CLI failed to start: ${error.message}`,
        sessionId: this.knownSessionId,
        usage: null,
        interrupted: false,
      })
    })
    child.on('close', () => {
      this.finish({
        subtype: this.stopped ? 'interrupted' : 'error_exit',
        text: this.stderrTail.trim(),
        sessionId: this.knownSessionId,
        usage: null,
        interrupted: this.stopped,
      })
      const outcome = this.outcome
      if (outcome !== undefined) this.done.resolve(outcome)
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

  /** Record the first terminal outcome; later candidates are dropped. */
  private finish(outcome: OutcomeInput): void {
    if (this.settled) return
    this.settled = true
    this.outcome = { ...outcome, stderrTail: this.stderrTail }
  }

  /** Parse one stdout JSONL line into turn events. */
  private consume(line: string): void {
    const trimmed = line.trim()
    if (trimmed === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return // a truncated non-JSON line carries no protocol meaning
    }
    const event = asRecord(parsed)
    if (event === undefined) return
    switch (event['type']) {
      case 'system': {
        if (event['subtype'] !== 'init') return
        const sessionId = asString(event['session_id'])
        if (sessionId !== undefined) {
          this.knownSessionId = sessionId
          this.events.onSessionId(sessionId)
        }
        const model = asString(event['model'])
        if (model !== undefined) this.events.onModel(model)
        return
      }
      case 'stream_event':
        this.consumeStreamEvent(event['event'])
        return
      case 'assistant':
        this.events.onAssistantMessage(contentBlocks(event['message']))
        return
      case 'user':
        this.consumeToolResults(event['message'])
        return
      case 'result': {
        const rawUsage = asRecord(event['usage'])
        this.finish({
          subtype: asString(event['subtype']) ?? 'success',
          text: typeof event['result'] === 'string' ? event['result'] : '',
          sessionId: asString(event['session_id']) ?? this.knownSessionId,
          usage: rawUsage === undefined ? null : {
            inputTokens: Number(rawUsage['input_tokens'] ?? 0),
            outputTokens: Number(rawUsage['output_tokens'] ?? 0),
            cacheReadTokens: Number(rawUsage['cache_read_input_tokens'] ?? 0),
            cacheWriteTokens: Number(rawUsage['cache_creation_input_tokens'] ?? 0),
          },
          interrupted: this.stopped,
        })
        return
      }
      default:
        return
    }
  }

  /** Translate one Anthropic Messages SSE event forwarded as a stream_event. */
  private consumeStreamEvent(forwarded: unknown): void {
    const stream = asRecord(forwarded)
    if (stream === undefined) return
    if (stream['type'] === 'content_block_start') {
      const block = asRecord(stream['content_block']) ?? { type: 'text' }
      const toolCallId = asString(block['id'])
      const toolName = asString(block['name'])
      this.blocks.set(asIndex(stream['index']), {
        kind: asString(block['type']) ?? 'text',
        inputJson: '',
        ...toolCallId === undefined ? {} : { toolCallId },
        ...toolName === undefined ? {} : { toolName },
      })
      return
    }
    if (stream['type'] === 'content_block_delta') {
      const index = asIndex(stream['index'])
      const delta = asRecord(stream['delta'])
      if (delta === undefined) return
      if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
        this.events.onTextDelta(index, delta['text'])
      } else if (delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
        this.events.onThinkingDelta(index, delta['thinking'])
      } else if (delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
        const block = this.blocks.get(index)
        const toolCallId = block?.toolCallId
        if (block !== undefined && toolCallId !== undefined) {
          block.inputJson += delta['partial_json']
          this.events.onToolUseDelta(index, toolCallId, block.toolName ?? 'tool', delta['partial_json'])
        }
      }
      return
    }
    if (stream['type'] === 'content_block_stop') {
      this.blocks.delete(asIndex(stream['index']))
    }
  }

  /** Forward each tool_result block of one claude `user` event. */
  private consumeToolResults(message: unknown): void {
    for (const block of contentBlocks(message)) {
      const record = block as unknown as JsonRecord
      const callId = asString(record['tool_use_id'])
      if (record['type'] !== 'tool_result' || callId === undefined) continue
      const content = record['content']
      let text: string
      if (typeof content === 'string') {
        text = content
      } else if (Array.isArray(content)) {
        text = content
          .map((part) => {
            const text = asRecord(part)?.['text']
            return typeof text === 'string' ? text : ''
          })
          .join('\n')
      } else {
        text = ''
      }
      this.events.onToolResult(callId, text, record['is_error'] === true)
    }
  }
}
