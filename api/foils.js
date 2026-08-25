/* 翼型庫（資料庫版）——repo 的 foils.json / airfoils/ 是「內建庫」，
   這裡是「社團自建庫」：網頁上傳直接進 DB，不用再等 GitHub issue 機器人。
   GET  /api/foils            → 清單（JSON，欄位對齊 foils.json）
   GET  /api/foils?dat=x.dat  → 該翼型的 .dat 純文字（WingForge/精靈直接抓）
   POST /api/foils {name, dat_name, dat_text, clmax, cl_cruise, cls, uploader} */
const { begin, sendJson, readBody, writeAllowed } = require("./_db");

module.exports = async (req, res) => {
  try {
    const sql = await begin(req, res);
    if (!sql) return;
    const url = new URL(req.url, "http://x");

    if (req.method === "GET") {
      const dat = url.searchParams.get("dat");
      if (dat) {
        const [row] = await sql`SELECT dat_text FROM foils WHERE dat_name = ${dat}`;
        if (!row) { sendJson(res, 404, { ok: false, error: "not_found" }); return; }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "public, max-age=600");
        res.end(row.dat_text);
        return;
      }
      const rows = await sql`
        SELECT name, dat_name AS dat, clmax, cl_cruise AS "clCruise",
               cls, cat, uploader, created_at
        FROM foils ORDER BY name`;
      sendJson(res, 200, { ok: true,
        foils: rows.map(r => ({ ...r, cls: r.cls ? r.cls.split(",") : [] })) });
      return;
    }

    if (req.method === "POST") {
      if (!writeAllowed(req)) { sendJson(res, 403, { ok: false, error: "bad_key" }); return; }
      const b = await readBody(req);
      // 只給 airfoiltools 網址、沒給座標時：伺服器端代抓（瀏覽器抓不了
      // ——airfoiltools 無 HTTPS 也無 CORS；serverless 這端沒這些限制）
      if (!b.dat_text && b.url) {
        const m = /[?&]airfoil=([\w-]+)/.exec(b.url);
        if (m) {
          try {
            const r = await fetch(
              "http://airfoiltools.com/airfoil/seligdatfile?airfoil=" + m[1],
              { signal: AbortSignal.timeout(8000) });
            if (r.ok) b.dat_text = await r.text();
          } catch (e) { /* 抓不到就走下面的必填檢查回報 */ }
        }
      }
      if (!b.name || !b.dat_name || !b.dat_text) {
        sendJson(res, 400, { ok: false, error: "缺座標：請選 .dat 檔，或確認 airfoiltools 網址正確" }); return;
      }
      // 基本健檢：至少 20 列「兩個浮點數」才像座標檔（跟 WingForge 同標準）
      const nPts = (b.dat_text.match(/^\s*-?[\d.]+\s+-?[\d.]+\s*$/gm) || []).length;
      if (nPts < 20) { sendJson(res, 400, { ok: false, error: "不像翼型座標檔（座標列 <20）" }); return; }
      await sql`
        INSERT INTO foils (name, dat_name, dat_text, clmax, cl_cruise, cls, cat, uploader)
        VALUES (${b.name}, ${b.dat_name}, ${b.dat_text},
                ${b.clmax || null}, ${b.cl_cruise || null},
                ${(b.cls || []).join(",")}, ${b.cat || ""}, ${b.uploader || ""})
        ON CONFLICT (name) DO UPDATE SET
          dat_name = EXCLUDED.dat_name, dat_text = EXCLUDED.dat_text,
          clmax = EXCLUDED.clmax, cl_cruise = EXCLUDED.cl_cruise,
          cls = EXCLUDED.cls, cat = EXCLUDED.cat, uploader = EXCLUDED.uploader`;
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 405, { ok: false, error: "method" });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e.message || e) });
  }
};
