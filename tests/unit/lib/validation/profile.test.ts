import { aliasSchema, onboardingSchema } from "@/lib/validation/profile";
import { describe, expect, it } from "vitest";

describe("aliasSchema", () => {
  it("trims the alias", () => {
    expect(aliasSchema.parse("  StudyBuddy  ")).toBe("StudyBuddy");
  });

  it("requires a non-empty alias", () => {
    expect(aliasSchema.safeParse("   ").success).toBe(false);
    expect(aliasSchema.safeParse("").success).toBe(false);
  });

  it("rejects aliases longer than 32 characters", () => {
    expect(aliasSchema.safeParse("a".repeat(33)).success).toBe(false);
    expect(aliasSchema.safeParse("a".repeat(32)).success).toBe(true);
  });

  it("accepts letters, numbers, spaces, hyphens and underscores", () => {
    expect(aliasSchema.parse("study-buddy_1")).toBe("study-buddy_1");
    expect(aliasSchema.parse("Exam Prep 2026")).toBe("Exam Prep 2026");
  });

  it("rejects aliases that do not start with a letter or number", () => {
    expect(aliasSchema.safeParse("_buddy").success).toBe(false);
    expect(aliasSchema.safeParse("@buddy").success).toBe(false);
    expect(aliasSchema.safeParse("budd!es").success).toBe(false);
  });
});

describe("onboardingSchema", () => {
  it("parses a valid alias payload", () => {
    expect(onboardingSchema.parse({ alias: " examnerd " })).toEqual({
      alias: "examnerd",
    });
  });

  it("reports the alias path on failure", () => {
    const result = onboardingSchema.safeParse({ alias: "" });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["alias"]);
  });
});
