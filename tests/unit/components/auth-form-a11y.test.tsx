// @vitest-environment jsdom
import { LoginForm } from "@/components/login-form";
import { OnboardingForm } from "@/components/onboarding-form";
import { SignUpForm } from "@/components/sign-up-form";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { push, refresh, signInWithPassword, signUp, fetchMock } = vi.hoisted(
  () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    fetchMock: vi.fn(),
  }),
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signInWithPassword, signUp } }),
}));

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("auth form accessibility wiring", () => {
  beforeEach(() => {
    push.mockReset();
    refresh.mockReset();
    signInWithPassword.mockReset();
    signUp.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("gives the login card the page's only level-one heading", () => {
    render(<LoginForm />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Login" }),
    ).toBeInTheDocument();
  });

  it("announces a failed sign-in as an alert tied to both fields", async () => {
    signInWithPassword.mockResolvedValue({
      error: new Error("Invalid login credentials"),
    });
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "sup3r-secret" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Login" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Invalid login credentials");
    expect(alert).toHaveAttribute("id", "login-error");
    for (const field of [
      screen.getByLabelText("Email"),
      screen.getByLabelText("Password"),
    ]) {
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field).toHaveAttribute("aria-describedby", "login-error");
    }
  });

  it("marks the sign-up fields invalid and links them to the alert", async () => {
    signUp.mockResolvedValue({
      data: { session: null },
      error: new Error("Password is too short."),
    });
    render(<SignUpForm />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "a" },
    });
    fireEvent.change(screen.getByLabelText("Repeat Password"), {
      target: { value: "a" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("id", "sign-up-error");
    expect(
      screen.getByLabelText("Repeat Password"),
    ).toHaveAttribute("aria-describedby", "sign-up-error");
  });

  it("describes the alias field with its help text and, on failure, the error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: { code: "alias_taken", message: "That alias is taken." },
      }),
    );
    render(<OnboardingForm />);

    const alias = screen.getByLabelText("Study alias");
    expect(alias).toHaveAttribute("aria-describedby", "alias-help");
    expect(screen.getByText(/Up to/)).toHaveAttribute("id", "alias-help");

    fireEvent.change(alias, { target: { value: "taken" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to rooms" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("id", "alias-error");
    expect(alias).toHaveAttribute("aria-invalid", "true");
    expect(alias).toHaveAttribute(
      "aria-describedby",
      "alias-error alias-help",
    );
  });
});
