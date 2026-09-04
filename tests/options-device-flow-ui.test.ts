// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { AddAccountPanel } from "../entrypoints/options/components/AddAccountPanel";
import { authErrorKey } from "../entrypoints/options/auth-presentation";
import type { DeviceFlowState } from "../entrypoints/options/device-flow-controller";
import { createLocaleStore, type Locale } from "../src/i18n";

afterEach(cleanup);
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
    const controller = { state, start: vi.fn(), cancel: vi.fn() };
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
it("formats expiry in the selected locale with the existing timezone and preserves literal code/URL", () => {
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
  const controller = { state, start: vi.fn(), cancel: vi.fn() };
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
  expect(onCancel).toHaveBeenCalledOnce();
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
