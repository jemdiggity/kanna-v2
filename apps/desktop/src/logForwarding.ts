export function formatLogArgument(arg: unknown): string {
  if (arg instanceof Error) {
    const maybeCode = (arg as Error & { code?: unknown }).code;
    const code = typeof maybeCode === "string" ? ` code=${maybeCode}` : "";
    const stack = typeof arg.stack === "string" && arg.stack.length > 0 ? `\n${arg.stack}` : "";
    return `${arg.name}: ${arg.message}${code}${stack}`;
  }

  if (typeof arg === "string") return arg;

  const seen = new WeakSet<object>();
  return JSON.stringify(arg, (_key, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value !== "object" || value === null) return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value;
  }) ?? String(arg);
}
