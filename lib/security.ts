import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "./db";

export const SESSION_COOKIE = "n9n_session";
export const CSRF_HEADER = "x-9n9-csrf";
export const PASSWORD_MIN_LENGTH = 15;
const SESSION_DAYS = 7;
const SCRYPT_COST = 131_072;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;

type SessionRow = {
  id: string;
  user_id: string;
  username: string;
  csrf_hash: string;
  csrf_token: string | null;
  expires_at: string;
};

export type AuthSession = {
  id: string;
  userId: string;
  username: string;
  csrfHash: string;
  csrfToken: string;
  expiresAt: string;
};

export type AuditEvent = {
  id: string;
  userId?: string;
  username?: string;
  event: string;
  resourceType?: string;
  resourceId?: string;
  metadata: Record<string, unknown>;
  ip?: string;
  createdAt: string;
};

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function equalDigest(value: string, expectedHex: string) {
  const actual = Buffer.from(digest(value), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function secretToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 32, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
    maxmem: 256 * 1024 * 1024,
  });
  return [
    "scrypt",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELISM,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export function verifyPassword(password: string, encoded: string) {
  const [algorithm, cost, blockSize, parallelism, salt, expected] =
    encoded.split("$");
  if (algorithm !== "scrypt" || !expected || !salt) return false;
  try {
    const derived = scryptSync(password, Buffer.from(salt, "base64url"), 32, {
      N: Number(cost),
      r: Number(blockSize),
      p: Number(parallelism),
      maxmem: 256 * 1024 * 1024,
    });
    const expectedBuffer = Buffer.from(expected, "base64url");
    return (
      derived.length === expectedBuffer.length &&
      timingSafeEqual(derived, expectedBuffer)
    );
  } catch {
    return false;
  }
}

export function validatePassword(password: unknown) {
  if (typeof password !== "string") return "Password is required";
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > 256) return "Password is too long";
  return null;
}

export function hasAdmin() {
  return Boolean(db.prepare("SELECT 1 FROM users LIMIT 1").get());
}

export function createInitialAdmin(username: string, password: string) {
  const cleanUsername = username.trim() || "admin";
  const passwordError = validatePassword(password);
  if (passwordError) throw new Error(passwordError);
  if (cleanUsername.length > 64) throw new Error("Username is too long");

  const create = db.transaction(() => {
    if (hasAdmin()) throw new Error("9n9 is already configured");
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users
        (id, username, password_hash, created_at, password_updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, cleanUsername, hashPassword(password), now, now);
    return { id, username: cleanUsername };
  });
  return create();
}

export function ensureBootstrapAdmin() {
  if (hasAdmin()) return;
  const password = process.env.N9N_BOOTSTRAP_ADMIN_PASSWORD;
  if (!password) return;
  createInitialAdmin(
    process.env.N9N_BOOTSTRAP_ADMIN_USERNAME ?? "admin",
    password,
  );
}

export function clientIp(request: NextRequest) {
  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function isPrivateAddress(value: string) {
  const ip = value.replace(/^::ffff:/, "");
  return (
    ip === "unknown" ||
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith("fd") ||
    ip.startsWith("fc")
  );
}

export function isAllowedNetwork(request: NextRequest) {
  if (process.env.N9N_TRUSTED_LAN_ONLY !== "true") return true;
  return isPrivateAddress(clientIp(request));
}

export function requestHasSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  const configured = process.env.N9N_PUBLIC_ORIGIN?.replace(/\/$/, "");
  const expected = configured ?? request.nextUrl.origin;
  if (origin) return origin === expected;

  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === expected;
  } catch {
    return false;
  }
}

export function createSession(
  user: { id: string; username: string },
  request: NextRequest,
) {
  const token = secretToken();
  const csrfToken = secretToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO sessions
      (id, user_id, token_hash, csrf_hash, csrf_token, created_at, expires_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    user.id,
    digest(token),
    digest(csrfToken),
    csrfToken,
    now.toISOString(),
    expires.toISOString(),
    request.headers.get("user-agent"),
    clientIp(request),
  );
  return { id, token, csrfToken, expires };
}

export function setSessionCookie(
  response: NextResponse,
  token: string,
  expires: Date,
  request: NextRequest,
) {
  const secure =
    request.nextUrl.protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https";
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    expires,
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: false,
    path: "/",
    expires: new Date(0),
  });
}

export function getSession(token: string | undefined): AuthSession | null {
  if (!token) return null;
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(
    new Date().toISOString(),
  );
  const row = db
    .prepare(
      `SELECT sessions.id, sessions.user_id, sessions.csrf_hash, sessions.csrf_token,
              sessions.expires_at, users.username
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
    )
    .get(digest(token), new Date().toISOString()) as SessionRow | undefined;
  if (!row || !row.csrf_token) return null;
  return row
    ? {
        id: row.id,
        userId: row.user_id,
        username: row.username,
        csrfHash: row.csrf_hash,
        csrfToken: row.csrf_token,
        expiresAt: row.expires_at,
      }
    : null;
}

export function getRequestSession(request: NextRequest) {
  ensureBootstrapAdmin();
  return getSession(request.cookies.get(SESSION_COOKIE)?.value);
}

export function getUserByCredentials(username: string, password: string) {
  const row = db
    .prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
    .get(username) as
    | { id: string; username: string; password_hash: string }
    | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  return { id: row.id, username: row.username };
}

export function deleteSession(sessionId: string) {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

export function deleteOtherSessions(userId: string, keepSessionId: string) {
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(
    userId,
    keepSessionId,
  );
}

export function changePassword(userId: string, current: string, next: string) {
  const passwordError = validatePassword(next);
  if (passwordError) throw new Error(passwordError);
  const row = db
    .prepare("SELECT password_hash FROM users WHERE id = ?")
    .get(userId) as { password_hash: string } | undefined;
  if (!row || !verifyPassword(current, row.password_hash)) {
    throw new Error("Current password is incorrect");
  }
  db.prepare(
    "UPDATE users SET password_hash = ?, password_updated_at = ? WHERE id = ?",
  ).run(hashPassword(next), new Date().toISOString(), userId);
}

export function authorize(request: NextRequest, csrf = false) {
  if (!isAllowedNetwork(request)) {
    return {
      response: NextResponse.json({ error: "Network not allowed" }, { status: 403 }),
    };
  }
  const session = getRequestSession(request);
  if (!session) {
    return {
      response: NextResponse.json({ error: "Authentication required" }, { status: 401 }),
    };
  }
  if (csrf) {
    const csrfToken = request.headers.get(CSRF_HEADER);
    if (
      !requestHasSameOrigin(request) ||
      !csrfToken ||
      !equalDigest(csrfToken, session.csrfHash)
    ) {
      audit("security.csrf_denied", {
        userId: session.userId,
        ip: clientIp(request),
      });
      return {
        response: NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 }),
      };
    }
  }
  return { session };
}

const rateLimits = new Map<string, number[]>();

export function consumeRateLimit(
  key: string,
  limit = 5,
  windowMs = 15 * 60_000,
) {
  const now = Date.now();
  const recent = (rateLimits.get(key) ?? []).filter(
    (timestamp) => timestamp > now - windowMs,
  );
  if (recent.length >= limit) {
    rateLimits.set(key, recent);
    return false;
  }
  recent.push(now);
  rateLimits.set(key, recent);
  return true;
}

export function audit(
  event: string,
  details: {
    userId?: string;
    resourceType?: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
    ip?: string;
  } = {},
) {
  db.prepare(
    `INSERT INTO audit_events
      (id, user_id, event, resource_type, resource_id, metadata, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    details.userId ?? null,
    event,
    details.resourceType ?? null,
    details.resourceId ?? null,
    JSON.stringify(details.metadata ?? {}),
    details.ip ?? null,
    new Date().toISOString(),
  );
}

export function listAuditEvents(limit = 200): AuditEvent[] {
  const rows = db
    .prepare(
      `SELECT audit_events.*, users.username
       FROM audit_events LEFT JOIN users ON users.id = audit_events.user_id
       ORDER BY audit_events.created_at DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(limit, 500))) as Array<{
    id: string;
    user_id: string | null;
    username: string | null;
    event: string;
    resource_type: string | null;
    resource_id: string | null;
    metadata: string;
    ip: string | null;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id ?? undefined,
    username: row.username ?? undefined,
    event: row.event,
    resourceType: row.resource_type ?? undefined,
    resourceId: row.resource_id ?? undefined,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    ip: row.ip ?? undefined,
    createdAt: row.created_at,
  }));
}

function masterKey() {
  const encoded = process.env.N9N_MASTER_KEY;
  if (!encoded) throw new Error("N9N_MASTER_KEY is not configured");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error("N9N_MASTER_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

export function encryptSecret(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSecret<T>(encoded: string): T {
  const [version, iv, tag, encrypted] = encoded.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) {
    throw new Error("Credential data is invalid");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    masterKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}

export function hashToken(token: string) {
  return digest(token);
}

export function newSecretToken() {
  return secretToken();
}

export function verifyToken(token: string, hash: string) {
  return equalDigest(token, hash);
}
