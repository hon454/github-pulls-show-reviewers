// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { AddAccountPanel } from "../entrypoints/options/components/AddAccountPanel";
import { authErrorKey } from "../entrypoints/options/auth-presentation";
import type { DeviceFlowState } from "../entrypoints/options/device-flow-controller";
import { createLocaleStore, type Locale } from "../src/i18n";

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());
function locale(language: Locale) {
  return createLocaleStore({
    getUILanguage: () => language,
    readLanguage: async () => "auto",
    writeLanguage: async () => undefined,
    subscribe: () => () => undefined,
  }).getSnapshot();
}
it.each([
  [{ phase: "idle" }, "Requesting device code", "기기 코드 요청"],
  [{ phase: "initiating" }, "Requesting device code", "기기 코드 요청"],
  [
    { phase: "fetching_installations" },
    "Loading your installations",
    "설치 정보 불러오는 중",
  ],
  [
    { phase: "connected", accountId: "account-1" },
    "Account connected",
    "계정을 연결했습니다",
  ],
  [{ phase: "expired" }, "The device code expired", "기기 코드가 만료"],
  [{ phase: "denied" }, "Authorization was denied", "승인이 거부"],
  [
    { phase: "fatal", code: "device_flow_disabled" },
    "Device flow is disabled",
    "기기 인증이 비활성화",
  ],
  [
    { phase: "fatal", code: "unknown_error" },
    "Could not complete sign-in",
    "로그인을 완료하지 못했습니다",
  ],
] satisfies [DeviceFlowState, string, string][])(
  "reformats %j with an existing controller",
  (state, english, korean) => {
    const controller = {
      state,
      start: vi.fn(),
      cancel: vi.fn(async () => true),
    };
    const props = { controller, onCancel: vi.fn(), locale: locale("en") };
    const view = render(createElement(AddAccountPanel, props));
    expect(view.container.textContent).toContain(english);
    view.rerender(
      createElement(AddAccountPanel, { ...props, locale: locale("ko") }),
    );
    expect(view.container.textContent).toContain(korean);
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.cancel).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="status"]')).not.toBeNull();
    const retry = Array.from(view.container.querySelectorAll("button")).find(
      (button) => /새 코드 생성|다시 시도/.test(button.textContent ?? ""),
    );
    if (retry) {
      fireEvent.click(retry);
      expect(controller.start).toHaveBeenCalledOnce();
    }
  },
);
it("formats expiry in the selected locale with the existing timezone and preserves literal code/URL", async () => {
  const expiresAt = Date.UTC(2026, 8, 4, 12, 34, 56);
  const state: DeviceFlowState = {
    phase: "waiting",
    userCode: "ABCD-EFGH",
    verificationUri: "https://github.com/login/device",
    verificationUriComplete:
      "https://github.com/login/device?user_code=ABCD-EFGH",
    interval: 5,
    expiresAt,
  };
  const controller = { state, start: vi.fn(), cancel: vi.fn(async () => true) };
  const onCancel = vi.fn();
  const view = render(
    createElement(AddAccountPanel, {
      controller,
      onCancel,
      locale: locale("en"),
    }),
  );
  for (const language of ["en", "ko", "ja", "zh_CN", "zh_TW"] as const) {
    view.rerender(
      createElement(AddAccountPanel, {
        controller,
        onCancel,
        locale: locale(language),
      }),
    );
    expect(view.container.textContent).toContain(
      new Date(expiresAt).toLocaleTimeString(language.replace("_", "-")),
    );
    expect(view.getByTestId("device-user-code").textContent).toBe("ABCD-EFGH");
    expect(view.container.querySelector("a")?.href).toBe(
      state.verificationUriComplete,
    );
  }
  fireEvent.click(view.getByText("取消"));
  expect(controller.cancel).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(onCancel).toHaveBeenCalledOnce();
});

function waitingState(userCode = "ABCD-EFGH"): DeviceFlowState {
  return {
    phase: "waiting",
    userCode,
    verificationUri: "https://github.com/login/device",
    verificationUriComplete: `https://github.com/login/device?user_code=${userCode}`,
    interval: 5,
    expiresAt: Date.UTC(2026, 8, 4, 12, 34, 56),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("awaits one clipboard write, reports its localized result, and keeps focus stable through locale changes", async () => {
  const write = deferred<void>();
  const writeText = vi.fn(() => write.promise);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const controller = {
    state: waitingState(),
    start: vi.fn(),
    cancel: vi.fn(async () => true),
  };
  const panelRef = { current: null };
  const view = render(
    createElement(AddAccountPanel, {
      controller,
      onCancel: vi.fn(),
      locale: locale("en"),
      panelRef,
    }),
  );
  const panel = view.getByTestId("add-account-panel");
  expect(document.activeElement).toBe(panel);
  expect(
    view.getByRole("region", { name: locale("en").t("options_add_account") }),
  ).toBe(panel);

  const copy = view.getByRole("button", {
    name: "Copy",
  }) as HTMLButtonElement;
  fireEvent.click(copy);
  fireEvent.click(copy);
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(copy.disabled).toBe(true);

  view.rerender(
    createElement(AddAccountPanel, {
      controller,
      onCancel: vi.fn(),
      locale: locale("ko"),
      panelRef,
    }),
  );
  expect(document.activeElement).toBe(panel);
  expect(controller.start).not.toHaveBeenCalled();
  await act(async () => write.resolve());

  expect(view.getByTestId("clipboard-feedback").textContent).toContain(
    "코드를 복사했습니다",
  );
  for (const language of ["en", "ja", "zh_CN", "zh_TW"] as const) {
    view.rerender(
      createElement(AddAccountPanel, {
        controller,
        onCancel: vi.fn(),
        locale: locale(language),
        panelRef,
      }),
    );
    expect(view.getByTestId("clipboard-feedback").textContent).toBe(
      locale(language).t("auth_code_copied"),
    );
  }
  expect(
    view.getByTestId("clipboard-feedback").getAttribute("aria-atomic"),
  ).toBe("true");
  expect(
    (
      view.getByRole("button", {
        name: locale("zh_TW").t("auth_copy"),
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it("reports rejected or unavailable clipboard writes without exposing an external error", async () => {
  const rejected = vi.fn(async () => {
    throw new Error("private browser rejection");
  });
  vi.stubGlobal("navigator", { clipboard: { writeText: rejected } });
  const controller = {
    state: waitingState(),
    start: vi.fn(),
    cancel: vi.fn(async () => true),
  };
  const view = render(
    createElement(AddAccountPanel, {
      controller,
      onCancel: vi.fn(),
      locale: locale("en"),
    }),
  );
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "Copy" })),
  );
  expect(view.getByTestId("clipboard-feedback").textContent).toContain(
    "Could not copy the code. Select and copy it manually.",
  );
  expect(view.container.textContent).not.toContain("private browser rejection");

  vi.stubGlobal("navigator", {});
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "Copy" })),
  );
  expect(view.getByTestId("clipboard-feedback").textContent).toContain(
    "Could not copy the code. Select and copy it manually.",
  );
});

it("does not let an old code's delayed clipboard result replace the next code's feedback", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const writeText = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const controller = {
    state: waitingState("OLD-CODE"),
    start: vi.fn(),
    cancel: vi.fn(async () => true),
  };
  const view = render(
    createElement(AddAccountPanel, {
      controller,
      onCancel: vi.fn(),
      locale: locale("en"),
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Copy" }));
  controller.state = waitingState("NEW-CODE");
  view.rerender(
    createElement(AddAccountPanel, {
      controller,
      onCancel: vi.fn(),
      locale: locale("en"),
    }),
  );
  expect(view.getByTestId("device-user-code").textContent).toBe("NEW-CODE");
  const copy = view.getByRole("button", {
    name: "Copy",
  }) as HTMLButtonElement;
  expect(copy.disabled).toBe(false);
  await act(async () => fireEvent.click(copy));
  expect(writeText).toHaveBeenCalledTimes(2);
  await act(async () => first.resolve());
  expect(view.getByTestId("clipboard-feedback").textContent).toBe("");
  await act(async () => second.resolve());
  expect(view.getByTestId("clipboard-feedback").textContent).toContain(
    "Code copied.",
  );
  expect(writeText).toHaveBeenNthCalledWith(1, "OLD-CODE");
  expect(writeText).toHaveBeenNthCalledWith(2, "NEW-CODE");
});

it.each([
  {
    name: "successful",
    writeText: vi.fn(async () => undefined),
    feedback: "Code copied.",
  },
  {
    name: "failed",
    writeText: vi.fn(async () => {
      throw new Error("clipboard denied");
    }),
    feedback: "Could not copy the code. Select and copy it manually.",
  },
])(
  "does not reuse a settled $name copy result when a device code returns in a new generation",
  async ({ writeText, feedback }) => {
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const controller = {
      state: waitingState("FIRST-CODE"),
      start: vi.fn(),
      cancel: vi.fn(async () => true),
    };
    const view = render(
      createElement(AddAccountPanel, {
        controller,
        onCancel: vi.fn(),
        locale: locale("en"),
      }),
    );
    await act(async () =>
      fireEvent.click(view.getByRole("button", { name: "Copy" })),
    );
    expect(view.getByTestId("clipboard-feedback").textContent).toBe(feedback);

    controller.state = waitingState("SECOND-CODE");
    view.rerender(
      createElement(AddAccountPanel, {
        controller,
        onCancel: vi.fn(),
        locale: locale("en"),
      }),
    );
    expect(view.getByTestId("clipboard-feedback").textContent).toBe("");

    controller.state = waitingState("FIRST-CODE");
    view.rerender(
      createElement(AddAccountPanel, {
        controller,
        onCancel: vi.fn(),
        locale: locale("en"),
      }),
    );
    expect(view.getByTestId("clipboard-feedback").textContent).toBe("");
  },
);

it("lets a recurring code start a new copy while its earlier generation is pending", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const writeText = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const controller = {
    state: waitingState("FIRST-CODE"),
    start: vi.fn(),
    cancel: vi.fn(async () => true),
  };
  const view = render(
    createElement(AddAccountPanel, {
      controller,
      onCancel: vi.fn(),
      locale: locale("en"),
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Copy" }));

  controller.state = waitingState("SECOND-CODE");
  view.rerender(
    createElement(AddAccountPanel, {
      controller,
      onCancel: vi.fn(),
      locale: locale("en"),
    }),
  );
  controller.state = waitingState("FIRST-CODE");
  view.rerender(
    createElement(AddAccountPanel, {
      controller,
      onCancel: vi.fn(),
      locale: locale("en"),
    }),
  );

  const copy = view.getByRole("button", { name: "Copy" }) as HTMLButtonElement;
  expect(copy.disabled).toBe(false);
  fireEvent.click(copy);
  expect(writeText).toHaveBeenCalledTimes(2);

  await act(async () => first.resolve());
  expect(view.getByTestId("clipboard-feedback").textContent).toBe("");
  await act(async () => second.resolve());
  expect(view.getByTestId("clipboard-feedback").textContent).toBe(
    "Code copied.",
  );
});
it.each([
  ["expired_token", "auth_expired"],
  ["access_denied", "auth_denied"],
  ["device_flow_disabled", "auth_error_disabled"],
  ["unsupported_grant_type", "auth_error_grant"],
  ["incorrect_client_credentials", "auth_error_client"],
  ["incorrect_device_code", "auth_error_device_code"],
  ["network_error", "auth_error_network"],
  ["invalid_response", "auth_error_invalid_response"],
  ["constructor", "auth_error_unknown"],
])("maps stable code %s to %s", (code, key) =>
  expect(authErrorKey(code)).toBe(key),
);
