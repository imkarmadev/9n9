import { NextRequest, NextResponse } from "next/server";
import { importWorkflow } from "@/lib/repository";
import { authorize, clientIp, consumeRateLimit } from "@/lib/security";

export async function POST(request: NextRequest) {
  const auth = authorize(request, true);
  if ("response" in auth) return auth.response;
  if (!consumeRateLimit(`workflow-import:${auth.session.userId}`, 20, 60_000)) return NextResponse.json({ error: "Too many imports" }, { status: 429 });
  const text = await request.text();
  if (text.length > 2_000_000) return NextResponse.json({ error: "Import is too large" }, { status: 413 });
  try {
    return NextResponse.json(importWorkflow(JSON.parse(text), { userId: auth.session.userId, ip: clientIp(request) }), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Import failed" }, { status: 400 });
  }
}
