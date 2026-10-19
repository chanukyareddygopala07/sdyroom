// @vitest-environment jsdom
import { AuthShell } from "@/components/auth/auth-shell";
import { BrandMark } from "@/components/brand-mark";
import { ActiveNavLink } from "@/components/layout/active-nav-link";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

let pathname = "/rooms";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

// The suite asserts the DOM contract (alt/width/src), not next/image's
// optimization pipeline, so the mock renders a plain img via createElement
// (which also keeps the no-img-element rule quiet inside this test double).
vi.mock("next/image", async () => {
  const { createElement } = await import("react");
  return {
    default: ({
      src,
      alt,
      ...rest
    }: {
      src: string | { src: string };
      alt: string;
    } & Record<string, unknown>) =>
      createElement("img", {
        ...rest,
        src: typeof src === "string" ? src : src.src,
        alt,
      }),
  };
});

describe("BrandMark — the official logo asset", () => {
  it("is decorative (empty alt) when it sits beside a visible wordmark", () => {
    const { container } = render(<BrandMark size={28} />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("width")).toBe("28");
    expect(img?.getAttribute("src")).toContain("sdyroom-logo");
  });

  it("carries an informative alt when it is the only logo on screen", () => {
    render(<BrandMark size={44} alt="SdyRoom logo" />);
    expect(screen.getByAltText("SdyRoom logo")).toBeInTheDocument();
  });
});

describe("ActiveNavLink — current destination marking", () => {
  it("sets aria-current on the exact match", () => {
    pathname = "/rooms";
    render(<ActiveNavLink href="/rooms">Public rooms</ActiveNavLink>);
    expect(
      screen.getByRole("link", { name: "Public rooms" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("marks a child route as current too", () => {
    pathname = "/rooms/abc";
    render(<ActiveNavLink href="/rooms">Public rooms</ActiveNavLink>);
    expect(
      screen.getByRole("link", { name: "Public rooms" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("leaves aria-current off when the route is elsewhere", () => {
    pathname = "/settings";
    render(<ActiveNavLink href="/rooms">Public rooms</ActiveNavLink>);
    expect(
      screen.getByRole("link", { name: "Public rooms" }),
    ).not.toHaveAttribute("aria-current");
  });
});

describe("AuthShell — shared authentication backdrop", () => {
  it("renders the informative logo, the form slot, and a way home", () => {
    render(
      <AuthShell>
        <p>Form goes here</p>
      </AuthShell>,
    );
    expect(screen.getByAltText("SdyRoom logo")).toBeInTheDocument();
    expect(screen.getByText("Form goes here")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to home" })).toHaveAttribute(
      "href",
      "/",
    );
  });
});
