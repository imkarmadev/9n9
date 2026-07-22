import { NextRequest, NextResponse } from "next/server";
import { createWorkflow, listWorkflows } from "@/lib/repository";
import { authorize, clientIp } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const auth = authorize(request);
  if ("response" in auth) return auth.response;
  const archivedValue = request.nextUrl.searchParams.get("archived");
  const sortValue = request.nextUrl.searchParams.get("sort");
  const archived = archivedValue === "archived" || archivedValue === "all" ? archivedValue : "active";
  const sort = sortValue === "name" || sortValue === "created" ? sortValue : "updated";
  return NextResponse.json(listWorkflows({ search: request.nextUrl.searchParams.get("search") ?? undefined, archived, sort }));
}

export async function POST(request: NextRequest) {
  const auth = authorize(request, true);
  if ("response" in auth) return auth.response;
  const body = await request.json().catch(() => ({}));
  const workflow = createWorkflow(typeof body.name === "string" ? body.name : undefined, {
    description: typeof body.description === "string" ? body.description : undefined,
    tags: Array.isArray(body.tags) ? body.tags : undefined,
    graph: body.graph,
  }, { userId: auth.session.userId, ip: clientIp(request) });
  return NextResponse.json(workflow, { status: 201 });
}
