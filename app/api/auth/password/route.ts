import { NextRequest, NextResponse } from "next/server";
import { audit, authorize, changePassword, clientIp, consumeRateLimit, deleteOtherSessions } from "@/lib/security";

export async function PUT(request: NextRequest) {
  const auth = authorize(request, true);
  if ("response" in auth) return auth.response;
  if (!consumeRateLimit(`password-change:${auth.session.userId}`, 5, 15 * 60_000)) {
    return NextResponse.json({ error: "Too many password attempts. Try again later." }, { status: 429 });
  }
  const body = await request.json().catch(() => ({}));
  try {
    changePassword(auth.session.userId, body.currentPassword, body.newPassword);
    deleteOtherSessions(auth.session.userId, auth.session.id);
    audit("auth.password_changed", { userId: auth.session.userId, ip: clientIp(request) });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Password change failed" }, { status: 400 });
  }
}
