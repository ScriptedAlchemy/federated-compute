// AUTO-GENERATED from the "artifact_machine" machine manifest by machinen bindgen.
// Do not edit by hand — regenerate with `pnpm bindgen`.
import { machineModule } from '@federated-compute/machinen-plugin/client';

export interface ArtifactMachineRegistry {
  getArtifactDescriptor(name: string, artifact: "image" | "snapshot" | "vmstate"): Promise<{ href: string; format: string; digest?: string; ext?: string; mediaType?: string; bytes?: number; platform?: string } | null>;
  getManifest(name: string): Promise<unknown>;
  listMachines(): Promise<{ name: string; version: string; artifacts: string[]; manifestUrl: string }[]>;
  resolvePullEntry(name: string, artifact: "image" | "snapshot" | "vmstate"): Promise<{ entry: string; manifestUrl: string; descriptor: { href: string; format: string; digest?: string; ext?: string; mediaType?: string; bytes?: number; platform?: string } }>;
}

export interface ArtifactMachineModules {
  './registry': ArtifactMachineRegistry;
}

export const registry = machineModule<ArtifactMachineRegistry>('artifact_machine', './registry', { version: '^1.0.0' });
