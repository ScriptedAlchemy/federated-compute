package dev.machinen.modules;

import static dev.machinen.runtime.GuestModule.FunctionSpec.param;

import dev.machinen.runtime.GuestModule;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** The {@code ./strings} expose: upper-casing and SHA-256 hashing. */
public final class StringsModule implements GuestModule {

  @Override
  public String path() {
    return "./strings";
  }

  @Override
  public Map<String, FunctionSpec> functions() {
    Map<String, FunctionSpec> fns = new LinkedHashMap<>();
    fns.put("upper", FunctionSpec.of(
        "string",
        args -> ((String) args.get(0)).toUpperCase(Locale.ROOT),
        param("s", "string")));
    fns.put("sha256", FunctionSpec.of(
        "string",
        args -> sha256((String) args.get(0)),
        param("s", "string")));
    return fns;
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
}
