package dev.machinen.server;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import dev.machinen.runtime.Exposes;
import dev.machinen.state.MachineState;

/** HTTP face of the guest: routing, bearer auth, and the JSON envelopes. */
public final class GuestServer {

  static final String NAME = "java_machine";
  static final String VERSION = "1.0.0";
  static final int MAX_BODY_BYTES = 5 * 1024 * 1024;
  static final int DISPATCH_THREADS = 8;

  private final HttpServer server;
  private final ExecutorService dispatcher;
  private final String token;
  private final Exposes exposes;
  private final MachineState state;

  public GuestServer(int port, String token, Exposes exposes, MachineState state)
      throws IOException {
    this.token = token;
    this.exposes = exposes;
    this.state = state;
    this.server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
    this.server.createContext("/", this::route);
    // A small pool instead of the default single dispatch thread, so one
    // slow or hostile call can't block /mf/health for everyone else.
    this.dispatcher = Executors.newFixedThreadPool(DISPATCH_THREADS);
    this.server.setExecutor(dispatcher);
  }

  public void start() {
    server.start();
  }

  /** Stops accepting connections and lets in-flight exchanges drain briefly. */
  public void stop() {
    server.stop(1);
    dispatcher.shutdown();
  }

  private void route(HttpExchange ex) throws IOException {
    try {
      switch (ex.getRequestURI().getPath()) {
        case "/mf-manifest.json" -> handleManifest(ex);
        case "/mf-types.ts" -> handleTypes(ex);
        case "/mf/health" -> handleHealth(ex);
        case "/mf/call" -> handleCall(ex);
        case "/mf/state" -> handleState(ex);
        default -> send(ex, 404, "{}");
      }
    } catch (Throwable t) {
      // Catch Throwable, not Exception: a hostile payload must never take
      // down a dispatch thread (e.g. StackOverflowError is an Error).
      try {
        send(ex, 500, Json.write(Map.of("ok", false, "error", errorBody(t))));
      } catch (IOException secondary) {
        ex.close(); // response already started — drop the exchange
      }
    }
  }

  private void handleHealth(HttpExchange ex) throws IOException {
    send(ex, 200, Json.write(Map.of("ok", true, "name", NAME)));
  }

  private void handleManifest(HttpExchange ex) throws IOException {
    if (unauthorized(ex)) return;
    if (!ex.getRequestMethod().equals("GET")) {
      send(ex, 404, "{}");
      return;
    }
    Map<String, Object> manifest = new LinkedHashMap<>();
    manifest.put("name", NAME);
    manifest.put("protocol", 3);
    manifest.put("version", VERSION);
    manifest.put("metaData", Map.of(
        "runtime", "OpenJDK " + System.getProperty("java.version"),
        "features", List.of("state")));
    manifest.put("exposes", exposes.manifestExposes());
    send(ex, 200, Json.write(manifest));
  }

  /**
   * Serves the static {@code mf-types.ts} artifact published by this
   * machine's build (see build.mjs), found via the MACHINEN_TYPES_FILE env
   * var (default: {@code mf-types.ts} in the working directory). 404 when
   * the artifact was not published — consumers fall back to the manifest.
   */
  private void handleTypes(HttpExchange ex) throws IOException {
    if (unauthorized(ex)) return;
    if (!ex.getRequestMethod().equals("GET")) {
      send(ex, 404, "{}");
      return;
    }
    Path typesFile = Path.of(System.getenv().getOrDefault("MACHINEN_TYPES_FILE", "mf-types.ts"));
    if (!Files.isRegularFile(typesFile)) {
      send(ex, 404, "{}");
      return;
    }
    send(ex, 200, "application/typescript", Files.readString(typesFile, StandardCharsets.UTF_8));
  }

  private void handleCall(HttpExchange ex) throws IOException {
    if (unauthorized(ex)) return;
    if (!ex.getRequestMethod().equals("POST")) {
      send(ex, 404, "{}");
      return;
    }
    String body = readBody(ex);
    if (body == null) return; // 413 already sent
    try {
      @SuppressWarnings("unchecked")
      Map<String, Object> request = (Map<String, Object>) Json.parse(body);
      String module = (String) request.get("module");
      String fn = (String) request.get("fn");
      @SuppressWarnings("unchecked")
      List<Object> args = request.get("args") == null
          ? List.of()
          : (List<Object>) request.get("args");

      Object result = exposes.call(module, fn, args);
      send(ex, 200, Json.write(Map.of("ok", true, "result", result)));
    } catch (Exception e) {
      send(ex, 200, Json.write(Map.of("ok", false, "error", errorBody(e))));
    }
  }

  private void handleState(HttpExchange ex) throws IOException {
    if (unauthorized(ex)) return;
    if (ex.getRequestMethod().equals("GET")) {
      send(ex, 200, Json.write(Map.of("ok", true, "state", state.dehydrate())));
      return;
    }
    if (ex.getRequestMethod().equals("POST")) {
      String body = readBody(ex);
      if (body == null) return; // 413 already sent
      try {
        Object parsed = Json.parse(body);
        if (!(parsed instanceof Map)) {
          throw new IllegalArgumentException("state body must be a JSON object");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> request = (Map<String, Object>) parsed;
        Object stateValue = request.getOrDefault("state", Map.of());
        if (!(stateValue instanceof Map)) {
          throw new IllegalArgumentException("\"state\" must be a JSON object");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> snapshot = (Map<String, Object>) stateValue;
        state.rehydrate(snapshot);
        send(ex, 200, Json.write(Map.of("ok", true)));
      } catch (Exception e) {
        send(ex, 200, Json.write(Map.of("ok", false, "error", errorBody(e))));
      }
      return;
    }
    send(ex, 404, "{}");
  }

  /** Structured error payload for the {ok:false} envelope. */
  private static Map<String, Object> errorBody(Throwable t) {
    String message = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
    return Map.of("message", message, "type", t.getClass().getSimpleName());
  }

  private boolean unauthorized(HttpExchange ex) throws IOException {
    if (token == null || token.isEmpty()) return false;
    String header = ex.getRequestHeaders().getFirst("Authorization");
    if (("Bearer " + token).equals(header)) return false;
    send(ex, 401, Json.write(Map.of(
        "ok", false,
        "error", Map.of("message", "unauthorized", "type", "AuthError"))));
    return true;
  }

  /** Reads the request body, or sends 413 and returns null if it exceeds the cap. */
  private String readBody(HttpExchange ex) throws IOException {
    byte[] bytes = ex.getRequestBody().readNBytes(MAX_BODY_BYTES + 1);
    if (bytes.length > MAX_BODY_BYTES) {
      send(ex, 413, Json.write(Map.of(
          "ok", false,
          "error", Map.of("message", "payload too large", "type", "PayloadError"))));
      return null;
    }
    return new String(bytes, StandardCharsets.UTF_8);
  }

  private static void send(HttpExchange ex, int status, String json) throws IOException {
    send(ex, status, "application/json", json);
  }

  private static void send(HttpExchange ex, int status, String contentType, String body)
      throws IOException {
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    ex.getResponseHeaders().set("content-type", contentType);
    ex.sendResponseHeaders(status, bytes.length);
    try (OutputStream out = ex.getResponseBody()) {
      out.write(bytes);
    }
  }
}
