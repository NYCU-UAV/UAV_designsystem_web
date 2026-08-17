// 解析「[翼型] 」Issue 的內文，驗證後把翼型寫進 foils.json 與 airfoils/。
// 由 .github/workflows/new-airfoil.yml 呼叫；純 node 內建模組、無相依。
// 輸入：環境變數 ISSUE_BODY；輸出：exit 0=成功（stdout 給結果訊息），
// exit 1=驗證失敗（stdout 給要回覆到 Issue 的錯誤說明）。
"use strict";
const fs = require("fs");

function fail(msg) {
  console.log("❌ 自動處理失敗：" + msg +
    "\n\n請修改 Issue 內文後「Close 再 Reopen」重新觸發，或請幹部手動處理。");
  process.exit(1);
}

const body = process.env.ISSUE_BODY || "";

// 1. 抓 ```json ... ``` 區塊
const jm = body.match(/```json\s*\n([\s\S]*?)```/);
if (!jm) fail("找不到 ```json 區塊（metadata）。");
let meta;
try { meta = JSON.parse(jm[1]); }
catch (e) { fail("metadata JSON 解析失敗：" + e.message); }
if (!meta.name || typeof meta.name !== "string") fail("metadata 缺 name。");
meta.name = meta.name.trim();
const isNaca = /^NACA\s*\d{4}$/i.test(meta.name);
if (!isNaca && !meta.dat) {
  // 沒填檔名但有 airfoiltools 網址 → 由網址推出（oa206-il → oa206.dat）
  const m = (meta.url || "").match(/airfoil=([\w.-]+)/);
  if (m) meta.dat = m[1].replace(/-il$/, "") + ".dat";
}
if (!isNaca && !/^[\w.-]+\.dat$/i.test(meta.dat || ""))
  fail("非 NACA 四位數必須有合法的 dat 檔名（英數._- 結尾 .dat），"
     + "或提供 airfoiltools 網址讓機器人自動命名。");
if (isNaca) meta.dat = "";
for (const k of ["clmax", "clCruise"]) {
  if (typeof meta[k] !== "number" || meta[k] <= 0 || meta[k] > 3)
    fail(`metadata 的 ${k} 要是 0~3 之間的數字。`);
}

// 2. 座標來源：優先讀 ```dat 區塊；沒有就用 metadata.url 從 airfoiltools 抓
function datUrlFrom(url) {
  // 注意：airfoiltools 只提供 HTTP（443 埠直接拒絕連線，實測 ECONNREFUSED），
  // 一律用 http:// 否則 fetch 必失敗。
  if (!url || !/airfoiltools\.com/i.test(url)) return null;
  const m = url.match(/airfoil=([\w.-]+)/);
  return m ? "http://airfoiltools.com/airfoil/seligdatfile?airfoil=" + m[1] : null;
}
async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "wingforge-bot" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.text();
}

(async () => {
let datText = null;
if (!isNaca) {
  const dm = body.match(/```dat\s*\n([\s\S]*?)```/);
  const placeholder = dm && /把\s*\.dat\s*內容貼在這裡|paste/i.test(dm[1]);
  if (!dm || placeholder || !dm[1].trim()) {
    // 沒貼座標 → 試著從 airfoiltools 網址下載（伺服器端無 CORS 限制）
    const du = datUrlFrom(meta.url);
    if (!du) fail("找不到 ```dat 區塊（座標內容），metadata 也沒有可下載的 "
      + "airfoiltools 網址。請貼上 .dat 內容，或在 metadata 補 url 欄位。");
    try { datText = (await fetchText(du)).replace(/\r/g, "").trim() + "\n"; }
    catch (e) { fail(`從 ${du} 下載失敗：${e.message}`); }
    console.error("(bot) 由網址下載座標：" + du);
  } else {
    datText = dm[1].replace(/\r/g, "").trim() + "\n";
  }
  const lines = datText.split("\n").filter(s => s.trim());
  // Selig 格式：首行名稱（可有可無）＋每行兩個浮點數；至少 20 個座標點
  let coords = 0;
  for (const ln of lines) {
    const toks = ln.trim().split(/\s+/);
    if (toks.length >= 2 && toks.slice(0, 2).every(t => isFinite(parseFloat(t))))
      coords++;
  }
  if (coords < 20) fail(`dat 內容看起來不是翼型座標（只辨識出 ${coords} 個座標列，`
    + "應 ≥20）。請用記事本開 .dat 全選複製貼上。");
  if (datText.length > 200 * 1024) fail("dat 內容超過 200KB，不像翼型檔。");
}

// 3. 正名：xflr5 是用 .dat 檔頭第一行當翼型名稱且比對區分大小寫，
// 所以一律以檔頭為準（提交者填的名稱只當備援），確保精靈/xlsx/xflr5 三方一致。
let canonName = meta.name;
if (datText) {
  const head = datText.split("\n")[0].trim();
  const isCoordLine = head.split(/\s+/).length >= 2 &&
    head.split(/\s+/).slice(0, 2).every(t => isFinite(parseFloat(t)));
  if (head && !isCoordLine) canonName = head.slice(0, 60);
}

// 4. 併入 foils.json（重名擋下）
const foils = JSON.parse(fs.readFileSync("foils.json", "utf8"));
if (foils.some(f => f.name.toLowerCase() === canonName.toLowerCase()))
  fail(`翼型「${canonName}」已存在於 foils.json。`);
foils.push({
  name: canonName, dat: meta.dat, have: !isNaca && !!meta.dat,
  cls: Array.isArray(meta.cls) ? meta.cls : [],
  clmax: meta.clmax, clCruise: meta.clCruise,
  aoaStall: meta.aoaStall || null, aoaCruise: meta.aoaCruise || null,
  note: (meta.note || "由 Issue 自動提交") + "",
  url: meta.url || "",
});
fs.writeFileSync("foils.json", JSON.stringify(foils, null, 1) + "\n");

// 5. 寫 dat 檔
if (datText) {
  fs.mkdirSync("airfoils", { recursive: true });
  const p = "airfoils/" + meta.dat;
  if (fs.existsSync(p)) fail(`airfoils/${meta.dat} 已存在（換個檔名）。`);
  fs.writeFileSync(p, datText);
}

console.log(`✅ 翼型「${canonName}」已加入社團翼型庫！\n\n`
  + `- foils.json：已新增（精靈重新整理即可看到）\n`
  + (datText ? `- airfoils/${meta.dat}：已上傳（Fusion 匯入時會自動下載）\n` : "")
  + (canonName !== meta.name
     ? `\n📌 名稱已依 .dat 檔頭正名為 **${canonName}**（原填「${meta.name}」）——`
       + `xflr5 認的就是這個名稱，請在精靈重新整理後改用庫裡這一筆。\n` : "")
  + `\n感謝貢獻 🛩️`);
})();
