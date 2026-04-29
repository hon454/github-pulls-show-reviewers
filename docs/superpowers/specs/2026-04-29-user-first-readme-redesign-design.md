# User-First README Redesign Design

## Goal

Redesign the README so its first impression is a product page for users, not an internal project dossier. The README should explain what the Chrome extension does, why it is useful, how to install it, what permissions it needs, and where contributors can find development details.

## Audience

The README serves both users and contributors, with users first:

- Primary: Chrome Web Store or GitHub visitors deciding whether to install the extension.
- Secondary: open-source contributors looking for setup and validation links.

## Non-Goals

- Do not expand the product beyond reviewer visibility on GitHub pull request lists.
- Do not turn the README into a general architecture index.
- Do not surface ADR links directly from the README.
- Do not remove developer documentation from the repository; move or link to it from lower-level docs instead.

## Proposed README Shape

The README should open with the extension's user value:

1. Title, short value proposition, Chrome Web Store badges, and hero screenshot.
2. A short explanation that the extension shows reviewer information directly on GitHub PR list pages.
3. User-focused sections:
   - `What It Does`
   - `Install`
   - `Public And Private Repositories`
   - `Settings`
   - `Privacy`
   - `FAQ`, if useful during implementation
4. A short contributor section:
   - `For Contributors`
   - Minimal setup and validation commands
   - Links to `CONTRIBUTING.md`, implementation notes, manual Chrome testing, and store notes
5. A compact documentation section with user- and contributor-facing links only.

## Content Rules

- Keep the top half focused on user outcomes: requested reviewers, requested teams, and latest completed review state.
- Explain authentication in user terms:
  - Public repositories work without signing in.
  - Private repositories require GitHub sign-in through the maintainer-owned GitHub App.
  - The GitHub App requests `Pull requests: Read` only.
  - Multiple accounts can be added side by side.
- Keep permission and privacy language clear and reassuring without exposing implementation rationale.
- Remove direct README references to ADRs, MVP implementation constraints, and internal decision records.
- Avoid internal-first terms such as "MVP" in user-facing sections.
- Keep development setup concise. Detailed repository structure, release workflow, and design rationale should live in existing docs.

## Documentation Boundaries

README should link to:

- `CONTRIBUTING.md`
- `docs/implementation-notes.md`
- `docs/manual-chrome-testing.md`
- `docs/chrome-web-store.md`
- `docs/privacy-policy.md`

README should not link directly to ADR files. ADRs may remain linked from implementation notes or other internal development docs.

## Validation

When implementing the redesign:

- Confirm no README references to `ADR` remain.
- Confirm the README still links to the Chrome Web Store listing.
- Confirm public/private repository behavior and permission language match the current extension behavior.
- Confirm contributor commands remain accurate for the current package scripts.
- Run the narrowest useful check, likely documentation inspection plus any markdown or repository validation command available.

