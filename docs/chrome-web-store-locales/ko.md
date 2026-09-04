# 한국어 Chrome Web Store listing (`ko`)

## Packaged name and short description

Name: `GitHub Pulls Show Reviewers`

Short description source: [`extension_description.message`](../../public/_locales/ko/messages.json).
Use that catalog value verbatim; there is no separately editable summary here.
`extension_name.message` in the same catalog must match the name above.
Run `pnpm verify:cws` to print the current values and check the 75/132 character limits.
Chrome selects packaged metadata independently of the manual extension UI language.

## Detailed description

<!-- description:start -->
GitHub Pulls Show Reviewers는 GitHub 풀 리퀘스트 목록에 리뷰어 정보를 바로 표시합니다. 풀 리퀘스트를 하나씩 열지 않고도 리뷰를 요청받은 사람과 팀, 각 리뷰어의 완료된 리뷰 상태를 확인할 수 있습니다.

리뷰 요청을 받은 사람은 테두리로 표시합니다. 완료된 리뷰에는 승인됨, 변경 요청됨, 의견 남김, 리뷰 무효화됨 상태에 따른 배지가 붙습니다. 리뷰를 완료한 뒤에도 요청 상태가 남아 있을 수 있으며, 승인·변경 요청·무효화된 리뷰 이후에 새 요청이 확인되면 새로고침 배지로 재요청을 표시합니다. 팀 표시는 리뷰를 요청받은 팀을 뜻하며 팀의 승인 상태를 나타내지 않습니다. 아직 제출하지 않은 대기 중인 리뷰는 표시하지 않습니다.

옵션에서 리뷰어 사용자 이름과 상태 배지의 표시 여부를 바꾸고, 리뷰어 링크의 검색 대상을 열린 풀 리퀘스트로 제한할 수 있습니다. 저장소 진단으로 접근 문제도 확인할 수 있습니다. 확장 프로그램은 리뷰어 정보에 집중하며 검사 결과, 병합 가능 여부, 담당자, 라벨은 추가하지 않습니다.

공개 저장소는 계정이나 토큰 없이 사용할 수 있으며 GitHub의 비인증 API 요청 한도가 적용됩니다. 비공개 저장소에서는 관리자가 운영하는 GitHub App의 OAuth Device Flow로 GitHub에 로그인합니다. App이 요청하는 저장소 권한은 Pull requests: Read뿐입니다. 사용자 계정과 App 설치 모두 해당 저장소에 접근할 수 있어야 하며, 로그인만으로 접근 권한이 생기지는 않습니다. 여러 GitHub 계정을 연결할 수 있고 계정 인증 정보와 설정은 브라우저에 로컬로 저장됩니다. 리뷰어 데이터 요청은 GitHub로 직접 전송되며 확장 프로그램이 운영하는 별도 백엔드는 없습니다.

확장 프로그램 UI는 영어, 한국어, 일본어, 중국어 간체와 번체를 지원합니다. 기본값은 Chrome UI 언어를 따르며 지원하지 않는 언어는 영어로 표시합니다. 옵션에서 언어를 직접 선택하면 선택한 값이 저장됩니다. 언어를 바꿔도 리뷰어 데이터를 다시 가져오지 않고 확장 프로그램 UI만 갱신합니다. 패키지의 이름과 요약 언어는 Chrome이 별도로 선택하며 UI 언어 설정으로 스토어 등록정보의 언어가 바뀌지는 않습니다.

GitHub 페이지, 풀 리퀘스트 제목, 사용자 이름, 팀 이름, GitHub 외부 인증 페이지는 번역하지 않습니다. 랜딩 페이지, 개인정보 처리방침과 연결된 개발자 문서는 영어로 제공됩니다.
<!-- description:end -->

## Ordered screenshot inventory

Upload these three images to this locale, in order. Text below describes each
scene for review; it is not an additional dashboard field to populate.

1. [01-pr-list-before-after.png](../chrome-web-store-assets/ko/01-pr-list-before-after.png) — 사용 전과 후: GitHub 풀 리퀘스트 목록에 바로 표시되는 리뷰어 정보.
1. [02-pr-list-avatar-state-showcase.png](../chrome-web-store-assets/ko/02-pr-list-avatar-state-showcase.png) — 요청받은 리뷰어와 팀, 완료된 리뷰 상태를 테두리와 배지로 확인.
1. [03-options-repository-check.png](../chrome-web-store-assets/ko/03-options-repository-check.png) — 표시 설정과 토큰 없는 공개 저장소 진단.

<!-- capture-before: 사용 전 -->
<!-- capture-after: 사용 후 -->

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
