// 守門：①每個 <script> 區塊語法可編譯 ②HTML on* 屬性引用的函式都有定義。
// 起因：兩度發生「區間手術把函式吃掉、HTML 還在引用」的靜默事故。
const fs = require("fs");
const h = fs.readFileSync("index.html", "utf8");
let ok = true;
[...h.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].forEach((m, i) => {
  if (!m[1].trim()) return;
  try { new Function(m[1]); } catch (e) { ok = false; console.log("script#" + i, e.message); }
});
const called = new Set(
  [...h.matchAll(/on(?:click|change|input)="\s*([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]));
const defined = new Set(
  [...h.matchAll(/(?:function\s+|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
const missing = [...called].filter(fn => !defined.has(fn));
if (missing.length) { ok = false; console.log("HTML 引用但沒定義的 handler:", missing); }
console.log(ok ? "檢查全過（" + called.size + " 個 handler）" : "有缺");
process.exit(ok ? 0 : 1);
