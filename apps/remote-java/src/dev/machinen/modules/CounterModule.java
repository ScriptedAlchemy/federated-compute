package dev.machinen.modules;

import dev.machinen.runtime.GuestModule;
import dev.machinen.state.MachineState;
import java.util.LinkedHashMap;
import java.util.Map;

/** The {@code ./counter} expose, backed by the rehydratable machine state. */
public final class CounterModule implements GuestModule {

  private final MachineState state;

  public CounterModule(MachineState state) {
    this.state = state;
  }

  @Override
  public String path() {
    return "./counter";
  }

  @Override
  public Map<String, FunctionSpec> functions() {
    Map<String, FunctionSpec> fns = new LinkedHashMap<>();
    fns.put("increment", FunctionSpec.of("number", args -> state.increment()));
    fns.put("current", FunctionSpec.of("number", args -> state.current()));
    return fns;
  }
}
