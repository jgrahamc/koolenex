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

/** Log the real error server-side, return a generic message to the client. */
export function safeError(tag: string, context: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error(tag, context, { error: msg });
  return context;
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
