import { NextRequest, NextResponse } from "next/server";
import {
  deleteWorkflow,
  getWorkflow,
  updateWorkflow,
} from "@/lib/repository";
import { refreshSchedules } from "@/lib/scheduler";
import type { WorkflowGraph } from "@/lib/types";
import { authorize, clientIp } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = authorize(request);
  if ("response" in auth) return auth.response;
  const { id } = await context.params;
  const workflow = getWorkflow(id);
  if (!workflow) {
    return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  }
  return NextResponse.json(workflow);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const auth = authorize(request, true);
  if ("response" in auth) return auth.response;
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));

  if (
    body.graph &&
    (!Array.isArray(body.graph.nodes) || !Array.isArray(body.graph.edges))
  ) {
    return NextResponse.json({ error: "Invalid workflow graph" }, { status: 400 });
  }

  let workflow;
  try {
    workflow = updateWorkflow(id, {
      name: typeof body.name === "string" ? body.name : undefined,
      slug: typeof body.slug === "string" ? body.slug : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      tags: Array.isArray(body.tags) ? body.tags : undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      graph: body.graph as WorkflowGraph | undefined,
      forceEnableInvalid: body.forceEnableInvalid === true,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    }, { userId: auth.session.userId, ip: clientIp(request) });
  } catch (error) {
    const typed = error as Error & { code?: string; issues?: unknown };
    return NextResponse.json({ error: typed.message, code: typed.code, issues: typed.issues }, { status: typed.code === "INVALID_WORKFLOW" || typed.message.includes("slug") ? 409 : 400 });
  }

  if (!workflow) {
    return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  }

  refreshSchedules();
  return NextResponse.json(workflow);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = authorize(request, true);
  if ("response" in auth) return auth.response;
  const { id } = await context.params;
  if (!deleteWorkflow(id, { userId: auth.session.userId, ip: clientIp(request) })) {
    return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  }
  refreshSchedules();
  return new NextResponse(null, { status: 204 });
}
