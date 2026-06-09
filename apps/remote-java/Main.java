import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;

/**
 * Machine guest service in Java. Implements the federated-compute guest
 * protocol (GET /mf/manifest, POST /mf/call) so the Module Federation host
 * can bind its exposed functions like imported modules. Zero dependencies:
 * run directly with `java Main.java` (source-file mode).
 */
public class Main {

  static final String NAME = "java_machine";
  static final String VERSION = "1.0.0";
  static final String TOKEN = System.getenv("MACHINEN_TOKEN");

  /** Warm state that survives snapshot/restore. */
  static final AtomicLong COUNTER = new AtomicLong(0);

  /** MF-style exposes: module path -> function name -> implementation. */
  static final Map<String, Map<String, Function<List<Object>, Object>>> EXPOSES = Map.of(
      "./strings", Map.of(
          "upper", args -> ((String) args.get(0)).toUpperCase(Locale.ROOT),
          "sha256", args -> sha256((String) args.get(0))),
      "./compute", Map.of(
          "primesBelow", args -> primesBelow(((Number) args.get(0)).intValue())),
      "./counter", Map.of(
          "increment", args -> COUNTER.incrementAndGet(),
          "current", args -> COUNTER.get()),
      "./jvm", Map.of(
          "info", args -> Map.of(
              "pid", ProcessHandle.current().pid(),
              "javaVersion", System.getProperty("java.version"),
              "vendor", System.getProperty("java.vendor"),
              "hint", "this ran inside the Java machine, not in the host process")));

  /** Typed signatures (protocol v2) — these feed the host's bindgen. */
  static final Map<String, Map<String, Object>> SIGNATURES = Map.of(
      "./strings", Map.of(
          "upper", sig("string", param("s", "string")),
          "sha256", sig("string", param("s", "string"))),
      "./compute", Map.of(
          "primesBelow", sig("number[]", param("n", "number"))),
      "./counter", Map.of(
          "increment", sig("number"),
          "current", sig("number")),
      "./jvm", Map.of(
          "info", sig("{ pid: number; javaVersion: string; vendor: string; hint: string }")));

  @SafeVarargs
  static Map<String, Object> sig(String returns, Map<String, Object>... params) {
    return Map.of("params", List.of(params), "returns", returns);
  }

  static Map<String, Object> param(String name, String type) {
    return Map.of("name", name, "type", type);
  }

  public static void main(String[] args) throws IOException {
    int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "3802"));
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
    server.createContext("/mf-manifest.json", Main::handleManifest);
    server.createContext("/mf/manifest", Main::handleManifest);
    server.createContext("/mf/health", Main::handleHealth);
    server.createContext("/mf/call", Main::handleCall);
    server.createContext("/mf/state", Main::handleState);
    server.start();
    System.out.println("[remote-java] machine guest listening on 127.0.0.1:" + port);
  }

  static void handleHealth(HttpExchange ex) throws IOException {
    send(ex, 200, Json.write(Map.of("ok", true, "name", NAME)));
  }

  static void handleState(HttpExchange ex) throws IOException {
    if (unauthorized(ex)) return;
    if (ex.getRequestMethod().equals("GET")) {
      send(ex, 200, Json.write(Map.of("ok", true, "state", Map.of("counter", COUNTER.get()))));
      return;
    }
    if (ex.getRequestMethod().equals("POST")) {
      String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
      @SuppressWarnings("unchecked")
      Map<String, Object> request = (Map<String, Object>) Json.parse(body);
      @SuppressWarnings("unchecked")
      Map<String, Object> state = (Map<String, Object>) request.getOrDefault("state", Map.of());
      COUNTER.set(((Number) state.getOrDefault("counter", 0L)).longValue());
      send(ex, 200, Json.write(Map.of("ok", true)));
      return;
    }
    send(ex, 404, "{}");
  }

  static boolean unauthorized(HttpExchange ex) throws IOException {
    if (TOKEN == null || TOKEN.isEmpty()) return false;
    String header = ex.getRequestHeaders().getFirst("Authorization");
    if (("Bearer " + TOKEN).equals(header)) return false;
    send(ex, 401, Json.write(Map.of(
        "ok", false,
        "error", Map.of("message", "unauthorized", "type", "AuthError"))));
    return true;
  }

  static void handleManifest(HttpExchange ex) throws IOException {
    if (unauthorized(ex)) return;
    if (!ex.getRequestMethod().equals("GET")) {
      send(ex, 404, "{}");
      return;
    }
    Map<String, Object> exposes = new LinkedHashMap<>();
    SIGNATURES.forEach((path, fns) -> exposes.put(path, fns));
    send(ex, 200, Json.write(Map.of(
        "name", NAME,
        "protocol", 3,
        "version", VERSION,
        "metaData", Map.of(
            "runtime", "OpenJDK " + System.getProperty("java.version"),
            "features", List.of("state")),
        "exposes", exposes)));
  }

  static void handleCall(HttpExchange ex) throws IOException {
    if (unauthorized(ex)) return;
    if (!ex.getRequestMethod().equals("POST")) {
      send(ex, 404, "{}");
      return;
    }
    try {
      String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
      @SuppressWarnings("unchecked")
      Map<String, Object> request = (Map<String, Object>) Json.parse(body);
      String module = (String) request.get("module");
      String fn = (String) request.get("fn");
      @SuppressWarnings("unchecked")
      List<Object> callArgs = request.get("args") == null
          ? List.of()
          : (List<Object>) request.get("args");

      Map<String, Function<List<Object>, Object>> mod = EXPOSES.get(module);
      if (mod == null) throw new IllegalArgumentException("unknown module \"" + module + "\"");
      Function<List<Object>, Object> target = mod.get(fn);
      if (target == null) {
        throw new IllegalArgumentException("module \"" + module + "\" has no function \"" + fn + "\"");
      }

      Object result = target.apply(callArgs);
      send(ex, 200, Json.write(Map.of("ok", true, "result", result)));
    } catch (Exception e) {
      String message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
      send(ex, 200, Json.write(Map.of(
          "ok", false,
          "error", Map.of("message", message, "type", e.getClass().getSimpleName()))));
    }
  }

  static void send(HttpExchange ex, int status, String json) throws IOException {
    byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
    ex.getResponseHeaders().set("content-type", "application/json");
    ex.sendResponseHeaders(status, bytes.length);
    try (OutputStream out = ex.getResponseBody()) {
      out.write(bytes);
    }
  }

  static String sha256(String input) {
    try {
      MessageDigest md = MessageDigest.getInstance("SHA-256");
      byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
      StringBuilder sb = new StringBuilder(digest.length * 2);
      for (byte b : digest) sb.append(String.format("%02x", b));
      return sb.toString();
    } catch (Exception e) {
      throw new RuntimeException(e);
    }
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

  /** Minimal JSON reader/writer — enough for the guest call protocol. */
  static final class Json {
    private final String s;
    private int i;

    private Json(String s) {
      this.s = s;
    }

    static Object parse(String s) {
      Json p = new Json(s);
      Object v = p.value();
      p.ws();
      if (p.i < p.s.length()) throw new IllegalArgumentException("trailing JSON content");
      return v;
    }

    private void ws() {
      while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
    }

    private Object value() {
      ws();
      char c = s.charAt(i);
      return switch (c) {
        case '{' -> object();
        case '[' -> array();
        case '"' -> string();
        case 't' -> literal("true", Boolean.TRUE);
        case 'f' -> literal("false", Boolean.FALSE);
        case 'n' -> literal("null", null);
        default -> number();
      };
    }

    private Map<String, Object> object() {
      Map<String, Object> map = new LinkedHashMap<>();
      i++; // {
      ws();
      if (s.charAt(i) == '}') {
        i++;
        return map;
      }
      while (true) {
        ws();
        String key = string();
        ws();
        expect(':');
        map.put(key, value());
        ws();
        if (s.charAt(i) == ',') {
          i++;
          continue;
        }
        expect('}');
        return map;
      }
    }

    private List<Object> array() {
      List<Object> list = new ArrayList<>();
      i++; // [
      ws();
      if (s.charAt(i) == ']') {
        i++;
        return list;
      }
      while (true) {
        list.add(value());
        ws();
        if (s.charAt(i) == ',') {
          i++;
          continue;
        }
        expect(']');
        return list;
      }
    }

    private String string() {
      expect('"');
      StringBuilder sb = new StringBuilder();
      while (true) {
        char c = s.charAt(i++);
        if (c == '"') return sb.toString();
        if (c == '\\') {
          char esc = s.charAt(i++);
          switch (esc) {
            case '"' -> sb.append('"');
            case '\\' -> sb.append('\\');
            case '/' -> sb.append('/');
            case 'b' -> sb.append('\b');
            case 'f' -> sb.append('\f');
            case 'n' -> sb.append('\n');
            case 'r' -> sb.append('\r');
            case 't' -> sb.append('\t');
            case 'u' -> {
              sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
              i += 4;
            }
            default -> throw new IllegalArgumentException("bad escape \\" + esc);
          }
        } else {
          sb.append(c);
        }
      }
    }

    private Object number() {
      int start = i;
      while (i < s.length() && "-+.eE0123456789".indexOf(s.charAt(i)) >= 0) i++;
      String raw = s.substring(start, i);
      if (raw.contains(".") || raw.contains("e") || raw.contains("E")) {
        return Double.parseDouble(raw);
      }
      return Long.parseLong(raw);
    }

    private Object literal(String word, Object value) {
      if (!s.startsWith(word, i)) throw new IllegalArgumentException("bad literal at " + i);
      i += word.length();
      return value;
    }

    private void expect(char c) {
      if (s.charAt(i) != c) {
        throw new IllegalArgumentException("expected '" + c + "' at " + i + ", got '" + s.charAt(i) + "'");
      }
      i++;
    }

    static String write(Object value) {
      StringBuilder sb = new StringBuilder();
      writeTo(sb, value);
      return sb.toString();
    }

    private static void writeTo(StringBuilder sb, Object value) {
      switch (value) {
        case null -> sb.append("null");
        case String str -> writeString(sb, str);
        case Boolean b -> sb.append(b);
        case Number n -> sb.append(n);
        case Map<?, ?> map -> {
          sb.append('{');
          boolean first = true;
          for (Map.Entry<?, ?> entry : map.entrySet()) {
            if (!first) sb.append(',');
            first = false;
            writeString(sb, String.valueOf(entry.getKey()));
            sb.append(':');
            writeTo(sb, entry.getValue());
          }
          sb.append('}');
        }
        case Iterable<?> items -> {
          sb.append('[');
          boolean first = true;
          for (Object item : items) {
            if (!first) sb.append(',');
            first = false;
            writeTo(sb, item);
          }
          sb.append(']');
        }
        default -> writeString(sb, String.valueOf(value));
      }
    }

    private static void writeString(StringBuilder sb, String str) {
      sb.append('"');
      for (int j = 0; j < str.length(); j++) {
        char c = str.charAt(j);
        switch (c) {
          case '"' -> sb.append("\\\"");
          case '\\' -> sb.append("\\\\");
          case '\n' -> sb.append("\\n");
          case '\r' -> sb.append("\\r");
          case '\t' -> sb.append("\\t");
          default -> {
            if (c < 0x20) {
              sb.append(String.format("\\u%04x", (int) c));
            } else {
              sb.append(c);
            }
          }
        }
      }
      sb.append('"');
    }
  }
}
