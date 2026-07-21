import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.CODEX_AGENT_URL ?? "http://codex-agent:8080";
  let codex: "online" | "offline" = "offline";

  try {
    const response = await fetch(url + "/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
    codex = response.ok ? "online" : "offline";
  } catch {
    codex = "offline";
  }

  return NextResponse.json({
    ok: true,
    codex,
    version: "0.2.0",
    telemetry: false,
  });
}
