package dev.machinen.server;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import dev.machinen.runtime.Exposes;
import dev.machinen.state.MachineState;

/** HTTP face of the guest: routing, bearer auth, and the JSON envelopes. */
public final class GuestServer {

  static final String NAME = "java_machine";
  static final String VERSION = "1.0.0";
  static final int MAX_BODY_BYTES = 5 * 1024 * 1024;

  private final HttpServer server;
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
  }

  public void start() {
    server.start();
  }

  /** Stops accepting connections and lets in-flight exchanges drain briefly. */
  public void stop() {
    server.stop(1);
  }

  private void route(HttpExchange ex) throws IOException {
    switch (ex.getRequestURI().getPath()) {
      case "/mf-manifest.json" -> handleManifest(ex);
      case "/mf/health" -> handleHealth(ex);
      case "/mf/call" -> handleCall(ex);
      case "/mf/state" -> handleState(ex);
      default -> send(ex, 404, "{}");
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
      String message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
      send(ex, 200, Json.write(Map.of(
          "ok", false,
          "error", Map.of("message", message, "type", e.getClass().getSimpleName()))));
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
      @SuppressWarnings("unchecked")
      Map<String, Object> request = (Map<String, Object>) Json.parse(body);
      @SuppressWarnings("unchecked")
      Map<String, Object> snapshot = (Map<String, Object>) request.getOrDefault("state", Map.of());
      state.rehydrate(snapshot);
      send(ex, 200, Json.write(Map.of("ok", true)));
      return;
    }
    send(ex, 404, "{}");
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
    byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
    ex.getResponseHeaders().set("content-type", "application/json");
    ex.sendResponseHeaders(status, bytes.length);
    try (OutputStream out = ex.getResponseBody()) {
      out.write(bytes);
    }
  }
}
