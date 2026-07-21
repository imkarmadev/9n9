import { NextRequest, NextResponse } from "next/server";
import { audit, authorize, clearSessionCookie, clientIp, deleteSession } from "@/lib/security";

export async function POST(request: NextRequest) {
  const auth = authorize(request, true);
  if ("response" in auth) return auth.response;
  deleteSession(auth.session.id);
  audit("auth.logout", { userId: auth.session.userId, ip: clientIp(request) });
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  response.headers.set("cache-control", "no-store");
  response.headers.set("clear-site-data", '"cache", "storage"');
  return response;
}
