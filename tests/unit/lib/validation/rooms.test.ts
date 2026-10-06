import {
  CAPACITY_DEFAULT,
  createRoomSchema,
  roomIdSchema,
  roomSearchSchema,
} from "@/lib/validation/rooms";
import { describe, expect, it } from "vitest";

describe("createRoomSchema", () => {
  it("trims the name and fills in the database defaults", () => {
    const parsed = createRoomSchema.parse({ name: "  Calculus Study Room  " });

    expect(parsed).toEqual({
      name: "Calculus Study Room",
      capacity: CAPACITY_DEFAULT,
      visibility: "public",
      status: "open",
      exam_track: null,
      subject: null,
      language: null,
      shared_goal: null,
    });
  });

  it("requires a name", () => {
    const result = createRoomSchema.safeParse({ name: "   " });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["name"]);
  });

  it("rejects a name longer than the database CHECK allows", () => {
    const result = createRoomSchema.safeParse({ name: "a".repeat(101) });

    expect(result.success).toBe(false);
  });

  it("coerces capacity from a form string and validates its range", () => {
    expect(createRoomSchema.parse({ name: "Room", capacity: "6" }).capacity).toBe(
      6,
    );
    expect(createRoomSchema.safeParse({ name: "Room", capacity: 0 }).success).toBe(
      false,
    );
    expect(
      createRoomSchema.safeParse({ name: "Room", capacity: 101 }).success,
    ).toBe(false);
    expect(
      createRoomSchema.safeParse({ name: "Room", capacity: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects unknown visibility and status values", () => {
    expect(
      createRoomSchema.safeParse({ name: "Room", visibility: "everyone" })
        .success,
    ).toBe(false);
    expect(
      createRoomSchema.safeParse({ name: "Room", status: "archived" }).success,
    ).toBe(false);
  });

  it("normalises blank optional fields to null and enforces their max lengths", () => {
    const parsed = createRoomSchema.parse({
      name: "Room",
      subject: "   ",
      exam_track: "JEE",
    });

    expect(parsed.subject).toBeNull();
    expect(parsed.exam_track).toBe("JEE");

    expect(
      createRoomSchema.safeParse({ name: "Room", exam_track: "a".repeat(81) })
        .success,
    ).toBe(false);
    expect(
      createRoomSchema.safeParse({ name: "Room", subject: "a".repeat(81) })
        .success,
    ).toBe(false);
    expect(
      createRoomSchema.safeParse({ name: "Room", language: "a".repeat(41) })
        .success,
    ).toBe(false);
    expect(
      createRoomSchema.safeParse({ name: "Room", shared_goal: "a".repeat(501) })
        .success,
    ).toBe(false);
  });

  it("never forwards an owner id to the RPC", () => {
    const parsed = createRoomSchema.parse({
      name: "Room",
      owner_id: "someone-else",
      id: "room-id",
    });

    expect(parsed).not.toHaveProperty("owner_id");
    expect(parsed).not.toHaveProperty("id");
  });
});

describe("roomSearchSchema", () => {
  it("defaults to an empty search and trims input", () => {
    expect(roomSearchSchema.parse({})).toEqual({ q: "" });
    expect(roomSearchSchema.parse({ q: "  calculus " })).toEqual({
      q: "calculus",
    });
  });

  it("rejects searches longer than the query limit", () => {
    expect(roomSearchSchema.safeParse({ q: "a".repeat(101) }).success).toBe(
      false,
    );
  });
});

describe("roomIdSchema", () => {
  it("accepts a UUID", () => {
    expect(roomIdSchema.safeParse("11111111-1111-4111-8111-111111111111").success).toBe(
      true,
    );
  });

  it("rejects anything that is not a UUID so bad ids stop at the route", () => {
    for (const value of ["", "not-a-uuid", "room-1", "1; drop table rooms"]) {
      expect(roomIdSchema.safeParse(value).success).toBe(false);
    }
  });
});
