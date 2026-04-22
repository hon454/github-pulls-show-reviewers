export default defineBackground(() => {
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
      browser.runtime.openOptionsPage().catch((error) => {
        console.error("[GitHub Pulls Show Reviewers] Failed to open options page.", error);
      });
    }
  });

  browser.action.onClicked.addListener(() => {
    browser.runtime.openOptionsPage().catch((error) => {
      console.error("[GitHub Pulls Show Reviewers] Failed to open options page.", error);
    });
  });
});
