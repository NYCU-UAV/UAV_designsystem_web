/* 共用 DB 層：Neon serverless Postgres（Vercel Storage → Neon 一鍵建立）。
   沒設 DATABASE_URL 時回傳 null，讓各端點回「還沒接資料庫」的可讀訊息，
   而不是 500 冷錯誤——前端據此顯示設定教學。 */
const { neon } = require("@neondatabase/serverless");

let _sql = null;
let _ready = false;

function getSql() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) return null;
  if (!_sql) _sql = neon(url);
  return _sql;
}

/* 首次呼叫時自動建表——社團沒有 DBA，schema 就讓程式自己顧。 */
async function ensureSchema(sql) {
  if (_ready) return;
  await sql`CREATE TABLE IF NOT EXISTS projects (
    id serial PRIMARY KEY,
    slug text UNIQUE NOT NULL,
    name text NOT NULL,
    owner text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS versions (
    id serial PRIMARY KEY,
    project_id int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    num int NOT NULL,
    author text NOT NULL DEFAULT '',
    note text NOT NULL DEFAULT '',
    state jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(project_id, num)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS foils (
    id serial PRIMARY KEY,
    name text UNIQUE NOT NULL,
    dat_name text NOT NULL,
    dat_text text NOT NULL,
    clmax real,
    cl_cruise real,
    cls text NOT NULL DEFAULT '',
    cat text NOT NULL DEFAULT '',
    uploader text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`ALTER TABLE foils ADD COLUMN IF NOT EXISTS cat text NOT NULL DEFAULT ''`;
  _ready = true;
}

function sendJson(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Club-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.end(JSON.stringify(obj));
}

/* 寫入保護（選用）：Vercel 環境變數設了 CLUB_KEY 的話，POST 要帶
   X-Club-Key。沒設就全開放（社團內部用；要鎖再設）。 */
function writeAllowed(req) {
  const key = process.env.CLUB_KEY;
  if (!key) return true;
  return (req.headers["x-club-key"] || "") === key;
}

/* 每個端點開頭都要做的三件事：CORS 預檢、DB 存在檢查、schema 準備 */
async function begin(req, res) {
  if (req.method === "OPTIONS") { sendJson(res, 204, {}); return null; }
  const sql = getSql();
  if (!sql) {
    sendJson(res, 503, { ok: false, error: "no_database",
      hint: "還沒接資料庫：到 Vercel 專案 → Storage → Create Database → Neon，" +
            "建立後環境變數會自動注入，重新 Deploy 即生效。" });
    return null;
  }
  await ensureSchema(sql);
  return sql;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
}

function slugify(name) {
  const s = String(name).trim().toLowerCase()
    .replace(/[^\w一-鿿-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return s || ("proj-" + Date.now().toString(36));
}

module.exports = { begin, sendJson, readBody, writeAllowed, slugify };
