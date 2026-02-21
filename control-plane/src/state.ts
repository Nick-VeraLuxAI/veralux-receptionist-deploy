import { randomUUID } from "crypto";
import type { CallState, Stage } from "./runTypes";

const INITIAL_STAGE: Stage = "greeting";

const CALL_TTL_MS = Number(process.env.CALL_TTL_MS ?? 30 * 60_000); // 30 min
const SWEEP_MS = Number(process.env.CALL_SWEEP_MS ?? 60_000); // 60 sec

export class InMemoryCallStore {
  private calls = new Map<string, CallState>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private tenantId: string,
    initialCalls?: CallState[],
    private onChange?: () => void,
    // Optional hook so the server can release global capacity counters too
    private onDeleteCall?: (callId: string) => void
  ) {
    if (initialCalls) {
      initialCalls.forEach((call) => {
        if (call && call.id) this.calls.set(call.id, call);
      });
    }

    // Start background sweep
    this.sweepTimer = setInterval(() => this.sweepExpiredCalls(), SWEEP_MS);
    this.sweepTimer.unref();
  }

  createCall(callerId?: string): CallState {
    const now = Date.now();
    const call: CallState = {
      id: randomUUID(),
      tenantId: this.tenantId,
      callerId,
      stage: INITIAL_STAGE,
      lead: {},
      history: [],
      createdAt: now,
      lastActivityAt: now,
    };
    this.calls.set(call.id, call);
    this.onChange?.();
    return call;
  }

  getCall(callId: string): CallState | undefined {
    return this.calls.get(callId);
  }

  listCalls(): CallState[] {
    return Array.from(this.calls.values());
  }

  save(call: CallState): CallState {
    const now = Date.now();
    const next: CallState = {
      ...call,
      createdAt: call.createdAt ?? now,
      lastActivityAt: now,
    };
    this.calls.set(call.id, next);
    this.onChange?.();
    return next;
  }

  deleteCall(callId: string): void {
    if (this.calls.delete(callId)) {
      this.onDeleteCall?.(callId);
      this.onChange?.();
    }
  }

  serialize(): CallState[] {
    return Array.from(this.calls.values());
  }

  private sweepExpiredCalls(): void {
    const now = Date.now();
    let changed = false;

    for (const [callId, call] of this.calls.entries()) {
      const last = call.lastActivityAt ?? call.createdAt;
      // If no timestamp at all, the call is an orphan from a DB reload — remove it.
      if (last === undefined || last === 0 || now - last > CALL_TTL_MS) {
        this.calls.delete(callId);
        this.onDeleteCall?.(callId);
        changed = true;
      }
    }

    if (changed) this.onChange?.();
  }
}
