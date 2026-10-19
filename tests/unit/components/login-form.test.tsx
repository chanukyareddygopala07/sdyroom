// @vitest-environment jsdom
import { LoginForm } from "@/components/login-form";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { push, signInWithPassword, signInWithOAuth } = vi.hoisted(() => ({
  push: vi.fn(),
  signInWithPassword: vi.fn(),
  signInWithOAuth: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signInWithPassword, signInWithOAuth } }),
}));

function fillCredentials() {
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "user@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "sup3r-secret" },
  });
}

describe("LoginForm", () => {
  afterEach(cleanup);

  beforeEach(() => {
    push.mockReset();
    signInWithPassword.mockReset();
    signInWithOAuth.mockReset();
  });

  it("renders required credential fields and a submit button", () => {
    render(<LoginForm />);

    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");

    expect(email).toHaveAttribute("type", "email");
    expect(email).toBeRequired();
    expect(password).toHaveAttribute("type", "password");
    expect(password).toBeRequired();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("offers the Google and GitHub OAuth entry points and the sign-up link", () => {
    render(<LoginForm />);

    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("link", { name: "Create an account" }),
    ).toHaveAttribute("href", "/auth/sign-up");
    expect(
      screen.getByRole("link", { name: "Forgot your password?" }),
    ).toHaveAttribute("href", "/auth/forgot-password");
  });

  it("shows a fixed copy line and does not navigate when sign-in fails", async () => {
    signInWithPassword.mockResolvedValue({
      error: new Error("Invalid login credentials"),
    });
    render(<LoginForm />);
    fillCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(
      await screen.findByText("Email or password is incorrect."),
    ).toBeInTheDocument();
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "sup3r-secret",
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("never renders an unrecognized provider message verbatim", async () => {
    signInWithPassword.mockResolvedValue({
      error: new Error("Internal trace: user 42 at db shard 7"),
    });
    render(<LoginForm />);
    fillCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(
      await screen.findByText("Something went wrong. Please try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/db shard 7/)).toBeNull();
  });

  it("navigates to the protected route after a successful sign-in", async () => {
    signInWithPassword.mockResolvedValue({ error: null });
    render(<LoginForm />);
    fillCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/rooms"));
    expect(screen.queryByText("Email or password is incorrect.")).toBeNull();
  });

  it("resumes the server-validated next target after a successful sign-in", async () => {
    signInWithPassword.mockResolvedValue({ error: null });
    render(<LoginForm next="/analytics" />);
    fillCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/analytics"));
  });

  it("disables the submit button and shows a loading label while sign-in is pending", async () => {
    let finishSignIn!: (value: { error: null }) => void;
    signInWithPassword.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSignIn = resolve;
        }),
    );
    render(<LoginForm />);
    fillCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(
      await screen.findByRole("button", { name: "Signing in…" }),
    ).toBeDisabled();

    finishSignIn({ error: null });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/rooms"));
  });

  it("toggles password visibility without changing the field identity", () => {
    render(<LoginForm />);
    const password = screen.getByLabelText("Password");
    const toggle = screen.getByRole("button", { name: "Show password" });

    expect(password).toHaveAttribute("type", "password");
    fireEvent.click(toggle);
    expect(password).toHaveAttribute("type", "text");
    expect(
      screen.getByRole("button", { name: "Hide password" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(password).toHaveAttribute("type", "password");
  });

  it("initiates the real Google OAuth flow against the auth callback", async () => {
    signInWithOAuth.mockResolvedValue({ error: null });
    render(<LoginForm />);

    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    await waitFor(() =>
      expect(signInWithOAuth).toHaveBeenCalledWith({
        provider: "google",
        options: {
          redirectTo: expect.stringMatching(/\/auth\/callback$/),
        },
      }),
    );
  });

  it("initiates the real GitHub OAuth flow and carries a validated next target", async () => {
    signInWithOAuth.mockResolvedValue({ error: null });
    render(<LoginForm next="/analytics" />);

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    );

    await waitFor(() =>
      expect(signInWithOAuth).toHaveBeenCalledWith({
        provider: "github",
        options: {
          redirectTo: expect.stringMatching(
            /\/auth\/callback\?next=%2Fanalytics$/,
          ),
        },
      }),
    );
  });

  it("shows a friendly alert and recovers when OAuth initiation fails", async () => {
    signInWithOAuth.mockResolvedValue({
      error: new Error("provider is not enabled"),
    });
    render(<LoginForm />);

    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent(
      "Google sign-in isn't available right now. Try again, or use your email and password.",
    );
    expect(screen.queryByText(/provider is not enabled/)).toBeNull();
    // The buttons come back so the visitor can retry or fall back.
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeEnabled();
  });

  it("disables every auth entry point while an OAuth redirect is in flight", async () => {
    let finishOAuth!: (value: { error: null }) => void;
    signInWithOAuth.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOAuth = resolve;
        }),
    );
    render(<LoginForm />);

    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    expect(
      await screen.findByRole("button", { name: "Continue with GitHub" }),
    ).toBeDisabled();
    // The shared pending flag also flips the password submit into its
    // loading state, so a second auth round-trip cannot start.
    expect(
      screen.getByRole("button", { name: "Signing in…" }),
    ).toBeDisabled();

    finishOAuth({ error: null });
  });

  it("shows the bounced-OAuth notice the callback redirects in with", () => {
    render(<LoginForm oauthError />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Sign-in was cancelled or could not be completed.",
    );
  });
});
