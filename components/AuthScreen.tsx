"use client";

import { LockKeyhole } from "lucide-react";
import { FormEvent, useState } from "react";

export function AuthScreen({ configured }: { configured: boolean }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(configured ? "/api/auth/login" : "/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Authentication failed");
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Authentication failed");
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand brand--auth">
          <div className="brand__mark">9</div>
          <div><strong>9n9</strong><span>local automation</span></div>
        </div>
        <div className="auth-card__icon"><LockKeyhole size={22} /></div>
        <h1>{configured ? "Welcome back" : "Secure your 9n9"}</h1>
        <p>{configured ? "Sign in to the local workspace." : "Create the first local administrator. Your password never leaves this machine."}</p>
        <label className="field"><span>Username</span><input aria-label="Username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
        <label className="field"><span>Password</span><input aria-label="Password" type="password" autoComplete={configured ? "current-password" : "new-password"} minLength={configured ? undefined : 15} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        {!configured && <small>Use at least 15 characters.</small>}
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="button button--run auth-submit" disabled={busy} type="submit">{busy ? "Working…" : configured ? "Sign in" : "Create admin"}</button>
      </form>
    </main>
  );
}
