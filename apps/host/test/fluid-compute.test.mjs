import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideFluidPlacement,
  fluidTimeline,
  simulateAdaptiveFluidTraffic,
} from '../dist/fluid-compute.js';

test('auto placement distributes large requests to the data region and opens a back-channel', () => {
  const decision = decideFluidPlacement({
    policy: 'auto',
    payloadBytes: 8192,
    callerRegion: 'us-east',
    originRegion: 'us-east',
    dataRegion: 'eu-west',
  });

  assert.equal(decision.mode, 'distribute');
  assert.equal(decision.executionRegion, 'eu-west');
  assert.equal(decision.replica, 'fluid_replica@eu-west');
  assert.equal(decision.connection.kind, 'host-mediated-backhaul');
  assert.equal(decision.connection.from, 'fluid_replica@eu-west');
  assert.equal(decision.connection.to, 'fluid_origin@us-east');
  assert.equal(decision.connection.state, 'opened');
  assert.match(decision.reason, /payload/i);
});

test('auto placement keeps small local calls at origin and moves cross-region calls to caller', () => {
  const local = decideFluidPlacement({
    policy: 'auto',
    payloadBytes: 128,
    callerRegion: 'us-east',
    originRegion: 'us-east',
    dataRegion: 'eu-west',
  });
  const colocated = decideFluidPlacement({
    policy: 'auto',
    payloadBytes: 128,
    callerRegion: 'ap-south',
    originRegion: 'us-east',
    dataRegion: 'eu-west',
  });

  assert.equal(local.mode, 'local');
  assert.equal(local.executionRegion, 'us-east');
  assert.equal(local.replica, 'fluid_origin@us-east');
  assert.equal(colocated.mode, 'colocate');
  assert.equal(colocated.executionRegion, 'ap-south');
  assert.equal(colocated.replica, 'fluid_replica@ap-south');
});

test('auto placement distributes at the payload threshold', () => {
  const decision = decideFluidPlacement({
    policy: 'auto',
    payloadBytes: 2048,
    callerRegion: 'us-east',
    originRegion: 'us-east',
    dataRegion: 'eu-west',
  });

  assert.equal(decision.mode, 'distribute');
  assert.equal(decision.executionRegion, 'eu-west');
});

test('placement refuses non-local execution when the target lacks the required shell', () => {
  const decision = decideFluidPlacement({
    policy: 'distribute',
    payloadBytes: 4096,
    callerRegion: 'us-east',
    originRegion: 'us-east',
    dataRegion: 'eu-west',
    requiredShell: 'shell-a',
    regions: [
      { region: 'us-east', canRestoreVmstate: true, shell: 'shell-a' },
      { region: 'eu-west', canRestoreVmstate: true, shell: 'shell-b' },
    ],
  });

  assert.equal(decision.mode, 'local');
  assert.equal(decision.executionRegion, 'us-east');
  assert.match(decision.reason, /no compatible MachineN shell/);
});

test('placement allows non-local execution when the target shell matches', () => {
  const decision = decideFluidPlacement({
    policy: 'distribute',
    payloadBytes: 4096,
    callerRegion: 'us-east',
    originRegion: 'us-east',
    dataRegion: 'eu-west',
    requiredShell: 'shell-a',
    regions: [
      { region: 'us-east', canRestoreVmstate: true, shell: 'shell-a' },
      { region: 'eu-west', canRestoreVmstate: true, shell: 'shell-a' },
    ],
  });

  assert.equal(decision.mode, 'distribute');
  assert.equal(decision.executionRegion, 'eu-west');
});

test('explicit colocate placement moves the machine toward the caller', () => {
  const decision = decideFluidPlacement({
    policy: 'colocate',
    payloadBytes: 128,
    callerRegion: 'ap-south',
    originRegion: 'us-east',
    dataRegion: 'eu-west',
  });

  assert.equal(decision.mode, 'colocate');
  assert.equal(decision.executionRegion, 'ap-south');
  assert.equal(decision.replica, 'fluid_replica@ap-south');
  assert.equal(decision.connection.from, 'fluid_replica@ap-south');
  assert.equal(decision.connection.to, 'fluid_origin@us-east');
});

test('timeline describes a browser function call, placement, replica, back-channel, and result', () => {
  const decision = decideFluidPlacement({
    policy: 'distribute',
    payloadBytes: 1024,
    callerRegion: 'us-east',
    originRegion: 'us-east',
    dataRegion: 'eu-west',
  });

  const timeline = fluidTimeline(decision);

  assert.deepEqual(
    timeline.map((step) => step.kind),
    ['query', 'invoke', 'decide', 'restore', 'connect', 'return'],
  );
  assert.equal(timeline.find((step) => step.kind === 'query')?.actor, 'browser');
  assert.equal(timeline.find((step) => step.kind === 'invoke')?.detail, "loadRemote('compute_machine/fluid')");
  assert.equal(timeline.find((step) => step.kind === 'restore')?.region, 'eu-west');
  assert.match(timeline.find((step) => step.kind === 'restore')?.detail ?? '', /restored from prepared vmstate/);
  assert.equal(
    timeline.find((step) => step.kind === 'connect')?.detail,
    'fluid_replica@eu-west -> fluid_origin@us-east',
  );
});

test('adaptive traffic waits for sustained heat before moving compute', () => {
  const cold = simulateAdaptiveFluidTraffic({ requestCount: 7, hotRegion: 'eu-west' });

  assert.equal(cold.finalRegion, 'us-east');
  assert.equal(cold.migration.atRequest, 0);
  assert.equal(cold.samples.every((sample) => sample.phase === 'origin'), true);
});

test('adaptive traffic pays a restore cost and then wins back latency', () => {
  const burst = simulateAdaptiveFluidTraffic({ requestCount: 32, hotRegion: 'eu-west' });

  assert.equal(burst.migration.atRequest, 8);
  assert.equal(burst.migration.to, 'eu-west');
  assert.equal(burst.finalRegion, 'eu-west');
  assert.ok(burst.savedMs > 0);
  assert.equal(burst.samples.find((sample) => sample.phase === 'migrating')?.latencyMs, 2434);
  assert.equal(burst.samples.at(-1)?.phase, 'colocated');
});
