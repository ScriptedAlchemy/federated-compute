export type FluidPolicy = 'auto' | 'local' | 'colocate' | 'distribute';
export type FluidMode = 'local' | 'colocate' | 'distribute';

export interface FluidRegionCapability {
  region: string;
  canRestoreVmstate: boolean;
  shell?: string;
}

export interface FluidPlacementInput {
  policy: FluidPolicy;
  payloadBytes: number;
  callerRegion: string;
  originRegion: string;
  dataRegion: string;
  requiredShell?: string;
  regions?: FluidRegionCapability[];
}

export interface FluidConnection {
  kind: 'host-mediated-backhaul';
  from: string;
  to: string;
  state: 'opened';
}

export interface FluidDecision {
  mode: FluidMode;
  policy: FluidPolicy;
  reason: string;
  originRegion: string;
  callerRegion: string;
  dataRegion: string;
  executionRegion: string;
  origin: string;
  replica: string;
  connection: FluidConnection;
}

export interface FluidTimelineStep {
  kind: 'query' | 'invoke' | 'decide' | 'restore' | 'connect' | 'return';
  actor: 'browser' | 'host' | 'fluid_origin' | 'fluid_replica';
  region: string;
  detail: string;
}

export interface AdaptiveTrafficOptions {
  requestCount?: number;
  hotRegion?: string;
  originRegion?: string;
  migrationCostMs?: number;
}

export interface AdaptiveTrafficSample {
  index: number;
  callerRegion: string;
  computeRegion: string;
  machine: string;
  latencyMs: number;
  baselineLatencyMs: number;
  phase: 'origin' | 'migrating' | 'colocated';
}

export interface AdaptiveMigrationEvent {
  atRequest: number;
  from: string;
  to: string;
  costMs: number;
  reason: string;
}

export interface AdaptiveTrafficResult {
  originRegion: string;
  hotRegion: string;
  finalRegion: string;
  requestCount: number;
  baselineTotalMs: number;
  adaptiveTotalMs: number;
  savedMs: number;
  migration: AdaptiveMigrationEvent;
  samples: AdaptiveTrafficSample[];
}

const LARGE_PAYLOAD_BYTES = 2048;
const DEFAULT_TRAFFIC_COUNT = 32;
const DEFAULT_MIGRATION_COST_MS = 2400;
const HOT_WINDOW = 5;
const LOCAL_LATENCY_MS = 24;
const BACKHAUL_LATENCY_MS = 170;
const COLOCATED_LATENCY_MS = 34;

function machineId(name: string, region: string): string {
  return `${name}@${region}`;
}

function autoMode(input: FluidPlacementInput): FluidMode {
  if (input.payloadBytes >= LARGE_PAYLOAD_BYTES) return 'distribute';
  if (input.callerRegion !== input.originRegion) return 'colocate';
  return 'local';
}

function preferredExecutionRegion(mode: FluidMode, input: FluidPlacementInput): string {
  switch (mode) {
    case 'local':
      return input.originRegion;
    case 'colocate':
      return input.callerRegion;
    case 'distribute':
      return input.dataRegion;
  }
}

function canRestoreIn(region: string, input: FluidPlacementInput): boolean {
  if (!input.requiredShell) return true;
  const candidate = input.regions?.find((r) => r.region === region);
  return !!candidate?.canRestoreVmstate && candidate.shell === input.requiredShell;
}

function placeMode(preferred: FluidMode, input: FluidPlacementInput): FluidMode {
  if (preferred === 'local') return preferred;
  if (canRestoreIn(preferredExecutionRegion(preferred, input), input)) return preferred;
  return 'local';
}

function reasonFor(mode: FluidMode, preferred: FluidMode, input: FluidPlacementInput): string {
  if (mode !== preferred) {
    return `preferred ${preferred} target has no compatible MachineN shell; origin handles the call`;
  }
  if (input.policy !== 'auto') return `policy "${input.policy}" selected by the caller`;
  switch (mode) {
    case 'distribute':
      return `payload ${input.payloadBytes}B crosses the ${LARGE_PAYLOAD_BYTES}B threshold; compute moves to the data region`;
    case 'colocate':
      return `caller is in ${input.callerRegion}; compute moves toward the caller`;
    case 'local':
      return 'caller and origin are co-located; the origin handles the call';
  }
}

export function decideFluidPlacement(input: FluidPlacementInput): FluidDecision {
  const policy = input.policy;
  const preferred = policy === 'auto' ? autoMode(input) : policy;
  const mode = placeMode(preferred, input);
  const executionRegion = preferredExecutionRegion(mode, input);
  const origin = machineId('fluid_origin', input.originRegion);
  const replica = mode === 'local' ? origin : machineId('fluid_replica', executionRegion);
  const reason = reasonFor(mode, preferred, input);

  return {
    mode,
    policy,
    reason,
    originRegion: input.originRegion,
    callerRegion: input.callerRegion,
    dataRegion: input.dataRegion,
    executionRegion,
    origin,
    replica,
    connection: {
      kind: 'host-mediated-backhaul',
      from: replica,
      to: origin,
      state: 'opened',
    },
  };
}

export function fluidTimeline(decision: FluidDecision): FluidTimelineStep[] {
  return [
    {
      kind: 'query',
      actor: 'browser',
      region: decision.callerRegion,
      detail: 'POST /api/fluid/query',
    },
    {
      kind: 'invoke',
      actor: 'host',
      region: decision.originRegion,
      detail: "loadRemote('compute_machine/fluid')",
    },
    {
      kind: 'decide',
      actor: 'fluid_origin',
      region: decision.originRegion,
      detail: `${decision.mode}: ${decision.reason}`,
    },
    {
      kind: 'restore',
      actor: decision.mode === 'local' ? 'fluid_origin' : 'fluid_replica',
      region: decision.executionRegion,
      detail:
        decision.mode === 'local'
          ? 'origin keeps the work'
          : `${decision.replica} restored from prepared vmstate`,
    },
    {
      kind: 'connect',
      actor: decision.mode === 'local' ? 'fluid_origin' : 'fluid_replica',
      region: decision.executionRegion,
      detail: `${decision.connection.from} -> ${decision.connection.to}`,
    },
    {
      kind: 'return',
      actor: 'host',
      region: decision.callerRegion,
      detail: 'result returned to the original browser call',
    },
  ];
}

function trafficRegion(index: number, hotRegion: string, originRegion: string): string {
  if (index <= 3) return originRegion;
  if (index % 9 === 0) return 'ap-south';
  return hotRegion;
}

function latencyFor(callerRegion: string, computeRegion: string, originRegion: string): number {
  if (callerRegion === computeRegion) return computeRegion === originRegion ? LOCAL_LATENCY_MS : COLOCATED_LATENCY_MS;
  return BACKHAUL_LATENCY_MS;
}

export function simulateAdaptiveFluidTraffic(
  options: AdaptiveTrafficOptions = {},
): AdaptiveTrafficResult {
  const originRegion = options.originRegion ?? 'us-east';
  const hotRegion = options.hotRegion ?? 'eu-west';
  const requestCount = Math.max(1, Math.min(Math.round(options.requestCount ?? DEFAULT_TRAFFIC_COUNT), 96));
  const migrationCostMs = Math.max(0, Math.round(options.migrationCostMs ?? DEFAULT_MIGRATION_COST_MS));
  const samples: AdaptiveTrafficSample[] = [];
  let computeRegion = originRegion;
  let hotStreak = 0;
  let migration: AdaptiveMigrationEvent | undefined;

  for (let index = 1; index <= requestCount; index++) {
    const callerRegion = trafficRegion(index, hotRegion, originRegion);
    hotStreak = callerRegion === hotRegion ? hotStreak + 1 : 0;
    let phase: AdaptiveTrafficSample['phase'] = computeRegion === originRegion ? 'origin' : 'colocated';
    let latencyMs = latencyFor(callerRegion, computeRegion, originRegion);

    if (!migration && hotStreak >= HOT_WINDOW) {
      migration = {
        atRequest: index,
        from: computeRegion,
        to: hotRegion,
        costMs: migrationCostMs,
        reason: `${HOT_WINDOW} consecutive calls arrived from ${hotRegion}; restore a compatible MachineN shell there`,
      };
      computeRegion = hotRegion;
      phase = 'migrating';
      latencyMs = migrationCostMs + latencyFor(callerRegion, computeRegion, originRegion);
    }

    samples.push({
      index,
      callerRegion,
      computeRegion,
      machine: machineId(computeRegion === originRegion ? 'fluid_origin' : 'fluid_replica', computeRegion),
      latencyMs,
      baselineLatencyMs: latencyFor(callerRegion, originRegion, originRegion),
      phase,
    });
  }

  const fallbackMigration: AdaptiveMigrationEvent = {
    atRequest: 0,
    from: originRegion,
    to: originRegion,
    costMs: 0,
    reason: 'traffic never stayed hot long enough to justify moving compute',
  };
  const baselineTotalMs = samples.reduce((sum, sample) => sum + sample.baselineLatencyMs, 0);
  const adaptiveTotalMs = samples.reduce((sum, sample) => sum + sample.latencyMs, 0);

  return {
    originRegion,
    hotRegion,
    finalRegion: computeRegion,
    requestCount,
    baselineTotalMs,
    adaptiveTotalMs,
    savedMs: baselineTotalMs - adaptiveTotalMs,
    migration: migration ?? fallbackMigration,
    samples,
  };
}
