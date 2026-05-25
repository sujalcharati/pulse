// =====================================================================
// In-memory log buffer (Decision C: buffer + periodic flush)
//
// Design choice: a bounded array with drop-oldest on overflow.
//
// Why a plain array and not a ring buffer with head/tail pointers?
//   - Array of ≤100 items: shift() is O(n) but n is tiny (microseconds).
//   - We optimize for code that's obviously correct over the interview
//     bench, not for a 10M ops/s benchmark. A ring buffer would be
//     three more lines of pointer bookkeeping for no measurable win.
//
// Why drop-oldest (not drop-newest)?
//   - During a sustained outage of the ingestion service, the freshest
//     events are most useful for the on-call debugger. Old events from
//     30+ seconds ago have already been superseded by what just broke.
//   - Drop-newest would mean the buffer "fossilizes" on the first 100
//     events of an incident, which is exactly backwards.
// =====================================================================

import type { LogEvent } from "../types.js";

export class LogBuffer {
  private readonly events: LogEvent[] = [];
  private dropped = 0;

  constructor(private readonly maxSize: number) {}

  /** Append an event. If the buffer is full, evict the oldest. */
  push(event: LogEvent): void {
    if (this.events.length >= this.maxSize) {
      this.events.shift();
      this.dropped++;
    }
    this.events.push(event);
  }

  /** Atomically pull up to `n` events from the front of the buffer.
   *  Used by the transport on each flush tick. */
  drain(n: number): LogEvent[] {
    return this.events.splice(0, n);
  }

  /** Put events back at the front (preserving order) when a flush
   *  fails and we want to retry. */
  unshift(events: LogEvent[]): void {
    this.events.unshift(...events);
    // Re-enforce the cap; if retry + new arrivals overflow we drop the
    // oldest of the *retried* batch, which is consistent with our policy.
    while (this.events.length > this.maxSize) {
      this.events.shift();
      this.dropped++;
    }
  }

  size(): number {
    return this.events.length;
  }

  /** Total events lost to drop-oldest since process start. Surfaced for
   *  debugging — the chat app could log it on shutdown. */
  droppedCount(): number {
    return this.dropped;
  }
}
