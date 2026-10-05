// @vitest-environment jsdom
import { OnboardingForm } from "@/components/onboarding-form";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { push, refresh, fetchMock } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("OnboardingForm", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    push.mockReset();
    refresh.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders the study alias field and submit button", () => {
    render(<OnboardingForm />);

    expect(screen.getByLabelText("Study alias")).toBeRequired();
    expect(
      screen.getByRole("button", { name: "Continue to rooms" }),
    ).toBeEnabled();
  });

  it("validates the alias before calling the API", async () => {
    render(<OnboardingForm />);

    fireEvent.change(screen.getByLabelText("Study alias"), {
      target: { value: "@not-an-alias" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue to rooms" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Study alias/i);
  });

  it("posts the trimmed alias and continues to room discovery", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        profile: { id: "user-1", alias: "examnerd" },
        created: true,
      }),
    );
    render(<OnboardingForm />);

    fireEvent.change(screen.getByLabelText("Study alias"), {
      target: { value: "  examnerd  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue to rooms" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/rooms"));
    expect(fetchMock).toHaveBeenCalledWith("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias: "examnerd" }),
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the server message when the alias is taken", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: { code: "alias_taken", message: "That alias is taken." },
      }),
    );
    render(<OnboardingForm />);

    fireEvent.change(screen.getByLabelText("Study alias"), {
      target: { value: "taken" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue to rooms" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That alias is taken.",
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("reports a network failure without navigating", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<OnboardingForm />);

    fireEvent.change(screen.getByLabelText("Study alias"), {
      target: { value: "examnerd" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue to rooms" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not reach the server. Please try again.",
    );
    expect(push).not.toHaveBeenCalled();
  });
});
