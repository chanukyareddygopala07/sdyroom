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

export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type RoomSearchInput = z.infer<typeof roomSearchSchema>;
