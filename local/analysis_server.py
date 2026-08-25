"""分析伺服器：讓精靈網頁按一下「分析」就跑完 flow5、直接畫出四張圖。

為什麼需要它：瀏覽器碰不到 flow5.exe（它是本機執行檔，不是網路服務——
flow5 的「API」是 C++ 函式庫，作者沒有提供雲端服務）。這支小程式負責
（a）供應精靈網頁本身，（b）提供 /api/analyze：收到設計參數後產生 flow5
需要的三個 XML 與翼型 .dat、無人值守跑完 flow5、解析 CSV，把四張圖的資料
與 XNP 回傳給網頁。

兩種部署模式，同一份程式：
  * 本機模式（預設）：學生自己下載 flow5，跑這支程式，開 127.0.0.1
  * 社團共用模式：只有一台機器裝 flow5 並跑
        python analysis_server.py --host 0.0.0.0
    其他人開 http://<那台的IP>:8765 即可，什麼都不用下載。

只用 Python 標準庫，不必 pip install。
"""
import argparse
import http.server
import json
import math
import os
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import urllib.request
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES = os.path.join(ROOT, "flow5-templates")
AIRFOIL_DIR = os.path.join(ROOT, "airfoils")

# 翼型下載鏈，與 Fusion 匯入器同一套（血訓見 wingforge/fusion/plane_import.py）：
# jsDelivr 不限流、commit 後數分鐘更新；raw 會 429 擋整台 IP；
# GitHub Pages 對機器人的 commit 永遠不更新。
FOIL_SOURCES = (
    "https://cdn.jsdelivr.net/gh/NYCU-UAV/UAV_designsystem_web@main/airfoils/",
    "https://raw.githubusercontent.com/NYCU-UAV/UAV_designsystem_web/main/airfoils/",
)


def find_flow5():
    """找 flow5.exe。順序：環境變數 FLOW5_EXE → 專案內 flow5/ → Downloads 底下。"""
    env = os.environ.get("FLOW5_EXE")
    if env and os.path.isfile(env):
        return env
    home = os.path.expanduser("~")
    for p in (os.path.join(ROOT, "flow5", "flow5.exe"),
              os.path.join(ROOT, "flow5", "flow5")):
        if os.path.isfile(p):
            return p
    dl = os.path.join(home, "Downloads")
    if os.path.isdir(dl):
        for name in sorted(os.listdir(dl)):
            if name.lower().startswith("flow5"):
                for base, _dirs, files in os.walk(os.path.join(dl, name)):
                    for exe in ("flow5.exe", "flow5"):
                        if exe in files:
                            return os.path.join(base, exe)
    return None


def naca4_dat(code, n_side=80):
    """NACA 四位數翼型座標（Selig order）。

    尾翼常用 NACA 00xx 而沒有現成 .dat，直接算出來，省得使用者去下載。
    """
    m, p, tt = int(code[0]) / 100.0, int(code[1]) / 10.0, int(code[2:]) / 100.0

    def camber(x):
        if p == 0 or m == 0:
            return 0.0, 0.0
        if x < p:
            return m / p ** 2 * (2 * p * x - x * x), 2 * m / p ** 2 * (p - x)
        return (m / (1 - p) ** 2 * ((1 - 2 * p) + 2 * p * x - x * x),
                2 * m / (1 - p) ** 2 * (p - x))

    def half(x):
        return 5 * tt * (0.2969 * math.sqrt(x) - 0.1260 * x - 0.3516 * x * x
                         + 0.2843 * x ** 3 - 0.1036 * x ** 4)   # 閉式後緣

    xs = [0.5 * (1 - math.cos(math.pi * i / (n_side - 1))) for i in range(n_side)]
    up, lo = [], []
    for x in xs:
        yc, dy = camber(x)
        th = math.atan(dy)
        yt = half(x)
        up.append((x - yt * math.sin(th), yc + yt * math.cos(th)))
        lo.append((x + yt * math.sin(th), yc - yt * math.cos(th)))
    pts = list(reversed(up)) + lo[1:]        # TE -> 上 -> LE -> 下 -> TE
    return "".join("  %.6f  %.6f\n" % (x, y) for x, y in pts)


def _isnum(s):
    try:
        float(s)
        return True
    except ValueError:
        return False


def to_selig(raw_lines):
    """把翼型座標正規化成 Selig order（TE -> 上表面 -> LE -> 下表面 -> TE）。

    實測血訓：翼型庫裡混著兩種格式，flow5/xflr5 都**只認 Selig**。把
    Lednicer 當 Selig 讀不會報錯，而是安靜產生亂掉的剖面——症狀是 α=0 時
    CL 變成 -2.7 這種離譜值（正常 Clark Y 約 +0.4）、CD 放大二十倍，四張圖
    全錯但程式一路綠燈。所以務必在餵給 flow5 前正規化。

    判別：Selig 從後緣 (1,0) 起頭；Lednicer 從前緣 (0,0) 起頭，且常有一行
    「61.0 61.0」之類的「上下表面各幾點」計數列（x 遠大於 1，直接濾掉）。
    """
    pts = []
    for ln in raw_lines:
        tok = ln.split()
        if len(tok) < 2 or not (_isnum(tok[0]) and _isnum(tok[1])):
            continue
        x, y = float(tok[0]), float(tok[1])
        if x > 1.5:          # 計數列，不是座標
            continue
        pts.append((x, y))
    if not pts:
        raise RuntimeError("翼型檔裡找不到座標")
    if pts[0][0] > 0.9:
        return pts                                   # 已是 Selig
    split = len(pts) // 2
    for i in range(1, len(pts)):
        if pts[i][0] < pts[i - 1][0]:                # x 回頭 = 第二段開始
            split = i
            break
    upper, lower = pts[:split], pts[split:]
    if sum(y for _x, y in upper) < sum(y for _x, y in lower):
        upper, lower = lower, upper                  # 確保 upper 真的在上面
    return list(reversed(upper)) + lower



def ensure_foil(name, dat_name, xml_dir):
    """確保 xml_dir 內有這個翼型的 .dat，且檔頭第一行等於 name。

    flow5 與 xflr5 都以 .dat 檔頭第一行當翼型名稱，並與 plane.xml 的
    Left/Right_Side_FoilName 逐字比對（區分大小寫）——對不上就整台飛機被
    丟棄（實測訊息：foils not found ...discarding this plane）。所以這裡
    一律把檔頭改寫成 plane.xml 用的名稱，從根本杜絕不一致。
    """
    text = None
    m = re.match(r"NACA\s*(\d{4})$", name.strip(), re.I)
    if m:
        text = naca4_dat(m.group(1))
    elif dat_name:
        local = os.path.join(AIRFOIL_DIR, dat_name)
        if os.path.isfile(local):
            text = open(local, encoding="utf-8", errors="replace").read()
        else:
            for base in FOIL_SOURCES:
                try:
                    req = urllib.request.Request(
                        base + dat_name, headers={"User-Agent": "wingforge"})
                    got = urllib.request.urlopen(req, timeout=10).read()
                    got = got.decode("utf-8", "replace")
                    if "<html" not in got[:200].lower():
                        text = got
                        break
                except Exception:
                    continue
    if text is None:
        raise RuntimeError(
            "找不到翼型「%s」的座標檔%s——請先用精靈的「一鍵上傳」把它加進"
            "社團翼型庫。" % (name, "（%s）" % dat_name if dat_name else ""))

    pts = to_selig(text.splitlines())
    fname = dat_name or (re.sub(r"[^\w.-]", "_", name) + ".dat")
    with open(os.path.join(xml_dir, fname), "w", encoding="utf-8") as fh:
        fh.write(name + chr(10))
        for x, y in pts:
            fh.write("  %.6f  %.6f" % (x, y) + chr(10))
    return fname


def fill(path, mapping):
    t = open(path, encoding="utf-8").read()
    for k, v in mapping.items():
        t = t.replace("{{%s}}" % k, str(v))
    return t


# 資料欄位在列中的索引（依 flow5 v7.57 的表頭順序）
COL = {"alpha": 1, "CL": 4, "CD": 5, "Cm": 9, "CLCD": 16}


def parse_csv(path):
    """flow5 的 analysis.csv -> (檔頭摘要, 資料列)。

    兩個實測踩雷：①資料是空白分隔（副檔名雖是 .csv）；②**第一列資料就接
    在表頭那一行的尾端**，不是獨立一行——只讀後續行會漏掉第一個 α。
    """
    raw = open(path, encoding="utf-8", errors="replace").read()
    lines = raw.splitlines()
    hi = next((i for i, l in enumerate(lines) if "α (°)" in l), None)
    if hi is None:
        raise RuntimeError("CSV 沒有預期的表頭（分析可能沒產生資料）")
    m = re.search(r"CoG_z \(m\)\s*", lines[hi])
    rows = []
    if m:
        tail = lines[hi][m.end():]
        if tail.strip():
            rows.append(tail.split())
    for l in lines[hi + 1:]:
        if l.strip():
            rows.append(l.split())
    summary = {}
    for key, pat in (("xnp_m", r"XNP\s*=[^=]*=\s*([-\d.eE+]+)\s*m"),
                     ("static_margin", r"Static margin\s*=\s*([-\d.eE+]+)"),
                     ("n_points", r"Nbr\. of data points\s*=\s*(\d+)")):
        mm = re.search(pat, raw)
        if mm:
            summary[key] = float(mm.group(1))
    return summary, rows


def build_charts(rows):
    """資料列 -> 四張圖的點與判讀（判讀邏輯與精靈第 8 步的教學一致）。"""
    pts = []
    for r in rows:
        try:
            pts.append({k: float(r[i]) for k, i in COL.items()})
        except (ValueError, IndexError):
            continue
    if not pts:
        raise RuntimeError("解析不到任何資料點")
    pts.sort(key=lambda p: p["alpha"])
    a = [p["alpha"] for p in pts]
    cl = [p["CL"] for p in pts]
    cm = [p["Cm"] for p in pts]
    ld = [p["CLCD"] for p in pts]

    slope = (cm[-1] - cm[0]) / (cl[-1] - cl[0]) if cl[-1] != cl[0] else 0.0
    zi = min(range(len(a)), key=lambda i: abs(a[i]))
    trim = None
    for i in range(len(a) - 1):
        if cm[i] * cm[i + 1] < 0:
            f = cm[i] / (cm[i] - cm[i + 1])
            trim = a[i] + (a[i + 1] - a[i]) * f
            break
    bi = max(range(len(ld)), key=lambda i: ld[i])
    return {
        "points": pts,
        "verdict": {
            "cm_cl_slope": slope,
            "stable": slope < 0,
            "cl_at_zero": cl[zi],
            "flies": cl[zi] > 0,
            "trim_alpha": trim,
            "best_ld": ld[bi],
            "best_ld_alpha": a[bi],
            "trim_vs_best": abs(trim - a[bi]) if trim is not None else None,
        },
    }


def run_analysis(payload):
    exe = find_flow5()
    if not exe:
        raise RuntimeError(
            "找不到 flow5。請設環境變數 FLOW5_EXE 指向 flow5.exe，"
            "或把 flow5 資料夾放進專案的 flow5/ 底下。")
    work = tempfile.mkdtemp(prefix="wingforge_f5_")
    try:
        xml_dir = os.path.join(work, "xml")
        out_dir = os.path.join(work, "out")
        os.makedirs(xml_dir)
        os.makedirs(out_dir)

        with open(os.path.join(xml_dir, "plane.xml"), "w", encoding="utf-8") as fh:
            fh.write(payload["planeXml"])

        foil_files = [ensure_foil(f["name"], f.get("dat") or "", xml_dir)
                      for f in payload["foils"]]

        with open(os.path.join(xml_dir, "analysis.xml"), "w", encoding="utf-8") as fh:
            fh.write(fill(os.path.join(TEMPLATES, "analysis.xml"), {
                "POLAR_NAME": "T1-%.1fms" % payload["velocity"],
                "PLANE_NAME": payload["planeName"],
                "VELOCITY": "%.5f" % payload["velocity"],
                "REF_AREA": "%.5f" % payload["refArea"],
                "REF_SPAN": "%.5f" % payload["refSpan"],
                "REF_CHORD": "%.5f" % payload["refChord"],
                "VISCOUS": "true" if payload.get("viscous") else "false",
            }))

        script_path = os.path.join(work, "script.xml")
        with open(script_path, "w", encoding="utf-8") as fh:
            fh.write(fill(os.path.join(TEMPLATES, "script.xml"), {
                "XML_DIR": xml_dir.replace("/", os.sep),
                "OUT_DIR": out_dir.replace("/", os.sep),
                "FOIL_FILES": "\n            ".join(
                    "<Foil_File_Name>%s</Foil_File_Name>" % n for n in foil_files),
                "ALPHA_MIN": payload.get("alphaMin", -20),
                "ALPHA_MAX": payload.get("alphaMax", 20),
                "ALPHA_STEP": payload.get("alphaStep", 0.5),
            }))

        proc = subprocess.run(
            [exe, "-p", "-s", script_path, "-t", os.path.join(work, "trace.log")],
            cwd=work, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=900)
        log = (proc.stdout or "") + (proc.stderr or "")

        csv_path = None
        for base, _d, files in os.walk(out_dir):
            for f in files:
                if f.lower().endswith(".csv"):
                    csv_path = os.path.join(base, f)
        if not csv_path:
            raise RuntimeError("flow5 沒有輸出 CSV。log 末段：\n"
                               + "\n".join(log.splitlines()[-15:]))
        summary, rows = parse_csv(csv_path)
        charts = build_charts(rows)
        charts["summary"] = summary
        charts["log_tail"] = log.splitlines()[-8:]
        return charts
    finally:
        shutil.rmtree(work, ignore_errors=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    def do_POST(self):
        if self.path != "/api/analyze":
            self.send_error(404)
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(n).decode("utf-8"))
            print("  分析中：%s ..." % payload.get("planeName"))
            result = run_analysis(payload)
            print("  完成：%d 個資料點" % len(result["points"]))
            body = json.dumps({"ok": True, "result": result}).encode("utf-8")
        except Exception as e:
            print("  失敗：%s" % e)
            body = json.dumps({"ok": False, "error": str(e)}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    ap = argparse.ArgumentParser(description="WingForge 分析伺服器")
    ap.add_argument("--host", default="127.0.0.1",
                    help="0.0.0.0 = 開放同網段其他人連（社團共用模式）")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    exe = find_flow5()
    print("=" * 58)
    print(" NYCU UAV 飛機設計精靈 — 分析伺服器")
    print("=" * 58)
    print(" flow5：%s" % (exe or "找不到（仍可填表，分析功能會停用）"))
    print(" 網址：http://%s:%d"
          % ("127.0.0.1" if args.host == "127.0.0.1" else args.host, args.port))
    if args.host != "127.0.0.1":
        print(" 共用模式：同網段的人用你的 IP 連進來，他們什麼都不用裝")
    print(" 關閉：在這個視窗按 Ctrl+C")
    print("=" * 58)

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((args.host, args.port), Handler) as httpd:
        if not args.no_browser and args.host == "127.0.0.1":
            try:
                webbrowser.open("http://127.0.0.1:%d" % args.port)
            except Exception:
                pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n 已關閉。")


if __name__ == "__main__":
    main()
