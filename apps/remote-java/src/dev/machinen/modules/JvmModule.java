package dev.machinen.modules;

import dev.machinen.runtime.GuestModule;
import java.util.Map;

/** The {@code ./jvm} expose: proof the call ran inside this JVM. */
public final class JvmModule implements GuestModule {

  @Override
  public String path() {
    return "./jvm";
  }

  @Override
  public Map<String, FunctionSpec> functions() {
    return Map.of(
        "info", FunctionSpec.of(
            "{ pid: number; javaVersion: string; vendor: string; hint: string }",
            args -> Map.of(
                "pid", ProcessHandle.current().pid(),
                "javaVersion", System.getProperty("java.version"),
                "vendor", System.getProperty("java.vendor"),
                "hint", "this ran inside the Java machine, not in the host process")));
  }
}
