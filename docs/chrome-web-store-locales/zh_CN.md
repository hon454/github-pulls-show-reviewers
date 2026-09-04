# 简体中文 Chrome Web Store listing (`zh_CN`)

## Packaged name and short description

Name: `GitHub Pulls Show Reviewers`

Short description source: [`extension_description.message`](../../public/_locales/zh_CN/messages.json).
Use that catalog value verbatim; there is no separately editable summary here.
`extension_name.message` in the same catalog must match the name above.
Run `pnpm verify:cws` to print the current values and check the 75/132 character limits.
Chrome selects packaged metadata independently of the manual extension UI language.

## Detailed description

<!-- description:start -->
GitHub Pulls Show Reviewers直接在GitHub拉取请求列表中显示审阅者信息。无需逐个打开拉取请求，即可查看受邀的审阅者、受邀团队以及每位审阅者已完成的审阅状态。

受邀审阅者以边框标记，已完成的审阅通过徽章显示已批准、已请求更改、已评论和审阅已撤销状态。审阅完成后，审阅者仍可能处于受邀状态；如果在批准、请求更改或撤销审阅后检测到新请求，刷新徽章会表示再次请求审阅。团队标签表示受邀团队，不代表团队的批准状态。尚未提交的待处理审阅不会显示。

你可以在设置中选择是否显示审阅者用户名和状态徽章，也可以将审阅者链接的搜索范围限定为未关闭的拉取请求。仓库诊断有助于排查访问问题。本扩展专注于审阅者信息，不添加检查结果、可合并状态、负责人或标签。

公开仓库无需账号或令牌即可使用，但受GitHub未认证API的用量限制。对于私有仓库，请通过维护者管理的GitHub App，使用OAuth Device Flow登录GitHub。App仅请求Pull requests: Read仓库权限。你的账号和App安装都必须具备目标仓库的访问权限；仅登录不会获得额外权限。你可以连接多个GitHub账号。账号凭据和偏好设置保存在浏览器本地。审阅者数据请求直接发送至GitHub，本扩展不运营接收用户数据的后端。

扩展界面支持英语、韩语、日语、简体中文和繁体中文。默认跟随Chrome界面语言，不支持的语言回退为英语。你也可以在设置中手动选择语言，选择会保存。切换语言只更新扩展界面的显示，不会重新获取审阅者数据。安装包名称和摘要的语言由Chrome单独选择；扩展的界面语言设置不会更改商店详情的语言。

本扩展不会翻译GitHub页面、拉取请求标题、用户名、团队名称或GitHub的外部授权页面。产品介绍页、隐私政策以及链接的开发者文档仍以英语提供。
<!-- description:end -->

## Ordered screenshot inventory

Upload these three images to this locale, in order. Text below describes each
scene for review; it is not an additional dashboard field to populate.

1. [01-pr-list-before-after.png](../chrome-web-store-assets/zh_CN/01-pr-list-before-after.png) — 使用前后对比：在GitHub拉取请求列表中直接显示审阅者信息。
1. [02-pr-list-avatar-state-showcase.png](../chrome-web-store-assets/zh_CN/02-pr-list-avatar-state-showcase.png) — 通过边框和徽章查看受邀审阅者、受邀团队及已完成的审阅状态。
1. [03-options-repository-check.png](../chrome-web-store-assets/zh_CN/03-options-repository-check.png) — 显示设置与无需令牌的公开仓库诊断。

<!-- capture-before: 使用前 -->
<!-- capture-after: 使用后 -->

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
