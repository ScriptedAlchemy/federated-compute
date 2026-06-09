// AUTO-GENERATED from the "java_machine" machine manifest by machinen bindgen.
// Do not edit by hand — regenerate with `pnpm bindgen`.

export interface JavaMachineJvm {
  info(): Promise<{ pid: number; javaVersion: string; vendor: string; hint: string }>;
}

export interface JavaMachineCompute {
  primesBelow(n: number): Promise<number[]>;
}

export interface JavaMachineStrings {
  sha256(s: string): Promise<string>;
  upper(s: string): Promise<string>;
}

export interface JavaMachineModules {
  './jvm': JavaMachineJvm;
  './compute': JavaMachineCompute;
  './strings': JavaMachineStrings;
}
