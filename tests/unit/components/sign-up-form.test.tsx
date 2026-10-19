// @vitest-environment jsdom
import { SignUpForm } from "@/components/sign-up-form";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { push, signUp, signInWithOAuth } = vi.hoisted(() => ({
  push: vi.fn(),
  signUp: vi.fn(),
  signInWithOAuth: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signUp, signInWithOAuth } }),
}));

function fillForm(password = "sup3r-secret") {
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "user@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText("Repeat Password"), {
    target: { value: password },
  });
}

describe("SignUpForm", () => {
  afterEach(cleanup);

  beforeEach(() => {
    push.mockReset();
    signUp.mockReset();
    signInWithOAuth.mockReset();
  });

  it("renders the required fields, the account-switch link and OAuth buttons", () => {
    render(<SignUpForm />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Create your SdyRoom account" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeRequired();
    expect(screen.getByLabelText("Password")).toBeRequired();
    expect(screen.getByLabelText("Repeat Password")).toBeRequired();
    expect(
      screen.getByRole("button", { name: "Create account" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("link", { name: "Sign in" }),
    ).toHaveAttribute("href", "/auth/login");
    expect(
      screen.getByRole("button", { name: "Sign up with Google" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Sign up with GitHub" }),
    ).toBeEnabled();
  });

  it("blocks submission and explains when the passwords do not match", async () => {
    render(<SignUpForm />);
    fillForm("sup3r-secret");
    fireEvent.change(screen.getByLabelText("Repeat Password"), {
      target: { value: "different" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Passwords do not match",
    );
    expect(signUp).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("creates the account and continues to onboarding when a session appears", async () => {
    signUp.mockResolvedValue({ data: { session: {} }, error: null });
    render(<SignUpForm />);
    fillForm();

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/onboarding"));
    expect(signUp).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "sup3r-secret",
      options: {
        emailRedirectTo: expect.stringContaining("/rooms"),
      },
    });
  });

  it("sends a confirmation-pending sign-up to the success screen", async () => {
    signUp.mockResolvedValue({ data: { session: null }, error: null });
    render(<SignUpForm />);
    fillForm();

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/auth/sign-up-success"),
    );
  });

  it("toggles password visibility on both password fields independently", () => {
    render(<SignUpForm />);

    const password = screen.getByLabelText("Password");
    const repeat = screen.getByLabelText("Repeat Password");
    const toggles = screen.getAllByRole("button", { name: "Show password" });
    expect(toggles).toHaveLength(2);

    fireEvent.click(toggles[0]!);
    expect(password).toHaveAttribute("type", "text");
    expect(repeat).toHaveAttribute("type", "password");
  });

  it("initiates the real Google OAuth sign-up flow against the callback", async () => {
    signInWithOAuth.mockResolvedValue({ error: null });
    render(<SignUpForm />);

    fireEvent.click(screen.getByRole("button", { name: "Sign up with Google" }));

    await waitFor(() =>
      expect(signInWithOAuth).toHaveBeenCalledWith({
        provider: "google",
        options: {
          redirectTo: expect.stringMatching(/\/auth\/callback$/),
        },
      }),
    );
  });

  it("initiates the real GitHub OAuth sign-up flow against the callback", async () => {
    signInWithOAuth.mockResolvedValue({ error: null });
    render(<SignUpForm />);

    fireEvent.click(screen.getByRole("button", { name: "Sign up with GitHub" }));

    await waitFor(() =>
      expect(signInWithOAuth).toHaveBeenCalledWith({
        provider: "github",
        options: {
          redirectTo: expect.stringMatching(/\/auth\/callback$/),
        },
      }),
    );
  });

  it("shows a friendly alert when OAuth initiation fails", async () => {
    signInWithOAuth.mockResolvedValue({
      error: new Error("provider is not enabled"),
    });
    render(<SignUpForm />);

    fireEvent.click(screen.getByRole("button", { name: "Sign up with Google" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Google sign-in isn't available right now. Try again, or use your email and password.",
    );
    expect(screen.queryByText(/provider is not enabled/)).toBeNull();
  });

  it("disables the submit button and shows a loading label while sign-up is pending", async () => {
    let finishSignUp!: (value: { data: { session: null }; error: null }) => void;
    signUp.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSignUp = resolve;
        }),
    );
    render(<SignUpForm />);
    fillForm();

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      await screen.findByRole("button", { name: "Creating account…" }),
    ).toBeDisabled();

    finishSignUp({ data: { session: null }, error: null });
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/auth/sign-up-success"),
    );
  });
});
