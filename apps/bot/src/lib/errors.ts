// Typed errors so callers can branch without string-matching messages.

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class BptfApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly endpoint?: string,
  ) {
    super(message);
    this.name = 'BptfApiError';
  }
}

export class SteamLockError extends Error {
  constructor(op: string) {
    super(`steam lock unobtainable for ${op}`);
    this.name = 'SteamLockError';
  }
}

export class PaperGuardError extends Error {
  constructor(action: string) {
    super(`blocked real Steam action "${action}" — PAPER_TRADING is on`);
    this.name = 'PaperGuardError';
  }
}

/** Narrow unknown errors to a readable message, mirroring bot.js's e.message usage. */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
