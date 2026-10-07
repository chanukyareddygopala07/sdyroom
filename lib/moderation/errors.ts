/**
 * One error vocabulary for every moderation RPC envelope. Codes mirror the
 * spec's error table (docs/prs/PR-09-moderation.md): 403 for privesc once
 * the room is known to the caller, 404 for anything that must not confirm
 * existence, 409 for state conflicts, 400 for contract violations.
 */
export type ModerationErrorCode =
  | "unauthenticated"
  | "not_found"
  | "not_moderator"
  | "not_owner"
  | "cannot_remove_owner"
  | "cannot_remove_self"
  | "cannot_mute_owner"
  | "cannot_mute_moderator"
  | "cannot_mute_self"
  | "cannot_moderate_owner"
  | "already_muted"
  | "not_muted"
  | "self_report"
  | "self_block"
  | "invalid_transition"
  | "invalid_subject"
  | "validation"
  | "invalid_request";

export class ModerationError extends Error {
  readonly code: ModerationErrorCode;
  readonly status: number;

  constructor(code: ModerationErrorCode, message: string, status: number) {
    super(message);
    this.name = "ModerationError";
    this.code = code;
    this.status = status;
  }
}

const MODERATION_RESULTS: Record<
  string,
  { code: ModerationErrorCode; status: number; message: string }
> = {
  not_found: {
    code: "not_found",
    status: 404,
    message: "That room does not exist or is not available.",
  },
  not_moderator: {
    code: "not_moderator",
    status: 403,
    message: "Only the room owner or a moderator can do that.",
  },
  not_owner: {
    code: "not_owner",
    status: 403,
    message: "Only the room owner can do that.",
  },
  cannot_remove_owner: {
    code: "cannot_remove_owner",
    status: 403,
    message: "The room owner cannot be removed from their own room.",
  },
  cannot_remove_self: {
    code: "cannot_remove_self",
    status: 403,
    message: "You cannot remove yourself this way.",
  },
  cannot_mute_owner: {
    code: "cannot_mute_owner",
    status: 403,
    message: "The room owner cannot be muted.",
  },
  cannot_mute_moderator: {
    code: "cannot_mute_moderator",
    status: 403,
    message: "Moderators cannot be muted.",
  },
  cannot_mute_self: {
    code: "cannot_mute_self",
    status: 403,
    message: "You cannot mute yourself.",
  },
  cannot_moderate_owner: {
    code: "cannot_moderate_owner",
    status: 403,
    message: "The room owner's role cannot be changed.",
  },
  already_muted: {
    code: "already_muted",
    status: 409,
    message: "That member is already muted.",
  },
  not_muted: {
    code: "not_muted",
    status: 409,
    message: "That member is not muted.",
  },
  self_report: {
    code: "self_report",
    status: 409,
    message: "You cannot report your own content.",
  },
  self_block: {
    code: "self_block",
    status: 409,
    message: "You cannot block yourself.",
  },
  invalid_transition: {
    code: "invalid_transition",
    status: 409,
    message: "That report status change is not allowed.",
  },
  invalid_subject: {
    code: "invalid_subject",
    status: 400,
    message: "That report subject is not valid.",
  },
  validation: {
    code: "validation",
    status: 400,
    message: "Those moderation details are not valid.",
  },
  invalid_request: {
    code: "invalid_request",
    status: 400,
    message: "That request is not valid.",
  },
};

/** Success codes the RPCs answer with — never mapped to an error. */
const SUCCESS_CODES = new Set([
  "ok",
  "created",
  "duplicate",
  "updated",
  "unchanged",
  "removed",
  "muted",
  "unmuted",
  "exists",
]);

export function isModerationSuccess(code: unknown): boolean {
  return typeof code === "string" && SUCCESS_CODES.has(code);
}

/**
 * Map an RPC envelope to an error, or `null` when the code is a success.
 * Unknown codes become `null` too so callers can treat them as transport
 * problems (500 hygiene) rather than echoing SQL text to a client.
 */
export function moderationErrorFrom(envelope: {
  code?: unknown;
}): ModerationError | null {
  const code = typeof envelope.code === "string" ? envelope.code : null;
  if (code === null || SUCCESS_CODES.has(code)) {
    return null;
  }
  const mapped = MODERATION_RESULTS[code];
  if (!mapped) {
    return null;
  }
  return new ModerationError(mapped.code, mapped.message, mapped.status);
}
