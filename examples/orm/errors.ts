/** Drizzle wraps driver errors in Error.cause; Kysely exposes the driver error. */
export function postgresErrorCode(error: unknown): string | undefined {
  for (let depth = 0; depth < 8 && error instanceof Error; depth++) {
    if ('code' in error && typeof error.code === 'string') return error.code;
    error = error.cause;
  }
  return undefined;
}
