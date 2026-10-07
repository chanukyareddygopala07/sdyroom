import { z } from "zod";

/** Hard ceiling on one upload: 20 MiB. Matches the bucket's file_size_limit. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TITLE_CHARS = 120;
export const MAX_SUBJECT_CHARS = 80;
export const MAX_CHAPTER_CHARS = 80;
export const MAX_FILENAME_CHARS = 255;
export const MAX_SEARCH_CHARS = 100;
export const RESOURCE_PAGE_SIZE_DEFAULT = 50;
export const RESOURCE_PAGE_SIZE_MAX = 100;
export const RESOURCE_OFFSET_MAX = 1_000_000;
/** How long an issued download URL stays valid. */
export const DOWNLOAD_TTL_SECONDS = 300;

/**
 * C0 DEL controls. A title, subject or chapter is rendered as text and stored
 * in a single-line column, so an embedded newline or NUL is never legitimate.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const singleLine = (max: number, label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} must be ${max} characters or fewer.`)
    .refine((value) => !CONTROL_CHARS.test(value), {
      message: `${label} must not contain control characters.`,
    });

/** Optional free text: trimmed, length-checked, blank normalised to null. */
const optionalLine = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be ${max} characters or fewer.`)
    .optional()
    .refine(
      (value) => value === undefined || !CONTROL_CHARS.test(value),
      `${label} must not contain control characters.`,
    )
    .transform((value) => (value === undefined || value === "" ? null : value));

/**
 * Metadata of `POST /api/resources`, minus the file itself.
 *
 * `.strict()` matters more than usual here: the upload carries an owner id and
 * a storage path that the server generates, and silently ignoring a client's
 * `owner_id` would let a forged value *look* accepted. Rejecting every unknown
 * key makes it impossible for a body to appear to have been honoured.
 */
export const resourceMetadataSchema = z
  .object({
    title: singleLine(MAX_TITLE_CHARS, "Title"),
    subject: optionalLine(MAX_SUBJECT_CHARS, "Subject"),
    chapter: optionalLine(MAX_CHAPTER_CHARS, "Chapter"),
    room_id: z.uuid("That room id is not valid.").optional(),
  })
  .strict();

/**
 * Query of `GET /api/resources`.
 *
 * `scope` and `room_id` select mutually exclusive listings: a request that
 * carries both is ambiguous, so it is a 400 rather than a silent preference.
 */
export const resourceListQuerySchema = z
  .object({
    // No default here on purpose: the mutual-exclusion rule below needs to see
    // whether the caller actually sent `scope`. The route treats an absent
    // `scope` as `personal`, which is the documented default.
    scope: z.enum(["personal"]).optional(),
    room_id: z.uuid("That room id is not valid.").optional(),
    q: z
      .string()
      .trim()
      .max(
        MAX_SEARCH_CHARS,
        `Search must be ${MAX_SEARCH_CHARS} characters or fewer.`,
      )
      .default(""),
    subject: optionalLine(MAX_SUBJECT_CHARS, "Subject"),
    chapter: optionalLine(MAX_CHAPTER_CHARS, "Chapter"),
    limit: z.coerce
      .number()
      .int("Limit must be a whole number.")
      .min(1, "Limit must be at least 1.")
      .max(
        RESOURCE_PAGE_SIZE_MAX,
        `Limit must be at most ${RESOURCE_PAGE_SIZE_MAX}.`,
      )
      .default(RESOURCE_PAGE_SIZE_DEFAULT),
    offset: z.coerce
      .number()
      .int("Offset must be a whole number.")
      .min(0, "Offset must be at least 0.")
      .max(
        RESOURCE_OFFSET_MAX,
        `Offset must be at most ${RESOURCE_OFFSET_MAX}.`,
      )
      .default(0),
  })
  .superRefine((value, ctx) => {
    if (value.scope !== undefined && value.room_id !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["scope"],
        message: "Pass either scope or room_id, not both.",
      });
    }
  });

/** Dynamic route id for `/api/resources/[id]` and its `download` child. */
export const resourceIdSchema = z.uuid();

export type ResourceMetadataInput = z.infer<typeof resourceMetadataSchema>;
export type ResourceListQuery = z.infer<typeof resourceListQuerySchema>;
