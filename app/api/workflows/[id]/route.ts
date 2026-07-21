import { NextRequest, NextResponse } from "next/server";
import {
  deleteWorkflow,
  getWorkflow,
  updateWorkflow,
} from "@/lib/repository";
import { refreshSchedules } from "@/lib/scheduler";
import type { WorkflowGraph } from "@/lib/types";
import { authorize } from "@/lib/security";

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

  const workflow = updateWorkflow(id, {
    name: typeof body.name === "string" ? body.name : undefined,
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    graph: body.graph as WorkflowGraph | undefined,
  });

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
  if (!deleteWorkflow(id)) {
    return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  }
  refreshSchedules();
  return new NextResponse(null, { status: 204 });
}
