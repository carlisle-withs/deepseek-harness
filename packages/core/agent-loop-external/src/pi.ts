/**
 * Pi CLI bridge: one spawned `pi --mode json -p` child per external turn over
 * the shared {@link JsonlProcessTurn} shell. Pi's stream folds naturally into
 * the claude event vocabulary: `message_update` deltas stream live, each
 * complete assistant `message_end` is one internal model round (its content
 * blocks normalize to text / thinking / tool_use), tool results arrive as
 * `toolResult`-role messages, and `agent_settled` settles the terminal
 * outcome — pi runs one assistant message per its own turn and repeats that
 * message at each `turn_end`; those repeats are ignored, since the boundary
 * already reported the message. Pi echoes the prompt back as a `user`
 * message before the assistant reply, so role tracking rides `message_start`;
 * text without a known role is never projected.
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
        return
      case 'message_update':
        this.consumeUpdate(event)
        return
      case 'message_end':
        this.consumeMessageBoundary(event)
        return
      case 'turn_end':
        // turn_end only repeats its turn's final message_end (identical
        // content, sometimes reshuffled argument keys); reporting here would
        // fold one reply into two durable rounds.
        this.captureUsage(event)
        return
      case 'agent_settled':
        this.finish({
          subtype: event['aborted'] === true ? 'interrupted' : 'success',
          text: '',
          sessionId: this.sessionId,
          usage: this.lastUsage === null ? null : this.turnUsage(this.lastUsage),
          interrupted: this.stopped || event['aborted'] === true,
        })
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

  /** Complete one message round, settle tool results, and end the turn. */
  private consumeMessageBoundary(event: EngineRecord): void {
    const message = this.messageOf(event)
    if (message['role'] === 'toolResult') {
      // One executed tool: the message carries its call id, text content, and
      // error flag, pairing the round's committed tool/call durably.
      const callId = asString(message['toolCallId'])
      if (callId !== undefined) {
        const content = message['content']
        const text = Array.isArray(content)
          ? content.map((part) => {
            const text = typeof part === 'object' && part !== null
              ? (part as EngineRecord)['text']
              : undefined
            return typeof text === 'string' ? text : ''
          }).join('\n')
          : ''
        this.events.onToolResult(callId, text, message['isError'] === true)
      }
      this.captureUsage(event)
      return
    }
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
      this.events.onAssistantMessage(blocks)
    }
    this.captureUsage(event)
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
