import { z } from "zod";
import {
  COMMUNITY_ATTACHMENT_MAX_BYTES,
  COMMUNITY_CIPHERTEXT_MAX_LENGTH,
  COMMUNITY_KEY_PACKAGE_MAX_LENGTH,
  COMMUNITY_MESSAGE_PAGE_SIZE_DEFAULT,
  COMMUNITY_MESSAGE_PAGE_SIZE_MAX,
} from "@/lib/communities/types";

/** Community id path segment. */
export const communityIdSchema = z.uuid();

/** Channel id path segment. */
export const communityChannelIdSchema = z.uuid();

/** Slug: 4–40 chars, lowercase alphanumerics and hyphens, no edge hyphens. */
export const communitySlugSchema = z
  .string()
  .trim()
  .min(4, "Community slug must be at least 4 characters.")
  .max(40, "Community slug must be 40 characters or fewer.")
  .regex(
    /^[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$/,
    "Use lowercase letters, numbers and hyphens (no leading or trailing hyphen).",
  );

const communityNameSchema = z
  .string()
  .trim()
  .min(3, "Community name must be at least 3 characters.")
  .max(60, "Community name must be 60 characters or fewer.");

const communityDescriptionSchema = z
  .string()
  .trim()
  .max(1000, "Description must be 1000 characters or fewer.")
  .default("");

const communityRulesSchema = z
  .string()
  .trim()
  .max(2000, "Rules must be 2000 characters or fewer.")
  .default("");

const communityCategorySchema = z.enum([
  "study",
  "exams",
  "subjects",
  "projects",
  "campus",
  "other",
]);

const communityVisibilitySchema = z.enum(["public", "private"]);

const communityJoinPolicySchema = z.enum(["open", "request"]);

/** Base64 (standard alphabet, padded) for an opaque MLS envelope. */
const base64Schema = z
  .string()
  .min(16, "That encrypted payload is not valid.")
  .max(
    COMMUNITY_CIPHERTEXT_MAX_LENGTH,
    `Encrypted payload must be ${COMMUNITY_CIPHERTEXT_MAX_LENGTH} characters or fewer.`,
  )
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "Encrypted payload must be base64.");

/**
 * Body of `POST /api/communities`. `.strict()` rejects unknown fields —
 * owner/member bookkeeping is pinned to the session by the `create_community`
 * RPC, never taken from the body. Private communities must use the request
 * join policy; the RPC and the table CHECK enforce the same pairing.
 */
export const createCommunitySchema = z
  .object({
    slug: communitySlugSchema,
    name: communityNameSchema,
    description: communityDescriptionSchema.optional(),
    category: communityCategorySchema.default("study"),
    visibility: communityVisibilitySchema.default("public"),
    joinPolicy: communityJoinPolicySchema.optional(),
    rules: communityRulesSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.visibility === "public" || value.joinPolicy !== "open",
    {
      message: "Private communities only accept request-based joining.",
      path: ["joinPolicy"],
    },
  );

/** Body of `PATCH /api/communities/[id]` — staff-only editable fields. */
export const updateCommunitySchema = z
  .object({
    name: communityNameSchema.optional(),
    description: communityDescriptionSchema.optional(),
    category: communityCategorySchema.optional(),
    visibility: communityVisibilitySchema.optional(),
    joinPolicy: communityJoinPolicySchema.optional(),
    rules: communityRulesSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.visibility !== "private" || value.joinPolicy !== "open",
    {
      message: "Private communities only accept request-based joining.",
      path: ["joinPolicy"],
    },
  );

/** Body of `POST /api/communities/[id]/channels`. */
export const createChannelSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Channel name is required.")
      .max(40, "Channel name must be 40 characters or fewer."),
    slug: z
      .string()
      .trim()
      .min(1, "Channel slug is required.")
      .max(40, "Channel slug must be 40 characters or fewer.")
      .regex(
        /^(general|[a-z0-9][a-z0-9-]{0,38}[a-z0-9])$/,
        "Use lowercase letters, numbers and hyphens.",
      ),
    description: z
      .string()
      .trim()
      .max(200, "Channel description must be 200 characters or fewer.")
      .default(""),
  })
  .strict();

/**
 * Body of `POST /api/communities/[id]/channels/[channelId]/messages` — one
 * opaque MLS envelope. The kind allow-list keeps the stream to protocol
 * messages: `application` is a private message, `commit` is a public
 * membership/epoch commit. Welcomes carry an addressee and go to
 * `community_welcomes` instead.
 */
export const sendCommunityMessageSchema = z
  .object({
    kind: z.enum(["application", "commit"]),
    ciphertext: base64Schema,
    clientMsgId: z.uuid("clientMsgId must be a UUID."),
    senderDeviceId: z
      .string()
      .trim()
      .min(8, "senderDeviceId must be at least 8 characters.")
      .max(64, "senderDeviceId must be 64 characters or fewer."),
  })
  .strict();

/**
 * Body of `POST /api/communities/[id]/channels/[channelId]/welcomes` — a
 * welcome envelope addressed to one user+device, plus the public ratchet-tree
 * snapshot the joiner needs (RFC 9420 distributes it alongside the welcome).
 */
export const sendCommunityWelcomeSchema = z
  .object({
    ciphertext: base64Schema,
    ratchetTree: z
      .string()
      .min(16, "That ratchet tree is not valid.")
      .max(1_048_576, "Ratchet tree must be 1 MB or fewer.")
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, "Ratchet tree must be base64."),
    clientMsgId: z.uuid("clientMsgId must be a UUID."),
    recipientUserId: z.uuid("recipientUserId must be a UUID."),
    recipientDeviceId: z
      .string()
      .trim()
      .min(8, "recipientDeviceId must be at least 8 characters.")
      .max(64, "recipientDeviceId must be 64 characters or fewer."),
  })
  .strict();

/** Query of `GET /api/communities/[id]/channels/[channelId]/messages`. */
export const communityMessagesQuerySchema = z.object({
  before: z.coerce
    .number()
    .int("before must be a whole number.")
    .min(1, "before must be at least 1.")
    .optional(),
  limit: z.coerce
    .number()
    .int("Limit must be a whole number.")
    .min(1, "Limit must be at least 1.")
    .max(
      COMMUNITY_MESSAGE_PAGE_SIZE_MAX,
      `Limit must be at most ${COMMUNITY_MESSAGE_PAGE_SIZE_MAX}.`,
    )
    .default(COMMUNITY_MESSAGE_PAGE_SIZE_DEFAULT),
});

/** Body of `POST /api/communities/devices` — publish one device's key package. */
export const registerCommunityDeviceSchema = z
  .object({
    deviceId: z
      .string()
      .trim()
      .min(8, "deviceId must be at least 8 characters.")
      .max(64, "deviceId must be 64 characters or fewer."),
    keyPackage: z
      .string()
      .min(64, "That key package is not valid.")
      .max(
        COMMUNITY_KEY_PACKAGE_MAX_LENGTH,
        `Key package must be ${COMMUNITY_KEY_PACKAGE_MAX_LENGTH} characters or fewer.`,
      )
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, "Key package must be base64."),
    signaturePublicKey: z
      .string()
      .trim()
      .min(16, "signaturePublicKey is not valid.")
      .max(256, "signaturePublicKey must be 256 characters or fewer."),
  })
  .strict();

/** Body of `POST /api/communities/devices/fetch` — key packages for Add commits. */
export const fetchCommunityKeysSchema = z
  .object({
    communityId: communityIdSchema,
    userIds: z
      .array(z.uuid())
      .min(1, "userIds must not be empty.")
      .max(50, "userIds must hold at most 50 ids."),
  })
  .strict();

/** Body of `POST /api/communities/[id]/reports`. */
export const createCommunityReportSchema = z
  .object({
    targetType: z.enum(["message", "member"]),
    targetId: z.string().trim().min(1).max(128),
    reason: z
      .string()
      .trim()
      .min(1, "A reason is required.")
      .max(500, "Reason must be 500 characters or fewer."),
    contextExcerpt: z
      .string()
      .trim()
      .max(2000, "Excerpt must be 2000 characters or fewer.")
      .nullish(),
  })
  .strict();

/** Body of `POST /api/communities/[id]/attachments` — ciphertext metadata. */
export const createCommunityAttachmentSchema = z
  .object({
    channelId: communityChannelIdSchema,
    storagePath: z
      .string()
      .trim()
      .regex(
        /^community-attachments\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/,
        "storagePath must be community-attachments/<community>/<channel>/<attachment>.",
      ),
    ciphertextSize: z
      .number()
      .int("ciphertextSize must be a whole number.")
      .min(1, "ciphertextSize must be at least 1.")
      .max(
        COMMUNITY_ATTACHMENT_MAX_BYTES,
        `Ciphertext must be ${COMMUNITY_ATTACHMENT_MAX_BYTES} bytes or fewer.`,
      ),
    contentType: z
      .string()
      .trim()
      .max(128, "contentType must be 128 characters or fewer.")
      .default("application/octet-stream"),
  })
  .strict();

/** Query of `GET /api/communities` — discovery filters. */
export const listCommunitiesQuerySchema = z.object({
  category: communityCategorySchema.optional(),
  q: z
    .string()
    .trim()
    .max(60, "Search must be 60 characters or fewer.")
    .optional(),
  limit: z.coerce
    .number()
    .int("Limit must be a whole number.")
    .min(1, "Limit must be at least 1.")
    .max(50, "Limit must be at most 50.")
    .default(20),
});

/** Body of `PATCH /api/communities/[id]/members/[userId]`. */
export const setCommunityMemberSchema = z
  .object({
    role: z.enum(["owner", "moderator", "member"]).nullish(),
    status: z.enum(["active", "requested", "banned"]).nullish(),
  })
  .strict();

export type CreateCommunityBody = z.infer<typeof createCommunitySchema>;
export type UpdateCommunityBody = z.infer<typeof updateCommunitySchema>;
export type CreateChannelBody = z.infer<typeof createChannelSchema>;
export type SendCommunityMessageBody = z.infer<
  typeof sendCommunityMessageSchema
>;
export type SendCommunityWelcomeBody = z.infer<
  typeof sendCommunityWelcomeSchema
>;
export type CommunityMessagesQuery = z.infer<
  typeof communityMessagesQuerySchema
>;
export type RegisterCommunityDeviceBody = z.infer<
  typeof registerCommunityDeviceSchema
>;
export type FetchCommunityKeysBody = z.infer<typeof fetchCommunityKeysSchema>;
export type CreateCommunityReportBody = z.infer<
  typeof createCommunityReportSchema
>;
export type CreateCommunityAttachmentBody = z.infer<
  typeof createCommunityAttachmentSchema
>;
export type ListCommunitiesQuery = z.infer<typeof listCommunitiesQuerySchema>;
export type SetCommunityMemberBody = z.infer<typeof setCommunityMemberSchema>;
