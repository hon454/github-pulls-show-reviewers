# GitHub Pulls Show Reviewers

[![Chrome Web Store バージョン](https://img.shields.io/chrome-web-store/v/hoocgjopdboeghdkfjlkngkkpbiljggk?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk?utm_source=github&utm_medium=readme_badge&utm_campaign=evergreen)
[![Chrome Web Store ユーザー数](https://img.shields.io/chrome-web-store/users/hoocgjopdboeghdkfjlkngkkpbiljggk?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk?utm_source=github&utm_medium=readme_badge&utm_campaign=evergreen)
[![CI](https://github.com/hon454/github-pulls-show-reviewers/actions/workflows/ci.yml/badge.svg)](https://github.com/hon454/github-pulls-show-reviewers/actions/workflows/ci.yml)

[English](./README.md) · [한국어](./README.ko.md) · [简体中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · **日本語**

> GitHub のプルリクエスト一覧で、レビューを依頼したユーザーやチーム、完了したレビューの状態を直接確認できます。

`GitHub Pulls Show Reviewers` は、プルリクエスト一覧にレビュアーの状態を表示することに特化した Chrome 拡張機能です。誰にレビューを依頼したか、どのようなレビューが完了しているかを確認するために、PR を一つずつ開く必要はありません。

![レビュアーチップとレビュー状態バッジを表示した GitHub PR 一覧](./docs/chrome-web-store-assets/02-pr-list-avatar-state-showcase.png)

[v1.17.1 リリースノート](./docs/releases/v1.17.1.md)（英語）：主要ボタンの見やすさ、各言語のコピー結果表示、ログイン時のフォーカス復帰を改善。

## 主な機能

- GitHub のプルリクエスト一覧の各行に、レビューを依頼したユーザーを表示します。
- GitHub のプルリクエスト一覧の各行に、レビューを依頼したチームを表示します。
- レビュアーごとに、完了したレビューの状態を表示します。対象は承認済み（`approved`）、変更要求済み（`changes requested`）、コメント済み（`commented`）、レビュー取り消し済み（`dismissed`）です。コメント以外の最新のレビューが、その後のコメントより優先されます。コメントは、コメント以外のレビューがない場合にのみ使われます。
- レビュアーチップから GitHub の PR 検索に移動できます。
- ページ単位のレビュアーメタデータを表示中の行で再利用します。GitHub REST API のページネーションで該当する行を取得できる場合は、検索結果やページを切り替えた一覧でも利用できます。
- 通常の画面遷移で GitHub がページを更新しても動作を続けます。同じ PR の GitHub 標準メタデータが拡張機能の表示領域を置き換えた場合、その領域を復元します。
- デスクトップの狭いウィンドウや分割画面でもレビュアーメタデータを表示します。GitHub が意図的に隠しているメタデータを再表示することはありません。
- レビュアーのいない PR 行の見た目は変更しません。レビュアー情報の取得が予期せず失敗すると、ページに再読み込みの案内を一つ表示し、取得済みのチップは維持します。失敗した行は、GitHub がメタデータを更新したときやページを再読み込みしたときに復旧する場合があります。API レート制限のリセットを待つだけでは再試行されません。表示設定や言語の変更は、失敗した行も含めて表示だけを更新します。
- アカウントの接続やインストールのアクセス範囲の更新後、表示中のすべてのレビュアー情報の取得が成功すると、不要になったアクセス案内を消します。一つの行の成功によって、別の行の失敗や処理待ちが隠されることはありません。各行の復旧に応じて案内内容が軽減される場合があります。GitHub API のレート制限がリセットされた後は、ページを再読み込みして再試行してください。リセットを待っても取得は自動再開しません。

## この拡張機能を使う理由

GitHub のプルリクエスト一覧は、タイトル、作成者、状態を確認するのに便利ですが、レビュアーの情報は見落としがちです。各 PR を開かずに、どのユーザーやチームにレビューを依頼しているか、レビュアーごとにどのようなレビューが完了しているかを把握するのは困難です。この拡張機能は、各 PR 行にコンパクトな `レビュアー:` 欄を追加し、これらの情報を一覧で確認できるようにします。

![GitHub PR 一覧でのレビュアーチップ導入前後の比較](./docs/chrome-web-store-assets/01-pr-list-before-after.png)

## インストール

[Chrome Web Store](https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk?utm_source=github&utm_medium=readme&utm_campaign=evergreen)からインストールしてください。

インストール後、GitHub リポジトリのプルリクエスト一覧を開きます。公開リポジトリではサインインせずに使えます。非公開リポジトリでは、拡張機能のオプションページを開き、そのリポジトリにアクセスできる GitHub アカウントを追加してください。

## 対応ブラウザーと言語

現在、正式なサポートとテストの対象は Chrome のみです。Edge、Brave、Arc などの Chromium 系ブラウザーでも同じ MV3 ビルドが動作する可能性はありますが、現時点ではリリース対象ではなく、Chrome の手動検証にも含まれません。Firefox も、MV3 の挙動、拡張機能のパッケージング、GitHub サインインのフローを個別に検証するまではサポート対象外です。

Chrome のメタデータ、オプション、サインイン、リポジトリ診断、レビュアーチップ、アクセス案内バナーは、英語、韓国語、日本語、簡体字中国語、繁体字中国語に対応しています。

## 公開・非公開リポジトリ

- **公開リポジトリ:** GitHub が十分な公開 PR データを提供している場合、サインインなしで利用できます。
- **非公開リポジトリ:** 拡張機能の GitHub App を通じて GitHub にサインインする必要があります。
- **権限:** GitHub App が要求する権限は `Pull requests: Read` のみです。
- **リポジトリアクセス:** GitHub がアクセスを拒否した場合は、アカウントのリポジトリ権限と、その所有者・リポジトリの GitHub App インストールのアクセス範囲を確認してください。
- **組織:** 非公開の組織リポジトリを読み取るには、組織のオーナーによる GitHub App のインストールや承認が必要になる場合があります。
- **複数アカウント:** 個人用と仕事用のアカウントを同時に追加できます。`all` インストールは App のアクセス範囲を表し、接続したユーザーごとにリポジトリ権限が異なる場合があります。認証付きのリポジトリ要求でレート制限によらない 403/404 が返ると、同じ所有者の他の有効なアカウントを順に試します。ローカルで範囲が確認できるアカウントを優先し、次に不完全な選択リポジトリのスナップショットを持つアカウントを試します。各グループ内のアカウント順は維持し、試行はページ・リポジトリの世代ごとに各アカウント一度までです。成功したアカウントの記憶はその世代に限定され、個別 PR の 404 でリポジトリ全体をアクセス不可とは判断しません。
- **再試行と診断:** レート制限、未解決の 401、ネットワーク・スキーマ・サーバーエラー、キャンセルはアカウント探索を停止します。401 の復旧は同じアカウント内に限定されます。再読み込み・移動、アカウントの再接続・削除、インストール範囲の変更、明示的な新しい診断で新しい世代を開始できます。行の更新、キャッシュの期限切れ、トークン更新、言語・表示の変更で失敗済みの候補を再試行しません。一致アカウントの診断は同じ方針で実際に使用したアカウントを表示し、トークンなしの診断は匿名のままです。公開リポジトリへの匿名アクセスと、候補が一つに定まる場合の既存のアカウント切り替えは維持されます。
- **サインインの維持:** ブラウザーを閉じて開き直してもサインインは維持されます。アカウントを削除するか GitHub App の認可を取り消すまで、バックグラウンドでアクセストークンが自動更新されます。
- **サインインの復旧:** バックグラウンド worker が通常の一時停止状態になっても、進行中のサインインは継続できます。ブラウザーが再起動した場合や認証リクエストが中断された場合は、新しいコードを取得してください。接続済みのアカウントは保存されたままです。

## 設定

オプションページでは、レビュアー情報の表示に特化した基本機能を保ちながら、表示方法を調整できます。

- レビュアーのアバターのみを表示するか、`@login` を含むチップに展開します。
- レビュー状態バッジの表示・非表示を切り替えます。
- レビュアーチップのリンクで、オープンな PR だけを検索するか、クローズ済みの PR も含めるかを選びます。
- 非公開リポジトリのアカウント、リポジトリアクセス、インストールのアクセス範囲、レート制限の診断を確認します。
- サインイン中は、ローカライズされたクリップボードのフィードバックでコピー完了を確認でき、失敗時は手動コピーの案内を表示します。パネルを閉じると有用なキーボードフォーカスが戻り、接続完了はアカウント欄で通知されます。拡張機能の言語を変えてもこのフィードバックを再表示するだけで、サインインは再開しません。

![オプションページの表示設定とリポジトリ診断](./docs/chrome-web-store-assets/03-options-repository-check.png)

## プライバシー

この拡張機能は、プルリクエスト一覧にレビュアー情報を表示するために必要な最小限のアクセス権限で動作します。

- 公開リポジトリではサインインは不要です。
- 非公開リポジトリでは、拡張機能の GitHub App を通じて GitHub にサインインします。
- GitHub App が要求する権限は `Pull requests: Read` のみです。
- OAuth、認証付きリクエスト、認証情報の保存はバックグラウンドが担当します。Content とオプション UI が受け取るのはアカウントの概要とユーザー向けのサインイン進行状況だけで、アクセストークン、リフレッシュトークン、OAuth デバイスコードの秘密値は渡されません。
- Chrome は content script によるローカルストレージへのアクセスを遮断します。オプション UI からトークンを除外する境界は拡張機能のコードで維持します。Chrome 自体はオプションページを信頼できる拡張機能ページとして扱います。
- オプションページで有効なアカウントや認証が無効になったアカウントを削除すると、そのアカウントのローカルに保存された認証情報だけが削除されます。
- GitHub App 自体の認可を取り消すには、GitHub の Applications 設定から削除してください。

全文は[公開プライバシーポリシー](https://github.com/hon454/github-pulls-show-reviewers/blob/main/docs/privacy-policy.md)をご覧ください。

## 支援

この拡張機能が役に立ったら、コーヒー一杯分のご支援をいただけるとうれしいです！

<a href="https://www.buymeacoffee.com/hon454s" target="_blank" rel="noopener noreferrer"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="コーヒー一杯分を支援する" width="217" height="60"></a>

## コントリビューター向け

このリポジトリは WXT、TypeScript、React、zod、Vitest、Playwright、pnpm を使用しています。

```bash
pnpm install
pnpm dev
```

`pnpm install` は pnpm のライフサイクルを通じて `wxt prepare` を自動実行するため、別途準備コマンドを実行する必要はありません。

主な検証コマンド:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm test:e2e
```

リリースのパッケージングやストアへの提出前には、次を実行してください。

```bash
pnpm verify:release
pnpm zip:release
```

`pnpm zip` は確認用のローカルビルドのみを作成します。Chrome Web Store 向けの本番パッケージングには `pnpm zip:release` を使います。このコマンドはメンテナーの GitHub App 識別子を読み込み、アップロード前に最終 ZIP を検証します。

新しい `v<version>` タグをプッシュすると、検証済みパッケージが GitHub Release に添付され、通常の審査で承認された後に自動公開されるよう CWS API v2 で提出されます。同一ソースの検証済みアップロード記録がすでにあり、審査待ちまたは公開済みの場合は、CWS への追加の書き込みを行わず、その検証済みパッケージを再利用します。手動ワークフローの既定値は `skip` です。認証情報のみを確認する `dry-run` は、ストアの状態を変更せず、リリースも作成しません。審査への提出とタグ作成には明示的な承認が必要です。段階的な提出、過去のタグ、ストア掲載情報の更新、検証の証跡、復旧手順については、[Chrome Web Store の手引き](./docs/chrome-web-store.md)と[エージェント標準実行手順](./docs/chrome-web-store-agent-runbook.md)に従ってください。

リポジトリの作業手順、ブランチ名、コミット形式、プルリクエストの要件については、[CONTRIBUTING.md](./CONTRIBUTING.md)をご覧ください。

## ドキュメント

README は対応する 5 言語で提供しています。以下の詳細な技術文書、貢献ガイド、運用文書は英語で管理しています。

- [ドキュメント管理と README 翻訳のガイドライン](./docs/guidelines/documentation-guideline.md)
- [実装ノート](./docs/implementation-notes.md)
- [Chrome の手動テスト](./docs/manual-chrome-testing.md)
- [Chrome Web Store の手引き](./docs/chrome-web-store.md)
- [Chrome Web Store 提出資料](./docs/chrome-web-store-submission.md)
- [Chrome Web Store エージェント実行手順](./docs/chrome-web-store-agent-runbook.md)
- [段階別 CWS 操作リファレンス](./docs/cws-agent-handoff.md)
- [ストア流入元の計測](./docs/growth/attribution.md)
- [公開・コミュニティ向け紹介文](./docs/growth/launch-kit.md)
- [プライバシーポリシー](./docs/privacy-policy.md)
- [セキュリティポリシー](./SECURITY.md)
- [リリースノート](./docs/releases/)
- [MIT ライセンス](./LICENSE)

## ローカライズ

拡張機能は英語（フォールバック言語）、韓国語、日本語、簡体字中国語、繁体字中国語に対応しています。Chrome のメタデータは Chrome の言語に従います。ローカルの `language` 設定は既定で `auto` になっており、拡張機能の UI 言語を手動で指定することもできます。オプションページ、表示設定、アカウント操作、GitHub のデバイスサインインフローはすべて 5 言語に対応しています。言語を変更すると、サインインの再開始、リポジトリ入力の消去、アカウント操作の再実行を伴わずに、開いている他のオプションタブにも反映されます。リポジトリ診断では、追加の API リクエストなしで既存の結果や実行中の状態の表示を変更します。開いている PR 一覧のレビュアーラベル、読み込み状態、ツールチップ、アクセシブルな名前、アクセス案内バナーも、データの再取得や待機中の処理の再開始なしで更新されます。閉じたバナーは閉じたままです。GitHub のコンテンツ、レビュアーの識別子、検索リンク、既存のレビュー状態の色・バッジ・優先順位は変わりません。製品名と GitHub App 名も変更しません。マニフェストと UI の境界や共通 API は[ローカライズ契約](./docs/adr/0006-bundled-localization-and-render-only-language.md)を、翻訳範囲、パッケージ検証、ブラウザーのネイティブ言語での検証の制約は[5 言語の用語集と QA レポート](./docs/localization.md)をご覧ください。

5 言語の [Chrome Web Store 紹介文とスクリーンショット](./docs/chrome-web-store-submission.md#per-locale-dashboard-checklist)は、パッケージ内の名前・概要カタログとは別に管理しています。`pnpm cws:assets` で合成した **TESTING** スクリーンショット 15 枚を再生成し、`pnpm verify:cws` で文章、リンク、画像の出所を検証します。既存の英語スクリーンショットとランディングページの参照先は維持します。これらの成果物は、本番設定、ダッシュボードへの登録、公開の完了を証明するものではありません。
