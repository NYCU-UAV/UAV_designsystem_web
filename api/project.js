/* GET  /api/project?slug=xxx        → 專案資訊＋版本清單（不含大 state）
   GET  /api/project?slug=xxx&v=3    → 第 3 版完整 state（載入/clone 用）
   POST /api/project?slug=xxx {state, author, note} → 另存新版本（num 自動遞增） */
const { begin, sendJson, readBody, writeAllowed } = require("./_db");

module.exports = async (req, res) => {
  try {
    const sql = await begin(req, res);
    if (!sql) return;
    const url = new URL(req.url, "http://x");
    const slug = url.searchParams.get("slug") || "";
    const [proj] = await sql`SELECT id, slug, name, owner, created_at
                             FROM projects WHERE slug = ${slug}`;
    if (!proj) { sendJson(res, 404, { ok: false, error: "not_found" }); return; }

    if (req.method === "GET") {
      const v = url.searchParams.get("v");
      if (v) {
        const [row] = await sql`SELECT num, author, note, state, created_at
                                FROM versions WHERE project_id = ${proj.id} AND num = ${+v}`;
        if (!row) { sendJson(res, 404, { ok: false, error: "version_not_found" }); return; }
        sendJson(res, 200, { ok: true, project: proj, version: row });
        return;
      }
      const versions = await sql`
        SELECT num, author, note, created_at,
               state->>'mtow'  AS mtow,  state->>'span' AS span,
               state->>'foil'  AS foil,  state->>'tailType' AS tail
        FROM versions WHERE project_id = ${proj.id} ORDER BY num DESC`;
      sendJson(res, 200, { ok: true, project: proj, versions });
      return;
    }

    if (req.method === "POST") {
      if (!writeAllowed(req)) { sendJson(res, 403, { ok: false, error: "bad_key" }); return; }
      const b = await readBody(req);
      if (!b.state) { sendJson(res, 400, { ok: false, error: "state_required" }); return; }
      const [row] = await sql`
        INSERT INTO versions (project_id, num, author, note, state)
        VALUES (${proj.id},
                COALESCE((SELECT max(num) FROM versions WHERE project_id = ${proj.id}), 0) + 1,
                ${b.author || ""}, ${b.note || ""}, ${JSON.stringify(b.state)})
        RETURNING num, created_at`;
      sendJson(res, 200, { ok: true, version: row });
      return;
    }

    if (req.method === "DELETE") {
      if (!writeAllowed(req)) { sendJson(res, 403, { ok: false, error: "bad_key" }); return; }
      await sql`DELETE FROM projects WHERE id = ${proj.id}`;   // versions 由 FK CASCADE 清
      sendJson(res, 200, { ok: true, deleted: proj.slug });
      return;
    }

    sendJson(res, 405, { ok: false, error: "method" });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e.message || e) });
  }
};
