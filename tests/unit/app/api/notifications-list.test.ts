import { GET } from "@/app/api/notifications/route";
import { GET as unreadCountGet } from "@/app/api/notifications/unread-count/route";
import { NotificationQueryError } from "@/lib/notifications/queries";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  getClaims,
  listNotifications,
  countUnreadNotifications,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  listNotifications: vi.fn(),
  countUnreadNotifications: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/notifications/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/queries")>()),
  listNotifications,
  countUnreadNotifications,
}));

const USER_ID = "77777777-7777-4777-8777-777777777777";
const ROOM_ID = "11111111-1111-4111-8111-111111111111";

const NOTIFICATION = {
  id: "22222222-2222-4222-8222-222222222222",
  type: "invite_created",
  room_id: ROOM_ID,
  payload: {
    title: "Invitation to Quiet Hall",
    body: "owneralias invited you.",
    href: "/invitations",
  },
  read_at: null,
  created_at: "2026-10-10T10:00:00.000000+00:00",
};

function listResult(overrides: Record<string, unknown> = {}) {
  return {
    notifications: [NOTIFICATION],
    hasMore: false,
    nextCursor: null,
    total: 1,
    unreadCount: 1,
    ...overrides,
  };
}

beforeEach(() => {
  createClient.mockReset();
  getClaims.mockReset();
  listNotifications.mockReset();
  countUnreadNotifications.mockReset();
});

function signIn() {
  createClient.mockResolvedValue({ auth: { getClaims } });
  getClaims.mockResolvedValue({ data: { claims: { sub: USER_ID } } });
}

describe("GET /api/notifications", () => {
  it("401s without a session", async () => {
    createClient.mockResolvedValue({ auth: { getClaims } });
    getClaims.mockResolvedValue({ data: null });

    const response = await GET(new NextRequest("http://localhost/api/notifications"));
    expect(response.status).toBe(401);
    expect(listNotifications).not.toHaveBeenCalled();
  });

  it("returns the contract envelope with a derived href", async () => {
    signIn();
    listNotifications.mockResolvedValue(listResult());

    const response = await GET(
      new NextRequest("http://localhost/api/notifications?limit=5&unread=true"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0].payload.href).toBe("/invitations");
    expect(body).toMatchObject({ has_more: false, total: 1, unread_count: 1 });
    expect(listNotifications).toHaveBeenCalledWith(expect.anything(), {
      limit: 5,
      unread: true,
      cursor: undefined,
    });
  });

  it("400s an invalid query before touching the database", async () => {
    signIn();

    const response = await GET(
      new NextRequest("http://localhost/api/notifications?limit=999"),
    );
    expect(response.status).toBe(400);
    expect(listNotifications).not.toHaveBeenCalled();
  });

  it("maps a query failure to 500 notifications_failed", async () => {
    signIn();
    listNotifications.mockRejectedValue(new NotificationQueryError("nope"));

    const response = await GET(new NextRequest("http://localhost/api/notifications"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("notifications_failed");
  });
});

describe("GET /api/notifications/unread-count", () => {
  it("401s without a session", async () => {
    createClient.mockResolvedValue({ auth: { getClaims } });
    getClaims.mockResolvedValue({ data: null });

    const response = await unreadCountGet();
    expect(response.status).toBe(401);
    expect(countUnreadNotifications).not.toHaveBeenCalled();
  });

  it("returns just the count — never the list", async () => {
    signIn();
    countUnreadNotifications.mockResolvedValue(3);

    const response = await unreadCountGet();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ unread_count: 3 });
  });

  it("maps a query failure to 500", async () => {
    signIn();
    countUnreadNotifications.mockRejectedValue(new NotificationQueryError("nope"));

    const response = await unreadCountGet();
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("notifications_failed");
  });
});
