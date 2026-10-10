import { PATCH } from "@/app/api/profile/notification-prefs/route";
import {
  NotificationQueryError,
} from "@/lib/notifications/queries";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, updatePrefs } = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  updateNotificationPrefs: vi.fn(),
  updatePrefs: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/notifications/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/queries")>()),
  updateNotificationPrefs: updatePrefs,
}));

const USER_ID = "77777777-7777-4777-8777-777777777777";

function patchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/profile/notification-prefs", {
    method: "PATCH",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  createClient.mockReset();
  getClaims.mockReset();
  updatePrefs.mockReset();
});

function signIn() {
  createClient.mockResolvedValue({ auth: { getClaims } });
  getClaims.mockResolvedValue({ data: { claims: { sub: USER_ID } } });
}

describe("PATCH /api/profile/notification-prefs", () => {
  it("401s without a session", async () => {
    createClient.mockResolvedValue({ auth: { getClaims } });
    getClaims.mockResolvedValue({ data: null });

    const response = await PATCH(patchRequest({ prefs: { invite: "none" } }));
    expect(response.status).toBe(401);
    expect(updatePrefs).not.toHaveBeenCalled();
  });

  it("400s a malformed body", async () => {
    signIn();

    const response = await PATCH(patchRequest("{not json"));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
  });

  it("400s an unknown category key, naming the field", async () => {
    signIn();

    const response = await PATCH(patchRequest({ prefs: { email: "all" } }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("validation");
    expect(JSON.stringify(body.error.issues)).toContain("email");
    expect(updatePrefs).not.toHaveBeenCalled();
  });

  it("merges the partial prefs onto the caller's own profile", async () => {
    signIn();
    updatePrefs.mockResolvedValue({
      default: "all",
      invite: "none",
      moderation: "all",
      ai: "all",
      resource: "all",
    });

    const response = await PATCH(patchRequest({ prefs: { invite: "none" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      prefs: {
        default: "all",
        invite: "none",
        moderation: "all",
        ai: "all",
        resource: "all",
      },
    });
    expect(updatePrefs).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      { invite: "none" },
    );
  });

  it("maps a storage failure to 500", async () => {
    signIn();
    updatePrefs.mockRejectedValue(new NotificationQueryError("nope"));

    const response = await PATCH(patchRequest({ prefs: { invite: "none" } }));
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("notifications_failed");
  });
});
