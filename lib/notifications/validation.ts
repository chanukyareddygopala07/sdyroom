import { z } from "zod";

import { PREF_VALUES } from "./types";

/** Path parameter for `/api/notifications/[notificationId]/read`. */
export const notificationIdSchema = z.uuid("Notification id must be a UUID.");

const cursorPartSeparator = "|";

/**
 * Opaque list cursor: `created_at|id` in base64url. The id rides along
 * because two rows can share a `now()` within one transaction, and a
 * keyset that only compares timestamps would silently skip one of them.
 */
export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}${cursorPartSeparator}${id}`, "utf8")
    .toString("base64url");
}

export const decodeCursorSchema = z
  .string()
  .min(1)
  .max(400)
  .transform((value, ctx): { createdAt: string; id: string } => {
    let decoded: string;
    try {
      decoded = Buffer.from(value, "base64url").toString("utf8");
    } catch {
      ctx.addIssue({ code: "custom", message: "Cursor is not valid." });
      return z.NEVER;
    }

    const separatorAt = decoded.indexOf(cursorPartSeparator);
    if (separatorAt <= 0) {
      ctx.addIssue({ code: "custom", message: "Cursor is not valid." });
      return z.NEVER;
    }

    const createdAt = decoded.slice(0, separatorAt);
    const id = decoded.slice(separatorAt + 1);
    const parsedId = z.uuid().safeParse(id);
    // PostgREST timestamps carry microseconds; `Date.parse` accepts every
    // form they arrive in, which a strict ISO schema would not.
    if (Number.isNaN(Date.parse(createdAt)) || !parsedId.success) {
      ctx.addIssue({ code: "custom", message: "Cursor is not valid." });
      return z.NEVER;
    }

    return { createdAt, id: parsedId.data };
  });

/**
 * `GET /api/notifications?limit=&cursor=&unread=`. `unread` arrives as the
 * string "true"/"false" — `z.coerce.boolean()` would treat the string
 * "false" as true, so the enum is parsed explicitly.
 */
export const listNotificationsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int("Limit must be a whole number")
    .min(1, "Limit must be at least 1")
    .max(50, "Limit must be 50 or fewer")
    .default(20),
  cursor: decodeCursorSchema.optional(),
  unread: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export const prefValueSchema = z.enum(PREF_VALUES);

/**
 * `PATCH /api/profile/notification-prefs` — a partial update of the four
 * categories plus the `default` fallback. `.strict()` on both levels means a
 * smuggled `user_id` or an unknown category key is a 400 naming the field,
 * not a silently ignored suggestion.
 */
export const updateNotificationPrefsSchema = z
  .object({
    prefs: z
      .object({
        default: prefValueSchema.optional(),
        invite: prefValueSchema.optional(),
        moderation: prefValueSchema.optional(),
        ai: prefValueSchema.optional(),
        resource: prefValueSchema.optional(),
      })
      .strict(),
  })
  .strict();

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
export type UpdateNotificationPrefsInput = z.infer<
  typeof updateNotificationPrefsSchema
>;
