import { z } from "zod";

export const INVITEE_ALIAS_MAX = 32;
export const INVITE_TTL_MIN_HOURS = 1;
export const INVITE_TTL_MAX_HOURS = 168;
export const INVITE_TTL_DEFAULT_HOURS = 168;

/**
 * The invite field: another student's SdyRoom alias. Trimmed and bounded by
 * the same 1–32 rule `profiles.alias` stores (0001), because the RPC matches
 * against `lower(alias)` directly. There is deliberately no email or phone
 * lookup — SdyRoom collects neither.
 */
export const inviteeAliasSchema = z
  .string()
  .trim()
  .min(1, "Alias is required")
  .max(INVITEE_ALIAS_MAX, `Alias must be ${INVITEE_ALIAS_MAX} characters or fewer`);

/**
 * Body of `POST /api/rooms/[id]/invitations`. `.strict()` rejects unknown
 * fields — an attempted `invitee_id` is a 400 naming the field, not an ignored
 * suggestion, so identity can never look like it was accepted from the body.
 * The TTL bound mirrors the RPC's own 1–168 check.
 */
export const createInvitationSchema = z
  .object({
    invitee_alias: inviteeAliasSchema,
    ttl_hours: z
      .coerce.number()
      .int("Invitation lifetime must be a whole number of hours")
      .min(INVITE_TTL_MIN_HOURS, `Invitation lifetime must be at least ${INVITE_TTL_MIN_HOURS} hour`)
      .max(INVITE_TTL_MAX_HOURS, `Invitation lifetime must be at most ${INVITE_TTL_MAX_HOURS} hours`)
      .default(INVITE_TTL_DEFAULT_HOURS),
  })
  .strict();

/** Dynamic route id for `/api/invitations/[id]/*` — invitation ids are UUIDs. */
export const invitationIdSchema = z.uuid();

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
