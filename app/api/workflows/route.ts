import { NextRequest, NextResponse } from "next/server";
import { createWorkflow, listWorkflows } from "@/lib/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(listWorkflows());
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const workflow = createWorkflow(
    typeof body.name === "string" ? body.name : undefined,
  );
  return NextResponse.json(workflow, { status: 201 });
}
