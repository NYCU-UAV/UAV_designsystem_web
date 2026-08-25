/* =====================================================================
   vlm.js — 渦格法（Vortex Lattice Method）求解器，跑在瀏覽器裡
   ---------------------------------------------------------------------
   為什麼要自己寫：flow5 是 441MB 的 Qt 桌面程式（85MB gmsh + 246MB Intel
   MKL + 38 個 Qt DLL），塞不進任何 serverless 平台（Vercel 函式解壓上限
   250MB），而全世界找不到現成可用的 JS/WASM 渦格法。自己寫一份跑在使用
   者的瀏覽器裡，網站就能維持純靜態——任何一台電腦打開網址就能分析，
   零伺服器、零帳單、零維護。

   方法：Katz & Plotkin《Low-Speed Aerodynamics》第 12 章的標準馬蹄渦格法。
   - 每面元一個馬蹄渦：束縛渦在面元 1/4 弦，尾渦沿機身 +x 拖到遠場
   - 控制點在面元 3/4 弦中央（經典 1/4-3/4 配置，自動滿足 Kutta 條件）
   - 翼型彎度用「薄翼面」方式進法向量：n = n0·cosε − ĉ·sinε，
     ε = atan(中弧線斜率)。這樣有彎度的翼型在 α=0 也會正確出升力
   - 尾渦固定沿 +x（不隨迎角轉）→ 影響係數矩陣與 α 無關 → LU 分解一次、
     81 個迎角各自只要一次回代。這是瀏覽器裡掃得完整條極曲線的關鍵
   - 力用 Kutta-Joukowski 近場法：F = ρ Γ (U_local × s)，含誘導阻力
   - 黏性阻力（可選）：條帶法平板摩擦 × 厚度形狀因子

   座標系（與 xflr5 / flow5 一致）：x 往後（順流）、y 往右、z 往上。
   幾何輸入單位 mm（跟填表精靈一致），內部一律換成 m。
   已知限制：線性理論——不含失速、不含機身、大迎角只是外插。
   ===================================================================== */
;(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.VLM = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEG = Math.PI / 180;

  /* ---------- 向量小工具（零相依） ---------- */
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]];
  }
  function norm(a) { return Math.sqrt(dot(a, a)); }
  function unit(a) { var n = norm(a); return n > 1e-12 ? mul(a, 1 / n) : [0, 0, 0]; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* =====================================================================
     翼型檔處理 —— 與 local/analysis_server.py 的 to_selig() 同一套邏輯
     ---------------------------------------------------------------------
     實測血訓：翼型庫混著 Selig 與 Lednicer 兩種格式。把 Lednicer 當
     Selig 讀不會報錯，而是安靜算出 CL=-2.7 之類的鬼數字。所以進求解器
     前一律正規化成 Selig order（後緣→上表面→前緣→下表面→後緣）。
     ===================================================================== */
  function parseDatSelig(text) {
    var pts = [];
    text.split(/\r?\n/).forEach(function (ln) {
      var tok = ln.trim().split(/\s+/);
      if (tok.length < 2) return;
      var x = parseFloat(tok[0]), y = parseFloat(tok[1]);
      if (!isFinite(x) || !isFinite(y)) return;
      if (x > 1.5) return;                    // 「61.0 61.0」計數列，不是座標
      pts.push([x, y]);
    });
    if (!pts.length) throw new Error("翼型檔裡找不到座標");
    if (pts[0][0] > 0.9) return pts;          // 已是 Selig（從後緣起頭）
    // Lednicer：前緣起頭、上下表面兩段。找「x 回頭」的分界點。
    var split = pts.length >> 1;
    for (var i = 1; i < pts.length; i++) {
      if (pts[i][0] < pts[i - 1][0]) { split = i; break; }
    }
    var upper = pts.slice(0, split), lower = pts.slice(split);
    var su = 0, sl = 0;
    upper.forEach(function (p) { su += p[1]; });
    lower.forEach(function (p) { sl += p[1]; });
    if (su < sl) { var t = upper; upper = lower; lower = t; }
    return upper.slice().reverse().concat(lower);
  }

  /* Selig 點列 → 中弧線斜率函數 + 最大厚度比。
     做法：在固定 x 站位上分別內插上、下表面，camber = 平均、thickness = 差。 */
  function foilCamber(seligPts) {
    // 以 x 最小的點切開上下表面（Selig：前段由後往前是上表面）
    var iLE = 0;
    for (var i = 1; i < seligPts.length; i++) {
      if (seligPts[i][0] < seligPts[iLE][0]) iLE = i;
    }
    var upper = seligPts.slice(0, iLE + 1).slice().reverse(); // LE→TE
    var lower = seligPts.slice(iLE);                          // LE→TE
    function interp(surf, x) {
      if (x <= surf[0][0]) return surf[0][1];
      for (var k = 1; k < surf.length; k++) {
        if (surf[k][0] >= x) {
          var a = surf[k - 1], b = surf[k];
          var t = (x - a[0]) / ((b[0] - a[0]) || 1e-12);
          return lerp(a[1], b[1], t);
        }
      }
      return surf[surf.length - 1][1];
    }
    var N = 60, xs = [], zc = [], tcMax = 0;
    for (var j = 0; j <= N; j++) {
      var x = 0.5 * (1 - Math.cos(Math.PI * j / N));  // 前緣密
      var zu = interp(upper, x), zl = interp(lower, x);
      xs.push(x); zc.push(0.5 * (zu + zl));
      if (zu - zl > tcMax) tcMax = zu - zl;
    }
    function zAt(x) {
      var j = 0;
      while (j < N && xs[j + 1] < x) j++;
      var j1 = Math.min(N, j + 1);
      var t = (x - xs[j]) / ((xs[j1] - xs[j]) || 1e-12);
      return lerp(zc[j], zc[Math.min(N, j + 1)], Math.max(0, Math.min(1, t)));
    }
    return {
      tc: tcMax,
      z: zAt,                                  // 中弧線高度 z_c(x)
      slope: function (x) {                    // dz_c/dx（中央差分）
        var j = 0;
        while (j < N && xs[j + 1] < x) j++;
        var j0 = Math.max(0, j - 1), j1 = Math.min(N, j + 1);
        return (zc[j1] - zc[j0]) / ((xs[j1] - xs[j0]) || 1e-12);
      },
    };
  }

  /* NACA 四位數的中弧線（解析式）。尾翼常用 NACA 00xx，不需要 dat 檔。 */
  function naca4Camber(code) {
    var m = parseInt(code[0], 10) / 100, p = parseInt(code[1], 10) / 10;
    var tt = parseInt(code.slice(2), 10) / 100;
    return {
      tc: tt,
      z: function (x) {
        if (m === 0 || p === 0) return 0;
        if (x < p) return m / (p * p) * (2 * p * x - x * x);
        return m / ((1 - p) * (1 - p)) * ((1 - 2 * p) + 2 * p * x - x * x);
      },
      slope: function (x) {
        if (m === 0 || p === 0) return 0;
        if (x < p) return 2 * m / (p * p) * (p - x);
        return 2 * m / ((1 - p) * (1 - p)) * (p - x);
      },
    };
  }

  var FLAT = { tc: 0.10, z: function () { return 0; },
             slope: function () { return 0; } };

  /* =====================================================================
     Biot-Savart：有限直線渦段（P1→P2、單位環量）在 P 的誘導速度
     Katz & Plotkin eq.(10.16)。CORE 閃掉控制點落在渦線上的奇異性。
     ===================================================================== */
  var CORE = 1e-10;
  function vortexSeg(p, p1, p2) {
    var r1 = sub(p, p1), r2 = sub(p, p2), r0 = sub(p2, p1);
    var c = cross(r1, r2);
    var cc = dot(c, c);
    if (cc < CORE) return [0, 0, 0];
    var n1 = norm(r1), n2 = norm(r2);
    if (n1 < 1e-9 || n2 < 1e-9) return [0, 0, 0];
    var k = (dot(r0, r1) / n1 - dot(r0, r2) / n2) / (4 * Math.PI * cc);
    return mul(c, k);
  }

  /* 馬蹄渦（遠場→a→b→遠場）的誘導速度；skipBound=true 時略過束縛段
     （近場受力計算時，面元不受自己束縛渦影響）。 */
  function horseshoe(p, a, b, far, skipBound) {
    var aFar = [a[0] + far, a[1], a[2]];
    var bFar = [b[0] + far, b[1], b[2]];
    var v = vortexSeg(p, aFar, a);
    if (!skipBound) v = add(v, vortexSeg(p, a, b));
    return add(v, vortexSeg(p, b, bFar));
  }

  /* =====================================================================
     幾何 → 面元
     geom = { wings: [{ name, type, position:[x,y,z]mm, symmetric,
                        sections:[{ y, chord, xOffset, dihedral, twist, foil }] }] }
     與 buildFlow5Xml 吃同一份描述 → 兩邊看到的飛機保證一模一樣。
     ===================================================================== */
  function cosineSpacing(n) {
    var out = [];
    for (var i = 0; i <= n; i++) out.push(0.5 * (1 - Math.cos(Math.PI * i / n)));
    return out;
  }

  function panelizeWing(wing, foilOf, opts, side, out) {
    var secs = wing.sections;
    var nc = opts.nChord, ns = opts.nSpanPerSegment;
    var vertical = wing.type === "FIN";
    var axisFrac = opts.twistAxis;
    var pos = wing.position;

    // 各剖面前緣三維座標。y 是「沿翼面」的展向距離（xflr5 慣例），
    // 有上反角時投影展長 = y·cosδ、z 隨段累積。
    var le = [], yAcc = 0, zAcc = 0;
    for (var s = 0; s < secs.length; s++) {
      if (s > 0) {
        var dy = secs[s].y - secs[s - 1].y;
        var dih = (secs[s - 1].dihedral || 0) * DEG;
        yAcc += dy * Math.cos(dih);
        zAcc += dy * Math.sin(dih);
      }
      var px = pos[0] + secs[s].xOffset;
      var py, pz;
      if (vertical) { py = pos[1]; pz = pos[2] + secs[s].y; }
      else { py = pos[1] + side * yAcc; pz = pos[2] + zAcc; }
      le.push([px, py, pz]);
    }

    var spanFrac = cosineSpacing(ns), chordFrac = cosineSpacing(nc);

    for (var seg = 0; seg < secs.length - 1; seg++) {
      var s0 = secs[seg], s1 = secs[seg + 1];
      var le0 = le[seg], le1 = le[seg + 1];
      var foil = foilOf(s0.foil);

      for (var j = 0; j < ns; j++) {
        var e0 = spanFrac[j], e1 = spanFrac[j + 1];
        var stripIdx = out.strips.length;

        // 條帶左右邊與中線：位置、弦長、扭轉後的弦方向
        var edge = [e0, e1, 0.5 * (e0 + e1)].map(function (e) {
          var c = lerp(s0.chord, s1.chord, e);
          var tw = (lerp(s0.twist || 0, s1.twist || 0, e)) * DEG;
          var p = [lerp(le0[0], le1[0], e), lerp(le0[1], le1[1], e), lerp(le0[2], le1[2], e)];
          // 扭轉繞「軸位置 axisFrac」的展向軸。正扭轉 = 抬頭 = 前緣上移。
          // 未扭轉弦向 = +x；扭轉後 cd = (cosθ, 0, -sinθ)（LE 高、TE 低）。
          var cd = vertical ? [Math.cos(tw), -Math.sin(tw), 0]
                            : [Math.cos(tw), 0, -Math.sin(tw)];
          // 前緣繞軸點旋轉：le' = le + x̂·(c·a) − cd·(c·a)
          var a = c * axisFrac;
          var leT = vertical
            ? [p[0] + a - cd[0] * a, p[1] - cd[1] * a, p[2]]
            : [p[0] + a - cd[0] * a, p[1], p[2] - cd[2] * a];
          return { le: leT, cd: cd, chord: c };
        });
        var eL = edge[0], eR = edge[1], eM = edge[2];

        var strip = { panels: [], chord: eM.chord, area: 0, foil: s0.foil,
                      tc: foil.tc, vertical: vertical, wing: wing.name, type: wing.type };

        for (var k = 0; k < nc; k++) {
          var f0 = chordFrac[k], f1 = chordFrac[k + 1];
          var fb = f0 + 0.25 * (f1 - f0);   // 束縛渦：面元 1/4 弦
          var fc = f0 + 0.75 * (f1 - f0);   // 控制點：面元 3/4 弦

          var a2 = add(eL.le, mul(eL.cd, eL.chord * fb));
          var b2 = add(eR.le, mul(eR.cd, eR.chord * fb));
          var cp = add(eM.le, mul(eM.cd, eM.chord * fc));

          var spanV = sub(b2, a2);
          var cHat = unit(eM.cd);
          var n0 = unit(cross(eM.cd, spanV));
          if (!vertical && side < 0) n0 = mul(n0, -1);   // 左半翼翻回朝上
          // 渦格鋪在中弧面上（不是弦線上）：沿 n0 抬 z_c(x)·c
          a2 = add(a2, mul(n0, foil.z(fb) * eL.chord));
          b2 = add(b2, mul(n0, foil.z(fb) * eR.chord));
          cp = add(cp, mul(n0, foil.z(fc) * eM.chord));
          // 彎度：法向量往前傾 ε = atan(dz_c/dx)
          var eps = Math.atan(foil.slope(fc));
          var n = unit(sub(mul(n0, Math.cos(eps)), mul(cHat, Math.sin(eps))));

          var p00 = add(eL.le, mul(eL.cd, eL.chord * f0));
          var p01 = add(eL.le, mul(eL.cd, eL.chord * f1));
          var p10 = add(eR.le, mul(eR.cd, eR.chord * f0));
          var p11 = add(eR.le, mul(eR.cd, eR.chord * f1));
          var area = 0.5 * (norm(cross(sub(p10, p00), sub(p01, p00))) +
                            norm(cross(sub(p01, p11), sub(p10, p11))));

          out.panels.push({ a: a2, b: b2, cp: cp, n: n, area: area,
                            mid: mul(add(a2, b2), 0.5), s: sub(b2, a2),
                            strip: stripIdx, type: wing.type });
          strip.panels.push(out.panels.length - 1);
          strip.area += area;
        }
        out.strips.push(strip);
      }
    }
  }

  function panelize(geom, foilOf, options) {
    var opts = Object.assign({ nChord: 8, nSpanPerSegment: 14, twistAxis: 0.25 },
                             options || {});
    var out = { panels: [], strips: [] };
    geom.wings.forEach(function (w) {
      var wm = {                                   // mm → m
        name: w.name, type: w.type, position: mul(w.position, 0.001),
        sections: w.sections.map(function (s) {
          return { y: s.y * 0.001, chord: s.chord * 0.001,
                   xOffset: s.xOffset * 0.001,
                   dihedral: s.dihedral || 0, twist: s.twist || 0, foil: s.foil };
        }),
      };
      if (w.type === "FIN") panelizeWing(wm, foilOf, opts, +1, out);
      else { panelizeWing(wm, foilOf, opts, +1, out);
             panelizeWing(wm, foilOf, opts, -1, out); }
    });
    return out;
  }

  /* 參考量（與 flow5 的 PROJECTED 慣例一致）：主翼投影面積/展長/MAC。 */
  function referenceDims(geom) {
    var S = 0, b = 0, macNum = 0, macDen = 0;
    geom.wings.forEach(function (w) {
      if (w.type !== "MAINWING") return;
      var yAcc = 0;
      for (var i = 0; i < w.sections.length - 1; i++) {
        var s0 = w.sections[i], s1 = w.sections[i + 1];
        var dy = (s1.y - s0.y) * Math.cos((s0.dihedral || 0) * DEG) * 0.001;
        var c0 = s0.chord * 0.001, c1 = s1.chord * 0.001;
        S += (c0 + c1) / 2 * dy * 2;               // ×2：左右對稱
        yAcc += dy;
        // 梯形段的 ∫c²dy 與 ∫c dy（線性弦長變化的解析積分）
        macNum += dy * (c0 * c0 + c0 * c1 + c1 * c1) / 3 * 2;
        macDen += dy * (c0 + c1) / 2 * 2;
      }
      b = Math.max(b, yAcc * 2);
    });
    return { S: S, b: b, mac: macDen > 0 ? macNum / macDen : 0 };
  }

  /* =====================================================================
     線性代數：LU（部分軸選）。A 與迎角無關 → 分解一次、每個 α 回代一次。
     ===================================================================== */
  function luDecompose(A, n) {
    var piv = new Int32Array(n), i, j, k;
    for (i = 0; i < n; i++) piv[i] = i;
    for (k = 0; k < n; k++) {
      var maxV = 0, maxR = k;
      for (i = k; i < n; i++) {
        var v = Math.abs(A[i][k]);
        if (v > maxV) { maxV = v; maxR = i; }
      }
      if (maxV < 1e-13) throw new Error("影響係數矩陣奇異（面元幾何有問題）");
      if (maxR !== k) {
        var t = A[k]; A[k] = A[maxR]; A[maxR] = t;
        var ti = piv[k]; piv[k] = piv[maxR]; piv[maxR] = ti;
      }
      var Akk = A[k][k];
      for (i = k + 1; i < n; i++) {
        var f = A[i][k] / Akk;
        A[i][k] = f;
        if (f !== 0) {
          var Ai = A[i], Ak = A[k];
          for (j = k + 1; j < n; j++) Ai[j] -= f * Ak[j];
        }
      }
    }
    return { A: A, piv: piv, n: n };
  }

  function luSolve(lu, rhs) {
    var n = lu.n, A = lu.A, piv = lu.piv, i, j;
    var x = new Float64Array(n);
    for (i = 0; i < n; i++) x[i] = rhs[piv[i]];
    for (i = 1; i < n; i++) {
      var s = x[i], Ai = A[i];
      for (j = 0; j < i; j++) s -= Ai[j] * x[j];
      x[i] = s;
    }
    for (i = n - 1; i >= 0; i--) {
      var s2 = x[i], Ai2 = A[i];
      for (j = i + 1; j < n; j++) s2 -= Ai2[j] * x[j];
      x[i] = s2 / Ai2[i];
    }
    return x;
  }

  /* =====================================================================
     模型建構：幾何+矩陣+LU 全部準備好，之後任何攻角都能便宜地解
     （四張圖掃 81 個攻角、流場動畫拖滑桿，都是同一個 model 重複用）
     ===================================================================== */
  function buildModel(params) {
    var geom = params.geom;
    var foilDb = params.foils || {};
    var V = params.velocity || 12;
    var rho = params.rho || 1.225, nu = params.nu || 1.46e-5;

    var camberCache = {}, missing = [];
    function foilOf(name) {
      if (camberCache[name]) return camberCache[name];
      var r;
      if (foilDb[name]) r = foilCamber(parseDatSelig(foilDb[name]));
      else {
        var m = /naca\s*(\d{4})\b/i.exec(name || "");
        if (m) r = naca4Camber(m[1]);
        else { r = FLAT; missing.push(name); }
      }
      camberCache[name] = r;
      return r;
    }

    var mesh = panelize(geom, foilOf, params.mesh);
    var P = mesh.panels, N = P.length;
    var ref = referenceDims(geom);
    var far = Math.max(ref.b, 1) * 100;

    var A = new Array(N), Wx = new Array(N), Wy = new Array(N), Wz = new Array(N);
    for (var i = 0; i < N; i++) {
      A[i] = new Float64Array(N);
      Wx[i] = new Float64Array(N); Wy[i] = new Float64Array(N); Wz[i] = new Float64Array(N);
      var cp = P[i].cp, n = P[i].n, mid = P[i].mid;
      for (var j = 0; j < N; j++) {
        var v = horseshoe(cp, P[j].a, P[j].b, far, false);
        A[i][j] = dot(v, n);
        var w = horseshoe(mid, P[j].a, P[j].b, far, i === j);
        Wx[i][j] = w[0]; Wy[i][j] = w[1]; Wz[i][j] = w[2];
      }
    }
    var lu = luDecompose(A, N);

    var CDv = 0;
    if (params.viscous !== false) {
      mesh.strips.forEach(function (st) {
        var Re = V * st.chord / nu;
        var Cf = Re < 3.5e5 ? 1.328 / Math.sqrt(Re) : 0.074 / Math.pow(Re, 0.2);
        var FF = 1 + 2.7 * st.tc + 100 * Math.pow(st.tc, 4);
        CDv += 2 * Cf * FF * st.area / ref.S;
      });
    }

    // 對稱面 y=0 的機身側影（畫流場圖用）：各翼根弦的中弧線
    var profile = [];
    geom.wings.forEach(function (w) {
      var s0 = w.sections[0];
      var foil = foilOf(s0.foil);
      var c = s0.chord * 0.001, tw = (s0.twist || 0) * DEG;
      var x0 = (w.position[0] + s0.xOffset) * 0.001, z0 = w.position[2] * 0.001;
      var pts = [];
      if (w.type === "FIN") {
        var sTip = w.sections[w.sections.length - 1];
        var h = sTip.y * 0.001, cT = sTip.chord * 0.001;
        var xT = x0 + sTip.xOffset * 0.001;
        pts = [[x0, z0], [x0 + c, z0], [xT + cT, z0 + h], [xT, z0 + h], [x0, z0]];
      } else {
        for (var k = 0; k <= 24; k++) {
          var f = k / 24;
          var xr = f * Math.cos(tw) + foil.z(f) * Math.sin(tw);
          var zr = -f * Math.sin(tw) + foil.z(f) * Math.cos(tw);
          pts.push([x0 + xr * c, z0 + zr * c]);
        }
      }
      profile.push({ name: w.name, fin: w.type === "FIN", pts: pts });
    });

    return { P: P, N: N, strips: mesh.strips, lu: lu, Wx: Wx, Wy: Wy, Wz: Wz,
             ref: ref, far: far, CDv: CDv, V: V, rho: rho,
             xcg: params.xcgM || 0, missing: missing, profile: profile };
  }

  /* 解單一攻角：一次 LU 回代 + Kutta-Joukowski 積分 */
  function solveAlpha(M, alpha) {
    var N = M.N, P = M.P, V = M.V;
    var ca = Math.cos(alpha * DEG), sa = Math.sin(alpha * DEG);
    var Vinf = [V * ca, 0, V * sa];
    var liftDir = [-sa, 0, ca], dragDir = [ca, 0, sa];

    var rhs = new Float64Array(N);
    for (var r = 0; r < N; r++) rhs[r] = -dot(Vinf, P[r].n);
    var G = luSolve(M.lu, rhs);

    var q = 0.5 * M.rho * V * V, S = M.ref.S, mac = M.ref.mac;
    var L = 0, Di = 0, My = 0;
    for (var p = 0; p < N; p++) {
      var wl = [0, 0, 0], Wxp = M.Wx[p], Wyp = M.Wy[p], Wzp = M.Wz[p];
      for (var j = 0; j < N; j++) {
        wl[0] += Wxp[j] * G[j]; wl[1] += Wyp[j] * G[j]; wl[2] += Wzp[j] * G[j];
      }
      var U = add(Vinf, wl);
      var F = mul(cross(U, P[p].s), M.rho * G[p]);
      L += dot(F, liftDir);
      Di += dot(F, dragDir);
      var rel = sub(P[p].mid, [M.xcg, 0, 0]);
      My += rel[2] * F[0] - rel[0] * F[2];
    }
    var CL = L / (q * S), CDi = Di / (q * S), Cm = My / (q * S * mac);
    var CD = CDi + M.CDv;
    return { alpha: alpha, CL: CL, CD: CD, CDi: CDi, Cm: Cm,
             CLCD: Math.abs(CD) > 1e-9 ? CL / CD : 0, G: G, Vinf: Vinf };
  }

  /* 全流場任一點的速度（自由流 + 所有馬蹄渦的誘導） */
  function velocityAt(M, G, Vinf, pt) {
    var v = [Vinf[0], Vinf[1], Vinf[2]];
    for (var j = 0; j < M.N; j++) {
      var w = horseshoe(pt, M.P[j].a, M.P[j].b, M.far, false);
      v = add(v, mul(w, G[j]));
    }
    return v;
  }

  /* =====================================================================
     流線：在對稱面 y=0 從上游撒種子點，沿速度場 RK2 積分。
     這是「上面同一組渦格解」的直接視覺化——翼前上洗、翼後下洗、
     尾翼吃到的下洗角，全部是算出來的，不是畫的。
     ===================================================================== */
  function streamlines(M, alpha, opts) {
    var o = opts || {};
    var pt = solveAlpha(M, alpha);
    var G = pt.G, Vinf = pt.Vinf;

    // 幾何包絡（m）
    var xmin = 1e9, xmax = -1e9, zmin = 1e9, zmax = -1e9;
    M.profile.forEach(function (pr) {
      pr.pts.forEach(function (p) {
        if (p[0] < xmin) xmin = p[0]; if (p[0] > xmax) xmax = p[0];
        if (p[1] < zmin) zmin = p[1]; if (p[1] > zmax) zmax = p[1];
      });
    });
    var L = Math.max(xmax - xmin, 0.2);
    var nL = o.nLines || 13;
    var x0 = xmin - 0.35 * L, x1 = xmax + 0.4 * L;
    var zLo = zmin - 0.3 * L, zHi = zmax + 0.35 * L;
    var ds = L / (o.stepsPerChord || 110);
    var lines = [];
    for (var s = 0; s < nL; s++) {
      var z = zLo + (zHi - zLo) * s / (nL - 1);
      var p = [x0, 0, z], line = [[p[0], p[2]]];
      for (var st = 0; st < 500 && p[0] < x1; st++) {
        var v1 = velocityAt(M, G, Vinf, p);
        var sp1 = norm(v1); if (sp1 < 1e-6) break;
        var mid = add(p, mul(v1, ds / sp1 * 0.5));
        var v2 = velocityAt(M, G, Vinf, mid);
        var sp2 = norm(v2); if (sp2 < 1e-6) break;
        p = add(p, mul(v2, ds / sp2));
        line.push([p[0], p[2]]);
      }
      lines.push(line);
    }
    return { lines: lines, point: { alpha: pt.alpha, CL: pt.CL, Cm: pt.Cm, CLCD: pt.CLCD },
             box: { x0: x0, x1: x1, z0: zLo, z1: zHi } };
  }

  /* =====================================================================
     主流程：solve() —— 掃迎角、產四張圖的資料與判讀
     ===================================================================== */
  function solve(params) {
    var M = params.model || buildModel(params);
    var a0 = params.alphaMin !== undefined ? params.alphaMin : -20;
    var a1 = params.alphaMax !== undefined ? params.alphaMax : 20;
    var da = params.alphaStep || 0.5;

    var pts = [];
    var nA = Math.round((a1 - a0) / da);
    for (var ia = 0; ia <= nA; ia++) {
      var r = solveAlpha(M, a0 + ia * da);
      pts.push({ alpha: r.alpha, CL: r.CL, CD: r.CD, CDi: r.CDi, Cm: r.Cm, CLCD: r.CLCD });
    }

    // 判讀（與 analysis_server.py 的 build_charts 同一套邏輯）
    var a = pts.map(function (p) { return p.alpha; });
    var cl = pts.map(function (p) { return p.CL; });
    var cm = pts.map(function (p) { return p.Cm; });
    var ld = pts.map(function (p) { return p.CLCD; });
    var slope = cl[cl.length - 1] !== cl[0]
      ? (cm[cm.length - 1] - cm[0]) / (cl[cl.length - 1] - cl[0]) : 0;
    var zi = 0;
    for (var z2 = 1; z2 < a.length; z2++) if (Math.abs(a[z2]) < Math.abs(a[zi])) zi = z2;
    var trim = null;
    for (var t2 = 0; t2 < a.length - 1; t2++) {
      if (cm[t2] * cm[t2 + 1] < 0) {
        trim = a[t2] + (a[t2 + 1] - a[t2]) * cm[t2] / (cm[t2] - cm[t2 + 1]);
        break;
      }
    }
    var bi = 0;
    for (var b2 = 1; b2 < ld.length; b2++) if (ld[b2] > ld[bi]) bi = b2;

    var xnp = M.xcg - slope * M.ref.mac;
    return {
      points: pts,
      verdict: {
        cm_cl_slope: slope, stable: slope < 0,
        cl_at_zero: cl[zi], flies: cl[zi] > 0,
        trim_alpha: trim,
        best_ld: ld[bi], best_ld_alpha: a[bi],
        trim_vs_best: trim === null ? null : Math.abs(trim - a[bi]),
      },
      summary: {
        xnp_m: xnp,
        static_margin: M.ref.mac > 0 ? (xnp - M.xcg) / M.ref.mac * 100 : 0,
        S: M.ref.S, b: M.ref.b, mac: M.ref.mac,
        cd_viscous: M.CDv, n_panels: M.N,
        method: "VLM-JS" + (params.viscous !== false ? "+平板摩擦" : "（無黏）"),
        missing_foils: M.missing,
      },
    };
  }

  return {
    solve: solve,
    buildModel: buildModel,
    solveAlpha: solveAlpha,
    streamlines: streamlines,
    panelize: panelize,
    referenceDims: referenceDims,
    parseDatSelig: parseDatSelig,
    foilCamber: foilCamber,
    naca4Camber: naca4Camber,
    _internals: { vortexSeg: vortexSeg, horseshoe: horseshoe,
                  luDecompose: luDecompose, luSolve: luSolve },
  };
});
