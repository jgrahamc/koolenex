type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const minLevel = (process.env.LOG_LEVEL as Level) || 'info';

function log(
  level: Level,
  tag: string,
  msg: string,
  data?: Record<string, unknown>,
): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const entry = { ts: new Date().toISOString(), level, tag, msg, ...data };
  const fn =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : console.log;
  fn(JSON.stringify(entry));
}

/**
 * Log the real error server-side, and return a client-facing message that
 * leads with `context` (a stable, code-checkable prefix - some callers
 * still branch on it, e.g. Assign/Read-by-serial's own error text) followed
 * by the real underlying message, e.g. "Device verify failed: Management
 * timeout waiting for MemoryExtended_Read_Response".
 *
 * Used to return just `context` alone, deliberately withholding the real
 * message from the client ("log the real error server-side, return a
 * generic message to the client") only made the event log harder to read
 * without the real failure reason: this is a single-operator internal
 * tool working real hardware, not a multi-tenant service with untrusted
 * clients, so hiding the actual failure reason from the one person who
 * needs it to diagnose a real bus/device problem was pure cost with no
 * real benefit - every other place in this app that CAN show real
 * protocol/hardware detail already does (e.g. restart-withheld's own
 * checksum/size messages).
 */
export function safeError(tag: string, context: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error(tag, context, { error: msg });
  return msg && msg !== context ? `${context}: ${msg}` : context;
}

/**
 * Same as safeError(), except a "not connected" condition passes its real
 * message straight through to the client instead of collapsing to the
 * generic context string - matches the 409-vs-502 status split routes in
 * server/routes/bus.ts already apply for this condition.
 */
export function safeErrorOrConnection(
  tag: string,
  context: string,
  err: unknown,
): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Not connected')) {
    logger.error(tag, context, { error: msg });
    return msg;
  }
  return safeError(tag, context, err);
}

export const logger = {
  debug: (tag: string, msg: string, data?: Record<string, unknown>) =>
    log('debug', tag, msg, data),
  info: (tag: string, msg: string, data?: Record<string, unknown>) =>
    log('info', tag, msg, data),
  warn: (tag: string, msg: string, data?: Record<string, unknown>) =>
    log('warn', tag, msg, data),
  error: (tag: string, msg: string, data?: Record<string, unknown>) =>
    log('error', tag, msg, data),
};
