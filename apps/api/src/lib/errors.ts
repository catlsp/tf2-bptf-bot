/** Narrow unknown errors to a readable message, mirroring apps/bot/src/lib/errors.ts. */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
