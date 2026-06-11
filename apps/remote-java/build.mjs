#!/usr/bin/env node
// Zero-dependency build: javac src/**/*.java -> build/classes, then package
// dist/java-machine.jar with dev.machinen.Main as the entrypoint. Finally
// publish the machine's static /mf-types.ts artifact (dist/mf-types.ts) by
// booting the fresh jar and pointing machinen-bindgen at it.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, "src");
const classesDir = join(root, "build", "classes");
const jarFile = join(root, "dist", "java-machine.jar");
const typesFile = join(root, "dist", "mf-types.ts");
const pluginDir = join(root, "..", "..", "packages", "runtime-plugin");
const bindgenCli = join(pluginDir, "dist", "cli.js");

function collectJavaFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectJavaFiles(path));
    else if (entry.name.endsWith(".java")) files.push(path);
  }
  return files;
}

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
  } catch (err) {
    console.error(`[build] ${cmd} failed${err.status != null ? ` (exit ${err.status})` : ""}`);
    process.exit(err.status ?? 1);
  }
}

const sources = collectJavaFiles(srcDir);
if (sources.length === 0) {
  console.error("[build] no .java sources found under src/");
  process.exit(1);
}

rmSync(classesDir, { recursive: true, force: true });
mkdirSync(classesDir, { recursive: true });
mkdirSync(dirname(jarFile), { recursive: true });

console.log(`[build] compiling ${sources.length} source files`);
run("javac", ["-d", classesDir, ...sources]);

console.log(`[build] packaging ${jarFile}`);
run("jar", [
  "--create",
  "--file", jarFile,
  "--main-class", "dev.machinen.Main",
  "-C", classesDir, ".",
]);

await publishTypesArtifact();

if (process.exitCode) {
  console.error("[build] finished with errors — mf-types generation failed");
} else {
  console.log("[build] done");
}

/**
 * Generates dist/mf-types.ts, the static artifact GuestServer serves at
 * GET /mf-types.ts: boot the jar on a free port, run machinen-bindgen
 * against it (the jar serves no types yet, so the CLI renders from the
 * manifest), then stop the jar.
 */
async function publishTypesArtifact() {
  if (!existsSync(bindgenCli)) {
    console.log("[build] building machinen plugin (bindgen CLI is needed)");
    run("pnpm", ["--dir", pluginDir, "run", "build"]);
  }

  // Drop any stale artifact so the booted jar 404s on /mf-types.ts and the
  // CLI renders fresh bindings from the manifest.
  rmSync(typesFile, { force: true });

  const port = await freePort();
  console.log(`[build] booting the jar on :${port} to generate ${typesFile}`);
  const guest = spawn("java", ["-jar", jarFile], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    await waitForHealth(port, guest);
    execFileSync("node", [
      bindgenCli,
      "--url", `http://127.0.0.1:${port}`,
      "--out", typesFile,
    ], { stdio: "inherit" });
  } catch (err) {
    console.error(`[build] mf-types generation failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    guest.kill();
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, guest) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (guest.exitCode !== null) throw new Error("guest jar exited before becoming healthy");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mf/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error("guest jar did not become healthy within 30s");
}
