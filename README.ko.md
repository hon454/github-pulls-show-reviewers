# GitHub Pulls Show Reviewers

[![Chrome Web Store 버전](https://img.shields.io/chrome-web-store/v/hoocgjopdboeghdkfjlkngkkpbiljggk?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk?utm_source=github&utm_medium=readme_badge&utm_campaign=evergreen)
[![Chrome Web Store 사용자 수](https://img.shields.io/chrome-web-store/users/hoocgjopdboeghdkfjlkngkkpbiljggk?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk?utm_source=github&utm_medium=readme_badge&utm_campaign=evergreen)
[![CI](https://github.com/hon454/github-pulls-show-reviewers/actions/workflows/ci.yml/badge.svg)](https://github.com/hon454/github-pulls-show-reviewers/actions/workflows/ci.yml)

[English](./README.md) · **한국어** · [简体中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [日本語](./README.ja.md)

> GitHub 풀 리퀘스트 목록에서 리뷰를 요청한 사용자와 팀, 완료된 리뷰 상태를 바로 확인하세요.

`GitHub Pulls Show Reviewers`는 풀 리퀘스트 목록에 리뷰어 상태를 표시하는 데 집중한 Chrome 확장 프로그램입니다. 리뷰를 누구에게 요청했는지, 어떤 리뷰가 완료됐는지 확인하려고 PR을 하나씩 열 필요가 없습니다.

![리뷰어 칩과 리뷰 상태 배지가 표시된 GitHub PR 목록](./docs/chrome-web-store-assets/02-pr-list-avatar-state-showcase.png)

[v1.17.0 릴리스 노트](./docs/releases/v1.17.0.md)(영어): 연결 계정을 제한된 순서로 탐색하는 저장소 접근과 background가 소유하는 인증.

## 주요 기능

- GitHub 풀 리퀘스트 목록의 각 행에 리뷰를 요청한 사용자를 표시합니다.
- GitHub 풀 리퀘스트 목록의 각 행에 리뷰를 요청한 팀을 표시합니다.
- 리뷰어별 완료된 리뷰 상태를 표시합니다: 승인됨(`approved`), 변경 요청됨(`changes requested`), 의견 남김(`commented`), 리뷰 무효화됨(`dismissed`). 의견을 제외한 가장 최근 리뷰가 이후 의견보다 우선하며, 의견 외의 리뷰가 없을 때만 의견을 사용합니다.
- 리뷰어 칩을 GitHub PR 검색으로 연결합니다.
- 페이지 단위의 리뷰어 메타데이터를 화면에 표시되는 행에서 재사용합니다. GitHub REST API의 페이지네이션으로 해당 행을 가져올 수 있다면 검색 결과나 페이지를 넘긴 목록에서도 재사용합니다.
- 일반적인 탐색 중 GitHub가 페이지를 갱신해도 계속 동작합니다. 같은 PR의 기본 메타데이터가 확장 프로그램의 표시 영역을 대체하면 해당 영역을 복구합니다.
- 좁은 데스크톱 창이나 분할 화면에서도 리뷰어 메타데이터를 유지합니다. GitHub가 의도적으로 숨긴 메타데이터를 다시 표시하지는 않습니다.
- 리뷰어가 없는 PR 행은 기존 모습 그대로 유지합니다. 리뷰어 요청이 예기치 않게 실패하면 페이지에 새로고침 안내를 하나 표시하고, 이미 불러온 리뷰어 칩은 유지합니다. 실패한 행은 GitHub가 메타데이터를 갱신하거나 페이지를 새로고침하면 복구될 수 있습니다. API 요청 한도가 초기화되기를 기다리는 것만으로는 다시 요청하지 않습니다. 표시·언어 설정 변경은 실패한 행을 포함해 화면 표시만 갱신합니다.
- 계정을 연결하거나 설치의 저장소 접근 범위를 갱신한 뒤, 화면에 표시되는 모든 리뷰어 로드가 성공하면 더 이상 필요하지 않은 접근 안내를 지웁니다. 한 행의 성공이 다른 행의 실패나 대기 중인 요청을 숨기지 않으며, 각 행이 복구되면서 안내 내용이 완화될 수 있습니다. GitHub API 요청 한도가 초기화된 뒤에는 페이지를 새로고침해야 다시 불러옵니다. 초기화를 기다려도 자동으로 재개하지 않습니다.

## 이 확장 프로그램을 쓰는 이유

GitHub 풀 리퀘스트 목록에서는 제목, 작성자, 상태를 빠르게 훑어볼 수 있지만 리뷰어 정보는 놓치기 쉽습니다. PR을 열지 않고는 어떤 사용자나 팀에 리뷰를 요청했는지, 리뷰어별로 어떤 리뷰가 완료됐는지 확인하기 어렵습니다. 이 확장 프로그램은 각 PR 행에 간결한 `리뷰어:` 영역을 추가해 이 정보를 바로 보여줍니다.

![GitHub PR 목록의 리뷰어 칩 적용 전후 비교](./docs/chrome-web-store-assets/01-pr-list-before-after.png)

## 설치

[Chrome Web Store](https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk?utm_source=github&utm_medium=readme&utm_campaign=evergreen)에서 확장 프로그램을 설치하세요.

설치 후 GitHub 저장소의 풀 리퀘스트 목록을 열면 됩니다. 공개 저장소에서는 로그인 없이 사용할 수 있습니다. 비공개 저장소에서는 확장 프로그램의 옵션 페이지를 열고 해당 저장소에 접근할 수 있는 GitHub 계정을 추가하세요.

## 지원 브라우저 및 언어

현재 공식 지원 및 테스트 대상 브라우저는 Chrome입니다. Edge, Brave, Arc 등 다른 Chromium 계열 브라우저에서도 같은 MV3 빌드가 동작할 수 있지만, 현재 릴리스 대상이나 수동 Chrome 검증 범위에는 포함되지 않습니다. Firefox 역시 MV3 동작, 확장 프로그램 패키징, GitHub 로그인 흐름을 별도로 검증하기 전까지는 지원 범위에 포함되지 않습니다.

Chrome 메타데이터, 옵션, 로그인, 저장소 진단, 리뷰어 칩, 접근 안내 배너는 영어, 한국어, 일본어, 중국어 간체 및 번체를 지원합니다.

## 공개 및 비공개 저장소

- **공개 저장소:** GitHub가 충분한 공개 PR 데이터를 제공하면 로그인 없이 사용할 수 있습니다.
- **비공개 저장소:** 확장 프로그램의 GitHub App을 통해 GitHub에 로그인해야 합니다.
- **권한:** GitHub App은 `Pull requests: Read` 권한만 요청합니다.
- **저장소 접근:** GitHub가 접근을 거부하면 계정의 저장소 권한과 해당 소유자·저장소의 GitHub App 설치 접근 범위를 함께 확인하세요.
- **조직:** 비공개 조직 저장소를 읽으려면 조직 소유자가 GitHub App을 설치하거나 승인해야 할 수 있습니다.
- **여러 계정:** 개인 계정과 업무 계정을 함께 추가할 수 있습니다. `all` 설치는 App의 접근 범위를 뜻하며, 연결된 사용자마다 저장소 권한은 다를 수 있습니다. 인증된 저장소 요청에서 레이트 제한이 아닌 403/404가 발생하면 같은 소유자의 다른 활성 계정을 제한된 순서로 시도합니다. 로컬에서 접근 범위가 확인된 계정, 불완전한 선택 저장소 스냅샷이 있는 계정 순이며 각 그룹 안에서는 기존 계정 순서를 유지합니다. 계정별 시도는 페이지·저장소 세대당 한 번입니다. 성공한 계정은 해당 세대에서만 기억하며, 개별 PR의 404로 저장소 전체를 접근 불가로 판단하지 않습니다.
- **재시도와 진단:** 레이트 제한, 해결되지 않은 401, 네트워크·스키마·서버 오류, 취소는 계정 탐색을 중단합니다. 401 복구는 같은 계정 안에서만 진행합니다. 새로고침·탐색, 계정 재연결·삭제, 설치 접근 범위 변경, 명시적인 새 진단 실행은 새 세대를 시작할 수 있습니다. 행 갱신, 캐시 만료, 토큰 갱신, 언어·표시 변경은 실패한 계정을 다시 시도하지 않습니다. 일치 계정 진단은 같은 정책으로 실제 사용한 계정을 표시하며, 토큰 없는 진단은 익명으로만 실행합니다. 공개 저장소의 익명 접근과 후보가 하나로 명확할 때의 계정 대체 경로는 유지됩니다.
- **로그인 유지:** 브라우저를 닫았다가 다시 열어도 로그인이 유지됩니다. 계정을 제거하거나 GitHub App 승인을 취소할 때까지 백그라운드에서 접근 토큰을 자동으로 갱신합니다.
- **로그인 복구:** 백그라운드 worker가 일시 중지돼도 진행 중인 로그인은 이어집니다. 브라우저를 다시 시작했거나 인증 요청이 중단됐다면 새 코드를 요청하세요. 이미 연결한 계정은 그대로 저장됩니다.

## 설정

옵션 페이지에서 리뷰어 정보 표시에 집중한 기본 기능을 유지하면서 표시 방식을 조정할 수 있습니다.

- 리뷰어 아바타만 표시하거나 `@login`을 포함한 칩으로 표시합니다.
- 리뷰 상태 배지를 표시하거나 숨깁니다.
- 리뷰어 칩의 링크가 열린 PR만 검색할지, 닫힌 PR도 포함할지 선택합니다.
- 비공개 저장소의 계정, 저장소 접근, 설치의 접근 범위, 요청 한도 진단을 확인합니다.
- 로그인 중에는 현지화된 클립보드 피드백으로 복사 완료를 확인하거나 직접 복사 안내를 받습니다. 패널을 닫으면 유용한 키보드 초점이 복원되고, 연결 완료는 계정 영역에 남아 안내됩니다. 확장 프로그램 언어를 바꿔도 이 피드백만 다시 표시되며 로그인이 다시 시작되지는 않습니다.

![옵션 페이지의 표시 설정과 저장소 진단](./docs/chrome-web-store-assets/03-options-repository-check.png)

## 개인정보 보호

이 확장 프로그램은 풀 리퀘스트 목록에 리뷰어 정보를 표시하는 데 필요한 최소한의 접근 권한을 사용합니다.

- 공개 저장소에서는 로그인할 필요가 없습니다.
- 비공개 저장소에서는 확장 프로그램의 GitHub App을 통해 GitHub에 로그인합니다.
- GitHub App은 `Pull requests: Read` 권한만 요청합니다.
- OAuth, 인증된 요청과 인증 정보 저장은 백그라운드가 담당합니다. Content와 옵션 UI에는 계정 요약과 사용자용 로그인 진행 상태만 전달되며, 접근 토큰·갱신 토큰·OAuth 기기 코드 비밀값은 전달되지 않습니다.
- Chrome은 content script의 로컬 저장소 접근을 차단합니다. 옵션 UI의 토큰 제외 경계는 확장 프로그램의 코드가 지키며, Chrome은 옵션 페이지를 여전히 신뢰할 수 있는 확장 프로그램 페이지로 취급합니다.
- 옵션 페이지에서 활성 계정이나 인증이 무효화된 계정을 제거하면 해당 계정의 로컬 저장 인증 정보만 삭제됩니다.
- GitHub App 자체의 승인을 취소하려면 GitHub의 Applications 설정에서 제거하세요.

전체 정책은 [공개 개인정보 처리방침](https://github.com/hon454/github-pulls-show-reviewers/blob/main/docs/privacy-policy.md)을 참고하세요.

## 후원

이 확장 프로그램이 도움이 됐다면 커피 한 잔으로 응원해 주세요!

<a href="https://www.buymeacoffee.com/hon454s" target="_blank" rel="noopener noreferrer"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="커피 한 잔 후원하기" width="217" height="60"></a>

## 기여 안내

이 저장소는 WXT, TypeScript, React, zod, Vitest, Playwright, pnpm을 사용합니다.

```bash
pnpm install
pnpm dev
```

`pnpm install`은 pnpm 라이프사이클을 통해 `wxt prepare`를 자동으로 실행하므로 별도의 준비 단계가 필요하지 않습니다.

주요 검증 명령:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm test:e2e
```

릴리스 패키징이나 스토어 제출 전에는 다음 명령을 실행하세요.

```bash
pnpm verify:release
pnpm zip:release
```

`pnpm zip`은 검토용 로컬 빌드만 만듭니다. Chrome Web Store 배포 패키징에는 유지보수자의 GitHub App 식별자를 불러오고 업로드 전 최종 ZIP을 검증하는 `pnpm zip:release`를 사용합니다.

새 `v<version>` 태그를 푸시하면 검증된 패키지를 GitHub Release에 첨부하고, 일반 심사 승인 후 자동 게시되도록 CWS API v2로 제출합니다. 동일한 소스에 대해 검증된 업로드 기록이 이미 있고 심사 대기 또는 게시 상태라면, CWS에 다시 쓰기 작업을 수행하지 않고 해당 검증 패키지를 재사용합니다. 수동 워크플로 실행의 기본값은 `skip`이며, 인증 정보만 확인하는 `dry-run`은 스토어 상태를 변경하거나 릴리스를 만들지 않습니다. 심사 제출과 태그 생성에는 명시적인 승인이 필요합니다. 단계별 제출, 과거 태그, 스토어 등록 정보 수정, 검증 증빙, 복구 절차는 [Chrome Web Store 안내](./docs/chrome-web-store.md)와 [에이전트 표준 실행 지침](./docs/chrome-web-store-agent-runbook.md)을 따르세요.

저장소 작업 절차, 브랜치 이름, 커밋 형식, 풀 리퀘스트 요구사항은 [CONTRIBUTING.md](./CONTRIBUTING.md)를 참고하세요.

## 문서

README는 지원하는 5개 언어로 제공됩니다. 아래의 상세 기술 문서, 기여 지침, 운영 문서는 영어로 관리합니다.

- [문서 관리 및 README 번역 지침](./docs/guidelines/documentation-guideline.md)
- [구현 노트](./docs/implementation-notes.md)
- [수동 Chrome 테스트](./docs/manual-chrome-testing.md)
- [Chrome Web Store 안내](./docs/chrome-web-store.md)
- [Chrome Web Store 제출 자료](./docs/chrome-web-store-submission.md)
- [Chrome Web Store 에이전트 실행 지침](./docs/chrome-web-store-agent-runbook.md)
- [단계별 CWS 작업 참조](./docs/cws-agent-handoff.md)
- [스토어 유입 경로 추적](./docs/growth/attribution.md)
- [출시 및 커뮤니티 소개 문구](./docs/growth/launch-kit.md)
- [개인정보 처리방침](./docs/privacy-policy.md)
- [보안 정책](./SECURITY.md)
- [릴리스 노트](./docs/releases/)
- [MIT 라이선스](./LICENSE)

## 현지화

확장 프로그램은 영어(기본 대체 언어), 한국어, 일본어, 중국어 간체 및 번체를 지원합니다. Chrome 메타데이터는 Chrome의 언어를 따릅니다. 로컬 `language` 설정의 기본값은 `auto`이며 확장 프로그램 UI의 언어를 직접 지정할 수도 있습니다. 옵션 페이지, 표시 설정, 계정 작업, GitHub 기기 로그인 흐름은 모두 5개 언어를 지원합니다. 언어를 변경하면 로그인을 다시 시작하거나 저장소 입력을 지우거나 계정 작업을 반복하지 않고도 열려 있는 다른 옵션 탭에 반영됩니다. 저장소 진단은 추가 API 요청 없이 기존 결과와 실행 중 상태의 표시를 바꿉니다. 열려 있는 PR 목록의 리뷰어 라벨, 로딩 상태, 툴팁, 접근성 이름, 접근 안내 배너도 데이터를 다시 가져오거나 대기 중인 작업을 재시작하지 않고 갱신됩니다. 닫은 배너는 다시 나타나지 않습니다. GitHub 콘텐츠, 리뷰어 식별자, 검색 링크, 기존 리뷰 상태 색상·배지·우선순위는 유지됩니다. 제품명과 GitHub App 이름도 변경하지 않습니다. 매니페스트와 UI의 경계 및 공통 API는 [현지화 계약](./docs/adr/0006-bundled-localization-and-render-only-language.md)을, 번역 범위·패키지 검증·브라우저 기본 언어 검증의 한계는 [5개 언어 용어집과 QA 보고서](./docs/localization.md)를 참고하세요.

5개 언어의 [Chrome Web Store 문구와 스크린샷](./docs/chrome-web-store-submission.md#per-locale-dashboard-checklist)은 패키지에 포함되는 이름·요약 카탈로그와 별도로 관리합니다. `pnpm cws:assets`로 합성 **TESTING** 스크린샷 15장을 다시 생성하고, `pnpm verify:cws`로 문구, 링크, 이미지 출처를 검증합니다. 기존 영어 스크린샷과 랜딩 페이지 참조는 경로를 유지합니다. 이 자료만으로는 실제 배포 설정, 대시보드 등록, 게시 완료를 입증할 수 없습니다.
