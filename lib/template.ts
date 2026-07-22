export type TemplateContext = {
  input: unknown;
  steps: Record<string, unknown>;
  binary?: Record<string, unknown>;
  files?: Record<string, unknown>;
};

export type ExpressionDiagnostic = {
  code: "syntax" | "missing_path" | "unknown_transform" | "transform";
  severity: "warning" | "error";
  message: string;
  expression: string;
  path?: string;
};

export type TemplatePreview = {
  value: unknown;
  diagnostics: ExpressionDiagnostic[];
  expressions: string[];
};

type PathToken = string | number | "*";

function contextRoots(context: TemplateContext): Record<string, unknown> {
  const input = context.input && typeof context.input === "object"
    ? context.input as Record<string, unknown>
    : {};
  return {
    input: context.input,
    steps: context.steps,
    binary: context.binary ?? (input.binary as Record<string, unknown> | undefined) ?? (input.$binary as Record<string, unknown> | undefined) ?? {},
    files: context.files ?? (input.files as Record<string, unknown> | undefined) ?? (input.$files as Record<string, unknown> | undefined) ?? {},
  };
}

function splitOutside(value: string, delimiter: string) {
  const parts: string[] = [];
  let current = "";
  let quote = "";
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      current += character;
      if (character === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "(" || character === "[") depth += 1;
    if (character === ")" || character === "]") depth -= 1;
    if (depth === 0 && value.slice(index, index + delimiter.length) === delimiter) {
      parts.push(current.trim());
      current = "";
      index += delimiter.length - 1;
      continue;
    }
    current += character;
  }
  parts.push(current.trim());
  return parts;
}

function parseLiteral(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/\\'/g, "'");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function pathTokens(path: string): PathToken[] | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const tokens: PathToken[] = [];
  let index = 0;
  if (trimmed[index] === "$") {
    tokens.push("input");
    index += 1;
  } else {
    const root = trimmed.slice(index).match(/^[A-Za-z_$][\w$-]*/)?.[0];
    if (!root) return null;
    tokens.push(root);
    index += root.length;
  }
  while (index < trimmed.length) {
    if (trimmed[index] === ".") {
      index += 1;
      if (trimmed[index] === "*") {
        tokens.push("*");
        index += 1;
        continue;
      }
      const key = trimmed.slice(index).match(/^[A-Za-z_$][\w$-]*/)?.[0];
      if (!key) return null;
      tokens.push(key);
      index += key.length;
      continue;
    }
    if (trimmed[index] === "[") {
      const close = trimmed.indexOf("]", index + 1);
      if (close === -1) return null;
      const content = trimmed.slice(index + 1, close).trim();
      if (content === "*") tokens.push("*");
      else if (/^\d+$/.test(content)) tokens.push(Number(content));
      else if ((content.startsWith('"') && content.endsWith('"')) || (content.startsWith("'") && content.endsWith("'"))) {
        tokens.push(String(parseLiteral(content)));
      } else return null;
      index = close + 1;
      continue;
    }
    return null;
  }
  return tokens;
}

function applyPath(root: unknown, tokens: PathToken[]) {
  let values = [root];
  let wildcard = false;
  for (const token of tokens) {
    const next: unknown[] = [];
    for (const value of values) {
      if (token === "*") {
        wildcard = true;
        if (Array.isArray(value)) next.push(...value);
        else if (value && typeof value === "object") next.push(...Object.values(value));
      } else if (value && typeof value === "object" && token in value) {
        next.push((value as Record<string | number, unknown>)[token]);
      }
    }
    values = next;
    if (!values.length) return { found: false, value: undefined };
  }
  return { found: true, value: wildcard ? values : values[0] };
}

function readExpressionPath(context: TemplateContext, path: string) {
  const tokens = pathTokens(path);
  if (!tokens) return { valid: false, found: false, value: undefined };
  const [root, ...rest] = tokens;
  const roots = contextRoots(context);
  if (typeof root !== "string" || !(root in roots)) {
    return { valid: true, found: false, value: undefined };
  }
  const result = applyPath(roots[root], rest);
  return { valid: true, ...result };
}

function transformSpec(value: string) {
  const call = value.match(/^([a-zA-Z_][\w-]*)\s*\(([\s\S]*)\)$/);
  if (call) return { name: call[1].toLowerCase(), argument: parseLiteral(call[2]) };
  const [name, ...argument] = splitOutside(value, ":");
  return {
    name: name.toLowerCase(),
    argument: argument.length ? parseLiteral(argument.join(":")) : undefined,
  };
}

function transform(value: unknown, spec: string): { value: unknown; error?: string; unknown?: boolean } {
  const { name, argument } = transformSpec(spec);
  try {
    switch (name) {
      case "string":
        return { value: value == null ? "" : typeof value === "string" ? value : JSON.stringify(value) };
      case "number": {
        const number = typeof value === "number" ? value : Number(value);
        return Number.isFinite(number) ? { value: number } : { value, error: "Value cannot be converted to a number" };
      }
      case "boolean":
        if (typeof value === "string") return { value: !["", "0", "false", "no", "off", "null", "undefined"].includes(value.trim().toLowerCase()) };
        return { value: Boolean(value) };
      case "date": {
        const date = new Date(value as string | number | Date);
        return Number.isNaN(date.getTime()) ? { value, error: "Value cannot be converted to a date" } : { value: date.toISOString() };
      }
      case "json":
        if (typeof value !== "string") return { value };
        return { value: JSON.parse(value) };
      case "array":
        return { value: Array.isArray(value) ? value : value == null ? [] : [value] };
      case "object": {
        if (value && typeof value === "object" && !Array.isArray(value)) return { value };
        if (typeof value === "string") {
          const parsed = JSON.parse(value);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Parsed value is not an object");
          return { value: parsed };
        }
        return { value: { value } };
      }
      case "fallback":
        return { value: value === undefined || value === null || value === "" ? argument : value };
      case "jsonpath": {
        const jsonPath = String(argument ?? "");
        if (!jsonPath.startsWith("$")) return { value, error: "JSONPath must start with $" };
        const tokens = pathTokens(jsonPath);
        if (!tokens) return { value, error: "Invalid JSONPath" };
        return { value: applyPath(value, tokens.slice(1)).value };
      }
      default:
        return { value, unknown: true, error: `Unknown transform: ${name}` };
    }
  } catch (error) {
    return { value, error: error instanceof Error ? error.message : "Transform failed" };
  }
}

function evaluateExpression(expression: string, context: TemplateContext) {
  const diagnostics: ExpressionDiagnostic[] = [];
  const pipeline = splitOutside(expression, "|");
  const base = pipeline.shift()?.trim() ?? "";
  const fallbackParts = splitOutside(base, "??");
  if (!fallbackParts[0] || fallbackParts.length > 2) {
    diagnostics.push({ code: "syntax", severity: "error", expression, message: "Invalid fallback expression" });
    return { value: undefined, diagnostics };
  }
  const path = fallbackParts[0];
  const resolved = readExpressionPath(context, path);
  if (!resolved.valid) {
    diagnostics.push({ code: "syntax", severity: "error", expression, path, message: `Invalid expression path: ${path}` });
    return { value: undefined, diagnostics };
  }
  let value = resolved.value;
  if (!resolved.found) {
    if (fallbackParts.length === 2) value = parseLiteral(fallbackParts[1]);
    else diagnostics.push({ code: "missing_path", severity: "warning", expression, path, message: `No sample or runtime value exists at ${path}` });
  }
  for (const spec of pipeline) {
    if (!spec) {
      diagnostics.push({ code: "syntax", severity: "error", expression, message: "Empty transform in pipeline" });
      continue;
    }
    const result = transform(value, spec);
    value = result.value;
    if (result.error) {
      diagnostics.push({
        code: result.unknown ? "unknown_transform" : "transform",
        severity: "error",
        expression,
        message: result.error,
      });
    }
  }
  return { value, diagnostics };
}

export function previewTemplate(value: unknown, context: TemplateContext): TemplatePreview {
  if (Array.isArray(value)) {
    const previews = value.map((item) => previewTemplate(item, context));
    return {
      value: previews.map((preview) => preview.value),
      diagnostics: previews.flatMap((preview) => preview.diagnostics),
      expressions: previews.flatMap((preview) => preview.expressions),
    };
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => [key, previewTemplate(item, context)] as const);
    return {
      value: Object.fromEntries(entries.map(([key, preview]) => [key, preview.value])),
      diagnostics: entries.flatMap(([, preview]) => preview.diagnostics),
      expressions: entries.flatMap(([, preview]) => preview.expressions),
    };
  }
  if (typeof value !== "string") return { value, diagnostics: [], expressions: [] };

  const matches = [...value.matchAll(/\{\{([\s\S]*?)\}\}/g)];
  const openCount = (value.match(/\{\{/g) ?? []).length;
  const closeCount = (value.match(/\}\}/g) ?? []).length;
  if (openCount !== closeCount) {
    return {
      value,
      expressions: matches.map((match) => match[1].trim()),
      diagnostics: [{ code: "syntax", severity: "error", expression: value, message: "Expression braces are not balanced" }],
    };
  }
  if (!matches.length) return { value, diagnostics: [], expressions: [] };
  const exact = value.match(/^\s*\{\{([\s\S]*?)\}\}\s*$/);
  if (exact && matches.length === 1) {
    const result = evaluateExpression(exact[1].trim(), context);
    return { value: result.value, diagnostics: result.diagnostics, expressions: [exact[1].trim()] };
  }

  const diagnostics: ExpressionDiagnostic[] = [];
  const expressions: string[] = [];
  const rendered = value.replace(/\{\{([\s\S]*?)\}\}/g, (_, source: string) => {
    const expression = source.trim();
    expressions.push(expression);
    const result = evaluateExpression(expression, context);
    diagnostics.push(...result.diagnostics);
    if (result.value === undefined || result.value === null) return "";
    return typeof result.value === "string" ? result.value : JSON.stringify(result.value);
  });
  return { value: rendered, diagnostics, expressions };
}

export function resolveTemplate(value: unknown, context: TemplateContext): unknown {
  const preview = previewTemplate(value, context);
  const failure = preview.diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (failure) throw new Error(failure.message);
  return preview.value;
}

export function validateTemplateSyntax(value: unknown): ExpressionDiagnostic[] {
  if (Array.isArray(value)) return value.flatMap(validateTemplateSyntax);
  if (value && typeof value === "object") return Object.values(value).flatMap(validateTemplateSyntax);
  if (typeof value !== "string") return [];
  const diagnostics: ExpressionDiagnostic[] = [];
  const matches = [...value.matchAll(/\{\{([\s\S]*?)\}\}/g)];
  if ((value.match(/\{\{/g) ?? []).length !== (value.match(/\}\}/g) ?? []).length) {
    diagnostics.push({ code: "syntax", severity: "error", expression: value, message: "Expression braces are not balanced" });
  }
  for (const match of matches) {
    const expression = match[1].trim();
    const pipeline = splitOutside(expression, "|");
    const base = pipeline.shift() ?? "";
    const fallback = splitOutside(base, "??");
    const tokens = pathTokens(fallback[0] ?? "");
    if (!tokens || fallback.length > 2) {
      diagnostics.push({ code: "syntax", severity: "error", expression, message: "Invalid expression path or fallback" });
      continue;
    }
    if (typeof tokens[0] !== "string" || !["input", "steps", "binary", "files"].includes(tokens[0])) {
      diagnostics.push({ code: "syntax", severity: "error", expression, path: fallback[0], message: `Unknown expression root: ${String(tokens[0])}` });
    }
    for (const source of pipeline) {
      if (!source) {
        diagnostics.push({ code: "syntax", severity: "error", expression, message: "Empty transform in pipeline" });
        continue;
      }
      const spec = transformSpec(source);
      if (!["string", "number", "boolean", "date", "json", "array", "object", "fallback", "jsonpath"].includes(spec.name)) {
        diagnostics.push({ code: "unknown_transform", severity: "error", expression, message: `Unknown transform: ${spec.name}` });
      } else if (spec.name === "jsonpath") {
        const path = String(spec.argument ?? "");
        if (!path.startsWith("$") || !pathTokens(path)) {
          diagnostics.push({ code: "syntax", severity: "error", expression, path, message: "Invalid JSONPath transform" });
        }
      }
    }
  }
  return diagnostics;
}

export function expressionPaths(context: TemplateContext, maxDepth = 5) {
  const paths: Array<{ path: string; value: unknown }> = [];
  const visit = (value: unknown, path: string, depth: number) => {
    paths.push({ path, value });
    if (depth >= maxDepth || !value || typeof value !== "object") return;
    const entries = Array.isArray(value) ? value.slice(0, 20).map((item, index) => [String(index), item] as const) : Object.entries(value).slice(0, 40);
    for (const [key, item] of entries) visit(item, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`, depth + 1);
  };
  for (const [root, value] of Object.entries(contextRoots(context))) visit(value, root, 0);
  return paths;
}
