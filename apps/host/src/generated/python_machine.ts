// AUTO-GENERATED from the "python_machine" machine manifest by machinen bindgen.
// Do not edit by hand — regenerate with `pnpm bindgen`.

export interface PythonMachineStats {
  mean(values: number[]): Promise<number>;
  median(values: number[]): Promise<number>;
  stdev(values: number[]): Promise<number>;
}

export interface PythonMachineData {
  wordCount(text: string): Promise<Record<string, number>>;
  sortNumbers(values: number[]): Promise<number[]>;
}

export interface PythonMachinePython {
  info(): Promise<{ pid: number; pythonVersion: string; implementation: string; hint: string }>;
}

export interface PythonMachineModules {
  './stats': PythonMachineStats;
  './data': PythonMachineData;
  './python': PythonMachinePython;
}
