// @vitest-environment jsdom
import {
  FloatingCardsDesktop,
  FloatingCardsStack,
} from "@/components/landing/floating-cards";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The hero cards are illustrative design previews — never live rooms or
 * sessions — so the contract under test is exactly that: hidden from
 * assistive technology wherever they render, and carrying only the three
 * preview labels the design specifies.
 */
describe("landing floating cards", () => {
  afterEach(cleanup);

  it("keeps the desktop cluster out of the accessibility tree", () => {
    const { container } = render(<FloatingCardsDesktop />);

    const cluster = container.firstElementChild!;
    expect(cluster).toHaveAttribute("aria-hidden", "true");
    expect(cluster).not.toHaveAttribute("tabindex");
    // Visual labels still present for sighted readers…
    expect(screen.getByText("Focus session")).toBeInTheDocument();
    expect(screen.getByText("Study room")).toBeInTheDocument();
    expect(screen.getByText("Your next step")).toBeInTheDocument();
    // …and the preview values are the fixed design copy, not live data.
    expect(screen.getByText("25:00")).toBeInTheDocument();
    expect(screen.getByText("NEET Biology · Cell Structure")).toBeInTheDocument();
    expect(screen.getByText("Finish one topic")).toBeInTheDocument();
  });

  it("keeps the mobile stack out of the accessibility tree too", () => {
    const { container } = render(<FloatingCardsStack />);

    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(screen.getAllByText("Focus session")).toHaveLength(1);
  });
});
