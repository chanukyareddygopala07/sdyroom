import {
  createGoalSchema,
  GOAL_TARGET_COUNT_MAX,
  GOAL_TARGET_SECONDS_MAX,
  GOAL_TITLE_MAX,
  updateGoalSchema,
} from "@/lib/validation/goals";
import { describe, expect, it } from "vitest";

describe("createGoalSchema", () => {
  it("accepts a title on its own", () => {
    const parsed = createGoalSchema.safeParse({ title: "Finish chapter 4" });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.target_seconds).toBeUndefined();
  });

  it("trims the title", () => {
    const parsed = createGoalSchema.safeParse({ title: "  Read notes  " });

    expect(parsed.success && parsed.data.title).toBe("Read notes");
  });

  it("accepts explicit null targets to clear them", () => {
    const parsed = createGoalSchema.safeParse({
      title: "Read notes",
      target_seconds: null,
      target_count: null,
    });

    expect(parsed.success && parsed.data.target_seconds).toBeNull();
    expect(parsed.success && parsed.data.target_count).toBeNull();
  });

  it.each([
    ["blank title", { title: "   " }],
    ["title over the limit", { title: "x".repeat(GOAL_TITLE_MAX + 1) }],
    ["target too short", { title: "Read", target_seconds: 30 }],
    ["target too long", { title: "Read", target_seconds: GOAL_TARGET_SECONDS_MAX + 60 }],
    ["target count too small", { title: "Read", target_count: 0 }],
    ["target count too large", { title: "Read", target_count: GOAL_TARGET_COUNT_MAX + 1 }],
    ["missing title", {}],
  ])("rejects %s", (_label, body) => {
    expect(createGoalSchema.safeParse(body).success).toBe(false);
  });

  it("rejects an unknown field instead of ignoring it", () => {
    expect(
      createGoalSchema.safeParse({
        title: "Read",
        user_id: "someone",
        status: "completed",
      }).success,
    ).toBe(false);
  });

  it("accepts a title exactly at the limit", () => {
    expect(
      createGoalSchema.safeParse({ title: "x".repeat(GOAL_TITLE_MAX) }).success,
    ).toBe(true);
  });
});

describe("updateGoalSchema", () => {
  it("accepts a single field and reports the rest as absent", () => {
    const parsed = updateGoalSchema.safeParse({ status: "completed" });

    expect(parsed.success && parsed.data).toEqual({ status: "completed" });
  });

  it("accepts every editable field together", () => {
    expect(
      updateGoalSchema.safeParse({
        title: "Revised",
        target_seconds: 1800,
        target_count: 10,
        status: "active",
      }).success,
    ).toBe(true);
  });

  it("rejects fields the client may never write", () => {
    expect(
      updateGoalSchema.safeParse({ completed_at: "2026-01-01T00:00:00Z" })
        .success,
    ).toBe(false);
    expect(updateGoalSchema.safeParse({ room_id: "x" }).success).toBe(false);
    expect(updateGoalSchema.safeParse({ status: "archived" }).success).toBe(
      false,
    );
  });

  it("rejects a body that is not an object", () => {
    expect(updateGoalSchema.safeParse(null).success).toBe(false);
    expect(updateGoalSchema.safeParse([]).success).toBe(false);
  });
});
