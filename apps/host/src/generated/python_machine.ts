// AUTO-GENERATED from the "python_machine" machine manifest by machinen bindgen.
// Do not edit by hand — regenerate with `pnpm bindgen`.
import { machineModule } from '@federated-compute/machinen-plugin/client';

export interface PythonMachineStats {
  mean(values: number[]): Promise<number>;
  median(values: number[]): Promise<number>;
  stdev(values: number[]): Promise<number>;
}

export interface PythonMachineData {
  wordCount(text: string): Promise<Record<string, number>>;
  sortNumbers(values: number[]): Promise<number[]>;
}

export interface PythonMachineCounter {
  increment(): Promise<number>;
  current(): Promise<number>;
}

export interface PythonMachinePython {
  info(): Promise<{ pid: number; pythonVersion: string; implementation: string; hint: string }>;
}

export interface PythonMachineModules {
  './stats': PythonMachineStats;
  './data': PythonMachineData;
  './counter': PythonMachineCounter;
  './python': PythonMachinePython;
}

export const stats = machineModule<PythonMachineStats>('python_machine', './stats', { version: '^1.0.0' });
export const data = machineModule<PythonMachineData>('python_machine', './data', { version: '^1.0.0' });
export const counter = machineModule<PythonMachineCounter>('python_machine', './counter', { version: '^1.0.0' });
export const python = machineModule<PythonMachinePython>('python_machine', './python', { version: '^1.0.0' });
