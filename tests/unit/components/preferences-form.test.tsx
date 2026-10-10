// @vitest-environment jsdom
import { PreferencesForm } from "@/components/notifications/preferences-form";
import type { NotificationPrefs } from "@/lib/notifications/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const ALL_DEFAULTS: NotificationPrefs = {
  default: "all",
  invite: "all",
  moderation: "all",
  ai: "all",
  resource: "all",
};

beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
  refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("PreferencesForm", () => {
  it("renders one closed select per category, seeded from the record", () => {
    render(
      <PreferencesForm
        initialPrefs={{ ...ALL_DEFAULTS, invite: "none" }}
      />,
    );

    const invite = screen.getByLabelText("Invitations") as HTMLSelectElement;
    expect(invite.value).toBe("none");
    // Closed by construction: the enum is the option list.
    expect(Array.from(invite.options).map((option) => option.value)).toEqual([
      "all",
      "mentions_and_invites",
      "none",
    ]);
    expect(screen.getByLabelText("Moderation")).toBeTruthy();
    expect(screen.getByLabelText("Resources")).toBeTruthy();
    expect(screen.getByLabelText("AI tasks")).toBeTruthy();
  });

  it("PATCHes the partial body and confirms in the live region", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { prefs: { ...ALL_DEFAULTS, moderation: "none" } }),
    );

    render(<PreferencesForm initialPrefs={ALL_DEFAULTS} />);
    fireEvent.change(screen.getByLabelText("Moderation"), {
      target: { value: "none" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));

    await waitFor(() => {
      expect(screen.getByTestId("prefs-status").textContent).toBe(
        "Preferences saved.",
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/profile/notification-prefs",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          prefs: {
            invite: "all",
            moderation: "none",
            resource: "all",
            ai: "all",
          },
        }),
      }),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("surfaces a server failure without claiming a save", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, { error: { message: "nope" } }),
    );

    render(<PreferencesForm initialPrefs={ALL_DEFAULTS} />);
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));

    await waitFor(() => {
      expect(screen.getByTestId("prefs-status").textContent).toBe("nope");
    });
  });

  it("walks the student back to login on a 401", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, {}));

    render(<PreferencesForm initialPrefs={ALL_DEFAULTS} />);
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/auth/login");
    });
  });
});
