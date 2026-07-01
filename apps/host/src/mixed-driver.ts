import {
  httpAttachDriver,
  machinenDriver,
  type MachineDriver,
  type MachinenDriverOptions,
  type MachineSpec,
} from '@federated-compute/machinen-plugin';

/**
 * Attach entries (machinen+http://...) go to the HTTP driver; image entries
 * (machinen://...) boot real microVMs. Shared by the demo server and the
 * end-user host entry so the routing cannot drift between them.
 */
export function mixedDriver(vmOptions: MachinenDriverOptions = {}): MachineDriver {
  const attach = httpAttachDriver();
  const vm = machinenDriver(vmOptions);
  return {
    boot(spec: MachineSpec) {
      return spec.kind === 'attach' ? attach.boot(spec) : vm.boot(spec);
    },
  };
}
