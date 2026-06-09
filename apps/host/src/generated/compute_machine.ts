// AUTO-GENERATED from the "compute_machine" machine manifest by machinen bindgen.
// Do not edit by hand — regenerate with `pnpm bindgen`.

export interface ComputeMachineMath {
  add(a: number, b: number): Promise<number>;
  fib(n: number): Promise<number>;
  countdown(from: number): AsyncIterable<number>;
}

export interface ComputeMachineText {
  shout(s: string): Promise<string>;
  reverse(s: string): Promise<string>;
}

export interface ComputeMachineSystem {
  whereAmI(): Promise<{ pid: number; platform: string; node: string; hint: string }>;
}

export interface ComputeMachineModules {
  './math': ComputeMachineMath;
  './text': ComputeMachineText;
  './system': ComputeMachineSystem;
}
