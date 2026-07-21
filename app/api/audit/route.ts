import { NextRequest, NextResponse } from "next/server";
import { authorize, listAuditEvents } from "@/lib/security";

export function GET(request: NextRequest) {
  const auth = authorize(request);
  if ("response" in auth) return auth.response;
  return NextResponse.json(listAuditEvents());
}
