import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { getProfile } from "@/lib/profiles/queries";
import { createRoom, RoomError } from "@/lib/rooms/create";
import { listPublicRooms } from "@/lib/rooms/queries";
import { createClient } from "@/lib/supabase/server";
import { createRoomSchema, roomSearchSchema } from "@/lib/validation/rooms";

/**
 * GET /api/rooms — public room discovery.
 * Requires a session (401 otherwise) and returns only public rooms.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to list public rooms.", 401);
  }

  const parsedSearch = roomSearchSchema.safeParse({
    q: request.nextUrl.searchParams.get("q") ?? undefined,
  });

  if (!parsedSearch.success) {
    return validationResponse(parsedSearch.error);
  }

  try {
    const rooms = await listPublicRooms(supabase, parsedSearch.data);
    return NextResponse.json({ rooms });
  } catch (error) {
    console.error("[api/rooms] list failed:", error);
    return errorResponse(
      "query_failed",
      "Public rooms could not be loaded.",
      500,
    );
  }
}

/**
 * POST /api/rooms — creates a room through the create_room RPC.
 * 401 without a session, 403 before onboarding, 400 on invalid fields.
 * The owner is never accepted from the client.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to create a room.", 401);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse(
      "invalid_json",
      "The request body must be JSON.",
      400,
    );
  }

  const parsedRoom = createRoomSchema.safeParse(parsedBody.body);
  if (!parsedRoom.success) {
    return validationResponse(parsedRoom.error);
  }

  try {
    const profile = await getProfile(supabase, claims.sub);
    if (!profile) {
      return errorResponse(
        "onboarding_required",
        "Choose a study alias before creating a room.",
        403,
      );
    }
  } catch (error) {
    console.error("[api/rooms] profile lookup failed:", error);
    return errorResponse(
      "query_failed",
      "Your profile could not be loaded.",
      500,
    );
  }

  try {
    const room = await createRoom(supabase, parsedRoom.data);
    return NextResponse.json({ room }, { status: 201 });
  } catch (error) {
    if (error instanceof RoomError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/rooms] create failed:", error);
    return errorResponse(
      "rpc_failed",
      "The room could not be created. Please try again.",
      500,
    );
  }
}
