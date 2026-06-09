import { GuestError } from '../errors.js';
import type { GuestRuntime } from '../guest.js';
import type { MachineDriver } from '../types.js';

function asGuestError(error: unknown): GuestError {
  const err = error as Error;
  return new GuestError(err?.message ?? String(error), {
    remoteType: err?.name,
    remoteStack: err?.stack,
  });
}

/** Driver that "boots" a guest runtime living in the same process. For tests and local dev. */
export function inProcessDriver(guest: GuestRuntime): MachineDriver {
  return {
    async boot() {
      return {
        manifest: async () => guest.manifest(),
        call: async (modulePath, fn, args) => {
          try {
            return await guest.dispatch(modulePath, fn, args);
          } catch (error) {
            throw asGuestError(error);
          }
        },
        callStream: (modulePath, fn, args) => guest.dispatchStream(modulePath, fn, args),
      };
    },
  };
}
