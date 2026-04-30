function stamp(){return new Date().toISOString();}
function normalizeMeta(meta){
  if (!meta) return undefined;
  if (meta instanceof Error) return { message: meta.message, stack: meta.stack };
  if (typeof meta === 'object') {
    try { return JSON.parse(JSON.stringify(meta)); } catch {}
  }
  return { value: String(meta) };
}
function write(level, message, meta){
  const payload = { ts: stamp(), level, message, ...(normalizeMeta(meta) ? { meta: normalizeMeta(meta) } : {}) };
  const line = `[${payload.ts}] ${level.toUpperCase()} ${message}`;
  if (level === 'error') console.error(line, payload.meta || '');
  else if (level === 'warn') console.warn(line, payload.meta || '');
  else console.log(line, payload.meta || '');
}
export const logger = {
  info(message, meta){ write('info', message, meta); },
  warn(message, meta){ write('warn', message, meta); },
  error(message, meta){ write('error', message, meta); },
};
export default logger;
