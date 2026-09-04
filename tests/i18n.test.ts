import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createLocaleStore,
  createTranslator,
  formatMessage,
  resolveLocale,
  toLanguageTag,
} from "../src/i18n";
import type {
  MessageKey,
  LanguagePreference,
  LocaleAdapter,
} from "../src/i18n";
import { catalogs } from "../src/i18n/catalogs";
import { validateCatalogs } from "../src/i18n/validation";
import type { Catalog } from "../src/i18n/messages";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness(read = Promise.resolve<LanguagePreference>("auto")) {
  let event: ((language: LanguagePreference) => void) | undefined;
  const remove = vi.fn(() => {
    event = undefined;
  });
  const adapter: LocaleAdapter = {
    getUILanguage: () => "ko-KR",
    readLanguage: vi.fn(() => read),
    writeLanguage: vi.fn(async () => undefined),
    subscribe: vi.fn((listener) => {
      event = listener;
      return remove;
    }),
  };
  return {
    adapter,
    remove,
    emit: (language: LanguagePreference) => event?.(language),
    store: createLocaleStore(adapter),
  };
}

describe("locale resolution without browser globals", () => {
  it.each([
    ["en", "en"],
    ["EN_us", "en"],
    ["en-GB", "en"],
    ["ko", "ko"],
    ["ko-KR", "ko"],
    ["ja", "ja"],
    ["ja_JP", "ja"],
    ["zh_CN", "zh_CN"],
    ["zh_TW", "zh_TW"],
    ["zh-SG", "zh_CN"],
    ["zh-HK", "zh_TW"],
    ["zh-MO", "zh_TW"],
    ["zh", "zh_CN"],
    ["zh-Hans", "zh_CN"],
    ["zh-Hant", "zh_TW"],
    ["zh-Hans-TW", "zh_CN"],
    ["zh-Hant-CN", "zh_TW"],
    [" ZH_hAnT_sG ", "zh_TW"],
    ["fr", "en"],
    ["", "en"],
    ["unsupported", "en"],
  ])("%s resolves to %s", (input, expected) =>
    expect(resolveLocale(input)).toBe(expected),
  );
  it("uses BCP 47 tags for Intl and HTML lang", () => {
    expect(toLanguageTag("zh_CN")).toBe("zh-CN");
    expect(toLanguageTag("zh_TW")).toBe("zh-TW");
    expect(toLanguageTag("ko")).toBe("ko");
  });
});

describe("plain text formatting and catalog contracts", () => {
  const en: Catalog = {
    options_example: {
      message: "$NAME$ owes $$ $COUNT$ to $NAME$.",
      description: "test",
      placeholders: { name: { content: "$1" }, count: { content: "$2" } },
    },
  };
  it("supports reordered/repeated named placeholders and literal dollars without reparsing values", () => {
    const translated = {
      options_example: {
        ...en.options_example,
        message: "$COUNT$ / $NAME$ / $NAME$ / $$",
      },
    };
    expect(
      formatMessage(translated, en, "options_example", {
        name: "<script>$COUNT$</script>",
        count: 2,
      }),
    ).toBe("2 / <script>$COUNT$</script> / <script>$COUNT$</script> / $");
    expect(
      formatMessage(en, en, "options_example", { name: "$&", count: 0 }),
    ).toBe("$& owes $ 0 to $&.");
  });
  it("falls back to English, then the key, and preserves an absent argument", () => {
    expect(
      formatMessage({}, en, "options_example", { name: "Lee", count: 3 }),
    ).toBe("Lee owes $ 3 to Lee.");
    expect(formatMessage({}, {}, "unknown")).toBe("unknown");
    expect(formatMessage({}, {}, "constructor")).toBe("constructor");
    expect(formatMessage(en, en, "options_example")).toBe(
      "$NAME$ owes $ $COUNT$ to $NAME$.",
    );
    expect(createTranslator("ja")("extension_name")).toBe(
      "GitHub Pulls Show Reviewers",
    );
  });
  it("requires complete nonempty catalogs with equal placeholder contracts", () => {
    expectTypeOf<keyof typeof catalogs.en>().toEqualTypeOf<MessageKey>();
    expect(validateCatalogs(catalogs)).toEqual([]);
    expect(validateCatalogs({ en, ko: en })).toEqual([]);
    expect(validateCatalogs({ en, ko: {} })).toContain(
      "ko: keys differ from English",
    );
    expect(
      validateCatalogs({
        en,
        ko: { options_example: { message: "", description: "" } },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("empty translation"),
        expect.stringContaining("placeholder contract"),
      ]),
    );
    expect(
      validateCatalogs({
        en: {
          options_bad: {
            message: "$OTHER$",
            description: "test",
            placeholders: { name: { content: "$2" } },
          },
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("do not match"),
        expect.stringContaining("contiguous"),
      ]),
    );
    expect(
      validateCatalogs({
        en: { nope: { message: "text", description: "test" } },
      }),
    ).toContain("en.nope: unreserved namespace");
  });
  it("preserves branding and Chrome metadata limits in all five catalogs", () => {
    expect(Object.keys(catalogs).sort()).toEqual([
      "en",
      "ja",
      "ko",
      "zh_CN",
      "zh_TW",
    ]);
    for (const catalog of Object.values(catalogs)) {
      expect(catalog.extension_name.message).toBe(
        "GitHub Pulls Show Reviewers",
      );
      expect(catalog.extension_name.message.length).toBeLessThanOrEqual(75);
      expect(catalog.extension_description.message.length).toBeLessThanOrEqual(
        132,
      );
      expect(catalog.extension_action_title.message).toContain(
        catalog.extension_name.message,
      );
    }
  });
});

describe("lifecycle-owned locale store", () => {
  it("shares one listener, publishes stable snapshots, and tears down after the last subscriber", async () => {
    const h = harness(Promise.resolve("ja"));
    const notify = vi.fn();
    const a = h.store.subscribe(notify);
    const b = h.store.subscribe(notify);
    await h.store.ready();
    expect(h.adapter.subscribe).toHaveBeenCalledTimes(1);
    expect(h.store.getSnapshot().locale).toBe("ja");
    const snapshot = h.store.getSnapshot();
    h.emit("ja");
    expect(h.store.getSnapshot()).toBe(snapshot);
    expect(notify).toHaveBeenCalledTimes(2);
    a();
    a();
    expect(h.remove).not.toHaveBeenCalled();
    b();
    expect(h.remove).toHaveBeenCalledTimes(1);
  });
  it("initializes ready-only consumers and rehydrates on a later subscription", async () => {
    const h = harness(Promise.resolve("ja"));
    await h.store.ready();
    expect(h.store.getSnapshot().locale).toBe("ja");
    expect(h.remove).toHaveBeenCalledTimes(1);
    vi.mocked(h.adapter.readLanguage).mockResolvedValueOnce("zh_TW");
    const stop = h.store.subscribe(() => undefined);
    await h.store.ready();
    expect(h.store.getSnapshot().lang).toBe("zh-TW");
    expect(h.adapter.subscribe).toHaveBeenCalledTimes(2);
    stop();
  });
  it("does not let an older initial read overwrite a storage event", async () => {
    const initial = deferred<LanguagePreference>();
    const h = harness(initial.promise);
    h.store.subscribe(() => undefined);
    h.emit("zh_TW");
    initial.resolve("en");
    await h.store.ready();
    expect(h.store.getSnapshot().locale).toBe("zh_TW");
    h.store.dispose();
  });
  it("ignores an old read after unsubscribe and a new read after resubscribe", async () => {
    const old = deferred<LanguagePreference>();
    const h = harness(old.promise);
    const stop = h.store.subscribe(() => undefined);
    stop();
    vi.mocked(h.adapter.readLanguage).mockResolvedValueOnce("ja");
    h.store.subscribe(() => undefined);
    await h.store.ready();
    old.resolve("en");
    await old.promise;
    expect(h.store.getSnapshot().locale).toBe("ja");
    h.store.dispose();
  });
  it("falls back to Chrome auto on read failure without writing anything", async () => {
    const h = harness(Promise.reject(new Error("storage unavailable")));
    await h.store.ready();
    expect(h.store.getSnapshot()).toMatchObject({
      language: "auto",
      locale: "ko",
    });
    expect(h.adapter.writeLanguage).not.toHaveBeenCalled();
  });
  it("keeps the latest event even if an overlapping initial read fails", async () => {
    const initial = deferred<LanguagePreference>();
    const h = harness(initial.promise);
    h.store.subscribe(() => undefined);
    h.emit("ja");
    initial.reject(new Error("failed"));
    await h.store.ready();
    expect(h.store.getSnapshot().locale).toBe("ja");
    h.store.dispose();
  });
  it("serializes rapid selections, invalidates initial reads, and recovers after write failure", async () => {
    const initial = deferred<LanguagePreference>();
    const h = harness(initial.promise);
    const notify = vi.fn();
    h.store.subscribe(notify);
    await h.store.setLanguage("ja");
    initial.resolve("en");
    await h.store.ready();
    expect(h.store.getSnapshot().locale).toBe("ja");
    vi.mocked(h.adapter.writeLanguage).mockRejectedValueOnce(
      new Error("write failed"),
    );
    await expect(h.store.setLanguage("en")).rejects.toThrow("write failed");
    expect(h.store.getSnapshot().locale).toBe("ja");
    await Promise.all([
      h.store.setLanguage("zh_CN"),
      h.store.setLanguage("auto"),
    ]);
    expect(h.store.getSnapshot()).toMatchObject({
      language: "auto",
      locale: "ko",
    });
    expect(h.adapter.writeLanguage).toHaveBeenNthCalledWith(3, "zh_CN");
    expect(notify).toHaveBeenCalledTimes(3);
    h.store.dispose();
  });
  it("preserves newer storage evidence over an older write completion", async () => {
    const h = harness();
    h.store.subscribe(() => undefined);
    await h.store.ready();
    const writing = deferred<void>();
    vi.mocked(h.adapter.writeLanguage).mockReturnValueOnce(writing.promise);
    const change = h.store.setLanguage("ja");
    await Promise.resolve();
    h.emit("zh_TW");
    writing.resolve();
    await change;
    expect(h.store.getSnapshot().locale).toBe("zh_TW");
    h.store.dispose();
  });
  it("accepts a valid initial read after a failed overlapping selection", async () => {
    const initial = deferred<LanguagePreference>();
    const h = harness(initial.promise);
    h.store.subscribe(() => undefined);
    vi.mocked(h.adapter.writeLanguage).mockRejectedValueOnce(
      new Error("write failed"),
    );
    await expect(h.store.setLanguage("ja")).rejects.toThrow("write failed");
    initial.resolve("zh_CN");
    await h.store.ready();
    expect(h.store.getSnapshot().locale).toBe("zh_CN");
    h.store.dispose();
  });
  it("disposes pending hydration and rejects reuse", async () => {
    const initial = deferred<LanguagePreference>();
    const h = harness(initial.promise);
    const notify = vi.fn();
    h.store.subscribe(notify);
    const ready = h.store.ready();
    h.store.dispose();
    initial.resolve("en");
    await ready;
    expect(notify).not.toHaveBeenCalled();
    expect(h.remove).toHaveBeenCalledTimes(1);
    expect(() => h.store.subscribe(notify)).toThrow("disposed");
    await expect(h.store.setLanguage("ja")).rejects.toThrow("disposed");
  });
});
