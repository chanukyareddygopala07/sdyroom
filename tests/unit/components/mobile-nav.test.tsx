// @vitest-environment jsdom
import { MobileNav, MOBILE_NAV_SHEET_ID } from "@/components/layout/mobile-nav";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import Link from "next/link";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Plain anchors: the sheet closes on any `<a>` click, and the real Link's
// router integration is not what this file is testing.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href?: unknown;
    children?: ReactNode;
  } & Record<string, unknown>) => (
    <a href={typeof href === "string" ? href : "#"} {...props}>
      {children}
    </a>
  ),
}));

function renderNav() {
  return render(
    <MobileNav
      account={
        <Link href="/onboarding" className="alias">
          studynerd
        </Link>
      }
    >
      <Link href="/rooms">Public rooms</Link>
      <Link href="/resources">My resources</Link>
    </MobileNav>,
  );
}

describe("MobileNav", () => {
  afterEach(cleanup);

  it("labels the disclosure and wires it to the sheet it controls", () => {
    renderNav();

    const trigger = screen.getByRole("button", {
      name: "Open navigation menu",
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-controls", MOBILE_NAV_SHEET_ID);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a labelled dialog holding the navigation links and account", async () => {
    renderNav();

    fireEvent.click(
      screen.getByRole("button", { name: "Open navigation menu" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Navigation menu",
    });
    expect(dialog).toHaveAttribute("id", MOBILE_NAV_SHEET_ID);
    expect(
      screen.getByRole("link", { name: "Public rooms" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "My resources" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "studynerd" })).toBeInTheDocument();
  });

  it("closes on Escape and moves focus back to the trigger", async () => {
    renderNav();
    const trigger = screen.getByRole("button", {
      name: "Open navigation menu",
    });
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Navigation menu" });

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes the sheet when one of its links is activated", async () => {
    renderNav();
    fireEvent.click(
      screen.getByRole("button", { name: "Open navigation menu" }),
    );
    await screen.findByRole("dialog", { name: "Navigation menu" });

    fireEvent.click(screen.getByRole("link", { name: "Public rooms" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});
