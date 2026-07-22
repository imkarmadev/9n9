import { NextRequest, NextResponse } from "next/server";
import { createTemplate, createTemplateFromWorkflow, listTemplates } from "@/lib/repository";
import { authorize, clientIp } from "@/lib/security";

export function GET(request: NextRequest) {
  const auth = authorize(request); if ("response" in auth) return auth.response;
  return NextResponse.json(listTemplates());
}
export async function POST(request: NextRequest) {
  const auth = authorize(request, true); if ("response" in auth) return auth.response;
  const body = await request.json().catch(() => ({}));
  try {
    const actor = { userId: auth.session.userId, ip: clientIp(request) };
    const result = typeof body.workflowId === "string" ? createTemplateFromWorkflow(body.workflowId, actor) : createTemplate(body, actor);
    return result ? NextResponse.json(result, { status: 201 }) : NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not create template" }, { status: 400 });
  }
}
