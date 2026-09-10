# GitHub Pulls Show Reviewers

[![Chrome Web Store 版本](https://img.shields.io/chrome-web-store/v/hoocgjopdboeghdkfjlkngkkpbiljggk?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk?utm_source=github&utm_medium=readme_badge&utm_campaign=evergreen)
[![Chrome Web Store 使用者人數](https://img.shields.io/chrome-web-store/users/hoocgjopdboeghdkfjlkngkkpbiljggk?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk?utm_source=github&utm_medium=readme_badge&utm_campaign=evergreen)
[![CI](https://github.com/hon454/github-pulls-show-reviewers/actions/workflows/ci.yml/badge.svg)](https://github.com/hon454/github-pulls-show-reviewers/actions/workflows/ci.yml)

[English](./README.md) · [한국어](./README.ko.md) · [简体中文](./README.zh-CN.md) · **繁體中文** · [日本語](./README.ja.md)

> 在 GitHub Pull Request 清單中，直接查看已要求審查的使用者、團隊，以及已完成的審查狀態。

`GitHub Pulls Show Reviewers` 是一款 Chrome 擴充功能，專注於在 Pull Request 清單中呈現審查者狀態。您不必逐一開啟 PR，就能知道已向誰提出審查要求，以及有哪些已完成的審查結果。

![GitHub PR 清單內的審查者標籤與審查狀態徽章](./docs/chrome-web-store-assets/02-pr-list-avatar-state-showcase.png)

[v1.18.0 版本說明](./docs/releases/v1.18.0.md)（英文）：更準確顯示受邀審查者狀態，並為停滯的要求提供有界復原；同時包含 v1.17.2 的開發工具安全性更新。開發相依套件仍有一項安全性稽核問題待解決。

## 主要功能

- 同時支援傳統儲存庫 PR 清單與 GitHub 的 New Repository Pull Requests Dashboard Preview，並自動辨識頁面結構，無須在擴充功能中另行設定。全域 PR 儀表板 `github.com/pulls` 不在支援範圍內。
- 在 GitHub Pull Request 清單的各列顯示已要求審查的使用者。
- 在 GitHub Pull Request 清單的各列顯示已要求審查的團隊。
- 顯示每位審查者已完成的審查狀態：已核准（`approved`）、已要求變更（`changes requested`）、已留言（`commented`）或審查已撤銷（`dismissed`）。最近一次非留言審查優先於後續留言；只有在沒有非留言審查時，才採用留言。
- 當已要求審查的使用者也有已完成的審查時，只有在有限的 issue event 證據確認之後再次要求審查時，才顯示再次要求審查的徽章。若證據不完整或無法取得，則保留要求審查的顏色與搜尋連結，在工具提示及無障礙名稱中保留先前的審查，並隱藏再次要求審查的徽章。
- 審查者標籤可連至 GitHub PR 搜尋。
- 在目前顯示的各列間重複使用頁面層級的審查者中繼資料。只要 GitHub REST API 的分頁結果能取得對應的列，搜尋結果或換頁後的 Pull Request 清單也能使用這些資料。
- 一般瀏覽過程中，即使 GitHub 更新頁面，擴充功能仍會持續運作。若同一 PR 的 GitHub 原生中繼資料取代了擴充功能的顯示區域，擴充功能會將該區域還原。
- 在較窄的桌面視窗與分割視窗配置中，維持審查者中繼資料的可見性，不會重新顯示 GitHub 刻意隱藏的中繼資料。
- 沒有審查者的 PR 列會維持原本的外觀。取得審查者資訊時若發生非預期錯誤，頁面會顯示一則重新載入提示，並保留已載入的審查者標籤。GitHub 更新中繼資料或重新整理頁面後，失敗的列可能恢復。單純等待 API 速率限制重設不會觸發重試。顯示與語言設定的變更只會更新畫面呈現，包含載入失敗的列。
- 共用的儲存庫中繼資料載入與已開始的審查者載入各以 30 秒為限；若背景回應遺失，35 秒的訊息等待保護機制會結束等待。等候最多 4 個並行請求名額的時間不計入期限。選用的審查請求事件查詢須在上層工作的剩餘期限內完成，總計最多 10 秒。若只有這項選用查詢逾時，會保留已確認的再次請求證據，其餘有歧義的請求則維持未確認狀態。必要請求逾時後仍會顯示相同的重新載入提示，並保留已載入的標籤；變更語言或顯示設定不會重新計時。
- 連結帳號或更新安裝的儲存庫存取範圍後，若目前顯示的所有審查者資訊皆成功載入，便會清除已不適用的存取提示。某一列成功不會隱藏其他列的失敗或待處理請求；隨著各列恢復，提示內容可能逐步減輕。GitHub API 速率限制重設後，請重新載入頁面以重試。等待重設並不會自動恢復載入。

## 為什麼使用它

GitHub 的 Pull Request 清單適合快速瀏覽標題、作者與狀態，但審查者資訊容易被忽略。若不開啟每個 PR，很難掌握已向哪些使用者或團隊提出審查要求，以及每位審查者已完成的審查結果。這款擴充功能在各 PR 列加入精簡的 `審查者：` 區域，讓您直接在清單中查看這些資訊。

![GitHub PR 清單加入審查者標籤前後的比較](./docs/chrome-web-store-assets/01-pr-list-before-after.png)

## 安裝

請從 [Chrome Web Store](https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk?utm_source=github&utm_medium=readme&utm_campaign=evergreen) 安裝擴充功能。

安裝後，開啟 GitHub 儲存庫的 Pull Request 清單即可。公開儲存庫不需要登入。若要使用私人儲存庫，請開啟擴充功能的選項頁面，新增可存取該儲存庫的 GitHub 帳號。

## 支援的瀏覽器與語言

目前，Chrome 是本擴充功能唯一正式支援並測試的瀏覽器。Edge、Brave、Arc 等其他 Chromium 系列瀏覽器可能也能執行相同的 MV3 建置版本，但目前並非發行目標，也不在 Chrome 手動驗證流程的涵蓋範圍內。Firefox 的 MV3 行為、擴充功能封裝與 GitHub 登入流程在經過專門測試前，同樣不在支援範圍內。

Chrome 中繼資料、選項、登入、儲存庫診斷、審查者標籤與存取提示橫幅，皆支援英文、韓文、日文、簡體中文與繁體中文。

## 公開與私人儲存庫

- **公開儲存庫：** 只要 GitHub 提供足夠的公開 PR 資料，即可免登入使用。
- **私人儲存庫：** 需要透過擴充功能的 GitHub App 登入 GitHub。
- **權限：** GitHub App 只要求 `Pull requests: Read` 權限。
- **儲存庫存取：** 若 GitHub 拒絕存取，請同時檢查帳號的儲存庫權限，以及對應擁有者或儲存庫的 GitHub App 安裝存取範圍。
- **組織：** 讀取組織的私人儲存庫前，可能需要組織擁有者安裝或核准 GitHub App。
- **多個帳號：** 可同時新增個人與工作帳號。`all` 安裝代表 App 的存取範圍；連結的使用者仍可能擁有不同的儲存庫權限。經過驗證的儲存庫請求傳回與速率限制無關的 403/404 後，擴充功能會依有限順序嘗試同一擁有者的其他有效帳號：先選擇本機已確認涵蓋的帳號，再選擇所選儲存庫快照不完整的帳號，各組內維持原有帳號順序。每個帳號在同一頁面與儲存庫的每一輪處理中只允許嘗試一次。成功的帳號僅在該輪處理中沿用；單一 PR 的 404 不會讓整個儲存庫被判定為無法存取。
- **重試與診斷：** 速率限制、尚未解決的 401、網路／結構驗證／伺服器錯誤及取消操作，都會停止帳號探索。401 僅能在同一帳號內復原。重新載入、導覽、重新連結或移除帳號、安裝存取範圍變更，以及明確啟動新的診斷，都可開始新一輪處理。資料列更新、快取到期、權杖更新、語言或顯示設定變更，不會重試已失敗的候選帳號。相符帳號診斷採用相同策略，並顯示實際使用的帳號；無權杖診斷始終以匿名方式執行。公開儲存庫的匿名存取，以及候選帳號唯一明確時的既有切換方式，皆維持不變。
- **保持登入：** 關閉瀏覽器再重新開啟後，登入狀態仍會保留。存取權杖會在背景自動更新，直到您移除帳號或撤銷 GitHub App 授權。
- **登入復原：** 背景 worker 正常暫停後，進行中的登入仍可繼續。若瀏覽器重新啟動或驗證請求中斷，請取得新的代碼；已連結的帳號仍會保留。

## 設定

選項頁面讓您在保留審查者資訊這項核心功能的同時，調整顯示方式：

- 僅顯示審查者頭像，或展開為包含 `@login` 的標籤。
- 顯示或隱藏審查狀態徽章。
- 選擇審查者標籤的連結只搜尋開啟中的 PR，或也包含已關閉的 PR。
- 查看私人儲存庫的帳號、儲存庫存取、安裝存取範圍與速率限制診斷。
- 登入時，本地化的剪貼簿回饋會確認複製成功，或在失敗時提示手動複製。關閉面板會還原有用的鍵盤焦點，連結成功會繼續在帳號區域提示。變更擴充功能語言只會重新呈現此回饋，不會重新啟動登入。

![選項頁面中的顯示設定與儲存庫診斷](./docs/chrome-web-store-assets/03-options-repository-check.png)

## 隱私

本擴充功能僅使用在 Pull Request 清單中顯示審查者資訊所需的最小存取權限。

- 使用公開儲存庫不需要登入。
- 私人儲存庫透過擴充功能的 GitHub App 登入 GitHub。
- GitHub App 只要求 `Pull requests: Read` 權限。
- OAuth、經過驗證的請求與憑證儲存由背景負責。Content 和選項 UI 只會收到帳號摘要及供使用者查看的登入進度，不會收到存取權杖、更新權杖或 OAuth 裝置代碼的秘密值。
- Chrome 會阻止 content script 存取本機儲存空間。選項 UI 排除權杖的界線由擴充功能程式碼維護；Chrome 仍將選項頁面視為可信任的擴充功能頁面。
- 在選項頁面移除有效帳號或驗證已失效的帳號，只會刪除該帳號儲存在本機的憑證。
- 若要撤銷 GitHub App 本身的授權，請在 GitHub 的 Applications 設定中移除它。

完整政策請參閱[公開隱私權政策](https://github.com/hon454/github-pulls-show-reviewers/blob/main/docs/privacy-policy.md)。

## 支持專案

如果這款擴充功能對您有幫助，歡迎請我喝杯咖啡！

<a href="https://www.buymeacoffee.com/hon454s" target="_blank" rel="noopener noreferrer"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="請我喝杯咖啡" width="217" height="60"></a>

## 貢獻指南

本儲存庫使用 WXT、TypeScript、React、zod、Vitest、Playwright 與 pnpm。

```bash
pnpm install
pnpm dev
```

`pnpm install` 會透過 pnpm 生命週期自動執行 `wxt prepare`，不需要另外執行準備步驟。

常用驗證指令：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm test:e2e
```

在發行封裝或提交至商店前，請執行：

```bash
pnpm verify:release
pnpm zip:release
```

`pnpm zip` 只會產生可供檢查的本機建置版本。Chrome Web Store 的正式封裝使用 `pnpm zip:release`；此指令會載入維護者的 GitHub App 識別碼，並在上傳前驗證最終 ZIP 檔案。

推送新的 `v<version>` 標籤會將已驗證的套件附加至 GitHub Release，並透過 CWS API v2 提交，在一般審查核准後自動發布。若完全相同的原始碼已有經驗證的上傳紀錄，且處於待審查或已發布狀態，就會重複使用該已驗證套件，不再執行 CWS 寫入操作。手動執行工作流程時，預設值為 `skip`；僅檢查憑證的 `dry-run` 不會變更商店狀態或建立發行版本。提交審查與建立標籤需要明確授權。分階段提交、舊標籤、商店資訊更新、驗證佐證與復原程序，請遵循 [Chrome Web Store 說明](./docs/chrome-web-store.md)與[代理標準作業手冊](./docs/chrome-web-store-agent-runbook.md)。

儲存庫工作流程、分支命名、提交格式與 Pull Request 要求，請參閱 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 文件

README 提供全部五種支援語言的版本。以下詳細技術文件、貢獻指南與維運文件皆以英文維護。

- [文件管理與 README 翻譯規範](./docs/guidelines/documentation-guideline.md)
- [實作說明](./docs/implementation-notes.md)
- [Chrome 手動測試](./docs/manual-chrome-testing.md)
- [Chrome Web Store 說明](./docs/chrome-web-store.md)
- [Chrome Web Store 提交資料](./docs/chrome-web-store-submission.md)
- [Chrome Web Store 代理作業手冊](./docs/chrome-web-store-agent-runbook.md)
- [分階段 CWS 操作參考](./docs/cws-agent-handoff.md)
- [商店流量來源歸因](./docs/growth/attribution.md)
- [發布與社群介紹文案](./docs/growth/launch-kit.md)
- [隱私權政策](./docs/privacy-policy.md)
- [安全性政策](./SECURITY.md)
- [版本資訊](./docs/releases/)
- [MIT 授權條款](./LICENSE)

## 在地化

擴充功能支援英文（後備語言）、韓文、日文、簡體中文與繁體中文。Chrome 中繼資料會依照 Chrome 的語言設定顯示。本機 `language` 設定預設為 `auto`，也能手動指定擴充功能介面的語言。選項頁面、顯示設定、帳號操作與 GitHub 裝置登入流程皆支援五種語言。切換語言時，其他已開啟的選項分頁也會同步更新，不會重新啟動登入、清空儲存庫輸入內容或重複執行帳號操作。儲存庫診斷會重新呈現既有結果與執行狀態，不會額外發送 API 請求。已開啟 PR 清單中的審查者標籤、載入狀態、工具提示、無障礙名稱與存取提示橫幅，也會在不重新擷取資料或重啟排隊工作的情況下更新。已關閉的橫幅會維持關閉。GitHub 內容、審查者識別碼、搜尋連結，以及既有審查狀態的顏色、徽章與優先順序均不變。產品名稱與 GitHub App 名稱也維持原樣。資訊清單與 UI 的職責邊界及共用 API，請參閱[在地化契約](./docs/adr/0006-bundled-localization-and-render-only-language.md)；翻譯涵蓋範圍、封裝測試與瀏覽器原生語言驗證的限制，請參閱[五語術語表與 QA 報告](./docs/localization.md)。

五種語言的 [Chrome Web Store 文案與螢幕截圖](./docs/chrome-web-store-submission.md#per-locale-dashboard-checklist)與封裝內的名稱及摘要目錄分開維護。使用 `pnpm cws:assets` 重新產生 15 張合成 **TESTING** 螢幕截圖，再以 `pnpm verify:cws` 驗證文案、連結與圖片來源。既有英文螢幕截圖與到達網頁參照的路徑維持不變。這些資料並不能證明正式環境設定、商店後台登錄或發布已完成。
