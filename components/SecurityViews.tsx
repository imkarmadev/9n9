"use client";

import { Activity, KeyRound, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
/* eslint-disable react-hooks/set-state-in-effect -- initial API hydration populates local view state. */
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { CredentialSummary, CredentialType } from "@/lib/credentials";
import type { AuditEvent } from "@/lib/security";

async function requestJson<T>(url: string, csrfToken: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.method && init.method !== "GET" ? { "x-9n9-csrf": csrfToken } : {}),
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? "Request failed");
  return body as T;
}

const typeLabels: Record<CredentialType, string> = {
  api_key: "API key",
  bearer: "Bearer token",
  basic: "Basic auth",
  oauth_token: "OAuth token",
  ssh_key: "SSH key",
};

function emptyData(type: CredentialType): Record<string, string> {
  switch (type) {
    case "api_key": return { headerName: "X-API-Key", value: "" };
    case "bearer": return { token: "" };
    case "basic": return { username: "", password: "" };
    case "oauth_token": return { accessToken: "", refreshToken: "" };
    case "ssh_key": return { username: "", privateKey: "", passphrase: "" };
  }
}

export function CredentialsView({
  csrfToken,
  credentials,
  onRefresh,
}: {
  csrfToken: string;
  credentials: CredentialSummary[];
  onRefresh: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = credentials.find((item) => item.id === selectedId);
  const [name, setName] = useState("");
  const [type, setType] = useState<CredentialType>("bearer");
  const [data, setData] = useState<Record<string, string>>(emptyData("bearer"));
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  function edit(credential: CredentialSummary) {
    setSelectedId(credential.id);
    setName(credential.name);
    setType(credential.type);
    setData({});
    setNotice("Leave secret fields blank to keep the encrypted value.");
  }

  function startNew() {
    setSelectedId(null);
    setName("");
    setType("bearer");
    setData(emptyData("bearer"));
    setNotice("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      const hasNewSecret = Object.values(data).some(Boolean);
      const body = selected
        ? { name, ...(hasNewSecret ? { type, data } : {}) }
        : { name, type, data };
      await requestJson(selected ? `/api/credentials/${selected.id}` : "/api/credentials", csrfToken, {
        method: selected ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      await onRefresh();
      setNotice(selected ? "Credential updated" : "Credential encrypted and saved");
      if (!selected) startNew();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selected || !window.confirm(`Delete ${selected.name}?`)) return;
    setBusy(true);
    try {
      await requestJson(`/api/credentials/${selected.id}`, csrfToken, { method: "DELETE" });
      startNew();
      await onRefresh();
      setNotice("Credential deleted");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  const field = (key: string, label: string, secret = false, multiline = false) => (
    <label className="field" key={key}>
      <span>{label}</span>
      {multiline ? (
        <textarea aria-label={label} rows={7} value={data[key] ?? ""} onChange={(event) => setData({ ...data, [key]: event.target.value })} />
      ) : (
        <input aria-label={label} type={secret ? "password" : "text"} value={data[key] ?? ""} onChange={(event) => setData({ ...data, [key]: event.target.value })} />
      )}
    </label>
  );

  return (
    <div className="security-view">
      <header className="runs-header">
        <div><span>Encrypted local vault</span><h1>Credentials</h1></div>
        <button className="button button--quiet" onClick={startNew}><Plus size={15} /> New credential</button>
      </header>
      <div className="security-grid">
        <section className="credential-list">
          {credentials.map((credential) => (
            <button key={credential.id} className={selectedId === credential.id ? "is-active" : ""} onClick={() => edit(credential)}>
              <KeyRound size={15} /><span><strong>{credential.name}</strong><small>{typeLabels[credential.type]} · {credential.masked}</small></span>
            </button>
          ))}
          {!credentials.length && <div className="runs-empty">No credentials saved.</div>}
        </section>
        <form className="credential-form" onSubmit={save}>
          <h2>{selected ? "Edit credential" : "New credential"}</h2>
          <label className="field"><span>Name</span><input aria-label="Credential name" value={name} onChange={(event) => setName(event.target.value)} required /></label>
          <label className="field"><span>Type</span><select aria-label="Credential type" value={type} disabled={Boolean(selected)} onChange={(event) => { const next = event.target.value as CredentialType; setType(next); setData(emptyData(next)); }}>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {type === "api_key" && <>{field("headerName", "Header name")}{field("value", "API key", true)}</>}
          {type === "bearer" && field("token", "Bearer token", true)}
          {type === "basic" && <>{field("username", "Account username")}{field("password", "Account password", true)}</>}
          {type === "oauth_token" && <>{field("accessToken", "Access token", true)}{field("refreshToken", "Refresh token", true)}</>}
          {type === "ssh_key" && <>{field("username", "SSH username")}{field("privateKey", "Private key", true, true)}{field("passphrase", "Key passphrase", true)}</>}
          {notice && <p className="form-notice" role="status">{notice}</p>}
          <div className="form-actions">
            {selected && <button className="button button--danger" type="button" onClick={remove} disabled={busy}><Trash2 size={14} /> Delete</button>}
            <button className="button button--run" disabled={busy}><Save size={14} /> {busy ? "Saving…" : "Save credential"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function AuditView({ csrfToken }: { csrfToken: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setEvents(await requestJson<AuditEvent[]>("/api/audit", csrfToken)); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load audit events"); }
  }, [csrfToken]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="security-view">
      <header className="runs-header"><div><span>Security history</span><h1>Audit log</h1></div><button className="button button--quiet" onClick={load}><Activity size={15} /> Refresh</button></header>
      {error && <p className="form-notice">{error}</p>}
      <div className="audit-table">
        {events.map((event) => <div key={event.id}><ShieldCheck size={15} /><strong>{event.event}</strong><span>{event.username ?? "system"}</span><span>{event.resourceType ?? "—"}</span><time>{new Date(event.createdAt).toLocaleString()}</time></div>)}
        {!events.length && <div className="runs-empty">No security events yet.</div>}
      </div>
    </div>
  );
}

export function AccountView({ csrfToken, username }: { csrfToken: string; username: string }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [notice, setNotice] = useState("");
  const strongEnough = useMemo(() => newPassword.length >= 15, [newPassword]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await requestJson("/api/auth/password", csrfToken, { method: "PUT", body: JSON.stringify({ currentPassword, newPassword }) });
      setCurrentPassword(""); setNewPassword(""); setNotice("Password changed; other sessions were signed out.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Password change failed"); }
  }
  return <div className="security-view"><header className="runs-header"><div><span>Signed in as {username}</span><h1>Security</h1></div></header><form className="credential-form account-form" onSubmit={submit}><h2>Change admin password</h2><label className="field"><span>Current password</span><input aria-label="Current password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label><label className="field"><span>New password</span><input aria-label="New password" type="password" minLength={15} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label><small>At least 15 characters. Other sessions will be revoked.</small>{notice && <p className="form-notice" role="status">{notice}</p>}<button className="button button--run" disabled={!strongEnough}>Change password</button></form></div>;
}
