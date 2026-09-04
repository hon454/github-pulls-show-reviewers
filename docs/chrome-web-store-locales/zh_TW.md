# 繁體中文 Chrome Web Store listing (`zh_TW`)

## Packaged name and short description

Name: `GitHub Pulls Show Reviewers`

Short description source: [`extension_description.message`](../../public/_locales/zh_TW/messages.json).
Use that catalog value verbatim; there is no separately editable summary here.
`extension_name.message` in the same catalog must match the name above.
Run `pnpm verify:cws` to print the current values and check the 75/132 character limits.
Chrome selects packaged metadata independently of the manual extension UI language.

## Detailed description

<!-- description:start -->
GitHub Pulls Show Reviewers直接在GitHub提取要求清單中顯示審查者資訊。你不必逐一開啟提取要求，就能查看受邀的審查者、受邀團隊，以及每位審查者已完成的審查狀態。

受邀審查者會以外框標示，已完成的審查則以徽章顯示已核准、已要求變更、已留言與審查已撤銷等狀態。審查完成後，審查者仍可能處於受邀狀態；如果在核准、要求變更或撤銷審查後偵測到新的要求，重新整理徽章會表示再次要求審查。團隊標籤代表受邀團隊，並不代表團隊的核准狀態。尚未提交的待處理審查不會顯示。

你可以在設定中選擇是否顯示審查者使用者名稱及狀態徽章，也可以將審查者連結的搜尋範圍限定為尚未關閉的提取要求。儲存庫診斷可協助釐清存取問題。本擴充功能專注於審查者資訊，不會加入檢查結果、可合併狀態、負責人或標籤。

公開儲存庫不需帳號或權杖即可使用，但仍受GitHub未驗證API的用量限制。若要存取私人儲存庫，請透過維護者管理的GitHub App，使用OAuth Device Flow登入GitHub。App只要求Pull requests: Read儲存庫權限。你的帳號與App安裝都必須具備目標儲存庫的存取權限，單憑登入並不會取得額外權限。你可以連結多個GitHub帳號。帳號憑證和偏好設定儲存在本機瀏覽器中。審查者資料要求會直接傳送至GitHub，本擴充功能沒有營運接收使用者資料的後端。

擴充功能介面支援英文、韓文、日文、簡體中文及繁體中文。預設會跟隨Chrome介面語言，不支援的語言則使用英文。你也可以在設定中手動選擇語言，選擇結果會保留。切換語言只會更新擴充功能介面的顯示，不會重新取得審查者資料。套件名稱與摘要的語言由Chrome另外選擇；擴充功能的介面語言設定不會變更商店資訊的語言。

本擴充功能不會翻譯GitHub頁面、提取要求標題、使用者名稱、團隊名稱或GitHub的外部授權頁面。產品介紹頁、隱私權政策與連結的開發者文件仍以英文提供。
<!-- description:end -->

## Ordered screenshot inventory

Upload these three images to this locale, in order. Text below describes each
scene for review; it is not an additional dashboard field to populate.

1. [01-pr-list-before-after.png](../chrome-web-store-assets/zh_TW/01-pr-list-before-after.png) — 使用前後比較：在GitHub提取要求清單中直接顯示審查者資訊。
1. [02-pr-list-avatar-state-showcase.png](../chrome-web-store-assets/zh_TW/02-pr-list-avatar-state-showcase.png) — 透過外框與徽章查看受邀審查者、受邀團隊及已完成的審查狀態。
1. [03-options-repository-check.png](../chrome-web-store-assets/zh_TW/03-options-repository-check.png) — 顯示設定與不需權杖的公開儲存庫診斷。

<!-- capture-before: 使用前 -->
<!-- capture-after: 使用後 -->

The two capture comments are the source for this locale's composition captions.
Screenshots use synthetic GitHub/user content and the **TESTING** GitHub App build
from `pnpm cws:assets`; they are not production-config package evidence.

## Terminology and review

Use the shared [localization glossary](../localization.md) and this locale's
catalog for reviewer states, usernames, repository access, and account terms.
`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, and `DISMISSED` mean completed
review states. Requested teams have no aggregate approval state. A fresh request
after a completed review is distinct from a completed review that remains requested.
Keep GitHub, GitHub App, OAuth Device Flow, Pull requests: Read, and the product
name unchanged. GitHub user content and external pages are outside translation scope.

For registration and evidence, follow the [per-locale checklist](../chrome-web-store-submission.md#per-locale-dashboard-checklist).
