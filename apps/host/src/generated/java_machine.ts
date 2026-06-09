// AUTO-GENERATED from the "java_machine" machine manifest by machinen bindgen.
// Do not edit by hand — regenerate with `pnpm bindgen`.
import { machineModule } from '@federated-compute/machinen-plugin/client';

export interface JavaMachineStrings {
  upper(s: string): Promise<string>;
  sha256(s: string): Promise<string>;
}

export interface JavaMachineJvm {
  info(): Promise<{ pid: number; javaVersion: string; vendor: string; hint: string }>;
}

export interface JavaMachineCompute {
  primesBelow(n: number): Promise<number[]>;
}

export interface JavaMachineModules {
  './strings': JavaMachineStrings;
  './jvm': JavaMachineJvm;
  './compute': JavaMachineCompute;
}

export const strings = machineModule<JavaMachineStrings>('java_machine', './strings', { version: '^1.0.0' });
export const jvm = machineModule<JavaMachineJvm>('java_machine', './jvm', { version: '^1.0.0' });
export const compute = machineModule<JavaMachineCompute>('java_machine', './compute', { version: '^1.0.0' });
