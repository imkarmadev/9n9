import { NextRequest, NextResponse } from "next/server";
import { listRuns } from "@/lib/repository";
import { authorize } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const auth = authorize(request);
  if ("response" in auth) return auth.response;
  return NextResponse.json(listRuns());
}
