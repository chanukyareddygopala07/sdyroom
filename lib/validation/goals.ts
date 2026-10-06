import { z } from "zod";

/** Mirrors the CHECK constraints on `study_goals` in 0003. */
export const GOAL_TITLE_MAX = 120;
export const GOAL_TARGET_SECONDS_MIN = 60;
export const GOAL_TARGET_SECONDS_MAX = 86400;
export const GOAL_TARGET_COUNT_MIN = 1;
export const GOAL_TARGET_COUNT_MAX = 10000;

export const goalStatusSchema = z.enum(["active", "completed"]);

const titleSchema = z
  .string()
  .trim()
  .min(1, "Goal title is required.")
  .max(
    GOAL_TITLE_MAX,
    `Goal title must be ${GOAL_TITLE_MAX} characters or fewer.`,
  );

const targetSecondsSchema = z.coerce
  .number()
  .int("Target time must be a whole number of seconds.")
  .min(
    GOAL_TARGET_SECONDS_MIN,
    `Target time must be at least ${GOAL_TARGET_SECONDS_MIN} seconds.`,
  )
  .max(
    GOAL_TARGET_SECONDS_MAX,
    `Target time must be at most ${GOAL_TARGET_SECONDS_MAX} seconds.`,
  );

const targetCountSchema = z.coerce
  .number()
  .int("Target count must be a whole number.")
  .min(GOAL_TARGET_COUNT_MIN, `Target count must be at least ${GOAL_TARGET_COUNT_MIN}.`)
  .max(
    GOAL_TARGET_COUNT_MAX,
    `Target count must be at most ${GOAL_TARGET_COUNT_MAX}.`,
  );

/**
 * Body of `POST /api/rooms/[id]/goals`. `.strict()` rejects unknown fields —
 * there is no `user_id` here: the identity comes from the verified session,
 * and the column grants would refuse a forged one anyway.
 */
export const createGoalSchema = z
  .object({
    title: titleSchema,
    target_seconds: targetSecondsSchema.nullable().optional(),
    target_count: targetCountSchema.nullable().optional(),
  })
  .strict();

/**
 * Body of `PATCH /api/goals/[goalId]`. Every field is optional; `null` clears
 * a target. `completed_at` and `updated_at` are deliberately not addressable —
 * they belong to the trigger, and the column grants reject them.
 */
export const updateGoalSchema = z
  .object({
    title: titleSchema.optional(),
    target_seconds: targetSecondsSchema.nullable().optional(),
    target_count: targetCountSchema.nullable().optional(),
    status: goalStatusSchema.optional(),
  })
  .strict();

export type CreateGoalBody = z.infer<typeof createGoalSchema>;
export type UpdateGoalBody = z.infer<typeof updateGoalSchema>;
