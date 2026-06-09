package dev.machinen.server;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Minimal JSON reader/writer — enough for the guest call protocol. */
public final class Json {

  /** Maximum nesting before parsing fails — bounds recursion so a deeply
   *  nested payload raises a catchable parse error, not StackOverflowError. */
  static final int MAX_DEPTH = 256;

  private final String s;
  private int i;
  private int depth;

  private Json(String s) {
    this.s = s;
  }

  public static Object parse(String s) {
    Json p = new Json(s);
    Object v = p.value();
    p.ws();
    if (p.i < p.s.length()) throw new IllegalArgumentException("trailing JSON content");
    return v;
  }

  private void ws() {
    while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
  }

  /** Current char, or a parse error (never a raw index exception) past the end. */
  private char cur() {
    if (i >= s.length()) throw new IllegalArgumentException("unexpected end of JSON at " + i);
    return s.charAt(i);
  }

  /** Like {@link #cur()}, but consumes the char. */
  private char take() {
    char c = cur();
    i++;
    return c;
  }

  private Object value() {
    ws();
    char c = cur();
    boolean nested = c == '{' || c == '[';
    if (nested && ++depth > MAX_DEPTH) {
      throw new IllegalArgumentException("JSON nested deeper than " + MAX_DEPTH + " levels");
    }
    try {
      return switch (c) {
        case '{' -> object();
        case '[' -> array();
        case '"' -> string();
        case 't' -> literal("true", Boolean.TRUE);
        case 'f' -> literal("false", Boolean.FALSE);
        case 'n' -> literal("null", null);
        default -> number();
      };
    } finally {
      if (nested) depth--;
    }
  }

  private Map<String, Object> object() {
    Map<String, Object> map = new LinkedHashMap<>();
    i++; // {
    ws();
    if (cur() == '}') {
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
      if (cur() == ',') {
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
    if (cur() == ']') {
      i++;
      return list;
    }
    while (true) {
      list.add(value());
      ws();
      if (cur() == ',') {
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
      char c = take();
      if (c == '"') return sb.toString();
      if (c == '\\') {
        char esc = take();
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
            if (i + 4 > s.length()) {
              throw new IllegalArgumentException("unexpected end of JSON in \\u escape at " + i);
            }
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
    if (raw.isEmpty()) throw new IllegalArgumentException("unexpected character at " + start);
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
    char got = cur();
    if (got != c) {
      throw new IllegalArgumentException("expected '" + c + "' at " + i + ", got '" + got + "'");
    }
    i++;
  }

  public static String write(Object value) {
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
