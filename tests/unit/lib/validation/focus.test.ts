import {
  FOCUS_DURATION_MAX,
  FOCUS_DURATION_MIN,
  startSessionSchema,
} from "@/lib/validation/focus";
import { describe, expect, it } from "vitest";

describe("startSessionSchema", () => {
  it("accepts the boundary durations", () => {
    expect(startSessionSchema.safeParse({ duration_seconds: FOCUS_DURATION_MIN }).success).toBe(true);
    expect(startSessionSchema.safeParse({ duration_seconds: FOCUS_DURATION_MAX }).success).toBe(true);
  });

  it("accepts a numeric string, matching the other JSON bodies", () => {
    const parsed = startSessionSchema.safeParse({ duration_seconds: "1500" });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.duration_seconds).toBe(1500);
  });

  it.each([
    ["too short", 30],
    ["too long", 10000],
    ["fractional", 1500.5],
    ["not a number", "soon"],
    ["missing", undefined],
    ["null", null],
  ])("rejects a %s duration", (_label, duration_seconds) => {
    expect(startSessionSchema.safeParse({ duration_seconds }).success).toBe(false);
  });

  it("rejects an unknown field instead of ignoring it", () => {
    const parsed = startSessionSchema.safeParse({
      duration_seconds: 1500,
      user_id: "someone",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects a body that is not an object", () => {
    expect(startSessionSchema.safeParse([]).success).toBe(false);
    expect(startSessionSchema.safeParse("1500").success).toBe(false);
  });
});
