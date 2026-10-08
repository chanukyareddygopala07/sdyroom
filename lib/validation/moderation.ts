import { z } from "zod";

/** Free text on a report, bounded exactly like the table's CHECK (0009). */
export const REPORT_DETAIL_MAX = 500;

/**
 * The closed reason list. Stored as CHECK-constrained text in
 * `moderation_reports`; there is no path by which a client-supplied string
 * outside this enum reaches the database.
 */
export const REPORT_REASONS = [
  "spam",
  "harassment",
  "abusive_content",
  "inappropriate_content",
  "impersonation",
  "unsafe_resource",
  "other",
] as const;

export const reportReasonSchema = z.enum(REPORT_REASONS);

/**
 * A moderation target alias: the same 1–32 trimmed shape `profiles.alias`
 * stores (the RPC matches on `lower(alias)`), kept independent of
 * `aliasSchema` the way `inviteeAliasSchema` is — moderation addresses a
 * member by the identity the roster shows, nothing more.
 */
export const moderationTargetAliasSchema = z
  .string()
  .trim()
  .min(1, "Alias is required")
  .max(32, "Alias must be 32 characters or fewer");

const reportFields = {
  reason: reportReasonSchema,
  detail: z
    .string()
    .trim()
    .max(REPORT_DETAIL_MAX, `Detail must be ${REPORT_DETAIL_MAX} characters or fewer`)
    .optional()
    .transform((value) => (value ? value : null)),
};

/**
 * `POST /api/rooms/[id]/reports` — a strict discriminated union. A user
 * subject is addressed by alias (the only wire identity SdyRoom has);
 * message and resource subjects are uuids the caller legitimately holds from
 * the room's own payloads. `.strict()` on every arm means a smuggled
 * `reporter_id` or `subject_user_id` is a 400 naming the field.
 */
export const createReportSchema = z.discriminatedUnion("subject_type", [
  z
    .object({
      subject_type: z.literal("user"),
      subject_alias: moderationTargetAliasSchema,
      ...reportFields,
    })
    .strict(),
  z
    .object({
      subject_type: z.literal("message"),
      subject_id: z.uuid("Report subject must be a valid id."),
      ...reportFields,
    })
    .strict(),
  z
    .object({
      subject_type: z.literal("resource"),
      subject_id: z.uuid("Report subject must be a valid id."),
      ...reportFields,
    })
    .strict(),
]);

/**
 * `PATCH /api/reports/[reportId]` — `pending` is the only status a client
 * cannot set (it is where reports start), and terminal states never reopen.
 */
export const reportStatusSchema = z.enum(["reviewing", "resolved", "dismissed"]);

export const updateReportStatusSchema = z
  .object({ status: reportStatusSchema })
  .strict();

/**
 * The three mute durations the product offers. The RPC re-checks the
 * resulting interval against the same three values.
 */
export const muteDurationSchema = z.enum(["1h", "24h", "7d"]);

export const muteBodySchema = z
  .object({ duration: muteDurationSchema })
  .strict();

/** `POST /api/blocks` — block by alias, never by a caller-supplied uuid. */
export const blockCreateSchema = z
  .object({ alias: moderationTargetAliasSchema })
  .strict();

/** Path parameter for member-scoped moderation routes. */
export const memberAliasSchema = moderationTargetAliasSchema;

/** Dynamic route id for `/api/reports/[reportId]` — report ids are UUIDs. */
export const reportIdSchema = z.uuid("Report id must be a UUID.");

/** `GET /api/rooms/[id]/reports?limit=` — bounded like every list endpoint. */
export const reportsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int("Limit must be a whole number")
    .min(1, "Limit must be at least 1")
    .max(100, "Limit must be 100 or fewer")
    .default(50),
});

export type CreateReportInput = z.infer<typeof createReportSchema>;
export type ReportStatus = z.infer<typeof reportStatusSchema>;
export type MuteDuration = z.infer<typeof muteDurationSchema>;
