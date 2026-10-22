/**
 * Pi CLI bridge: one spawned `pi --mode json -p` child per external turn over
 * the shared {@link JsonlProcessTurn} shell. Pi's stream folds naturally into
 * the claude event vocabulary: `message_update` deltas stream live, each
 * complete assistant `message_end` is one internal model round (its content
 * blocks normalize to text / thinking / tool_use), and `turn_end` settles the
 * terminal outcome with the turn's usage. Pi echoes the prompt back as a
 * `user` message before the assistant reply, so role tracking rides
 * `message_start`; text without a known role is never projected.
 *
 * Env overrides: `ENGINE_LOOP_PI_COMMAND`, `ENGINE_LOOP_PI_ARGS`,
 * `ENGINE_LOOP_PI_MODEL`.
 *
 * @module dsh-agent-loop-external/pi
 */

import type {
  EngineContentBlock,
  EngineHarnessConfig,
  EngineRecord,
  EngineTurnEvents,
  EngineTurnUsage,
} from './process-turn.ts'
import { JsonlProcessTurn } from './process-turn.ts'

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * One live `pi --mode json -p` child.
 */
export class PiTurn extends JsonlProcessTurn {
  private sessionId: string | null = null
  private currentRole: string | null = null
  /** Whether any text delta streamed; whole-text fallbacks run once otherwise. */
  private streamedText = false
  private lastUsage: EngineRecord | null = null
  /**
   * Serialized content of the last reported assistant message: pi repeats the
   * final message at both `message_end` and `turn_end`, and re-reporting it
   * would fold one reply into two durable rounds.
   */
  private lastReportedContent: string | null = null

  constructor(
    config: EngineHarnessConfig,
    cwd: string,
    private readonly events: EngineTurnEvents,
  ) {
    super(config, cwd)
  }

  protected override get engineLabel(): string {
    return 'pi CLI'
  }

  protected override buildCommand(resumeSessionId: string | null): { command: string; args: string[] } {
    const args = ['--mode', 'json', '-p']
    if (this.config.model !== undefined) args.push('--model', this.config.model)
    if (resumeSessionId !== null) args.push('--session', resumeSessionId)
    args.push(...this.config.extraArgs)
    return { command: this.config.command, args }
  }

  protected override consume(event: EngineRecord): void {
    switch (event['type']) {
      case 'session': {
        const sessionId = asString(event['id'])
        if (sessionId !== undefined) {
          this.sessionId = sessionId
          this.events.onSessionId(sessionId)
        }
        const model = asString(event['model'])
        if (model !== undefined) this.events.onModel(model)
        return
      }
      case 'message_start':
        this.currentRole = asString((this.messageOf(event))['role']) ?? null
        // A fresh message start clears the repeat guard, so two genuinely
        // identical consecutive messages both report.
        this.lastReportedContent = null
        return
      case 'message_update':
        this.consumeUpdate(event)
        return
      case 'message_end':
      case 'turn_end':
        this.consumeMessageBoundary(event)
        return
      case 'error':
        this.finish(this.errorOutcome(asString(event['message']) ?? 'pi error'))
        return
      default:
        return
    }
  }

  /** The `message` record of one pi stream event. */
  private messageOf(event: EngineRecord): EngineRecord {
    const message = event['message']
    return typeof message === 'object' && message !== null && !Array.isArray(message)
      ? message as EngineRecord
      : {}
  }

  /** Stream one live update; only assistant messages project. */
  private consumeUpdate(event: EngineRecord): void {
    if (this.currentRole !== 'assistant') {
      this.captureUsage(event)
      return
    }
    const inner = typeof event['assistantMessageEvent'] === 'object' && event['assistantMessageEvent'] !== null
      ? event['assistantMessageEvent'] as EngineRecord
      : undefined
    if (inner === undefined) {
      this.captureUsage(event)
      return
    }
    if (inner['type'] === 'text' && typeof inner['text'] === 'string') {
      // Some pi versions carry cumulative text snapshots rather than deltas:
      // project the first snapshot once as a whole delta and let the message
      // boundary carry the final text.
      if (!this.streamedText) {
        this.streamedText = true
        this.events.onTextDelta(0, inner['text'])
      }
    } else if (inner['type'] === 'text_delta' && typeof inner['text'] === 'string') {
      this.streamedText = true
      this.events.onTextDelta(0, inner['text'])
    } else if (inner['type'] === 'reasoning_delta' && typeof inner['text'] === 'string') {
      this.events.onThinkingDelta(1, inner['text'])
    }
    this.captureUsage(event)
  }

  /** Complete one message round, and settle the outcome at the turn boundary. */
  private consumeMessageBoundary(event: EngineRecord): void {
    // TODO(external-loop): pi's tool-result messages are not surfaced yet;
    // committed tool calls without an engine result close with the driver's
    // synthetic missing-result error.
    const message = this.messageOf(event)
    if (message['role'] !== 'assistant') {
      this.captureUsage(event)
      return
    }
    const content = message['content']
    if (Array.isArray(content)) {
      const blocks: EngineContentBlock[] = []
      for (const block of content) {
        if (typeof block !== 'object' || block === null || Array.isArray(block)) continue
        const record = block as EngineRecord
        if (record['type'] === 'text' && typeof record['text'] === 'string') {
          blocks.push({ type: 'text', text: record['text'] })
        } else if (record['type'] === 'reasoning' && typeof record['text'] === 'string') {
          blocks.push({ type: 'thinking', thinking: record['text'] })
        } else if (record['type'] === 'toolCall' && typeof record['id'] === 'string') {
          blocks.push({
            type: 'tool_use',
            id: record['id'],
            ...(typeof record['name'] === 'string' ? { name: record['name'] } : {}),
            input: record['arguments'],
          })
        }
      }
      // turn_end repeats the final message_end unchanged; report each
      // distinct message exactly once as one durable round.
      const serialized = JSON.stringify(blocks)
      if (serialized !== this.lastReportedContent) {
        this.lastReportedContent = serialized
        this.events.onAssistantMessage(blocks)
      }
    }
    this.captureUsage(event)
    if (event['type'] === 'turn_end') {
      const usage = this.lastUsage
      this.finish({
        subtype: 'success',
        text: '',
        sessionId: this.sessionId,
        usage: usage === null ? null : this.turnUsage(usage),
        interrupted: this.stopped,
      })
    }
  }

  /** Keep the freshest usage snapshot of the turn. */
  private captureUsage(event: EngineRecord): void {
    if (typeof event['usage'] === 'object' && event['usage'] !== null) {
      this.lastUsage = event['usage'] as EngineRecord
    }
  }

  /** Map pi's usage field names into the engine accounting shape. */
  private turnUsage(usage: EngineRecord): EngineTurnUsage {
    return {
      inputTokens: Number(usage['input'] ?? 0),
      outputTokens: Number(usage['output'] ?? 0),
      cacheReadTokens: Number(usage['cacheRead'] ?? 0),
      cacheWriteTokens: Number(usage['cacheWrite'] ?? 0),
    }
  }
}
