import {
  decodeCursorSchema,
  encodeCursor,
  listNotificationsQuerySchema,
  updateNotificationPrefsSchema,
} from "@/lib/notifications/validation";
import { describe, expect, it } from "vitest";

const ID = "22222222-2222-4222-8222-222222222222";
const CREATED_AT = "2026-10-10T10:00:00.123456+00:00";

describe("cursor codec", () => {
  it("round-trips created_at and id", () => {
    const cursor = decodeCursorSchema.parse(encodeCursor(CREATED_AT, ID));
    expect(cursor).toEqual({ createdAt: CREATED_AT, id: ID });
  });

  it("refuses garbage rather than guessing", () => {
    expect(decodeCursorSchema.safeParse("not-base64url!!").success).toBe(false);
    expect(
      decodeCursorSchema.safeParse(Buffer.from("no-separator", "utf8").toString("base64url")).success,
    ).toBe(false);
    expect(
      decodeCursorSchema.safeParse(Buffer.from(`not-a-date|${ID}`, "utf8").toString("base64url")).success,
    ).toBe(false);
    expect(
      decodeCursorSchema.safeParse(Buffer.from(`${CREATED_AT}|nope`, "utf8").toString("base64url")).success,
    ).toBe(false);
  });
});

describe("listNotificationsQuerySchema", () => {
  it("defaults to a bounded page of read-and-unread rows", () => {
    const parsed = listNotificationsQuerySchema.parse({});
    expect(parsed).toEqual({ limit: 20, unread: false });
    expect(parsed.cursor).toBeUndefined();
  });

  it("parses the unread flag as a real boolean (not coerce.boolean)", () => {
    expect(listNotificationsQuerySchema.parse({ unread: "true" }).unread).toBe(true);
    expect(listNotificationsQuerySchema.parse({ unread: "false" }).unread).toBe(false);
  });

  it("rejects limits outside the documented bounds", () => {
    expect(listNotificationsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(listNotificationsQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(listNotificationsQuerySchema.safeParse({ limit: "1.5" }).success).toBe(false);
  });

  it("rejects a malformed cursor", () => {
    expect(
      listNotificationsQuerySchema.safeParse({ cursor: "bogus" }).success,
    ).toBe(false);
  });
});

describe("updateNotificationPrefsSchema", () => {
  it("accepts a partial update of closed values", () => {
    const parsed = updateNotificationPrefsSchema.parse({
      prefs: { invite: "none", moderation: "mentions_and_invites" },
    });
    expect(parsed.prefs).toEqual({
      invite: "none",
      moderation: "mentions_and_invites",
    });
  });

  it("refuses unknown pref keys", () => {
    expect(
      updateNotificationPrefsSchema.safeParse({ prefs: { email: "all" } }).success,
    ).toBe(false);
  });

  it("refuses values outside the closed enum", () => {
    expect(
      updateNotificationPrefsSchema.safeParse({ prefs: { invite: "sometimes" } }).success,
    ).toBe(false);
  });

  it("refuses smuggled top-level fields", () => {
    expect(
      updateNotificationPrefsSchema.safeParse({
        prefs: { invite: "all" },
        user_id: "44444444-4444-4444-8444-444444444444",
      }).success,
    ).toBe(false);
  });
});
