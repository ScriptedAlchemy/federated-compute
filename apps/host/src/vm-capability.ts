// Server-side truth for the whole-VM demo lane. Same honesty contract as
// scripts/machinen-e2e.mjs: detect, never fake. The UI renders this verbatim.
//
// Cheap preflight only — no VM boot. Base-asset presence is NOT preflighted:
// assets fetch on first boot, and boot errors surface honestly through the
// live routes.
import { accessSync, constants, existsSync } from 'node:fs';
import {
  installedMachinenRuntimeVersion,
  ociHostPlatform,
} from '@federated-compute/machinen-plugin';

export type VmCapabilityReason =
  | 'live'
  | 'missing-kvm'
  | 'kvm-not-accessible'
  | 'unsupported-platform'
  | 'missing-runtime';

export interface VmCapability {
  available: boolean;
  reason: VmCapabilityReason;
  detail: string;
  platform: string; // OCI-style, e.g. linux/amd64
  /** Installed @machinen/runtime version (vmstate bundles pin it exactly). */
  runtime?: string;
}

export function detectVmCapability(): VmCapability {
  const platform = ociHostPlatform();
  const result = (
    reason: VmCapabilityReason,
    detail: string,
    runtime?: string,
  ): VmCapability => ({
    available: reason === 'live',
    reason,
    detail,
    platform,
    runtime,
  });

  if (process.platform === 'linux') {
    if (!existsSync('/dev/kvm')) {
      return result('missing-kvm', '/dev/kvm is absent on this host (no KVM / nested virtualization)');
    }
    try {
      accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
    } catch {
      return result('kvm-not-accessible', '/dev/kvm exists but is not read/writable by this user');
    }
  } else if (!(process.platform === 'darwin' && process.arch === 'arm64')) {
    return result('unsupported-platform', `real microVMs need Linux/KVM or Apple Silicon (this host: ${platform})`);
  }

  // Resolved through the plugin's own anchor (the runtime is its optional
  // peer): a host-relative createRequire would miss it in the pnpm layout.
  const runtime = installedMachinenRuntimeVersion();
  if (!runtime) {
    return result('missing-runtime', '@machinen/runtime is not installed (optional peer of the plugin)');
  }

  return result(
    'live',
    `real microVM track enabled (KVM/HVF + @machinen/runtime ${runtime} present)`,
    runtime,
  );
}
