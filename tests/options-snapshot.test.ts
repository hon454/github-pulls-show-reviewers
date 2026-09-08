// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisplaySettingsPanel } from "../entrypoints/options/components/DisplaySettingsPanel";
import { OptionsPage } from "../entrypoints/options/options-page";
import { createTranslator } from "../src/i18n";
import { getLocaleStore } from "../src/i18n/browser";
import { disposeUIClient, getUIClient } from "../src/runtime/ui-client";
import { accountMutations } from "../src/storage/accounts";
import { connectInput } from "./helpers/auth-harness";
import {
  createUIBridgeHarness,
  optionsSender,
  containsSecret,
  deferred,
  drain,
} from "./helpers/ui-bridge-harness";

let harness: ReturnType<typeof createUIBridgeHarness>;
let other: ReturnType<ReturnType<typeof createUIBridgeHarness>["client"]>;
beforeEach(async () => {
  harness = createUIBridgeHarness();
  other = harness.client(optionsSender("options-2"));
  other.subscribe(() => {});
  await other.read();
});
afterEach(async () => {
  cleanup();
  getLocaleStore().dispose();
  disposeUIClient();
  other.dispose();
  await drain();
  expect(
    containsSecret([harness.replies, [...harness.notifications.values()]]),
  ).toBe(false);
  harness.dispose();
  await drain();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const checkbox = (name: string) =>
  document.querySelector<HTMLInputElement>(`[data-testid="prefs-${name}"]`)!;

describe("options components with two real background clients and delayed transport replies", () => {
  it.each(["different", "same"])(
    "keeps a newer %s-field notification after an older patch reply",
    async (field) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      harness.browserMock.runtime.sendMessage.mockImplementation(
        async (request) => {
          const response = await harness.send(request);
          if ((request as { type: string }).type === "patchPreferences") {
            entered.resolve();
            await release.promise;
          }
          return response;
        },
      );
      render(
        createElement(DisplaySettingsPanel, { t: createTranslator("en") }),
      );
      await waitFor(() =>
        expect(checkbox("show-state-badge").checked).toBe(true),
      );
      await act(async () => {
        await getUIClient().read();
      });
      fireEvent.click(checkbox("show-state-badge"));
      await act(async () => {
        await entered.promise;
      });
      await act(async () => {
        await other.patchPreferences({
          type: "patchPreferences",
          patch:
            field === "same"
              ? { showStateBadge: true }
              : { showReviewerName: true },
        });
      });
      expect(
        checkbox(field === "same" ? "show-state-badge" : "show-reviewer-name")
          .checked,
      ).toBe(true);
      await act(async () => {
        release.resolve();
        await drain();
      });
      await waitFor(() =>
        expect(checkbox("show-state-badge").disabled).toBe(false),
      );
      expect(checkbox("show-state-badge").checked).toBe(field === "same");
      expect(checkbox("show-reviewer-name").checked).toBe(
        field === "different",
      );
      expect((await getUIClient().read()).preferences).toEqual(
        harness.storage.snapshot().preferences,
      );
    },
  );

  it("does not overwrite display changes with an older initial snapshot completion", async () => {
    const client = getUIClient();
    const read = client.read;
    const entered = deferred<void>();
    const release = deferred<void>();
    vi.spyOn(client, "read").mockImplementationOnce(async () => {
      const old = await read();
      entered.resolve();
      await release.promise;
      return old;
    });
    render(createElement(DisplaySettingsPanel, { t: createTranslator("en") }));
    await act(async () => {
      await entered.promise;
    });
    await act(async () => {
      await other.patchPreferences({
        type: "patchPreferences",
        patch: { showReviewerName: true, openPullsOnly: false },
      });
    });
    expect(checkbox("show-reviewer-name").checked).toBe(true);
    await act(async () => {
      release.resolve();
      await drain();
    });
    expect(checkbox("show-reviewer-name").checked).toBe(true);
    expect(checkbox("open-pulls-only").checked).toBe(false);
  });

  it("does not restore a removed account from an older reload completion", async () => {
    const account = await accountMutations.upsertAccountByLogin(connectInput());
    const client = getUIClient();
    const read = client.read;
    const entered = deferred<void>();
    const release = deferred<void>();
    vi.spyOn(client, "read").mockImplementation(async () => {
      const old = await read();
      entered.resolve();
      await release.promise;
      return old;
    });
    render(createElement(OptionsPage));
    await act(async () => {
      await entered.promise;
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="account-card-octocat"]'),
      ).not.toBeNull(),
    );
    await act(async () => {
      await harness.send(
        { type: "removeAccount", accountId: account.id },
        optionsSender("options-2"),
      );
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="accounts-empty"]'),
      ).not.toBeNull(),
    );
    await act(async () => {
      release.resolve();
      await drain();
    });
    expect(
      document.querySelector('[data-testid="account-card-octocat"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="accounts-empty"]'),
    ).not.toBeNull();
  });
});
