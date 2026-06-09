// AUTO-GENERATED from the "compute_machine" machine manifest by machinen bindgen.
// Do not edit by hand — regenerate with `pnpm bindgen`.
import { machineModule } from '@federated-compute/machinen-plugin/client';

export interface ComputeMachineCounter {
  current(): Promise<number>;
  increment(): Promise<number>;
}

export interface ComputeMachineMath {
  add(a: number, b: number): Promise<number>;
  countdown(from: number): AsyncIterable<number>;
  fib(n: number): Promise<number>;
}

export interface ComputeMachineSystem {
  whereAmI(): Promise<{ pid: number; platform: string; node: string; hint: string }>;
}

export interface ComputeMachineText {
  reverse(s: string): Promise<string>;
  shout(s: string): Promise<string>;
}

export interface ComputeMachineModules {
  './counter': ComputeMachineCounter;
  './math': ComputeMachineMath;
  './system': ComputeMachineSystem;
  './text': ComputeMachineText;
}

export const counter = machineModule<ComputeMachineCounter>('compute_machine', './counter', { version: '^1.0.0' });
export const math = machineModule<ComputeMachineMath>('compute_machine', './math', { version: '^1.0.0', streams: ['countdown'] });
export const system = machineModule<ComputeMachineSystem>('compute_machine', './system', { version: '^1.0.0' });
export const text = machineModule<ComputeMachineText>('compute_machine', './text', { version: '^1.0.0' });
