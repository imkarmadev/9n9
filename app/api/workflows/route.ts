import { NextRequest, NextResponse } from "next/server";
import { createWorkflow, listWorkflows } from "@/lib/repository";
import { authorize } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const auth = authorize(request);
  if ("response" in auth) return auth.response;
  return NextResponse.json(listWorkflows());
}

export async function POST(request: NextRequest) {
  const auth = authorize(request, true);
  if ("response" in auth) return auth.response;
  const body = await request.json().catch(() => ({}));
  const workflow = createWorkflow(
    typeof body.name === "string" ? body.name : undefined,
  );
  return NextResponse.json(workflow, { status: 201 });
}
