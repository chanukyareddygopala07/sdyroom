import "@testing-library/jest-dom/vitest";

// jsdom has no layout engine; Radix primitives (RadioGroup, Menu, Popper)
// measure through ResizeObserver and would crash without this stub.
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}
