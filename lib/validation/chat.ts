import { z } from "zod";
import { CHAT_MESSAGE_MAX_LENGTH } from "@/lib/chat/types";

/** History page size the workspace requests, and the hard ceiling on `limit`. */
export const MESSAGE_PAGE_SIZE_DEFAULT = 50;
export const MESSAGE_PAGE_SIZE_MAX = 100;

const messageBodySchema = z
  .string()
  .trim()
  .min(1, "Message text is required.")
  .max(
    CHAT_MESSAGE_MAX_LENGTH,
    `Message must be ${CHAT_MESSAGE_MAX_LENGTH} characters or fewer.`,
  );

/**
 * Body of `POST /api/rooms/[id]/messages`. `.strict()` rejects unknown
 * fields — there is no `user_id` here: the identity comes from the verified
 * session, and RLS pins the insert to `auth.uid()` regardless. The `.trim()`
 * runs before the length checks, so the stored value already satisfies the
 * table's `body = btrim(body)` CHECK.
 */
export const sendMessageSchema = z
  .object({
    body: messageBodySchema,
  })
  .strict();

/**
 * Query of `GET /api/rooms/[id]/messages`. `before` names a message id whose
 * page comes below the one requested; it must be a UUID here and is scoped to
 * the room by the query layer, so an id from another room is a 400 rather
 * than a cross-room signal.
 */
export const messagesQuerySchema = z.object({
  before: z.uuid("That message id is not valid.").optional(),
  limit: z.coerce
    .number()
    .int("Limit must be a whole number.")
    .min(1, "Limit must be at least 1.")
    .max(
      MESSAGE_PAGE_SIZE_MAX,
      `Limit must be at most ${MESSAGE_PAGE_SIZE_MAX}.`,
    )
    .default(MESSAGE_PAGE_SIZE_DEFAULT),
});

export type SendMessageBody = z.infer<typeof sendMessageSchema>;
export type MessagesQuery = z.infer<typeof messagesQuerySchema>;
