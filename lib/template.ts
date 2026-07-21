type TemplateContext = {
  input: unknown;
  steps: Record<string, unknown>;
};

function readPath(root: unknown, path: string) {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value && typeof value === "object" && key in value) {
      return (value as Record<string, unknown>)[key];
    }
    return undefined;
  }, root);
}

export function resolveTemplate(
  value: unknown,
  context: TemplateContext,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplate(item, context));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveTemplate(item, context),
      ]),
    );
  }

  if (typeof value !== "string") return value;

  const exact = value.match(/^\s*\{\{\s*([^}]+)\s*\}\}\s*$/);
  if (exact) return readPath(context, exact[1].trim());

  return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, path: string) => {
    const resolved = readPath(context, path.trim());
    if (resolved === undefined || resolved === null) return "";
    return typeof resolved === "string"
      ? resolved
      : JSON.stringify(resolved);
  });
}
