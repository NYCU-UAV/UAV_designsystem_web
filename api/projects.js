/* GET  /api/projects            → 專案列表（含最新版摘要）
   POST /api/projects {name, owner[, state, note]}
        → 建立專案；有帶 state 就順手存成 v1（「創立專案」一鍵完成） */
const { begin, sendJson, readBody, writeAllowed, slugify } = require("./_db");

module.exports = async (req, res) => {
  try {
    const sql = await begin(req, res);
    if (!sql) return;

    if (req.method === "GET") {
      const rows = await sql`
        SELECT p.slug, p.name, p.owner, p.created_at,
               max(v.num)        AS latest,
               count(v.id)::int  AS n_versions,
               max(v.created_at) AS updated_at
        FROM projects p LEFT JOIN versions v ON v.project_id = p.id
        GROUP BY p.id ORDER BY max(v.created_at) DESC NULLS LAST`;
      sendJson(res, 200, { ok: true, projects: rows });
      return;
    }

    if (req.method === "POST") {
      if (!writeAllowed(req)) { sendJson(res, 403, { ok: false, error: "bad_key" }); return; }
      const b = await readBody(req);
      if (!b.name) { sendJson(res, 400, { ok: false, error: "name_required" }); return; }
      const slug = slugify(b.name);
      const dup = await sql`SELECT 1 FROM projects WHERE slug = ${slug}`;
      if (dup.length) { sendJson(res, 409, { ok: false, error: "slug_taken", slug }); return; }
      const [proj] = await sql`
        INSERT INTO projects (slug, name, owner)
        VALUES (${slug}, ${b.name}, ${b.owner || ""})
        RETURNING id, slug, name, owner`;
      let version = null;
      if (b.state) {
        const [v] = await sql`
          INSERT INTO versions (project_id, num, author, note, state)
          VALUES (${proj.id}, 1, ${b.owner || ""}, ${b.note || "初版"}, ${JSON.stringify(b.state)})
          RETURNING num, created_at`;
        version = v;
      }
      sendJson(res, 200, { ok: true, project: proj, version });
      return;
    }

    sendJson(res, 405, { ok: false, error: "method" });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e.message || e) });
  }
};
