import { z } from "zod";

export const ROOM_NAME_MIN = 1;
export const ROOM_NAME_MAX = 100;
export const CAPACITY_MIN = 1;
export const CAPACITY_MAX = 100;
export const CAPACITY_DEFAULT = 4;
export const EXAM_TRACK_MAX = 80;
export const SUBJECT_MAX = 80;
export const LANGUAGE_MAX = 40;
export const SHARED_GOAL_MAX = 500;
export const ROOM_QUERY_MAX = 100;

export const roomVisibilitySchema = z.enum(["public", "private"]);
export const roomStatusSchema = z.enum(["open", "closed"]);

/**
 * Optional free text: trimmed, length-checked after trimming (matching the
 * CHECK constraints in 0001_init.sql), then normalised to null — whether the
 * field is missing or blank — so the RPC stores NULL instead of an empty
 * string.
 */
const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be ${max} characters or fewer`)
    .optional()
    .transform((value) => (value === undefined || value === "" ? null : value));

/**
 * Every user-supplied room field. There is deliberately no owner id: the
 * database derives the owner from auth.uid() inside create_room().
 */
export const createRoomSchema = z.object({
  name: z
    .string()
    .trim()
    .min(ROOM_NAME_MIN, "Room name is required")
    .max(ROOM_NAME_MAX, `Room name must be ${ROOM_NAME_MAX} characters or fewer`),
  capacity: z
    .coerce.number()
    .int("Capacity must be a whole number")
    .min(CAPACITY_MIN, `Capacity must be at least ${CAPACITY_MIN}`)
    .max(CAPACITY_MAX, `Capacity must be at most ${CAPACITY_MAX}`)
    .default(CAPACITY_DEFAULT),
  visibility: roomVisibilitySchema.default("public"),
  exam_track: optionalText(EXAM_TRACK_MAX, "Exam track"),
  subject: optionalText(SUBJECT_MAX, "Subject"),
  language: optionalText(LANGUAGE_MAX, "Language"),
  shared_goal: optionalText(SHARED_GOAL_MAX, "Shared goal"),
  status: roomStatusSchema.default("open"),
});

export const roomSearchSchema = z.object({
  q: z
    .string()
    .trim()
    .max(ROOM_QUERY_MAX, `Search must be ${ROOM_QUERY_MAX} characters or fewer`)
    .default(""),
});

/**
 * The same optional text rule as on create, but as a *patch* value: absent
 * means "leave it alone" (the key never appears in the parsed output, so it
 * is dropped from the RPC's change set), while `null` or a blank string
 * means "clear it". Length and trim still apply before the database's CHECK
 * constraints would.
 */
const optionalTextPatch = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be ${max} characters or fewer`)
    .nullable()
    .optional()
    .transform((value) =>
      value === undefined ? undefined : value === null || value === "" ? null : value,
    );

/**
 * Body of `PATCH /api/rooms/[id]` — the owner's edit form. `.strict()`
 * refuses unknown fields (`owner_id`, `visibility`, `id`, `created_at`,
 * `updated_at` are not addressable here, and the database holds no UPDATE
 * grant for them either), and `.partial()` makes every listed field optional
 * so a PATCH carries only what changed. An empty object parses successfully
 * and the route rejects it with `invalid_request`, matching the goals PATCH.
 *
 * `name` has no default and no blank→null transform: a room always has a
 * name, so an empty string is a validation error rather than a clear.
 */
export const updateRoomSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(ROOM_NAME_MIN, "Room name is required")
      .max(ROOM_NAME_MAX, `Room name must be ${ROOM_NAME_MAX} characters or fewer`),
    capacity: z
      .coerce.number()
      .int("Capacity must be a whole number")
      .min(CAPACITY_MIN, `Capacity must be at least ${CAPACITY_MIN}`)
      .max(CAPACITY_MAX, `Capacity must be at most ${CAPACITY_MAX}`),
    status: roomStatusSchema,
    exam_track: optionalTextPatch(EXAM_TRACK_MAX, "Exam track"),
    subject: optionalTextPatch(SUBJECT_MAX, "Subject"),
    language: optionalTextPatch(LANGUAGE_MAX, "Language"),
    shared_goal: optionalTextPatch(SHARED_GOAL_MAX, "Shared goal"),
  })
  .strict()
  .partial();

/**
 * Dynamic route id for `/api/rooms/[id]/join` and `/leave`. Room ids are
 * UUIDs, so anything else is a 400 before the request reaches the database.
 */
export const roomIdSchema = z.uuid();

export type CreateRoomInput = z.infer<typeof createRoomSchema>;

export type UpdateRoomInput = z.infer<typeof updateRoomSchema>;

export type RoomSearchInput = z.infer<typeof roomSearchSchema>;
