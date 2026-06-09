package dev.machinen.runtime;

import java.util.List;
import java.util.Map;
import java.util.function.Function;

/** One MF-style expose: a module path plus its named, typed functions. */
public interface GuestModule {

  /** Expose path as it appears in the manifest, e.g. {@code "./strings"}. */
  String path();

  /** Function name -> spec, in manifest order. */
  Map<String, FunctionSpec> functions();

  /**
   * Pairs a protocol-v2 signature map ({@code {params, returns}}) with the
   * implementation invoked by POST /mf/call.
   */
  record FunctionSpec(Map<String, Object> signature, Function<List<Object>, Object> impl) {

    @SafeVarargs
    public static FunctionSpec of(
        String returns, Function<List<Object>, Object> impl, Map<String, Object>... params) {
      return new FunctionSpec(Map.of("params", List.of(params), "returns", returns), impl);
    }

    public static Map<String, Object> param(String name, String type) {
      return Map.of("name", name, "type", type);
    }
  }
}
