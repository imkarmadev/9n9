import { NextRequest, NextResponse } from "next/server";
import { executeWorkflow } from "@/lib/executor";
import { getWorkflowBySlug } from "@/lib/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ slug: string }> };

async function trigger(request: NextRequest, context: RouteContext) {
  const { slug } = await context.params;
  const workflow = getWorkflowBySlug(slug);

  if (!workflow || !workflow.enabled) {
    return NextResponse.json(
      { error: "Webhook not found or flow is disabled" },
      { status: 404 },
    );
  }

  let body: unknown = null;
  if (request.method !== "GET") {
    const contentType = request.headers.get("content-type") ?? "";
    body = contentType.includes("application/json")
      ? await request.json().catch(() => null)
      : await request.text();
  }

  const input = {
    method: request.method,
    query: Object.fromEntries(request.nextUrl.searchParams),
    headers: Object.fromEntries(request.headers),
    body,
  };

  const run = await executeWorkflow(workflow, "webhook", input);
  return NextResponse.json(run.output ?? run, {
    status: run.status === "success" ? 200 : 422,
  });
}

export const GET = trigger;
export const POST = trigger;
export const PUT = trigger;
export const PATCH = trigger;
