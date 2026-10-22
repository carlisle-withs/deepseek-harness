/**
 * Claude Code CLI bridge: one spawned `claude -p --output-format
 * stream-json` child per external turn, translating its JSONL event stream
 * into driver callbacks over the shared {@link JsonlProcessTurn} shell. Turn
 * continuity rides the CLI's own session persistence — the first turn
 * captures `session_id` from `system/init`, later turns pass `--resume <id>`
 * so prior context is never re-sent.
 *
 * The parsing logic is ported from the engine-shim prototype (battle-tested
 * against Claude Code 2.x). The invocation is env-overridable via
 * `ENGINE_LOOP_CLAUDE_COMMAND`, `ENGINE_LOOP_CLAUDE_ARGS` (default
 * `--permission-mode acceptEdits`), and `ENGINE_LOOP_CLAUDE_MODEL`.
 *
 * @module dsh-agent-loop-external/claude
 */

import type {
  EngineContentBlock,
  EngineHarnessConfig,
  EngineRecord,
  EngineTurnEvents,
  EngineTurnOutcome,
  EngineTurnUsage,
} from './process-turn.ts'
import { JsonlProcessTurn } from './process-turn.ts'

export type ClaudeContentBlock = EngineContentBlock
export type ClaudeTurnEvents = EngineTurnEvents
export type ClaudeTurnOutcome = EngineTurnOutcome
export type ClaudeTurnUsage = EngineTurnUsage

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asIndex(value: unknown): number {
  const index = Number(value)
  return Number.isSafeInteger(index) && index >= 0 ? index : -1
}

/** Content blocks of one assistant message, already narrowed. */
function contentBlocks(message: unknown): readonly ClaudeContentBlock[] {
  const content = typeof message === 'object' && message !== null
    ? (message as EngineRecord)['content']
    : undefined
  if (!Array.isArray(content)) return []
  return content.filter((block): block is ClaudeContentBlock =>
    typeof block === 'object' && block !== null && !Array.isArray(block))
}

/** One accumulating `tool_use` content block between its start and stop. */
interface BlockAccumulator {
  kind: string
  toolCallId?: string
  toolName?: string
  inputJson: string
}

/**
 * One live `claude -p` child over the shared JSONL process shell.
 */
export class ClaudeCodeTurn extends JsonlProcessTurn {
  private readonly blocks = new Map<number, BlockAccumulator>()
  private knownSessionId: string | null = null

  constructor(
    config: EngineHarnessConfig,
    cwd: string,
    private readonly events: ClaudeTurnEvents,
  ) {
    super(config, cwd)
  }

  protected override get engineLabel(): string {
    return 'claude CLI'
  }

  protected override buildCommand(resumeSessionId: string | null): { command: string; args: string[] } {
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
    return { command: this.config.command, args }
  }

  protected override consume(event: EngineRecord): void {
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
        const rawUsage = typeof event['usage'] === 'object' && event['usage'] !== null
          ? event['usage'] as EngineRecord
          : undefined
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
    const stream = typeof forwarded === 'object' && forwarded !== null
      ? forwarded as EngineRecord
      : undefined
    if (stream === undefined) return
    if (stream['type'] === 'content_block_start') {
      const block = typeof stream['content_block'] === 'object' && stream['content_block'] !== null
        ? stream['content_block'] as EngineRecord
        : { type: 'text' }
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
      const delta = typeof stream['delta'] === 'object' && stream['delta'] !== null
        ? stream['delta'] as EngineRecord
        : undefined
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
      const record = block as unknown as EngineRecord
      const callId = asString(record['tool_use_id'])
      if (record['type'] !== 'tool_result' || callId === undefined) continue
      const content = record['content']
      let text: string
      if (typeof content === 'string') {
        text = content
      } else if (Array.isArray(content)) {
        text = content
          .map((part) => {
            const text = typeof part === 'object' && part !== null
              ? (part as EngineRecord)['text']
              : undefined
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
