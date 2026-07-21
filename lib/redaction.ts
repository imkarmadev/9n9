const SECRET_KEY = /(authorization|password|passwd|token|secret|api[-_]?key|private[-_]?key|cookie)/i;

export function redactSecrets(value: unknown, secrets: string[] = []): unknown {
  const replacements = secrets.filter((secret) => secret.length >= 3);
  const redactText = (text: string) =>
    replacements.reduce(
      (current, secret) => current.split(secret).join("[REDACTED]"),
      text,
    );

  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) ? "[REDACTED]" : redactSecrets(item, replacements),
      ]),
    );
  }
  return value;
}
