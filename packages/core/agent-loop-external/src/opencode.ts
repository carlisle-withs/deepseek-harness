/**
 * OpenCode CLI bridge: one spawned `opencode run --format json` child per
 * external turn over the shared {@link JsonlProcessTurn} shell. OpenCode's
 * JSON bus reports message parts with CUMULATIVE text snapshots rather than
 * deltas and has no per-message boundary events, so this adapter diffs each
 * part's snapshot into a delta and never reports an assistant message — the
 * driver commits the streamed round at the terminal outcome. Tool parts
 * stream as tool-call deltas; their bus results arrive on the same part,
 * forwarded as tool results. When the process exits with accumulated text
 * and no explicit error, the turn settles as a success (the `--format json`
 * event set varies across versions).
 *
 * Env overrides: `ENGINE_LOOP_OPENCODE_COMMAND`, `ENGINE_LOOP_OPENCODE_ARGS`
 * (default `--auto`), `ENGINE_LOOP_OPENCODE_MODEL`.
 *
 * @module dsh-agent-loop-external/opencode
 */

import type {
  EngineHarnessConfig,
  EngineRecord,
  EngineTurnEvents,
} from './process-turn.ts'
import { JsonlProcessTurn } from './process-turn.ts'

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * One live `opencode run --format json` child.
 */
export class OpencodeTurn extends JsonlProcessTurn {
  private sessionId: string | null = null
  /** Cumulative text per part id, diffed into deltas. */
  private readonly textByPart = new Map<string, string>()
  /** Stream-assembly block index per part id. */
  private readonly indexByPart = new Map<string, number>()
  private nextIndex = 0
  private readonly seenTools = new Set<string>()
  private readonly completedTools = new Set<string>()

  constructor(
    config: EngineHarnessConfig,
    cwd: string,
    private readonly events: EngineTurnEvents,
  ) {
    super(config, cwd)
  }

  protected override get engineLabel(): string {
    return 'opencode CLI'
  }

  protected override buildCommand(resumeSessionId: string | null): { command: string; args: string[] } {
    const args = ['run', '--format', 'json']
    if (this.config.model !== undefined) args.push('--model', this.config.model)
    if (resumeSessionId !== null) args.push('--session', resumeSessionId)
    args.push(...this.config.extraArgs)
    return { command: this.config.command, args }
  }

  protected override consume(event: EngineRecord): void {
    if (event['type'] === 'error') {
      const error = typeof event['error'] === 'object' && event['error'] !== null
        ? (event['error'] as EngineRecord)['message']
        : undefined
      this.finish(this.errorOutcome(asString(error) ?? 'opencode error'))
      return
    }
    const sessionId = asString(event['sessionID'])
    if (sessionId !== undefined && this.sessionId === null) {
      this.sessionId = sessionId
      this.events.onSessionId(sessionId)
    }
    // Bus events (message.updated / message.part.updated): one part per event,
    // or a whole message's parts array.
    const parts = this.partsOf(event)
    if (parts !== undefined) {
      for (const part of parts) this.consumePart(part)
    }
  }

  /** The parts array of one bus event, when it carries message content. */
  private partsOf(event: EngineRecord): readonly unknown[] | undefined {
    const message = typeof event['message'] === 'object' && event['message'] !== null
      ? event['message'] as EngineRecord
      : undefined
    if (message !== undefined && Array.isArray(message['parts'])) {
      return message['parts'] as readonly unknown[]
    }
    if (event['part'] !== undefined) return [event['part']]
    return undefined
  }

  /** Fold one message part: text diffs stream, tool parts report lifecycle. */
  private consumePart(part: unknown): void {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) return
    const record = part as EngineRecord
    const id = asString(record['id']) ?? 'text'
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      const full = record['text']
      const prior = this.textByPart.get(id) ?? ''
      if (full.length > prior.length && full.startsWith(prior)) {
        this.textByPart.set(id, full)
        this.events.onTextDelta(this.indexOf(id), full.slice(prior.length))
      } else if (prior === '') {
        this.textByPart.set(id, full)
        this.events.onTextDelta(this.indexOf(id), full)
      }
    } else if (record['type'] === 'tool') {
      const state = typeof record['state'] === 'object' && record['state'] !== null
        ? record['state'] as EngineRecord
        : {}
      const callId = `opencode:${id}`
      if (!this.seenTools.has(callId)) {
        this.seenTools.add(callId)
        const tool = asString(state['tool']) ?? 'tool'
        const input = state['input'] ?? state
        this.events.onToolUseDelta(this.indexOf(id), callId, tool, safeJson(input))
      }
      // TODO(external-loop): the driver cannot commit mid-round tool calls
      // without an engine message boundary, so opencode tool results are not
      // durable pairs yet; the part's completion only reaches the live stream.
      if ((state['status'] === 'completed' || state['status'] === 'error') && !this.completedTools.has(callId)) {
        this.completedTools.add(callId)
        const output = state['output']
        const text = typeof output === 'string' ? output : safeJson(output ?? '')
        this.events.onToolResult(callId, text, state['status'] === 'error')
      }
    }
  }

  /** One stable stream-assembly index per part id. */
  private indexOf(partId: string): number {
    let index = this.indexByPart.get(partId)
    if (index === undefined) {
      index = this.nextIndex++
      this.indexByPart.set(partId, index)
    }
    return index
  }

  protected override onProcessExit(): void {
    if (this.stopped) {
      this.finish(this.errorOutcome('interrupted'))
      return
    }
    const text = [...this.textByPart.values()].join('\n')
    if (text.trim().length > 0) {
      // The --format json event set varies across versions; accumulated text
      // without an explicit error settles as a successful turn.
      this.finish({
        subtype: 'success',
        text,
        sessionId: this.sessionId,
        usage: null,
        interrupted: false,
      })
      return
    }
    this.finish(this.errorOutcome('process ended without output'))
  }

  protected override consumeText(_line: string): void {
    // Plain text beyond the JSON stream (banners, "> " echoes) is ignored.
  }
}

/** Serialize one tool input snapshot as a single arguments delta. */
function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : '{}'
  } catch {
    return '{}'
  }
}
