// AUTO-GENERATED from the "db_machine" machine manifest by machinen bindgen.
// Do not edit by hand — regenerate with `pnpm bindgen`.
import { machineModule } from '@federated-compute/machinen-plugin/client';

export interface DbMachineDb {
  listUsers(): Promise<{ id: number; name: string; plan: string }[]>;
  ordersFor(userId: number): Promise<{ id: string; amount: number }[]>;
}

export interface DbMachineModules {
  './db': DbMachineDb;
}

export const db = machineModule<DbMachineDb>('db_machine', './db', { version: '^1.0.0' });
