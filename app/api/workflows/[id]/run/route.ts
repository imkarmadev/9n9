import { NextRequest, NextResponse } from "next/server";
import { executeWorkflow } from "@/lib/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));

  try {
    const run = await executeWorkflow(id, "manual", body.input ?? {});
    return NextResponse.json(run, {
      status: run.status === "success" ? 200 : 422,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Run failed" },
      { status: 404 },
    );
  }
}
