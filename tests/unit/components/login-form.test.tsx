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

const { push, signInWithPassword } = vi.hoisted(() => ({
  push: vi.fn(),
  signInWithPassword: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signInWithPassword } }),
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
  });

  it("renders required credential fields and a submit button", () => {
    render(<LoginForm />);

    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");

    expect(email).toHaveAttribute("type", "email");
    expect(email).toBeRequired();
    expect(password).toHaveAttribute("type", "password");
    expect(password).toBeRequired();
    expect(screen.getByRole("button", { name: "Login" })).toBeEnabled();
  });

  it("shows the Supabase error message and does not navigate when sign-in fails", async () => {
    signInWithPassword.mockResolvedValue({
      error: new Error("Invalid login credentials"),
    });
    render(<LoginForm />);
    fillCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Login" }));

    expect(
      await screen.findByText("Invalid login credentials"),
    ).toBeInTheDocument();
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "sup3r-secret",
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("navigates to the protected route after a successful sign-in", async () => {
    signInWithPassword.mockResolvedValue({ error: null });
    render(<LoginForm />);
    fillCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Login" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/rooms"));
    expect(screen.queryByText("Invalid login credentials")).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: "Login" }));

    expect(
      await screen.findByRole("button", { name: "Logging in..." }),
    ).toBeDisabled();

    finishSignIn({ error: null });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/rooms"));
  });
});
