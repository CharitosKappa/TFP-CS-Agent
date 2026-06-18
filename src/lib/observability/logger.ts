// Minimal structured (JSON-line) logger. Keep PII out of fields: log ids,
// counts, statuses and durations — never message bodies or customer content.

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const record = { level, event, ...fields };
  const sink = level === "error" || level === "warn" ? console.error : console.log;
  try {
    sink(JSON.stringify(record));
  } catch {
    sink(`${level} ${event}`);
  }
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};

/** Reduces an error to a short, log-safe shape (name + truncated message, no stack). */
export function errInfo(e: unknown): { name: string; message: string } {
  if (e instanceof Error) return { name: e.name, message: e.message.slice(0, 300) };
  return { name: "Unknown", message: String(e).slice(0, 300) };
}
