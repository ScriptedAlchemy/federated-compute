// AUTO-GENERATED from the "java_machine" machine manifest by machinen bindgen.
// Do not edit by hand — regenerate with `pnpm bindgen`.
import { machineModule } from '@federated-compute/machinen-plugin/client';

export interface JavaMachineJvm {
  info(): Promise<{ pid: number; javaVersion: string; vendor: string; hint: string }>;
}

export interface JavaMachineStrings {
  upper(s: string): Promise<string>;
  sha256(s: string): Promise<string>;
}

export interface JavaMachineCounter {
  current(): Promise<number>;
  increment(): Promise<number>;
}

export interface JavaMachineCompute {
  primesBelow(n: number): Promise<number[]>;
}

export interface JavaMachineModules {
  './jvm': JavaMachineJvm;
  './strings': JavaMachineStrings;
  './counter': JavaMachineCounter;
  './compute': JavaMachineCompute;
}

export const jvm = machineModule<JavaMachineJvm>('java_machine', './jvm', { version: '^1.0.0' });
export const strings = machineModule<JavaMachineStrings>('java_machine', './strings', { version: '^1.0.0' });
export const counter = machineModule<JavaMachineCounter>('java_machine', './counter', { version: '^1.0.0' });
export const compute = machineModule<JavaMachineCompute>('java_machine', './compute', { version: '^1.0.0' });
