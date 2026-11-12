import { vi } from "vitest";
Object.defineProperty(window, "matchMedia", {
  value: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }),
});
Object.defineProperty(document, "fonts", {
  value: {
    addEventListener() {},
    removeEventListener() {},
    check: () => true,
    load: async () => [],
    ready: Promise.resolve(),
  },
});
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
vi.stubGlobal(
  "FontFace",
  class {
    load() {
      return Promise.resolve(this);
    }
  },
);
