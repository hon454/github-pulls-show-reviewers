# 日本語 Chrome Web Store listing (`ja`)

## Packaged name and short description

Name: `GitHub Pulls Show Reviewers`

Short description source: [`extension_description.message`](../../public/_locales/ja/messages.json).
Use that catalog value verbatim; there is no separately editable summary here.
`extension_name.message` in the same catalog must match the name above.
Run `pnpm verify:cws` to print the current values and check the 75/132 character limits.
Chrome selects packaged metadata independently of the manual extension UI language.

## Detailed description

<!-- description:start -->
GitHub Pulls Show Reviewersは、GitHubのプルリクエスト一覧にレビュアー情報を表示します。各プルリクエストを開かずに、レビューを依頼したレビュアーやチーム、各レビュアーの完了済みレビューの状態を確認できます。

レビュー依頼中のレビュアーには枠線が付きます。完了済みレビューは、承認済み、変更要求済み、コメント済み、レビュー取り消し済みの状態をバッジで表示します。レビュー完了後も依頼が残る場合があります。承認、変更要求、取り消し済みレビューの後に新しい依頼が確認された場合は、更新バッジで再依頼を示します。チーム表示はレビューを依頼したチームを示し、チームの承認状況を示すものではありません。未送信の保留中レビューは表示しません。

設定では、レビュアーのユーザー名や状態バッジの表示を切り替え、レビュアーのリンク先を開いているプルリクエストに限定することもできます。リポジトリ診断でアクセスの問題を確認できます。対象はレビュアー情報に限り、チェック結果、マージ可否、担当者、ラベルは追加しません。

公開リポジトリはアカウントやトークンなしで利用できますが、GitHubの未認証APIのレート制限が適用されます。非公開リポジトリには、メンテナーが管理するGitHub AppのOAuth Device Flowを使ってGitHubにログインします。Appが要求するリポジトリ権限はPull requests: Readのみです。利用には、アカウントとAppのインストール先の両方が対象リポジトリにアクセスできる必要があり、ログインだけでアクセス権が付与されることはありません。複数のGitHubアカウントを接続できます。アカウントの認証情報と設定はブラウザ内にローカル保存されます。レビュアーデータのリクエストはGitHubに直接送られ、拡張機能が運営するバックエンドはありません。

拡張機能のUIは英語、韓国語、日本語、簡体字中国語、繁体字中国語に対応しています。初期設定ではChromeのUI言語に従い、非対応の言語には英語を使用します。設定で言語を手動選択すると、その選択が保存されます。言語の変更はUIの再表示のみで、レビュアーデータを再取得しません。パッケージの名前と概要の言語はChromeが別途選択するため、UIの設定ではストア掲載情報の言語は変わりません。

GitHubのページ、プルリクエストのタイトル、ユーザー名、チーム名、GitHubの外部認証ページは翻訳しません。ランディングページ、プライバシーポリシー、リンク先の開発者ドキュメントは英語です。
<!-- description:end -->

## Ordered screenshot inventory

Upload these three images to this locale, in order. Text below describes each
scene for review; it is not an additional dashboard field to populate.

1. [01-pr-list-before-after.png](../chrome-web-store-assets/ja/01-pr-list-before-after.png) — 導入前と導入後：GitHubのプルリクエスト一覧にレビュアー情報を表示。
1. [02-pr-list-avatar-state-showcase.png](../chrome-web-store-assets/ja/02-pr-list-avatar-state-showcase.png) — 依頼中のレビュアーとチーム、完了済みレビューの状態を枠線とバッジで確認。
1. [03-options-repository-check.png](../chrome-web-store-assets/ja/03-options-repository-check.png) — 表示設定とトークンを使わない公開リポジトリの診断。

<!-- capture-before: 導入前 -->
<!-- capture-after: 導入後 -->

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
