import { MachineTimeoutError } from './errors.js';

export interface CircuitBreakerConfig {
  /** Consecutive transport failures before the circuit opens. */
  threshold: number;
  /** How long the circuit stays open before allowing a half-open probe. */
  resetMs: number;
}

export interface CallPolicy {
  /** Per-call deadline. Timeouts count as transport failures. Default 30s. */
  timeoutMs?: number;
  /** Transport-only retries per call (guest errors never retry). Default 0. */
  retries?: number;
  /** Base backoff between retries, doubled each attempt. Default 100ms. */
  backoffMs?: number;
  /** Per-machine circuit breaker; `false` disables. Default { threshold: 5, resetMs: 10_000 }. */
  circuitBreaker?: CircuitBreakerConfig | false;
}

export const DEFAULT_POLICY: Required<Omit<CallPolicy, 'circuitBreaker'>> & {
  circuitBreaker: CircuitBreakerConfig | false;
} = {
  timeoutMs: 30_000,
  retries: 0,
  backoffMs: 100,
  circuitBreaker: { threshold: 5, resetMs: 10_000 },
};

export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new MachineTimeoutError(`${label} timed out after ${ms}ms`)),
          ms,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type CircuitState = 'closed' | 'open' | 'half-open';

/** Minimal per-machine circuit breaker (consecutive-failure threshold). */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;

  constructor(private config: CircuitBreakerConfig) {}

  /** Returns the state a new call should observe (transitions open -> half-open). */
  gate(now = Date.now()): CircuitState {
    if (this.failures < this.config.threshold) return 'closed';
    if (now - this.openedAt >= this.config.resetMs && !this.probing) {
      this.probing = true;
      return 'half-open';
    }
    return 'open';
  }

  onSuccess(): boolean {
    const wasOpen = this.failures >= this.config.threshold;
    this.failures = 0;
    this.probing = false;
    return wasOpen; // true => circuit just closed
  }

  onTransportFailure(now = Date.now()): boolean {
    this.failures++;
    this.probing = false;
    if (this.failures === this.config.threshold) {
      this.openedAt = now;
      return true; // circuit just opened
    }
    if (this.failures > this.config.threshold) this.openedAt = now;
    return false;
  }
}

export interface MachineMetrics {
  calls: number;
  errors: number;
  crashes: number;
  retries: number;
  timeouts: number;
  circuitOpens: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

const RESERVOIR_SIZE = 512;

/** Per-machine call statistics, fed by the plugin's call path. */
export class MetricsRecorder {
  private counters = {
    calls: 0,
    errors: 0,
    crashes: 0,
    retries: 0,
    timeouts: 0,
    circuitOpens: 0,
  };
  private durations: number[] = [];
  private cursor = 0;

  record(event: keyof MetricsRecorder['counters']): void {
    this.counters[event]++;
  }

  recordDuration(ms: number): void {
    if (this.durations.length < RESERVOIR_SIZE) {
      this.durations.push(ms);
    } else {
      this.durations[this.cursor] = ms;
      this.cursor = (this.cursor + 1) % RESERVOIR_SIZE;
    }
  }

  snapshot(): MachineMetrics {
    const sorted = [...this.durations].sort((a, b) => a - b);
    const at = (q: number) => (sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : 0);
    return {
      ...this.counters,
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
    };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
