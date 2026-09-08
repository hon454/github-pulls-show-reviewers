# GitHub Pulls Show Reviewers

[![Chrome Web Store 版本](https://img.shields.io/chrome-web-store/v/hoocgjopdboeghdkfjlkngkkpbiljggk?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk?utm_source=github&utm_medium=readme_badge&utm_campaign=evergreen)
[![Chrome Web Store 用户数](https://img.shields.io/chrome-web-store/users/hoocgjopdboeghdkfjlkngkkpbiljggk?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk?utm_source=github&utm_medium=readme_badge&utm_campaign=evergreen)
[![CI](https://github.com/hon454/github-pulls-show-reviewers/actions/workflows/ci.yml/badge.svg)](https://github.com/hon454/github-pulls-show-reviewers/actions/workflows/ci.yml)

[English](./README.md) · [한국어](./README.ko.md) · **简体中文** · [繁體中文](./README.zh-TW.md) · [日本語](./README.ja.md)

> 在 GitHub 拉取请求列表中，直接查看已请求审阅的用户、团队及已完成的审阅状态。

`GitHub Pulls Show Reviewers` 是一款 Chrome 扩展，专注于在拉取请求列表中显示审阅者状态。无需逐个打开 PR，即可了解向谁发出了审阅请求，以及已完成的审阅结果。

![GitHub PR 列表中显示的审阅者标签和审阅状态徽标](./docs/chrome-web-store-assets/02-pr-list-avatar-state-showcase.png)

## 主要功能

- 在 GitHub 拉取请求列表的每一行显示已请求审阅的用户。
- 在 GitHub 拉取请求列表的每一行显示已请求审阅的团队。
- 显示每位审阅者已完成的审阅状态：已批准（`approved`）、已请求更改（`changes requested`）、已评论（`commented`）或审阅已撤销（`dismissed`）。最近一次非评论审阅优先于之后的评论；仅在没有非评论审阅时才采用评论。
- 点击审阅者标签可跳转到 GitHub PR 搜索。
- 在当前显示的行之间复用页面级审阅者元数据。如果 GitHub REST API 的分页结果包含相关行，搜索结果和翻页后的拉取请求列表也能复用这些数据。
- 在正常导航过程中，即使 GitHub 更新页面，扩展也会继续工作。如果同一 PR 的 GitHub 原生元数据替换了扩展的显示区域，扩展会恢复该区域。
- 在较窄的桌面窗口和分屏布局中保持审阅者元数据可见，不会重新显示 GitHub 在这些布局下主动隐藏的元数据。
- 没有审阅者的 PR 行保持原样。如果获取审阅者信息时发生意外错误，页面会显示一条重新加载提示，并保留已加载的审阅者标签。GitHub 更新元数据或刷新页面后，失败的行可能恢复。仅等待 API 速率限制重置不会触发重试。显示和语言设置的更改只更新界面呈现，失败的行也不例外。
- 连接账号或更新安装的仓库访问范围后，如果当前显示的所有审阅者信息均加载成功，扩展会清除不再适用的访问提示。某一行加载成功不会隐藏其他行的失败或待处理请求；随着各行恢复，提示内容可能相应减轻。GitHub API 速率限制重置后，需要重新加载页面才能重试。等待重置不会自动恢复加载。

## 为什么使用它

GitHub 拉取请求列表便于浏览标题、作者和状态，但审阅者信息容易被忽略。如果不打开每个 PR，就很难知道向哪些用户或团队发出了审阅请求，以及每位审阅者已完成的审阅结果。这个扩展在每个 PR 行中添加简洁的 `审阅者：` 区域，让这些信息直接显示在列表里。

![GitHub PR 列表添加审阅者标签前后的对比](./docs/chrome-web-store-assets/01-pr-list-before-after.png)

## 安装

从 [Chrome Web Store](https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk?utm_source=github&utm_medium=readme&utm_campaign=evergreen) 安装扩展。

安装后，打开 GitHub 仓库的拉取请求列表即可。公开仓库无需登录。对于私有仓库，请打开扩展的选项页面，添加有权访问该仓库的 GitHub 账号。

## 支持的浏览器和语言

目前，Chrome 是本扩展唯一正式支持并测试的浏览器。Edge、Brave、Arc 等其他 Chromium 系浏览器可能也能运行同一 MV3 构建，但目前不属于发布目标，也未纳入 Chrome 手动验证流程。Firefox 的 MV3 行为、扩展打包和 GitHub 登录流程在经过专门测试之前，同样不在支持范围内。

Chrome 元数据、选项、登录、仓库诊断、审阅者标签和访问提示横幅支持英语、韩语、日语、简体中文和繁体中文。

## 公开和私有仓库

- **公开仓库：** 只要 GitHub 提供足够的公开 PR 数据，就可以免登录使用。
- **私有仓库：** 需要通过扩展的 GitHub App 登录 GitHub。
- **权限：** GitHub App 仅请求 `Pull requests: Read` 权限。
- **仓库访问：** 如果 GitHub 拒绝访问，请同时检查账号的仓库权限，以及相应所有者或仓库的 GitHub App 安装访问范围。
- **组织：** 读取组织的私有仓库前，可能需要组织所有者安装或批准 GitHub App。
- **多个账号：** 可以同时添加个人和工作账号。`all` 安装表示 App 的访问范围；连接的用户仍可能拥有不同的仓库权限。认证仓库请求返回非速率限制的 403/404 后，扩展会按有限序列尝试同一所有者的其他有效账号：先尝试本地已确认覆盖的账号，再尝试所选仓库快照不完整的账号，各组内保留原有账号顺序。每个账号在同一页面和仓库的每轮处理中只准入一次。成功账号仅在该轮处理中复用；单个 PR 的 404 不会将整个仓库判定为不可访问。
- **重试与诊断：** 速率限制、未解决的 401、网络／模式验证／服务器错误及取消都会停止账号发现。401 只能在同一账号内恢复。重新加载、导航、重新连接或移除账号、安装访问范围变化，以及明确启动新的诊断，可开始新一轮处理。行更新、缓存过期、令牌刷新、语言或显示设置变化不会重新尝试已失败的候选账号。匹配账号诊断采用相同策略并显示实际使用的账号；无令牌诊断始终匿名。公开仓库的匿名访问及候选账号唯一明确时的现有切换路径保持不变。
- **保持登录：** 关闭并重新打开浏览器后，登录状态仍会保留。访问令牌会在后台自动刷新，直到你移除账号或撤销 GitHub App 授权。
- **登录恢复：** 后台 worker 正常挂起后，进行中的登录仍可继续。如果浏览器重启或认证请求中断，请获取新代码；已连接的账号仍会保留。

## 设置

选项页面可以调整显示方式，同时保留以审阅者信息为核心的工作流程：

- 仅显示审阅者头像，或展开为带有 `@login` 的标签。
- 显示或隐藏审阅状态徽标。
- 选择审阅者标签链接仅搜索打开的 PR，还是也包含已关闭的 PR。
- 检查私有仓库的账号、仓库访问、安装访问范围和速率限制诊断。

![选项页面中的显示设置和仓库诊断](./docs/chrome-web-store-assets/03-options-repository-check.png)

## 隐私

本扩展仅使用在拉取请求列表中显示审阅者信息所需的最小访问权限。

- 公开仓库无需登录。
- 私有仓库通过扩展的 GitHub App 登录 GitHub。
- GitHub App 仅请求 `Pull requests: Read` 权限。
- OAuth、经过认证的请求和凭据存储由后台负责。Content 和选项 UI 只接收账号摘要及面向用户的登录进度，不会接收访问令牌、刷新令牌或 OAuth 设备代码的秘密值。
- Chrome 会阻止 content script 访问本地存储。选项 UI 排除令牌的边界由扩展代码维护；Chrome 仍将选项页面视为可信扩展页面。
- 在选项页面移除有效账号或认证已失效的账号，只会删除该账号保存在本地的凭据。
- 如需撤销 GitHub App 本身的授权，请在 GitHub 的 Applications 设置中移除它。

完整政策请参阅[公开隐私政策](https://github.com/hon454/github-pulls-show-reviewers/blob/main/docs/privacy-policy.md)。

## 支持项目

如果这个扩展对你有帮助，欢迎请我喝杯咖啡！

<a href="https://www.buymeacoffee.com/hon454s" target="_blank" rel="noopener noreferrer"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="请我喝杯咖啡" width="217" height="60"></a>

## 贡献指南

本仓库使用 WXT、TypeScript、React、zod、Vitest、Playwright 和 pnpm。

```bash
pnpm install
pnpm dev
```

`pnpm install` 会通过 pnpm 生命周期自动运行 `wxt prepare`，无需单独执行准备步骤。

常用验证命令：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm test:e2e
```

在发布打包或提交到商店之前，运行：

```bash
pnpm verify:release
pnpm zip:release
```

`pnpm zip` 仅生成可供检查的本地构建。面向 Chrome Web Store 的生产打包使用 `pnpm zip:release`，该命令会加载维护者的 GitHub App 标识符，并在上传前验证最终 ZIP 文件。

推送新的 `v<version>` 标签会将验证过的扩展包附加到 GitHub Release，并通过 CWS API v2 提交，在常规审核通过后自动发布。如果完全相同的源代码已有经过验证的上传记录，且处于待审核或已发布状态，则复用该验证过的扩展包，不再执行 CWS 写入操作。手动工作流默认使用 `skip`；仅检查凭据的 `dry-run` 不会更改商店状态或创建发布。提交审核和创建标签需要明确授权。分阶段提交、旧标签、商店详情更新、验证证据和恢复流程，请遵循 [Chrome Web Store 说明](./docs/chrome-web-store.md)和[代理标准操作手册](./docs/chrome-web-store-agent-runbook.md)。

仓库工作流程、分支命名、提交格式和拉取请求要求，请参阅 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 文档

README 提供全部五种支持语言的版本。以下详细技术文档、贡献指南和运维文档以英语维护。

- [文档管理和 README 翻译规范](./docs/guidelines/documentation-guideline.md)
- [实现说明](./docs/implementation-notes.md)
- [Chrome 手动测试](./docs/manual-chrome-testing.md)
- [Chrome Web Store 说明](./docs/chrome-web-store.md)
- [Chrome Web Store 提交资料](./docs/chrome-web-store-submission.md)
- [Chrome Web Store 代理操作手册](./docs/chrome-web-store-agent-runbook.md)
- [分阶段 CWS 操作参考](./docs/cws-agent-handoff.md)
- [商店流量来源归因](./docs/growth/attribution.md)
- [发布和社区介绍文案](./docs/growth/launch-kit.md)
- [隐私政策](./docs/privacy-policy.md)
- [安全政策](./SECURITY.md)
- [发布说明](./docs/releases/)
- [MIT 许可证](./LICENSE)

## 本地化

扩展支持英语（回退语言）、韩语、日语、简体中文和繁体中文。Chrome 元数据遵循 Chrome 的语言设置。本地 `language` 设置默认为 `auto`，也可以手动指定扩展界面的语言。选项页面、显示设置、账号操作和 GitHub 设备登录流程均支持这五种语言。更改语言会同步更新其他已打开的选项标签页，不会重新启动登录、清空仓库输入或重复执行账号操作。仓库诊断会重新呈现已有结果和运行状态，不会额外发送 API 请求。已打开的 PR 列表中的审阅者标签、加载状态、工具提示、无障碍名称和访问提示横幅也会更新，无需重新获取数据或重启排队中的任务。已关闭的横幅会保持关闭。GitHub 内容、审阅者标识符、搜索链接，以及现有审阅状态的颜色、徽标和优先级均保持不变。产品名称和 GitHub App 名称也不会更改。有关清单与 UI 的职责边界及共享 API，请参阅[本地化契约](./docs/adr/0006-bundled-localization-and-render-only-language.md)；有关翻译覆盖范围、打包测试和浏览器原生语言验证的限制，请参阅[五语言术语表与 QA 报告](./docs/localization.md)。

五种语言的 [Chrome Web Store 文案和截图](./docs/chrome-web-store-submission.md#per-locale-dashboard-checklist)与打包的名称和摘要目录分开维护。使用 `pnpm cws:assets` 重新生成 15 张合成 **TESTING** 截图，再通过 `pnpm verify:cws` 验证文案、链接和图片来源。现有英语截图和落地页引用的路径保持不变。这些资料不能证明生产配置、商店后台登记或发布已经完成。
