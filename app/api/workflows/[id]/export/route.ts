import { NextRequest, NextResponse } from "next/server";
import { exportWorkflow } from "@/lib/repository";
import { authorize } from "@/lib/security";

type RouteContext = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, context: RouteContext) {
  const auth = authorize(request); if ("response" in auth) return auth.response;
  const { id } = await context.params;
  const result = exportWorkflow(id);
  if (!result) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  return new NextResponse(JSON.stringify(result, null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${result.workflow.slug}.9n9.json"` } });
}
