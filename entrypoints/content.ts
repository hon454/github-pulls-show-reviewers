import { bootReviewerListPage } from "~/features/reviewers";

export default defineContentScript({
  matches: ["https://github.com/*/*/pulls*"],
  runAt: "document_idle",
  main(ctx) {
    bootReviewerListPage(ctx);
  },
});
