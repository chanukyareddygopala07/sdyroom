import { z } from "zod";

/** Mirrors `focus_sessions_duration` in 0003_focus_sessions_and_goals.sql. */
export const FOCUS_DURATION_MIN = 60;
export const FOCUS_DURATION_MAX = 7200;

export const FOCUS_DURATION_PRESETS = [1500, 2700, 3600] as const;

/**
 * Body of `POST /api/rooms/[id]/session/start`.
 *
 * `.strict()` means an unknown field is a 400 rather than something the
 * endpoint quietly ignores — a request that looks like it carried extra
 * intent must never appear to have been honoured.
 */
export const startSessionSchema = z
  .object({
    duration_seconds: z.coerce
      .number()
      .int("Focus duration must be a whole number of seconds.")
      .min(
        FOCUS_DURATION_MIN,
        `Focus duration must be at least ${FOCUS_DURATION_MIN} seconds.`,
      )
      .max(
        FOCUS_DURATION_MAX,
        `Focus duration must be at most ${FOCUS_DURATION_MAX} seconds.`,
      ),
  })
  .strict();

export type StartSessionInput = z.infer<typeof startSessionSchema>;
