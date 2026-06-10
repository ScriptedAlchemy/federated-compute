// AUTO-GENERATED from the "analytics_machine" machine manifest by machinen bindgen.
// Do not edit by hand — regenerate with `pnpm bindgen`.
import { machineModule } from '@federated-compute/machinen-plugin/client';

export interface AnalyticsMachineAnalytics {
  topSpenders(limit: number): Promise<{ spenders: { name: string; plan: string; total: number }[]; queries: number; dbMs: number }>;
}

export interface AnalyticsMachineModules {
  './analytics': AnalyticsMachineAnalytics;
}

export const analytics = machineModule<AnalyticsMachineAnalytics>('analytics_machine', './analytics', { version: '^1.0.0' });
