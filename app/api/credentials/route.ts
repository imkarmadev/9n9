import { NextRequest, NextResponse } from "next/server";
import { createCredential, listCredentials } from "@/lib/credentials";
import { authorize, clientIp, consumeRateLimit } from "@/lib/security";

export function GET(request: NextRequest) {
  const auth = authorize(request);
  if ("response" in auth) return auth.response;
  return NextResponse.json(listCredentials());
}

export async function POST(request: NextRequest) {
  const auth = authorize(request, true);
  if ("response" in auth) return auth.response;
  if (!consumeRateLimit(`credential-write:${auth.session.userId}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many credential changes" }, { status: 429 });
  }
  const body = await request.json().catch(() => ({}));
  try {
    return NextResponse.json(createCredential(body, { userId: auth.session.userId, ip: clientIp(request) }), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not create credential" }, { status: 400 });
  }
}
