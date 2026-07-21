import { NextRequest, NextResponse } from "next/server";
import { deleteCredential, updateCredential } from "@/lib/credentials";
import { authorize, clientIp, consumeRateLimit } from "@/lib/security";

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, context: RouteContext) {
  const auth = authorize(request, true);
  if ("response" in auth) return auth.response;
  if (!consumeRateLimit(`credential-write:${auth.session.userId}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many credential changes" }, { status: 429 });
  }
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  try {
    const result = updateCredential(id, body, { userId: auth.session.userId, ip: clientIp(request) });
    return result ? NextResponse.json(result) : NextResponse.json({ error: "Credential not found" }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not update credential" }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = authorize(request, true);
  if ("response" in auth) return auth.response;
  if (!consumeRateLimit(`credential-write:${auth.session.userId}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many credential changes" }, { status: 429 });
  }
  const { id } = await context.params;
  return deleteCredential(id, { userId: auth.session.userId, ip: clientIp(request) })
    ? new NextResponse(null, { status: 204 })
    : NextResponse.json({ error: "Credential not found" }, { status: 404 });
}
