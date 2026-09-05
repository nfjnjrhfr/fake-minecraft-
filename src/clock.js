// A virtual clock. Nothing in this internet uses wall time: every link
// latency, timeout and retry is an event scheduled on this queue, so a whole
// session is deterministic and runs as fast as the CPU allows.

export class Clock {
  constructor() {
    this.now = 0;
    this.queue = [];
    this.seq = 0;
  }

  /** Schedule `fn` to run at absolute virtual time `time` (ms). */
  at(time, fn) {
    const event = { time, seq: this.seq++, fn, cancelled: false };
    // Keep the queue sorted by (time, seq) with a binary insert.
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const other = this.queue[mid];
      if (other.time < time || (other.time === time && other.seq < event.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, event);
    return event;
  }

  /** Schedule `fn` to run `delay` ms from now. */
  after(delay, fn) {
    return this.at(this.now + Math.max(0, delay), fn);
  }

  static cancel(event) {
    if (event) event.cancelled = true;
  }

  /** Run the next pending event. Returns false when the queue is empty. */
  step() {
    while (this.queue.length) {
      const event = this.queue.shift();
      if (event.cancelled) continue;
      this.now = Math.max(this.now, event.time);
      event.fn();
      return true;
    }
    return false;
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Advance `clock` until `promise` settles.
 *
 * Host code is written with async/await, so between clock events we hand
 * control back to the microtask queue (via setImmediate) to let those
 * continuations run and schedule their own events.
 */
export async function drive(clock, promise) {
  let settled = false;
  let value;
  let error;
  let failed = false;
  promise.then(
    (v) => {
      settled = true;
      value = v;
    },
    (e) => {
      settled = true;
      failed = true;
      error = e;
    },
  );

  let idleRounds = 0;
  while (!settled) {
    await tick();
    if (settled) break;
    if (clock.step()) {
      idleRounds = 0;
    } else if (++idleRounds >= 2) {
      throw new Error('the network went idle while a request was still pending');
    }
  }

  if (failed) throw error;
  return value;
}
