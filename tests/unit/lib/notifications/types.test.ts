import {
  DEFAULT_NOTIFICATION_PREFS,
  formatRelativeTime,
  hrefForNotification,
  NOTIFICATION_CATEGORY_BY_TYPE,
  NOTIFICATION_TYPES,
  toNotificationView,
} from "@/lib/notifications/types";
import { describe, expect, it } from "vitest";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

describe("notification types", () => {
  it("assigns a preference category to every type exactly once", () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(NOTIFICATION_CATEGORY_BY_TYPE[type]).toBeDefined();
    }
    expect(Object.keys(NOTIFICATION_CATEGORY_BY_TYPE).sort()).toEqual(
      [...NOTIFICATION_TYPES].sort(),
    );
  });

  it("leaves system unconfigurable (null category)", () => {
    expect(NOTIFICATION_CATEGORY_BY_TYPE.system).toBeNull();
  });

  it("defaults every preference to all", () => {
    expect(DEFAULT_NOTIFICATION_PREFS).toEqual({
      default: "all",
      invite: "all",
      moderation: "all",
      ai: "all",
      resource: "all",
    });
  });
});

describe("hrefForNotification", () => {
  it("points every type at a route that exists", () => {
    const routes = new Set<string>([
      "/",
      "/invitations",
      "/rooms",
      `/rooms/${ROOM_ID}`,
      "/resources",
    ]);
    for (const type of NOTIFICATION_TYPES) {
      expect(routes.has(hrefForNotification(type, ROOM_ID))).toBe(true);
    }
  });

  it("sends invites to the invite inbox and removals to the room list", () => {
    expect(hrefForNotification("invite_created", ROOM_ID)).toBe("/invitations");
    expect(hrefForNotification("invite_accepted", ROOM_ID)).toBe("/invitations");
    // A removed member can no longer open the workspace — the list is the
    // honest destination.
    expect(hrefForNotification("member_removed", ROOM_ID)).toBe("/rooms");
  });

  it("degrades to the section index when the room is gone", () => {
    expect(hrefForNotification("muted", null)).toBe("/rooms");
    expect(hrefForNotification("report_resolved", null)).toBe("/rooms");
    expect(hrefForNotification("ai_task_complete", null)).toBe("/rooms");
    expect(hrefForNotification("resource_ready", null)).toBe("/resources");
    expect(hrefForNotification("system", null)).toBe("/");
  });
});

describe("toNotificationView", () => {
  it("maps a row and derives the href into the payload", () => {
    const view = toNotificationView({
      id: "22222222-2222-4222-8222-222222222222",
      type: "muted",
      room_id: ROOM_ID,
      payload: { title: "You were muted", body: "Hidden for an hour." },
      read_at: null,
      created_at: "2026-10-10T10:00:00.000000+00:00",
    });

    expect(view).toEqual({
      id: "22222222-2222-4222-8222-222222222222",
      type: "muted",
      room_id: ROOM_ID,
      payload: {
        title: "You were muted",
        body: "Hidden for an hour.",
        href: `/rooms/${ROOM_ID}`,
      },
      read_at: null,
      created_at: "2026-10-10T10:00:00.000000+00:00",
    });
  });

  it("survives a malformed payload without taking the list down", () => {
    const view = toNotificationView({
      id: "33333333-3333-4333-8333-333333333333",
      type: "system",
      room_id: null,
      payload: ["not", "an", "object"],
      read_at: null,
      created_at: "2026-10-10T10:00:00.000000+00:00",
    });

    expect(view.payload).toEqual({ title: "", body: "", href: "/" });
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");

  it("collapses the last minute to 'just now'", () => {
    expect(formatRelativeTime("2026-10-10T11:59:30.000Z", now)).toBe("just now");
  });

  it("uses compact units for minutes, hours and days", () => {
    expect(formatRelativeTime("2026-10-10T11:55:00.000Z", now)).toBe("5m ago");
    expect(formatRelativeTime("2026-10-10T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatRelativeTime("2026-10-08T12:00:00.000Z", now)).toBe("2d ago");
  });

  it("shows the date past a week and nothing for junk", () => {
    expect(formatRelativeTime("2026-09-01T12:00:00.000Z", now)).toBe(
      new Date("2026-09-01T12:00:00.000Z").toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
    );
    expect(formatRelativeTime("not-a-date", now)).toBe("");
  });
});
