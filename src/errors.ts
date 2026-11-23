/** An error's name and message for the logs (never a request body or a secret). */
export function describeError(error: unknown): { error: string; message?: string } {
  return error instanceof Error ? { error: error.name, message: error.message } : { error: String(error) }
}
