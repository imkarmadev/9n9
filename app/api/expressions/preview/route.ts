import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/security";
import {
  expressionPaths,
  previewTemplate,
  type TemplateContext,
} from "@/lib/template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = authorize(request, true);
  if ("response" in auth) return auth.response;
  const body = await request.json().catch(() => null) as {
    value?: unknown;
    context?: Partial<TemplateContext>;
  } | null;
  if (!body || !("value" in body)) {
    return NextResponse.json({ error: "Expression value is required" }, { status: 400 });
  }
  const context: TemplateContext = {
    input: body.context?.input ?? {},
    steps: body.context?.steps && typeof body.context.steps === "object"
      ? body.context.steps
      : {},
    binary: body.context?.binary,
    files: body.context?.files,
  };
  return NextResponse.json({
    ...previewTemplate(body.value, context),
    paths: expressionPaths(context),
  });
}
