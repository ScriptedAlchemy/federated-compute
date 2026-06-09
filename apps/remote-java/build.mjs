#!/usr/bin/env node
// Zero-dependency build: javac src/**/*.java -> build/classes, then package
// dist/java-machine.jar with dev.machinen.Main as the entrypoint.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, "src");
const classesDir = join(root, "build", "classes");
const jarFile = join(root, "dist", "java-machine.jar");

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

console.log("[build] done");
