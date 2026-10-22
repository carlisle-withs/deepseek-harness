/**
 * External-harness Agent driver: each turn hands its claimed input to an
 * external CLI engine and folds the reply into the durable session log with
 * the same event vocabulary the default React loop writes, so the unchanged
 * dsh UI renders external turns like native ones.
 *
 * Phase ①: the engine is a canned stub (see {@link ExternalAgent.runExternalHarness});
 * the Claude Code spawn lands in Phase ②. Durable inbox routing is already
 * real: pending input round-trips `agent/inbox/spliced` events exactly like
 * the default loop's inbox.
 *
 * @module dsh-agent-loop-external/agent
 */

import type { ChildProcess } from 'node:child_process'
import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  Inbox as InboxContract,
  InboxState,
  InboxTarget,
} from '@deepseek-ai/dsh-agent'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import {
  AssistantStreamAccumulator,
  createAssistantMessage,
  LlmAttemptId,
} from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'

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

/**
 * The single logical step number every external turn records. The external
 * engine owns its own internal progress; the dsh log keeps one step per turn
 * so existing turn/step readers see a well-formed boundary sequence.
 */
const HARNESS_STEP = 1

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
  /**
   * Phase ②: the external harness child behind the running turn.
   * TODO(external-loop): spawn here and resolve {@link runExternalHarness}
   * from its stream; `cancel()` kills it.
   */
  private child: ChildProcess | undefined

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
    // TODO(external-loop): mid-turn steering needs a live harness channel
    // (Phase ②); queued steering runs as the next turn's input, as today.
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
    // The awaiting turn observes the abort signal; a live harness child must
    // not outlive its turn. TODO(external-loop): await child exit in Phase ②.
    this.child?.kill()
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
    let turnEnds: TurnEndReason | null = null
    try {
      const messages = this.claimTurnInput(turn)
      for (const message of messages) {
        this.session.append('user/message', message, { surfaceOp: 'append' })
      }
      if (messages.length > 0) {
        signal.throwIfAborted()
        const prompt = messages.map(messageText).join('\n')
        const { text } = await this.runExternalHarness(prompt)
        signal.throwIfAborted()
        this.appendAssistantReply(turn, text)
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
      this.dispatch.emit('agent/error', { turn, step: HARNESS_STEP, error })
      throw error
    } finally {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
      this.session.append('turn/end', { turn, reason: turnEnds! })
    }
    return this.hasPending()
  }

  /**
   * Append one assistant reply as a durable `assistant/message` carrying the
   * compact embedded stream, publishing the matching live
   * `agent/assistant-stream` start/chunk/end frames around the commit — the
   * exact durable and live shapes the default loop's step produces.
   * @param turn - the open turn number.
   * @param text - the engine's reply text.
   */
  private appendAssistantReply(turn: number, text: string): void {
    const attemptId = LlmAttemptId(`${this.id}:${++this.attemptCounter}`)
    const nextRevision = (): number => ++this.streamRevision
    const accumulator = new AssistantStreamAccumulator()
    const chunks: StreamChunk[] = [
      { type: 'text-delta', index: 0, text },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    this.dispatch.emit('agent/assistant-stream', {
      frame: { type: 'start', attemptId, revision: nextRevision(), turn, step: HARNESS_STEP },
    })
    let index = 0
    for (const chunk of chunks) {
      const timed = accumulator.push({ time: Date.now(), chunk })
      this.dispatch.emit('agent/assistant-stream', {
        frame: {
          type: 'chunk',
          attemptId,
          revision: nextRevision(),
          index: index++,
          time: timed.time,
          chunk: timed.chunk,
        },
      })
    }
    const message = createAssistantMessage({
      content: [{ type: 'text', text }],
      source: {
        provider: this.options.provider ?? 'external',
        model: this.options.model ?? 'claude-code',
      },
    })
    const stream: AssistantStreamRecord[] = [...accumulator.snapshot()]
    const event = this.session.append('assistant/message', {
      turn,
      step: HARNESS_STEP,
      message,
      stream,
    }, { surfaceOp: 'append' })
    this.dispatch.emit('agent/assistant-stream', {
      frame: {
        type: 'end',
        attemptId,
        revision: nextRevision(),
        index,
        outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq },
      },
    })
  }

  /**
   * Run one prompt through the external CLI harness.
   *
   * TODO(external-loop Phase ②): spawn the real engine, e.g.
   * `claude -p --output-format stream-json --include-partial-messages
   * --verbose --permission-mode acceptEdits` with the prompt on stdin and
   * conversation resume via `--session`, translating its stream frames into
   * live `agent/assistant-stream` publications and blocks. Phase ① returns
   * one canned text so the full turn pipeline is observable end to end.
   * @param prompt - the turn's claimed input text.
   * @returns the engine's assistant text for this turn.
   */
  protected async runExternalHarness(prompt: string): Promise<{ text: string }> {
    return { text: `[external-loop] engine=claude, received: ${prompt.slice(0, 80)}` }
  }
}
