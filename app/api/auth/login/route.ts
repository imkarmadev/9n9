import { NextRequest, NextResponse } from "next/server";
import { audit, clientIp, consumeRateLimit, createSession, ensureBootstrapAdmin, getUserByCredentials, isAllowedNetwork, requestHasSameOrigin, setSessionCookie } from "@/lib/security";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  ensureBootstrapAdmin();
  const ip = clientIp(request);
  if (!isAllowedNetwork(request)) return NextResponse.json({ error: "Network not allowed" }, { status: 403 });
  if (!requestHasSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const key = `login:${ip}:${username.toLowerCase()}`;
  if (!consumeRateLimit(key)) {
    audit("auth.rate_limited", { ip, metadata: { username } });
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "retry-after": "900" } });
  }
  const user = getUserByCredentials(username, typeof body.password === "string" ? body.password : "");
  if (!user) {
    audit("auth.login_failed", { ip, metadata: { username } });
    return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  }
  const session = createSession(user, request);
  audit("auth.login", { userId: user.id, ip });
  const response = NextResponse.json({ username: user.username, csrfToken: session.csrfToken });
  setSessionCookie(response, session.token, session.expires, request);
  response.headers.set("cache-control", "no-store");
  return response;
}
