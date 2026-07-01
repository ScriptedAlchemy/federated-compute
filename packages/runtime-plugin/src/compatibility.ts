import semverSatisfies from 'semver/functions/satisfies.js';
import semverValid from 'semver/functions/valid.js';
import { MachineVersionError } from './errors.js';
import type { MachineExposeManifest, MachineSpec } from './types.js';

type VersionCheckContext = 'booted-machine' | 'pull-origin';

export function assertGuestManifestCompatible(
  spec: MachineSpec,
  manifest: MachineExposeManifest,
): void {
  assertGuestProtocol(spec, manifest);
  assertManifestVersion(spec, manifest, 'booted-machine');
}

export function assertGuestProtocol(spec: MachineSpec, manifest: MachineExposeManifest): void {
  if (manifest?.protocol !== 3) {
    throw new Error(
      `[machinen-plugin] machine "${spec.remoteName}" speaks guest protocol ${String(manifest?.protocol)}, expected 3`,
    );
  }
  if (!manifest.exposes || typeof manifest.exposes !== 'object') {
    throw new Error(
      `[machinen-plugin] machine "${spec.remoteName}" manifest has no "exposes" map`,
    );
  }
}

export function assertManifestVersion(
  spec: MachineSpec,
  manifest: MachineExposeManifest,
  context: VersionCheckContext,
): void {
  const required = spec.params.get('version');
  if (!required) return;

  const actual = manifest.version;
  if (!actual || !semverValid(actual)) {
    throw new MachineVersionError(invalidVersionMessage(spec, required, actual, context), {
      required,
      reported: actual,
    });
  }

  if (!semverSatisfies(actual, required)) {
    throw new MachineVersionError(versionMismatchMessage(spec, required, actual, context), {
      required,
      reported: actual,
    });
  }
}

function invalidVersionMessage(
  spec: MachineSpec,
  required: string,
  actual: string | undefined,
  context: VersionCheckContext,
): string {
  if (context === 'pull-origin') {
    return `[machinen-plugin] pull "${spec.remoteName}": entry requires version "${required}" but the origin manifest has no valid version (got "${actual}")`;
  }

  return `[machinen-plugin] entry for "${spec.remoteName}" requires version "${required}" but the machine manifest has no valid version (got "${actual}")`;
}

function versionMismatchMessage(
  spec: MachineSpec,
  required: string,
  actual: string,
  context: VersionCheckContext,
): string {
  if (context === 'pull-origin') {
    return `[machinen-plugin] pull "${spec.remoteName}": origin version mismatch before download: required "${required}", origin reports "${actual}"`;
  }

  return `[machinen-plugin] machine "${spec.remoteName}" version mismatch: required "${required}", machine reports "${actual}"`;
}
