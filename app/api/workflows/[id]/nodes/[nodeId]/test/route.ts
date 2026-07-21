import { NextRequest, NextResponse } from "next/server";
import { testWorkflowNode } from "@/lib/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string; nodeId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { id, nodeId } = await context.params;
  const body = await request.json().catch(() => ({}));

  try {
    const result = await testWorkflowNode(
      id,
      nodeId,
      body.input ?? {},
      body.steps ?? {},
    );
    return NextResponse.json(result, {
      status: result.status === "success" ? 200 : 422,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Node test failed" },
      { status: 404 },
    );
  }
}
