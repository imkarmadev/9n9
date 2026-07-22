import { NextRequest, NextResponse } from "next/server";
import { restoreArchivedWorkflow } from "@/lib/repository";
import { authorize, clientIp } from "@/lib/security";

type RouteContext = { params: Promise<{ id: string }> };
export async function POST(request: NextRequest, context: RouteContext) {
  const auth = authorize(request, true); if ("response" in auth) return auth.response;
  const { id } = await context.params;
  const result = restoreArchivedWorkflow(id, { userId: auth.session.userId, ip: clientIp(request) });
  return result ? NextResponse.json(result) : NextResponse.json({ error: "Workflow not found" }, { status: 404 });
}
