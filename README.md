# NYCU UAV 飛機設計系統（新生版）

給新生的「從零到 Fusion 出機翼」一條龍工具。**不用裝任何東西**，開網頁照著填就好。

## 🚀 快速開始（新生看這裡）

1. 開啟 **[填表精靈](https://nycu-uav.github.io/UAV_designsystem_web/)**（GitHub Pages）
2. 照 8 個步驟填：選機型 → 重量速度 → 主翼 → 翼型 → 佈局 → 尾翼 → 動力 → 總檢查
   - 每一步都有即時檢核：**綠✓＝落在「好飛」的經驗區間**，⚠＝提醒你想清楚取捨
3. 按「產生 xlsx 設計表」下載檔案
4. 開 Fusion 360（要先裝 [WingForge 外掛](https://github.com/Posheng28/wingforge)）：
   **實體 > 建立 > 從表格生成** → 選剛下載的 xlsx → 確定 → 主翼＋尾翼自動長出來
5. 每支翼都是參數化特徵，之後用 **修改 > Edit Wing** 隨時調（先點選特徵再按）

翼型 .dat 檔說明：NACA 四位數免檔案；Clark Y / SD7037 / AG35 外掛已附；
其他翼型到 [airfoiltools.com](http://airfoiltools.com) 下載 Selig format dat，
放進 `wingforge/airfoils/` 資料夾。

## 📁 designs/ — 歷屆設計存檔

做完的設計請把 xlsx commit 進 `designs/`，檔名格式：

```
YYYYMMDD_姓名_機名.xlsx   （例：20260817_小明_2米練習機.xlsx）
```

這就是社團的設計資料庫——後面的新生可以直接下載學長姐的檔案丟進 Fusion 重現整台機，
或當自己設計的起點。

## 🔧 進階（要看公式與出處的人）

- 精靈的所有公式與建議區間都經過多方查證，出處：MIT 16.01（Drela）Basic Aircraft
  Design Rules、朱寶鎏《模型飛機飛行原理》、NACA Report 823（V 尾）、SEFSD Wing
  Cube Loading、FAA 速度係數等——完整引文在 wingforge repo 的
  `design-sheets/飛機設計計算表_v2.xlsx` SOURCES 分頁（那份是手填 Excel 版，
  公式全開、可自行改算）。
- 產出 xlsx 的 `EXPORT` 分頁是與 WingForge 外掛（`core/plane_table.py`）約定的
  機器契約（`EXPORT_VERSION 1`）——**改 index.html 的產出格式前，先確認外掛端
  解析器同步更新**。

## 🪶 foils.json — 全社團共用翼型庫

精靈的翼型清單從本 repo 的 [`foils.json`](foils.json) 載入（GitHub Pages 同源 fetch）。
要新增翼型給所有人用：

1. 在精靈「翼型」步按「➕ 新增翼型」填好 → 會給你一段 JSON 片段與編輯連結
2. 把 `.dat` 檔 commit 進 `wingforge/airfoils/`
3. 把 JSON 片段貼進 `foils.json` 陣列尾端 commit → 全社團即刻看到

（沒 commit 的自訂翼型只在當次瀏覽器工作階段有效，重新整理就消失——這是刻意設計，
共用資產一律走 GitHub 留紀錄。）

## 🛠 維護

- 純靜態單檔（`index.html`）＋`foils.json` 翼型庫，無後端、無建置流程；改完 push 即上線。
- xlsx 在瀏覽器端生成（自帶 minimal zip writer），數值為算好的常量
  （非公式），Fusion 端只讀值所以完全相容。
- `index.html` 內建的 FOILS 陣列只是 foils.json 抓不到時的離線後備，兩邊不必嚴格同步，
  以 foils.json 為準。
