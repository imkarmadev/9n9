import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const database = new Database(process.env.N9N_DATABASE_PATH ?? "/data/9n9.db");
const user = database.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").get();
if (!user) throw new Error("Create the 9n9 admin before creating a test session");

const token = randomBytes(32).toString("base64url");
const csrf = randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const now = new Date();
const expires = new Date(now.getTime() + 15 * 60_000);

database.prepare("DELETE FROM sessions WHERE user_agent = ?").run("9n9-deploy-test");
database.prepare(
  `INSERT INTO sessions
    (id, user_id, token_hash, csrf_hash, csrf_token, created_at, expires_at, user_agent, ip)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  randomUUID(),
  user.id,
  digest(token),
  digest(csrf),
  csrf,
  now.toISOString(),
  expires.toISOString(),
  "9n9-deploy-test",
  "127.0.0.1",
);

process.stdout.write(`${token}\n${csrf}\n`);
