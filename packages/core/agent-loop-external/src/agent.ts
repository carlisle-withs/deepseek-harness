/**
 * External-harness Agent driver: each turn hands its claimed input to an
 * external CLI engine and folds the reply into the durable session log with
 * the same event vocabulary the default React loop writes, so the unchanged
 * dsh UI renders external turns like native ones.
 *
 * Phase ②: the engine is the Claude Code CLI bridge (./claude.ts and
 * {@link ExternalAgent.runExternalHarness}) — one `claude -p
 * --output-format stream-json` child per turn whose deltas stream live into
 * `agent/assistant-stream` frames and whose internal rounds settle as durable
 * assistant messages, tool calls, results, and usage. Each engine round opens
 * one durable step (`step/start` … `step/end`), matching the default loop's
 * turn/step/message structure the chat projection consumes; the final
 * tool-less round defers its commit to the terminal `result` event so its
 * message carries the turn's usage. Durable inbox routing is real since
 * Phase ①: pending input round-trips `agent/inbox/spliced` events exactly
 * like the default loop's inbox.
 *
 * Model selection: each turn reads the session-controller's durable
 * `modelSelection` projection (pending user pick first), logs one
 * `request/header`/`request/context` pair that retires it, and passes the
 * chosen model to the CLI as `--model` (ENGINE_LOOP_CLAUDE_MODEL still pins
 * the engine model above every selection).
 *
 * @module dsh-agent-loop-external/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  AssistantStreamFrame,
  CancelOptions,
  Inbox as InboxContract,
  InboxState,
  InboxTarget,
} from '@deepseek-ai/dsh-agent'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import {
  AssistantStreamAccumulator,
  BlockAssembler,
  LlmAttemptId,
  ReasoningEffortId,
  ToolCallId,
  callConfigEquals,
  createAssistantMessage,
  createToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord, ContentBlock, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Context } from '@deepseek-ai/cordis'
import type {
  Session,
  SessionId,
  SessionSeq,
  TurnEndReason,
  UserMessage,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import {
  ClaudeCodeTurn,
  claudeConfigFromEnv,
  type ClaudeContentBlock,
  type ClaudeHarnessConfig,
  type ClaudeTurnUsage,
} from './claude.ts'

/** Driver lifecycle: idle, a non-turn maintenance task, or one draining turn chain. */
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; wakeRequested: boolean }

/** One durable model selection, as the session-controller projection stores it. */
interface ModelSelectionLike {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Loose shape of the `modelSelection` projection state owned by the session controller. */
interface ModelSelectionStateLike {
  lastUsed: ModelSelectionLike | null
  pending: ModelSelectionLike | null
}

/**
 * Copy one cancel cause into the JSON-safe shape `turn/end` records. The live
 * cause is the caller's object and may carry non-serializable fields (Node
 * attaches `stack` to abort reasons), which `Session.append` would reject.
 * @param signal - a turn or maintenance signal this driver owns.
 * @returns the copied cause, or undefined while the signal is still live.
 */
function durableCancelCause(signal: AbortSignal): AgentCancelCause | undefined {
  if (!signal.aborted) return undefined
  const cause = signal.reason as AgentCancelCause
  switch (cause.kind) {
    case 'user':
    case 'parent':
    case 'disposed':
      return { kind: cause.kind }
    case 'hook':
      return { kind: 'hook', reason: cause.reason }
  }
}

/** Join one message's text blocks into engine prompt text. */
function messageText(message: UserMessage): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Serialize a claude tool input for an unstreamed tool-call chunk. */
function jsonArguments(input: unknown): string {
  if (input === undefined || input === null) return '{}'
  try {
    return JSON.stringify(input)
  } catch {
    return '{}'
  }
}

/** Map claude's disjoint token counts into the session usage shape. */
function turnUsage(usage: ClaudeTurnUsage): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...usage.cacheReadTokens > 0 ? { cacheReadTokens: usage.cacheReadTokens } : {},
    ...usage.cacheWriteTokens > 0 ? { cacheWriteTokens: usage.cacheWriteTokens } : {},
  }
}

/** Result text recorded for a tool call whose engine result never arrived. */
const TOOL_RESULT_MISSING = 'Error: external harness ended the turn before the tool result arrived'

/**
 * One claude internal model round folded as one live assistant attempt inside
 * its own durable step: compact stream accumulation, block assembly, and the
 * same `agent/assistant-stream` frame sequence one default-loop step publishes.
 */
class RoundAttempt {
  private readonly accumulator = new AssistantStreamAccumulator()
  private readonly assembler = new BlockAssembler()
  private readonly streamedToolCalls = new Set<ToolCallId>()
  private frameIndex = 0
  private terminal = false
  /** Whether any delta chunk arrived; false drives the whole-message fallback. */
  deltaStreamed = false

  constructor(
    readonly attemptId: LlmAttemptId,
    private readonly turn: number,
    readonly step: number,
    private readonly nextRevision: () => number,
    private readonly emit: (frame: AssistantStreamFrame) => void,
  ) {}

  /** Whether this started attempt has emitted its terminal frame. */
  get ended(): boolean {
    return this.terminal
  }

  /** Publish the opening marker before the first delivered chunk. */
  start(): void {
    this.emit({
      type: 'start',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      turn: this.turn,
      step: this.step,
    })
  }

  /** Feed one chunk to durable compaction, assembly, and live publication. */
  push(chunk: StreamChunk): void {
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
      this.deltaStreamed = true
    }
    if (chunk.type === 'tool-call-delta') this.streamedToolCalls.add(chunk.id)
    const timed = this.accumulator.push({ time: Date.now(), chunk })
    this.assembler.push(timed.chunk)
    this.emit({
      type: 'chunk',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.frameIndex++,
      time: timed.time,
      chunk: timed.chunk,
    })
  }

  /** Whether a tool-call delta carrying this id already streamed. */
  hasToolCall(callId: ToolCallId): boolean {
    return this.streamedToolCalls.has(callId)
  }

  /**
   * Publish terminal settlement after the matching durable event commits.
   * @param eventType - durable settlement type.
   * @param append - synchronous durable append returning its committed seq.
   */
  settle(eventType: 'assistant/message' | 'assistant/attempt', append: () => SessionSeq): void {
    let seq: SessionSeq
    try {
      seq = append()
    } catch (error: unknown) {
      this.abandon()
      throw error
    }
    this.terminal = true
    this.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.frameIndex,
      outcome: { kind: 'committed', eventType, seq },
    })
  }

  /** Publish abandonment when no durable attempt event can be committed. */
  abandon(): void {
    if (this.terminal) return
    this.terminal = true
    this.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.frameIndex,
      outcome: { kind: 'abandoned' },
    })
  }

  /** Exact compact stream for the final durable event. */
  get stream(): AssistantStreamRecord[] {
    return [...this.accumulator.snapshot()] as AssistantStreamRecord[]
  }

  /** Canonical completed-message blocks from the same chunks. */
  blocks(): ContentBlock[] {
    return this.assembler.blocks()
  }

  /** Safe visible prefix when cancellation interrupts the round. */
  interruptedBlocks(): ContentBlock[] {
    return this.assembler.interruptedBlocks()
  }
}

/**
 * Driver-owned durable Inbox view over the session's `inbox` projection,
 * exactly like the default loop's inbox: every mutation appends one
 * `agent/inbox/spliced` event, so pending input survives restarts.
 */
class ExternalInbox implements InboxContract {
  constructor(private readonly agent: ExternalAgent) {}

  get nextTurn(): readonly UserMessage[] {
    return this.agent.inboxState()['next-turn']
  }

  get nextStep(): readonly UserMessage[] {
    return this.agent.inboxState()['next-step']
  }

  clear(): void {
    this.splice('next-step', 0, this.nextStep.length, [])
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }

  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.agent.inboxState()[target].length, 0, [message])
  }

  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  replace(messageId: UserMessage['id'], newMessage: UserMessage): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [newMessage])
    return true
  }

  remove(messageId: UserMessage['id']): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [])
    return true
  }

  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    return this.agent.spliceInbox(target, start, deleteCount, inserted, true)
  }

  /** Locate one pending identity across both owned lists. */
  private locate(messageId: UserMessage['id']): { target: InboxTarget; index: number } | undefined {
    const state = this.agent.inboxState()
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = state[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }
}

/** Drives one session through turn boundaries by delegating each turn to an external CLI harness. */
export class ExternalAgent implements Agent {
  readonly inbox: ExternalInbox
  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  private readonly dispatch: AgentEventDispatch
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()
  /** Process-local revision of assistant frames for this attached session. */
  private streamRevision = 0
  /** Attached-session-local attempt counter, mirroring the default loop's ids. */
  private attemptCounter = 0
  /** The external harness child behind the running turn; `cancel()` stops it. */
  private harness: ClaudeCodeTurn | undefined
  /** Claude session identity captured at init; later turns `--resume` it instead of resending context. */
  private engineSessionId: string | null = null
  /** Model id claude reported at init, for assistant attribution. */
  private engineModel: string | null = null
  /** Harness invocation resolved once per agent from `ENGINE_LOOP_CLAUDE_*`. */
  private readonly harnessConfig: ClaudeHarnessConfig = claudeConfigFromEnv()

  constructor(
    private readonly loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    this.dispatch = agentEvents(loopCtx, this)
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx
    this.inbox = new ExternalInbox(this)
    // Continue turn numbering from any persisted history; 0 for a fresh session.
    const lastTurn = this.loopCtx.sessionProjections.stateOf(this.session, 'turnBoundary')?.lastTurn ?? 0
    this.phase = { kind: 'idle', lastTurn }
  }

  get status(): AgentStatus {
    return this.phase.kind === 'running' ? 'running' : 'idle'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  /** Read the current durable inbox projection state. */
  inboxState(): InboxState {
    const state = this.ctx.sessionProjections.stateOf(this.session, 'inbox')
    if (state === undefined) {
      throw new Error(
        `agent "${this.id}" cannot read inbox state: its projection registration is not active`,
      )
    }
    return state
  }

  /**
   * Apply one normalized inbox mutation and durably record it, mirroring the
   * default loop's inbox splice semantics (clamping, duplicate-id rejection,
   * `agent/inbox/inserted`/`discarded` notifications).
   * @param discardRemoved - mark removed messages canceled rather than claimed.
   * @returns messages removed by the splice.
   */
  spliceInbox(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): UserMessage[] {
    const state = this.inboxState()
    const inbox = state[target]
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart = offset < 0
      ? Math.max(inbox.length + offset, 0)
      : Math.min(offset, inbox.length)
    const truncatedDeleteCount = Math.trunc(deleteCount)
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart,
    )
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    const candidate = inbox.toSpliced(actualStart, actualDeleteCount, ...inserted)
    const ids = new Set<string>()
    for (const message of target === 'next-turn'
      ? [...candidate, ...state['next-step']]
      : [...state['next-turn'], ...candidate]) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }
    const outcome = discardRemoved && actualDeleteCount > 0 ? 'canceled' as const : undefined
    const event = this.session.append('agent/inbox/spliced', {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    })
    const removed = inbox.slice(actualStart, actualStart + actualDeleteCount)
    if (discardRemoved) {
      for (const message of removed) this.dispatch.emit('agent/inbox/discarded', { message })
    }
    for (const message of event.data.inserted) {
      this.dispatch.emit('agent/inbox/inserted', { message })
    }
    return removed
  }

  /** Whether either pending-message list contains work. */
  private hasPending(): boolean {
    const state = this.inboxState()
    return state['next-turn'].length > 0 || state['next-step'].length > 0
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Waking input cannot join an aborted activity, so it starts the next turn.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.spliceInbox(resolvedTarget, Infinity, 0, [message], false)
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(message: UserMessage): void {
    this.send(message, 'next-turn', true)
  }

  steer(message: UserMessage): void {
    // TODO(external-loop): mid-turn steering needs a live harness channel;
    // the one-shot `claude -p` child has none, so steering queues as the next
    // turn's input, exactly as in Phase ①.
    this.send(message, 'next-step', true)
  }

  inject(message: UserMessage): void {
    // Injected context parks durably until the next waking input claims it.
    this.send(message, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
    // The awaiting turn observes the abort signal; its harness child must not
    // outlive the turn, so stop() tears down the whole process tree.
    this.harness?.stop()
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        const cause = durableCancelCause(maintenance.abort.signal)
        if (cause?.kind !== 'disposed' && maintenance.wakeRequested && this.hasPending()) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /**
   * Start the turn driver, or latch its wake behind maintenance or an aborted
   * activity, mirroring the default loop's wake convergence.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      const reason = durableCancelCause(this.phase.abort.signal)
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.drive()).then(driver.resolve, driver.reject)
  }

  /** Drain queued turns; failures and cancellation are contained at this boundary. */
  private async drive(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch {
      // Reported through agent/error inside the turn; the log stays consistent.
    } finally {
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.hasPending()) this.wakeDriver()
      }
    }
  }

  /** Claim one turn's input: all next-step work plus the first queued turn message. */
  private claimTurnInput(turn: number): UserMessage[] {
    const claimed = [...this.spliceInbox('next-step', 0, this.inboxState()['next-step'].length, [], false)]
    claimed.push(...this.spliceInbox('next-turn', 0, 1, [], false))
    for (const message of claimed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return claimed
  }

  /** Run one external turn; resolves true when another queued turn should follow. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      throw new Error(`agent "${this.id}": turn without driver reservation`)
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    this.session.append('turn/start', { turn })
    phase.turn = turn
    /** The turn's open step; 0 before the first step opens. */
    const steps = { current: 0 }
    let turnEnds: TurnEndReason | null = null
    try {
      const messages = this.claimTurnInput(turn)
      if (messages.length > 0) {
        signal.throwIfAborted()
        const prompt = messages.map(messageText).join('\n')
        await this.runExternalHarness(prompt, turn, messages, steps, signal)
        signal.throwIfAborted()
      }
      turnEnds = { kind: 'completed' }
    } catch (error: unknown) {
      const cause = durableCancelCause(signal)
      if (cause !== undefined) {
        turnEnds = { kind: 'aborted', reason: cause }
        throw error
      }
      turnEnds = {
        kind: 'error',
        error: { message: error instanceof Error ? error.message : String(error), code: 'UNKNOWN' },
      }
      this.dispatch.emit('agent/error', { turn, step: steps.current, error })
      throw error
    } finally {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
      this.session.append('turn/end', { turn, reason: turnEnds! })
    }
    return this.hasPending()
  }

  /**
   * Read the session-controller's durable model-selection intent, when its
   * projection is registered. Read through a structural cast: the
   * `modelSelection` projection key belongs to a package this driver does not
   * depend on, so its state type is not merged into our compile-time table.
   * @returns the pending user selection first, else the last used one.
   */
  private pendingModelSelection(): ModelSelectionLike | undefined {
    const projections = this.ctx.sessionProjections as unknown as {
      stateOf(session: Session, key: 'modelSelection'): ModelSelectionStateLike | undefined
    }
    const state = projections.stateOf(this.session, 'modelSelection')
    return state?.pending ?? state?.lastUsed ?? undefined
  }

  /**
   * Log one request envelope for the turn's effective route. The
   * `request/header` event retires a pending model selection exactly as the
   * default loop's request does (the session-controller folds it), and the
   * `request/context` snapshot feeds route-aware UI.
   * @param provider - effective provider route.
   * @param model - effective model id.
   * @param reasoningEffort - adapter-owned effort from the selection, if any.
   */
  private appendRequestEnvelope(provider: string, model: string, reasoningEffort?: string): void {
    const config = {
      provider,
      model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
    }
    const baseline = this.session.requestHeader()
    if (baseline === undefined) {
      this.session.append('request/header', { header: { config }, reason: 'initial' })
    } else if (!callConfigEquals(baseline.config, config)) {
      this.session.append('request/header', { header: { config }, reason: 'change' })
    }
    const previous = this.session.requestContext()
    if (previous?.provider !== provider || previous.model !== model) {
      this.session.append('request/context', { provider, model })
    }
  }

  /**
   * Run one prompt through the external Claude Code CLI harness, streaming
   * the reply into the durable log as it arrives.
   *
   * One spawned child (`claude -p --output-format stream-json
   * --include-partial-messages --verbose`, prompt on stdin, `--resume` of the
   * captured claude session on later turns) owns the turn. The turn's claimed
   * input enters step 1 (`step/start`, `user/message`), then each internal
   * claude model round opens its own step and folds into one durable
   * `assistant/message` carrying its compact embedded stream, published with
   * live `agent/assistant-stream` frames — the exact durable and live shapes
   * one default-loop step produces. Rounds that request tools commit inside
   * their step, followed by `tool/call` events and claude's `tool_result`
   * messages as `tool/result` events citing their calls; the final tool-less
   * round defers its commit to the terminal `result` event so its message
   * carries the turn's usage. On abort or harness failure the streamed prefix
   * settles as an interrupted `assistant/message` (or an `assistant/attempt`
   * when nothing streamed), and tool calls without their engine result close
   * with synthetic error results, so the turn closes durably exactly like a
   * cancelled default-loop step.
   *
   * TODO(external-loop): thinking deltas currently join the same attempt as
   * reasoning chunks; a UI-facing reasoning presentation pass is deferred.
   * @param prompt - the turn's claimed input text.
   * @param turn - the open turn number.
   * @param messages - the turn's claimed input, appended as step 1's user messages.
   * @param steps - the turn's mutable open-step holder, for error reporting.
   * @param signal - the turn's abort signal.
   */
  protected async runExternalHarness(
    prompt: string,
    turn: number,
    messages: readonly UserMessage[],
    steps: { current: number },
    signal: AbortSignal,
  ): Promise<void> {
    const nextRevision = (): number => ++this.streamRevision
    const emitFrame = (frame: AssistantStreamFrame): void => {
      this.dispatch.emit('agent/assistant-stream', { frame })
    }
    /** The round currently receiving claude deltas; undefined between rounds. */
    let round: RoundAttempt | undefined
    /** A finished tool-less round deferring its commit to the result event. */
    let held: RoundAttempt | undefined
    /** The turn's open step; 0 before the first step opens. */
    let openStep = 0
    /** Rounds already begun in this turn; the first reuses the initial step. */
    let roundsStarted = 0
    /** Committed tool/call seqs and steps still awaiting their claude tool_result. */
    const openCalls = new Map<ToolCallId, { seq: SessionSeq; step: number }>()

    const modelSource = (): { provider: string; model: string } => ({
      provider: this.options.provider ?? 'claude-code',
      model: this.engineModel ?? this.options.model ?? 'claude-code',
    })

    const openNextStep = (): number => {
      // Close the current step before the next opens, mirroring the default
      // loop's per-request step boundary (and retiring the web fold's
      // retained transient rows before the next attempt's start frame).
      if (openStep > 0) this.session.append('step/end', { turn, step: openStep })
      openStep += 1
      this.session.append('step/start', { turn, step: openStep })
      steps.current = openStep
      return openStep
    }

    const pushChunk = (chunk: StreamChunk): void => {
      if (round === undefined) {
        // A new engine round: settle the previous round's deferred commit and
        // open the next step BEFORE this round's first live frame, so the web
        // fold never sees a start frame while a settlement is still retained.
        const previous = held
        held = undefined
        if (previous !== undefined) commitAssistant(previous, previous.blocks(), {})
        roundsStarted += 1
        const attempt = new RoundAttempt(
          LlmAttemptId(`${this.id}:${++this.attemptCounter}`),
          turn,
          // The turn's first round runs in the step already opened for the
          // claimed input; every later round opens its own step.
          roundsStarted === 1 ? openStep : openNextStep(),
          nextRevision,
          emitFrame,
        )
        round = attempt
        attempt.start()
      }
      round.push(chunk)
    }

    /** Synthesize one whole-message chunk for streams without partial deltas. */
    const synthesizeChunk = (index: number, block: ClaudeContentBlock): void => {
      if (block.type === 'text' && typeof block.text === 'string') {
        pushChunk({ type: 'text-delta', index, text: block.text })
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        pushChunk({ type: 'reasoning-delta', index, text: block.thinking })
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && block.id !== '') {
        pushChunk({
          type: 'tool-call-delta',
          index,
          id: ToolCallId(block.id),
          name: typeof block.name === 'string' ? block.name : 'tool',
          argumentsDelta: jsonArguments(block.input),
        })
      }
    }

    const commitAssistant = (
      attempt: RoundAttempt,
      content: readonly ContentBlock[],
      extra: { interrupted?: true; usage?: TokenUsage },
    ): void => {
      attempt.settle('assistant/message', () => this.session.append('assistant/message', {
        turn,
        step: attempt.step,
        message: createAssistantMessage({ content, source: modelSource() }),
        stream: attempt.stream,
        ...extra.interrupted === undefined ? {} : { interrupted: extra.interrupted },
        ...extra.usage === undefined ? {} : { usage: extra.usage },
      }, { surfaceOp: 'append' }).seq)
    }

    /** Commit the deferred tool-less round; the next round supersedes it. */
    const flushHeld = (): void => {
      const previous = held
      held = undefined
      if (previous !== undefined) commitAssistant(previous, previous.blocks(), {})
    }

    /** Fold one complete claude assistant message into durable events. */
    const commitRound = (content: readonly ClaudeContentBlock[]): void => {
      if (round === undefined) flushHeld()
      if (round !== undefined && !round.deltaStreamed) {
        // Whole-message fallback: without partial deltas (flag dropped, older
        // CLI) synthesize the round's chunks so the durable embedded stream
        // matches the committed blocks.
        for (const [index, block] of content.entries()) synthesizeChunk(index, block)
      } else if (round !== undefined) {
        // Per-block fallback: claude omits input_json_delta for empty tool
        // inputs; such a block still needs its chunk to reach assembly.
        for (const [index, block] of content.entries()) {
          if (block.type !== 'tool_use' || typeof block.id !== 'string' || block.id === '') continue
          const id = ToolCallId(block.id)
          if (round.hasToolCall(id)) continue
          pushChunk({
            type: 'tool-call-delta',
            index,
            id,
            name: typeof block.name === 'string' ? block.name : 'tool',
            argumentsDelta: jsonArguments(block.input),
          })
        }
      }
      const attempt = round
      round = undefined
      if (attempt === undefined) return
      const requestsTools = content.some(block => block.type === 'tool_use')
      attempt.push({ type: 'finish', reason: requestsTools ? { kind: 'tool-calls' } : { kind: 'stop' } })
      if (!requestsTools) {
        held = attempt
        return
      }
      const blocks = attempt.blocks()
      commitAssistant(attempt, blocks, {})
      for (const block of blocks) {
        if (block.type !== 'tool-call') continue
        const callSeq = this.session.append('tool/call', {
          turn,
          step: attempt.step,
          callId: block.id,
          name: block.name,
          arguments: block.arguments,
        }).seq
        openCalls.set(block.id, { seq: callSeq, step: attempt.step })
      }
    }

    const commitToolResult = (callId: string, text: string, isError: boolean): void => {
      const id = ToolCallId(callId)
      const open = openCalls.get(id)
      if (open === undefined) return // a result without a committed call carries no durable pair
      openCalls.delete(id)
      this.session.append('tool/result', {
        turn,
        step: open.step,
        message: createToolResultMessage({
          callId: id,
          content: [{ type: 'text', text }],
          isError,
        }),
      }, { surfaceOp: 'append', sourceEventSeqs: [open.seq] })
    }

    /** Settle whatever streamed but never committed as an interrupted prefix. */
    const settleInterrupted = (): void => {
      const live = round
      round = undefined
      const finished = held
      held = undefined
      if (live !== undefined) {
        const content = live.interruptedBlocks()
        if (content.length > 0) {
          commitAssistant(live, content, { interrupted: true })
        } else {
          live.settle('assistant/attempt', () =>
            this.session.append('assistant/attempt', {
              turn,
              step: live.step,
              stream: live.stream,
            }).seq)
        }
      }
      if (finished !== undefined) commitAssistant(finished, finished.blocks(), { interrupted: true })
    }

    /** Close committed calls whose engine result can no longer arrive. */
    const closeOpenCalls = (): void => {
      for (const [callId, { seq, step }] of [...openCalls]) {
        openCalls.delete(callId)
        this.session.append('tool/result', {
          turn,
          step,
          message: createToolResultMessage({
            callId,
            content: [{ type: 'text', text: TOOL_RESULT_MISSING }],
            isError: true,
          }),
        }, { surfaceOp: 'append', sourceEventSeqs: [seq] })
      }
    }

    // Effective route for this turn: the env pin above everything, then the
    // durable user selection, then the agent options; the request envelope
    // retires a pending selection and the model flag drives the CLI child.
    const selection = this.pendingModelSelection()
    const provider = selection?.provider ?? this.options.provider ?? 'claude-code'
    const modelFlag = this.harnessConfig.model ?? selection?.model ?? this.options.model
    const headerModel = modelFlag ?? this.engineModel ?? 'claude-code'

    // Step 1 opens before the claimed input joins the surface, matching the
    // default loop's step boundary ordering.
    openNextStep()
    for (const message of messages) {
      this.session.append('user/message', message, { surfaceOp: 'append' })
    }
    this.appendRequestEnvelope(provider, headerModel, selection?.reasoningEffort)
    signal.throwIfAborted()

    const harness = this.harness = new ClaudeCodeTurn(
      { ...this.harnessConfig, ...modelFlag === undefined ? {} : { model: modelFlag } },
      this.session.header.cwd ?? process.cwd(),
      {
        onSessionId: (sessionId) => { this.engineSessionId = sessionId },
        onModel: (model) => { this.engineModel = model },
        onTextDelta: (index, text) => { pushChunk({ type: 'text-delta', index, text }) },
        onThinkingDelta: (index, text) => { pushChunk({ type: 'reasoning-delta', index, text }) },
        onToolUseDelta: (index, id, name, argumentsDelta) => {
          pushChunk({ type: 'tool-call-delta', index, id: ToolCallId(id), name, argumentsDelta })
        },
        onAssistantMessage: commitRound,
        onToolResult: commitToolResult,
      },
    )
    try {
      const outcome = await harness.start(prompt, this.engineSessionId)
      this.harness = undefined
      if (signal.aborted || outcome.interrupted) {
        settleInterrupted()
        closeOpenCalls()
        signal.throwIfAborted()
        throw new Error(
          `external harness interrupted (${outcome.subtype}): ${outcome.stderrTail.trim()}`,
        )
      }
      if (outcome.subtype !== 'success') {
        settleInterrupted()
        closeOpenCalls()
        throw new Error(
          `external harness failed (${outcome.subtype}): ${outcome.text || outcome.stderrTail.trim()}`,
        )
      }
      // The turn's terminal round settles now, carrying the engine's usage.
      const finalRound = held
      held = undefined
      if (finalRound !== undefined) {
        commitAssistant(
          finalRound,
          finalRound.blocks(),
          outcome.usage === null ? {} : { usage: turnUsage(outcome.usage) },
        )
      }
      closeOpenCalls()
    } finally {
      if (openStep > 0) this.session.append('step/end', { turn, step: openStep })
    }
  }
}
