package dev.machinen.runtime;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Registry of guest modules: builds the manifest exposes and dispatches calls. */
public final class Exposes {

  private final Map<String, GuestModule> modules = new LinkedHashMap<>();

  public Exposes(List<GuestModule> modules) {
    for (GuestModule module : modules) {
      this.modules.put(module.path(), module);
    }
  }

  /** Expose path -> function name -> signature map, for the manifest. */
  public Map<String, Object> manifestExposes() {
    Map<String, Object> exposes = new LinkedHashMap<>();
    modules.forEach((path, module) -> {
      Map<String, Object> signatures = new LinkedHashMap<>();
      module.functions().forEach((name, spec) -> signatures.put(name, spec.signature()));
      exposes.put(path, signatures);
    });
    return exposes;
  }

  /** Dispatches a POST /mf/call invocation; errors keep the protocol wording. */
  public Object call(String module, String fn, List<Object> args) {
    GuestModule target = modules.get(module);
    if (target == null) {
      throw new IllegalArgumentException("unknown module \"" + module + "\"");
    }
    GuestModule.FunctionSpec spec = target.functions().get(fn);
    if (spec == null) {
      throw new IllegalArgumentException("module \"" + module + "\" has no function \"" + fn + "\"");
    }
    return spec.impl().apply(args);
  }
}
