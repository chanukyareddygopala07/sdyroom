import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateRoomInput } from "@/lib/validation/rooms";
import { toPublicRoom } from "./shape";
import type { PublicRoom } from "./types";

export type RoomErrorCode =
  | "validation"
  | "permission_denied"
  | "invariant_violation"
  | "network"
  | "rpc_failed";

/** Failure carrying the HTTP status the API layer should return. */
export class RoomError extends Error {
  readonly code: RoomErrorCode;
  readonly status: number;

  constructor(code: RoomErrorCode, message: string, status: number) {
    super(message);
    this.name = "RoomError";
    this.code = code;
    this.status = status;
  }
}

type RpcError = { code?: string | null; message?: string | null };

const NETWORK_MARKERS = [
  "fetch failed",
  "failed to fetch",
  "econnrefused",
  "networkerror",
  "socket hang up",
];

function isNetworkFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return NETWORK_MARKERS.some((marker) => lower.includes(marker));
}

/** Maps create_room errors onto stable, client-safe codes. */
export function mapRpcError(error: RpcError): RoomError {
  const message = error.message ?? "";

  switch (error.code) {
    case "22023":
      return new RoomError(
        "validation",
        message || "The room details are not valid.",
        400,
      );
    case "42501":
      return new RoomError(
        "permission_denied",
        "You do not have permission to create this room.",
        403,
      );
    case "23514":
      return new RoomError(
        "invariant_violation",
        "The room could not be saved because its owner membership is missing.",
        500,
      );
    default:
      break;
  }

  if (isNetworkFailure(message)) {
    return new RoomError(
      "network",
      "Could not reach the database. Please try again.",
      503,
    );
  }

  return new RoomError(
    "rpc_failed",
    "The room could not be created. Please try again.",
    500,
  );
}

/**
 * Creates a room through the create_room RPC. The owner is derived from
 * auth.uid() inside the function, and the owner membership is written in the
 * same transaction, so this is the only way the app creates rooms.
 */
export async function createRoom(
  client: SupabaseClient,
  input: CreateRoomInput,
): Promise<PublicRoom> {
  try {
    const { data, error } = await client.rpc("create_room", {
      p_name: input.name,
      p_capacity: input.capacity,
      p_visibility: input.visibility,
      p_exam_track: input.exam_track,
      p_subject: input.subject,
      p_language: input.language,
      p_status: input.status,
      p_shared_goal: input.shared_goal,
    });

    if (error) {
      throw mapRpcError(error);
    }

    if (!data) {
      throw new RoomError(
        "rpc_failed",
        "The room could not be created. Please try again.",
        500,
      );
    }

    return toPublicRoom(data as Record<string, unknown>);
  } catch (error) {
    if (error instanceof RoomError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "";
    if (isNetworkFailure(message)) {
      throw new RoomError(
        "network",
        "Could not reach the database. Please try again.",
        503,
      );
    }

    throw new RoomError(
      "rpc_failed",
      "The room could not be created. Please try again.",
      500,
    );
  }
}
