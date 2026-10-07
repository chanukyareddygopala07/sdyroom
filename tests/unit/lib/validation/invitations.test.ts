import { describe, expect, it } from "vitest";
import {
  createInvitationSchema,
  inviteeAliasSchema,
  invitationIdSchema,
  INVITE_TTL_DEFAULT_HOURS,
} from "@/lib/validation/invitations";

describe("inviteeAliasSchema", () => {
  it("trims and accepts a normal alias", () => {
    expect(inviteeAliasSchema.parse("  studybuddy  ")).toBe("studybuddy");
  });

  it("rejects empty, whitespace-only and over-long aliases", () => {
    expect(inviteeAliasSchema.safeParse("").success).toBe(false);
    expect(inviteeAliasSchema.safeParse("   ").success).toBe(false);
    expect(inviteeAliasSchema.safeParse("a".repeat(33)).success).toBe(false);
    expect(inviteeAliasSchema.safeParse("a".repeat(32)).success).toBe(true);
  });
});

describe("createInvitationSchema", () => {
  it("defaults the TTL to 168 hours", () => {
    const parsed = createInvitationSchema.parse({ invitee_alias: "buddy" });
    expect(parsed.ttl_hours).toBe(INVITE_TTL_DEFAULT_HOURS);
    expect(INVITE_TTL_DEFAULT_HOURS).toBe(168);
  });

  it("accepts the documented 1–168 hour range", () => {
    expect(
      createInvitationSchema.parse({ invitee_alias: "buddy", ttl_hours: 1 })
        .ttl_hours,
    ).toBe(1);
    expect(
      createInvitationSchema.parse({ invitee_alias: "buddy", ttl_hours: 168 })
        .ttl_hours,
    ).toBe(168);
  });

  it("rejects TTLs outside the RPC's own bounds", () => {
    for (const ttl_hours of [0, 169, 1.5, -3]) {
      expect(
        createInvitationSchema.safeParse({ invitee_alias: "buddy", ttl_hours })
          .success,
      ).toBe(false);
    }
  });

  it("refuses identity or message fields instead of ignoring them", () => {
    // Addressed invitations carry an alias, never an id — a body that tries
    // to supply one must fail loudly rather than look like it was honoured.
    expect(
      createInvitationSchema.safeParse({
        invitee_alias: "buddy",
        invitee_id: "someone",
      }).success,
    ).toBe(false);
    expect(
      createInvitationSchema.safeParse({
        invitee_alias: "buddy",
        message: "hey!",
      }).success,
    ).toBe(false);
    // The product has no message field: an invitation is addressed, not
    // annotated.
    expect(createInvitationSchema.safeParse({ invitee_alias: "buddy", email: "a@b.c" }).success).toBe(
      false,
    );
  });
});

describe("invitationIdSchema", () => {
  it("accepts UUIDs only", () => {
    expect(
      invitationIdSchema.safeParse("2a4f5f38-0e0b-4a10-9cbb-6f7a8f2b1c44")
        .success,
    ).toBe(true);
    expect(invitationIdSchema.safeParse("not-a-uuid").success).toBe(false);
    expect(invitationIdSchema.safeParse("").success).toBe(false);
  });
});
