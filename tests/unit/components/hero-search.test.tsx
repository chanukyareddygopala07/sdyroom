// @vitest-environment jsdom
import { HeroSearch } from "@/components/landing/hero-search";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

describe("HeroSearch", () => {
  afterEach(cleanup);

  it("submits the real discovery route with the real query parameter", () => {
    render(<HeroSearch />);

    const form = screen.getByRole("search");
    expect(form).toHaveAttribute("action", "/rooms");
    expect(form).toHaveAttribute("method", "get");

    const input = screen.getByPlaceholderText(
      "Find a study room, subject, or exam...",
    );
    expect(input).toHaveAttribute("name", "q");
    expect(input).toHaveAttribute("type", "search");
    expect(input).toHaveAttribute("maxlength", "100");

    expect(
      screen.getByRole("button", { name: "Explore rooms" }),
    ).toHaveAttribute("type", "submit");
  });

  it("labels the field for assistive technology", () => {
    render(<HeroSearch />);

    expect(
      screen.getByLabelText(/find a study room, subject, or exam/i),
    ).toBeInTheDocument();
  });

  it("offers the suggested searches as plain links with q", () => {
    render(<HeroSearch />);

    expect(
      screen.getByRole("link", { name: "biology" }),
    ).toHaveAttribute("href", "/rooms?q=biology");
    expect(
      screen.getByRole("link", { name: "cell structure" }),
    ).toHaveAttribute("href", "/rooms?q=cell%20structure");
    expect(
      screen.getByRole("link", { name: "neet" }),
    ).toHaveAttribute("href", "/rooms?q=neet");
  });
});
