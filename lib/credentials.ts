import { randomUUID } from "node:crypto";
import { db } from "./db";
import { audit, decryptSecret, encryptSecret } from "./security";

export const CREDENTIAL_TYPES = [
  "api_key",
  "bearer",
  "basic",
  "oauth_token",
  "ssh_key",
] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export type CredentialData = Record<string, string>;
export type CredentialSummary = {
  id: string;
  name: string;
  type: CredentialType;
  masked: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
};

type CredentialRow = {
  id: string;
  name: string;
  type: CredentialType;
  encrypted_data: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
};

function requiredFields(type: CredentialType) {
  switch (type) {
    case "api_key":
      return ["headerName", "value"];
    case "bearer":
      return ["token"];
    case "basic":
      return ["username", "password"];
    case "oauth_token":
      return ["accessToken"];
    case "ssh_key":
      return ["privateKey"];
  }
}

function validate(type: unknown, data: unknown): asserts type is CredentialType {
  if (!CREDENTIAL_TYPES.includes(type as CredentialType)) {
    throw new Error("Unsupported credential type");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Credential data is required");
  }
  for (const field of requiredFields(type as CredentialType)) {
    if (typeof (data as CredentialData)[field] !== "string" || !(data as CredentialData)[field]) {
      throw new Error(`${field} is required`);
    }
  }
}

function mask(row: CredentialRow, data?: CredentialData) {
  if (row.type === "api_key" && data?.headerName) return `${data.headerName}: ••••••••`;
  if (row.type === "basic" && data?.username) return `${data.username}:••••••••`;
  if (row.type === "ssh_key" && data?.username) return `${data.username} / private key`;
  return "••••••••";
}

function summary(row: CredentialRow): CredentialSummary {
  let data: CredentialData | undefined;
  try {
    data = decryptSecret<CredentialData>(row.encrypted_data);
  } catch {
    // Metadata remains usable if the deployment key is temporarily unavailable.
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    masked: mask(row, data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at ?? undefined,
  };
}

export function listCredentials(): CredentialSummary[] {
  return (db.prepare("SELECT * FROM credentials ORDER BY name COLLATE NOCASE").all() as CredentialRow[]).map(summary);
}

export function getCredential(id: string) {
  const row = db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as CredentialRow | undefined;
  if (!row) return null;
  return {
    summary: summary(row),
    data: decryptSecret<CredentialData>(row.encrypted_data),
  };
}

export function createCredential(input: {
  name: unknown;
  type: unknown;
  data: unknown;
}, actor: { userId: string; ip?: string }) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("Credential name is required");
  if (name.length > 100) throw new Error("Credential name is too long");
  validate(input.type, input.data);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO credentials
      (id, name, type, encrypted_data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, name, input.type, encryptSecret(input.data), now, now);
  audit("credential.created", {
    ...actor,
    resourceType: "credential",
    resourceId: id,
    metadata: { name, type: input.type },
  });
  return summary(db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as CredentialRow);
}

export function updateCredential(id: string, input: {
  name?: unknown;
  type?: unknown;
  data?: unknown;
}, actor: { userId: string; ip?: string }) {
  const existing = db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as CredentialRow | undefined;
  if (!existing) return null;
  const name = typeof input.name === "string" ? input.name.trim() : existing.name;
  if (!name || name.length > 100) throw new Error("Credential name is invalid");
  const type = input.type ?? existing.type;
  let encrypted = existing.encrypted_data;
  if (input.data !== undefined) {
    validate(type, input.data);
    encrypted = encryptSecret(input.data);
  } else if (type !== existing.type) {
    throw new Error("Credential data is required when changing type");
  }
  db.prepare("UPDATE credentials SET name = ?, type = ?, encrypted_data = ?, updated_at = ? WHERE id = ?")
    .run(name, type, encrypted, new Date().toISOString(), id);
  audit("credential.updated", {
    ...actor,
    resourceType: "credential",
    resourceId: id,
    metadata: { name, type },
  });
  return summary(db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as CredentialRow);
}

export function deleteCredential(id: string, actor: { userId: string; ip?: string }) {
  const existing = db.prepare("SELECT name, type FROM credentials WHERE id = ?").get(id) as { name: string; type: string } | undefined;
  if (!existing) return false;
  db.prepare("DELETE FROM credentials WHERE id = ?").run(id);
  audit("credential.deleted", {
    ...actor,
    resourceType: "credential",
    resourceId: id,
    metadata: existing,
  });
  return true;
}

export function markCredentialUsed(id: string) {
  db.prepare("UPDATE credentials SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  audit("credential.used", { resourceType: "credential", resourceId: id });
}

export function credentialSecretValues(data: CredentialData) {
  return Object.values(data).filter((value) => value.length >= 3);
}

export function applyHttpCredential(
  type: CredentialType,
  data: CredentialData,
  headers: Record<string, string>,
) {
  switch (type) {
    case "api_key":
      headers[data.headerName] = data.value;
      break;
    case "bearer":
      headers.authorization = `Bearer ${data.token}`;
      break;
    case "basic":
      headers.authorization = `Basic ${Buffer.from(`${data.username}:${data.password}`).toString("base64")}`;
      break;
    case "oauth_token":
      headers.authorization = `Bearer ${data.accessToken}`;
      break;
    case "ssh_key":
      throw new Error("SSH key credentials require an SSH node");
  }
}
