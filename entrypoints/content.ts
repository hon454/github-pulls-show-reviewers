import { bootReviewerListPage } from "../src/features/reviewers";

export default defineContentScript({
  matches: ["https://github.com/*/*"],
  runAt: "document_idle",
  main(ctx) {
    bootReviewerListPage(ctx);
  },
});
