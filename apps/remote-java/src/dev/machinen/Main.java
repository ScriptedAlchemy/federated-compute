package dev.machinen;

import dev.machinen.modules.ComputeModule;
import dev.machinen.modules.CounterModule;
import dev.machinen.modules.JvmModule;
import dev.machinen.modules.StringsModule;
import dev.machinen.runtime.Exposes;
import dev.machinen.server.GuestServer;
import dev.machinen.state.MachineState;
import java.util.List;

/**
 * Machine guest service in Java. Implements the federated-compute guest
 * protocol v3 (GET /mf-manifest.json, GET /mf/health, POST /mf/call,
 * GET/POST /mf/state) so the Module Federation host can bind its exposed
 * functions like imported modules. Zero dependencies, JDK only.
 */
public final class Main {

  private Main() {}

  public static void main(String[] args) throws Exception {
    String host = System.getenv().getOrDefault("HOST", "127.0.0.1");
    int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "3802"));

    MachineState state = new MachineState();
    Exposes exposes = new Exposes(List.of(
        new StringsModule(),
        new ComputeModule(),
        new CounterModule(state),
        new JvmModule()));

    GuestServer server = new GuestServer(host, port, exposes, state);
    server.start();
    System.out.println("[remote-java] machine guest listening on " + host + ":" + port);

    Runtime.getRuntime().addShutdownHook(new Thread(() -> {
      server.stop();
      System.out.println("[remote-java] machine guest shutting down");
    }, "guest-shutdown"));
  }
}
