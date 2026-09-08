import { env } from '../../config/env.js';

/**
 * What the GPU work behind the Media Index actually costs.
 *
 * Modal exposes no supported billing API, so this is measured time inside the
 * service multiplied by a rate somebody typed in. With no rate configured it
 * returns null and the row says so, rather than pricing GPU seconds at zero
 * and calling them free — a cost of nothing is a claim, and it would be a
 * false one.
 */

/**
 * How long the GPU was actually held.
 *
 * The per-call timers start inside the remote method, which is AFTER the
 * model has been loaded onto the GPU — and loading it is real, billed time.
 * A cost built from the call timers alone understates every cold container,
 * which is precisely the container the first call of a run lands on.
 *
 * So the load is added once per CONTAINER rather than once per call: each
 * reply carries the id of the container that served it and how long that
 * container spent starting. Twenty calls to one warm container pay for one
 * startup, which is what actually happened.
 */
export function gpuMsFrom(metrics: ReadonlyArray<Record<string, unknown>>): number {
  const calls = metrics.reduce((sum, row) => sum + (typeof row.total_ms === 'number' ? row.total_ms : 0), 0);

  const startupByContainer = new Map<string, number>();
  for (const row of metrics) {
    if (typeof row.container !== 'string' || typeof row.startup_ms !== 'number') continue;
    startupByContainer.set(row.container, row.startup_ms);
  }
  const startup = [...startupByContainer.values()].reduce((sum, ms) => sum + ms, 0);

  return calls + startup;
}

/** Null when no rate is configured. Never zero: zero would read as free. */
export function estimateGpuCostUsd(msHeld: number): number | null {
  const rate = env.MODAL_L4_USD_PER_GPU_HOUR;
  if (rate === null || !Number.isFinite(msHeld) || msHeld <= 0) return null;
  return Number(((msHeld / 3_600_000) * rate).toFixed(6));
}
