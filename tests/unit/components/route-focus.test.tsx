// @vitest-environment jsdom
import { RouteFocus } from "@/components/layout/route-focus";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { pathnameHolder } = vi.hoisted(() => ({
  pathnameHolder: { current: "/rooms" },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameHolder.current,
}));

function mountMain() {
  const main = document.createElement("div");
  main.id = "main";
  main.tabIndex = -1;
  document.body.appendChild(main);
  return main;
}

describe("RouteFocus", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    pathnameHolder.current = "/rooms";
  });

  it("does not steal focus on the first render (a full page load)", () => {
    const main = mountMain();
    render(<RouteFocus />);

    expect(document.activeElement).not.toBe(main);
  });

  it("focuses the main landmark after a client-side navigation", () => {
    const main = mountMain();
    const { rerender } = render(<RouteFocus />);

    pathnameHolder.current = "/resources";
    rerender(<RouteFocus />);

    expect(document.activeElement).toBe(main);
  });

  it("keeps focus put when the same path re-renders", () => {
    const main = mountMain();
    const { rerender } = render(<RouteFocus />);
    pathnameHolder.current = "/resources";
    rerender(<RouteFocus />);
    expect(document.activeElement).toBe(main);

    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    expect(document.activeElement).toBe(button);

    // A router.refresh() or search-param change on the same route.
    rerender(<RouteFocus />);

    expect(document.activeElement).toBe(button);
  });
});
