import { NextRequest, NextResponse } from "next/server";
import { restoreWorkflowVersion } from "@/lib/repository";
import { authorize, clientIp } from "@/lib/security";

type RouteContext = { params: Promise<{ id: string; version: string }> };
export async function POST(request: NextRequest, context: RouteContext) {
  const auth = authorize(request, true); if ("response" in auth) return auth.response;
  const { id, version } = await context.params;
  const parsed = Number(version);
  if (!Number.isInteger(parsed) || parsed < 1) return NextResponse.json({ error: "Invalid version" }, { status: 400 });
  try {
    const result = restoreWorkflowVersion(id, parsed, { userId: auth.session.userId, ip: clientIp(request) });
    return result ? NextResponse.json(result) : NextResponse.json({ error: "Version not found" }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Restore failed" }, { status: 409 });
  }
}
