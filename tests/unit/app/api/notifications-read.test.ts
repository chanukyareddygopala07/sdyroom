import { POST as readAllPost } from "@/app/api/notifications/read-all/route";
import { POST as readPost } from "@/app/api/notifications/[notificationId]/read/route";
import {
  NotificationNotFoundError,
  NotificationQueryError,
} from "@/lib/notifications/queries";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, markRead, markAllRead } = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/notifications/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/queries")>()),
  markNotificationRead: markRead,
  markAllNotificationsRead: markAllRead,
}));

const USER_ID = "77777777-7777-4777-8777-777777777777";
const NOTIFICATION_ID = "22222222-2222-4222-8222-222222222222";

function readRequest(path: string) {
  return new NextRequest(`http://localhost${path}`, { method: "POST", body: "{}" });
}

beforeEach(() => {
  createClient.mockReset();
  getClaims.mockReset();
  markRead.mockReset();
  markAllRead.mockReset();
});

function signIn() {
  createClient.mockResolvedValue({ auth: { getClaims } });
  getClaims.mockResolvedValue({ data: { claims: { sub: USER_ID } } });
}

describe("POST /api/notifications/[notificationId]/read", () => {
  it("401s without a session", async () => {
    createClient.mockResolvedValue({ auth: { getClaims } });
    getClaims.mockResolvedValue({ data: null });

    const response = await readPost(
      readRequest(`/api/notifications/${NOTIFICATION_ID}/read`),
      { params: Promise.resolve({ notificationId: NOTIFICATION_ID }) },
    );
    expect(response.status).toBe(401);
    expect(markRead).not.toHaveBeenCalled();
  });

  it("400s a non-uuid id", async () => {
    signIn();

    const response = await readPost(readRequest("/api/notifications/nope/read"), {
      params: Promise.resolve({ notificationId: "nope" }),
    });
    expect(response.status).toBe(400);
    expect(markRead).not.toHaveBeenCalled();
  });

  it("marks one row and reports changed, not unchanged", async () => {
    signIn();
    markRead.mockResolvedValue({ read: true, unchanged: false });

    const response = await readPost(
      readRequest(`/api/notifications/${NOTIFICATION_ID}/read`),
      { params: Promise.resolve({ notificationId: NOTIFICATION_ID }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ read: true, unchanged: false });
    expect(markRead).toHaveBeenCalledWith(expect.anything(), NOTIFICATION_ID);
  });

  it("keeps idempotent reads at 200 with unchanged: true", async () => {
    signIn();
    markRead.mockResolvedValue({ read: true, unchanged: true });

    const response = await readPost(
      readRequest(`/api/notifications/${NOTIFICATION_ID}/read`),
      { params: Promise.resolve({ notificationId: NOTIFICATION_ID }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ read: true, unchanged: true });
  });

  it("404s a foreign or missing id with the same body", async () => {
    signIn();
    markRead.mockRejectedValue(new NotificationNotFoundError());

    const response = await readPost(
      readRequest(`/api/notifications/${NOTIFICATION_ID}/read`),
      { params: Promise.resolve({ notificationId: NOTIFICATION_ID }) },
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("maps a query failure to 500", async () => {
    signIn();
    markRead.mockRejectedValue(new NotificationQueryError("nope"));

    const response = await readPost(
      readRequest(`/api/notifications/${NOTIFICATION_ID}/read`),
      { params: Promise.resolve({ notificationId: NOTIFICATION_ID }) },
    );
    expect(response.status).toBe(500);
  });
});

describe("POST /api/notifications/read-all", () => {
  it("401s without a session", async () => {
    createClient.mockResolvedValue({ auth: { getClaims } });
    getClaims.mockResolvedValue({ data: null });

    const response = await readAllPost(readRequest("/api/notifications/read-all"));
    expect(response.status).toBe(401);
    expect(markAllRead).not.toHaveBeenCalled();
  });

  it("returns the number of rows the caller actually touched", async () => {
    signIn();
    markAllRead.mockResolvedValue({ updated: 3 });

    const response = await readAllPost(readRequest("/api/notifications/read-all"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updated: 3 });
  });

  it("reports zero on a second call rather than a stale number", async () => {
    signIn();
    markAllRead.mockResolvedValue({ updated: 0 });

    const response = await readAllPost(readRequest("/api/notifications/read-all"));
    expect(await response.json()).toEqual({ updated: 0 });
  });
});
