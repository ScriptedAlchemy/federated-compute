package dev.machinen.modules;

import static dev.machinen.runtime.GuestModule.FunctionSpec.param;

import dev.machinen.runtime.GuestModule;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** The {@code ./compute} expose: CPU-bound demo work. */
public final class ComputeModule implements GuestModule {

  @Override
  public String path() {
    return "./compute";
  }

  @Override
  public Map<String, FunctionSpec> functions() {
    return Map.of(
        "primesBelow", FunctionSpec.of(
            "number[]",
            args -> primesBelow(((Number) args.get(0)).intValue()),
            param("n", "number")));
  }

  static List<Integer> primesBelow(int n) {
    boolean[] composite = new boolean[Math.max(n, 2)];
    List<Integer> primes = new ArrayList<>();
    for (int i = 2; i < n; i++) {
      if (composite[i]) continue;
      primes.add(i);
      for (long j = (long) i * i; j < n; j += i) composite[(int) j] = true;
    }
    return primes;
  }
}
