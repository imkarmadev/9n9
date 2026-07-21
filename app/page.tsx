import { WorkflowStudio } from "@/components/WorkflowStudio";
import { AuthScreen } from "@/components/AuthScreen";
import { cookies } from "next/headers";
import { ensureBootstrapAdmin, getSession, hasAdmin, SESSION_COOKIE } from "@/lib/security";

export const dynamic = "force-dynamic";

export default async function Home() {
  ensureBootstrapAdmin();
  const cookieStore = await cookies();
  const session = getSession(cookieStore.get(SESSION_COOKIE)?.value);
  if (!session) return <AuthScreen configured={hasAdmin()} />;
  return <WorkflowStudio csrfToken={session.csrfToken} username={session.username} />;
}
