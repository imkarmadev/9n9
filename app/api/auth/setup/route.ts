import { NextRequest, NextResponse } from "next/server";
import { audit, clientIp, consumeRateLimit, createInitialAdmin, createSession, hasAdmin, isAllowedNetwork, requestHasSameOrigin, setSessionCookie } from "@/lib/security";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const ip = clientIp(request);
  if (!isAllowedNetwork(request)) return NextResponse.json({ error: "Network not allowed" }, { status: 403 });
  if (!requestHasSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  if (!consumeRateLimit(`setup:${ip}`)) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  if (hasAdmin()) return NextResponse.json({ error: "9n9 is already configured" }, { status: 409 });
  const body = await request.json().catch(() => ({}));
  try {
    const user = createInitialAdmin(typeof body.username === "string" ? body.username : "admin", body.password);
    const session = createSession(user, request);
    audit("auth.setup", { userId: user.id, ip });
    const response = NextResponse.json({ username: user.username, csrfToken: session.csrfToken }, { status: 201 });
    setSessionCookie(response, session.token, session.expires, request);
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Setup failed" }, { status: 400 });
  }
}
