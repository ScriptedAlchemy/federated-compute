// AUTO-GENERATED from the "compute_machine" machine manifest by machinen bindgen.
// Do not edit by hand — regenerate with `pnpm bindgen`.
import { machineModule } from '@federated-compute/machinen-plugin/client';

export interface ComputeMachineAdmin {
  die(): Promise<{ pid: number; exitingInMs: number }>;
}

export interface ComputeMachineCounter {
  current(): Promise<number>;
  increment(): Promise<number>;
}

export interface ComputeMachineMath {
  add(a: number, b: number): Promise<number>;
  countdown(from: number): AsyncIterable<number>;
  fib(n: number): Promise<number>;
}

export interface ComputeMachineSolver {
  progress(): Promise<{ running: boolean; iteration: number; cacheSize: number; cacheCapacity: number; best: number; fingerprint: string; pid: number }>;
  start(): Promise<{ running: boolean; iteration: number; cacheSize: number; cacheCapacity: number; best: number; fingerprint: string; pid: number }>;
  stop(): Promise<{ running: boolean; iteration: number; cacheSize: number; cacheCapacity: number; best: number; fingerprint: string; pid: number }>;
}

export interface ComputeMachineSystem {
  whereAmI(): Promise<{ pid: number; platform: string; node: string; hint: string }>;
}

export interface ComputeMachineText {
  reverse(s: string): Promise<string>;
  shout(s: string): Promise<string>;
}

export interface ComputeMachineModules {
  './admin': ComputeMachineAdmin;
  './counter': ComputeMachineCounter;
  './math': ComputeMachineMath;
  './solver': ComputeMachineSolver;
  './system': ComputeMachineSystem;
  './text': ComputeMachineText;
}

export const admin = machineModule<ComputeMachineAdmin>('compute_machine', './admin', { version: '^1.0.0' });
export const counter = machineModule<ComputeMachineCounter>('compute_machine', './counter', { version: '^1.0.0' });
export const math = machineModule<ComputeMachineMath>('compute_machine', './math', { version: '^1.0.0', streams: ['countdown'] });
export const solver = machineModule<ComputeMachineSolver>('compute_machine', './solver', { version: '^1.0.0' });
export const system = machineModule<ComputeMachineSystem>('compute_machine', './system', { version: '^1.0.0' });
export const text = machineModule<ComputeMachineText>('compute_machine', './text', { version: '^1.0.0' });
