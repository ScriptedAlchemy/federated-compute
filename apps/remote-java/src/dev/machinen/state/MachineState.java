package dev.machinen.state;

import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/** Warm state that survives snapshot/restore via /mf/state. */
public final class MachineState {

  private final AtomicLong counter = new AtomicLong(0);

  public long increment() {
    return counter.incrementAndGet();
  }

  public long current() {
    return counter.get();
  }

  /** Snapshot for GET /mf/state. */
  public Map<String, Object> dehydrate() {
    return Map.of("counter", counter.get());
  }

  /** Restore from POST /mf/state. */
  public void rehydrate(Map<String, Object> state) {
    counter.set(((Number) state.getOrDefault("counter", 0L)).longValue());
  }
}
