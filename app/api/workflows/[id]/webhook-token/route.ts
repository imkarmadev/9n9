import { NextRequest, NextResponse } from "next/server";
import { rotateWebhookToken } from "@/lib/repository";
import { authorize, clientIp, consumeRateLimit } from "@/lib/security";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = authorize(request, true);
  if ("response" in auth) return auth.response;
  if (!consumeRateLimit(`webhook-rotate:${auth.session.userId}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many rotations" }, { status: 429 });
  }
  const { id } = await context.params;
  const result = rotateWebhookToken(id, { userId: auth.session.userId, ip: clientIp(request) });
  return result ? NextResponse.json(result) : NextResponse.json({ error: "Workflow not found" }, { status: 404 });
}
