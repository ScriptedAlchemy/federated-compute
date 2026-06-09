/** An error thrown by code running inside the machine (the call itself failed). */
export class GuestError extends Error {
  /** The error class name on the guest side (e.g. "TypeError"). */
  remoteType?: string;
  /** Guest-side stack trace, when the guest chose to send one. */
  remoteStack?: string;

  constructor(message: string, opts: { remoteType?: string; remoteStack?: string } = {}) {
    super(message);
    this.name = 'GuestError';
    this.remoteType = opts.remoteType;
    this.remoteStack = opts.remoteStack;
  }
}

/** The machine itself was unreachable (connection refused, died mid-call, 5xx...). */
export class MachineTransportError extends Error {
  constructor(message: string, opts: { cause?: unknown } = {}) {
    super(message, opts);
    this.name = 'MachineTransportError';
  }
}

/** Heuristic: connection-level failures that mean "the machine is gone". */
export function isTransportFailure(error: unknown): boolean {
  if (error instanceof MachineTransportError) return true;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return true;
  // Node's fetch throws TypeError on network failure, with the cause carrying the code.
  if (error instanceof TypeError && (error as { cause?: unknown }).cause) {
    return isTransportFailure((error as { cause?: unknown }).cause);
  }
  return false;
}
