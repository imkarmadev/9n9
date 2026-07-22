import { NextRequest, NextResponse } from "next/server";
import { deleteTemplate } from "@/lib/repository";
import { authorize, clientIp } from "@/lib/security";

type RouteContext = { params: Promise<{ id: string }> };
export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = authorize(request, true); if ("response" in auth) return auth.response;
  const { id } = await context.params;
  return deleteTemplate(id, { userId: auth.session.userId, ip: clientIp(request) }) ? new NextResponse(null, { status: 204 }) : NextResponse.json({ error: "Template not found" }, { status: 404 });
}
