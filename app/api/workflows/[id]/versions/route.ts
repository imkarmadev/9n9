import { NextRequest, NextResponse } from "next/server";
import { getWorkflow, listWorkflowVersions } from "@/lib/repository";
import { authorize } from "@/lib/security";

type RouteContext = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, context: RouteContext) {
  const auth = authorize(request); if ("response" in auth) return auth.response;
  const { id } = await context.params;
  if (!getWorkflow(id)) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  return NextResponse.json(listWorkflowVersions(id));
}
