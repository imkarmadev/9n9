import { NextRequest, NextResponse } from "next/server";
import { executeWorkflow } from "@/lib/executor";
import { getWorkflowBySlug, verifyWebhookToken } from "@/lib/repository";
import { audit, clientIp } from "@/lib/security";
import { redactSecrets } from "@/lib/redaction";

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

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : request.headers.get("x-9n9-webhook-token") ?? "";
  if (!token || !verifyWebhookToken(workflow.id, token)) {
    audit("webhook.denied", {
      resourceType: "workflow",
      resourceId: workflow.id,
      ip: clientIp(request),
    });
    return NextResponse.json({ error: "Invalid webhook token" }, { status: 401 });
  }

  let body: unknown = null;
  if (request.method !== "GET") {
    const contentType = request.headers.get("content-type") ?? "";
    body = contentType.includes("application/json")
      ? await request.json().catch(() => null)
      : await request.text();
  }

  const input = redactSecrets({
    method: request.method,
    query: Object.fromEntries(request.nextUrl.searchParams),
    headers: Object.fromEntries(request.headers),
    body,
  }, [token]);

  const run = await executeWorkflow(workflow, "webhook", input);
  return NextResponse.json(run.output ?? run, {
    status: run.status === "success" ? 200 : 422,
  });
}

export const GET = trigger;
export const POST = trigger;
export const PUT = trigger;
export const PATCH = trigger;
