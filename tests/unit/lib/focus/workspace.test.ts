import { FocusSessionError } from "@/lib/focus/sessions";
import { getFocusWorkspace } from "@/lib/focus/workspace";
import { createFakeClient } from "../../helpers/fake-supabase";
import { describe, expect, it } from "vitest";

const ROOM = "11111111-1111-4111-8111-111111111111";

const runningSession = {
  id: "22222222-2222-4222-8222-222222222222",
  room_id: ROOM,
  state: "running",
  duration_seconds: 1500,
  started_at: "2026-10-06T07:00:00+00:00",
  ends_at: "2026-10-06T07:25:00+00:00",
  paused_at: null,
  paused_seconds: 0,
  ended_at: null,
};

const completedSession = {
  id: "33333333-3333-4333-8333-333333333333",
  room_id: ROOM,
  state: "completed",
  duration_seconds: 2700,
  started_at: "2026-10-05T09:00:00+00:00",
  ends_at: "2026-10-05T09:45:00+00:00",
  paused_at: null,
  paused_seconds: 120,
  ended_at: "2026-10-05T09:44:10+00:00",
};

const roomRow = {
  id: ROOM,
  name: "Physics sprint",
  exam_track: "JEE",
  subject: "Physics",
  language: "English",
  capacity: 4,
  status: "open",
  shared_goal: "Finish rotational mechanics",
  created_at: "2026-10-01T10:00:00+00:00",
};

const okState = {
  code: "ok",
  session: runningSession,
  viewer_role: "owner",
  server_now_ms: 1791298800000,
  member_count: 3,
};

describe("getFocusWorkspace", () => {
  it("reads membership through the state RPC, then the room and history", async () => {
    const { client, builder, state, rpcCalls } = createFakeClient(
      { data: okState },
      [
        { data: okState }, // readFocusState
        { data: roomRow }, // rooms (maybeSingle)
        { data: [completedSession] }, // focus_sessions history
      ],
    );

    const workspace = await getFocusWorkspace(client as never, ROOM);

    expect(rpcCalls).toEqual([
      { fn: "focus_session_state", args: { p_room_id: ROOM } },
    ]);
    expect(workspace.room).toEqual({
      id: ROOM,
      name: "Physics sprint",
      exam_track: "JEE",
      subject: "Physics",
      language: "English",
      capacity: 4,
      status: "open",
      shared_goal: "Finish rotational mechanics",
      created_at: "2026-10-01T10:00:00+00:00",
    });
    expect(workspace.viewer_role).toBe("owner");
    expect(workspace.member_count).toBe(3);
    expect(workspace.server_now_ms).toBe(1791298800000);
    expect(workspace.session).toMatchObject({ id: runningSession.id });
    expect(workspace.history).toHaveLength(1);
    expect(workspace.history[0]).toMatchObject({
      id: completedSession.id,
      state: "completed",
    });

    // History is limited to terminal sessions of this room.
    expect(state.in).toEqual([["state", ["completed", "expired"]]]);
    expect(state.limit).toEqual([10]);
    expect(builder.select).toHaveBeenCalledWith(
      expect.stringContaining("ended_at"),
    );
  });

  it("never queries a room the caller is not a member of", async () => {
    const { client } = createFakeClient({
      data: { code: "room_not_found" },
    });

    const error = await getFocusWorkspace(client as never, ROOM).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(FocusSessionError);
    expect(error).toMatchObject({ code: "not_found", status: 404 });
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.from).not.toHaveBeenCalled();
  });

  it("treats a room row that vanished after the membership check as a 404", async () => {
    const { client } = createFakeClient({ data: okState }, [
      { data: okState },
      { data: null },
      { data: [] },
    ]);

    const error = await getFocusWorkspace(client as never, ROOM).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(FocusSessionError);
    expect(error).toMatchObject({ code: "not_found", status: 404 });
  });

  it("throws a plain error when the room query fails", async () => {
    const { client } = createFakeClient({ data: okState }, [
      { data: okState },
      { data: null, error: { message: "connection lost" } },
      { data: [] },
    ]);

    await expect(getFocusWorkspace(client as never, ROOM)).rejects.toThrow(
      /workspace room query failed/,
    );
  });

  it("throws a plain error when the history query fails", async () => {
    const { client } = createFakeClient({ data: okState }, [
      { data: okState },
      { data: roomRow },
      { data: null, error: { message: "connection lost" } },
    ]);

    await expect(getFocusWorkspace(client as never, ROOM)).rejects.toThrow(
      /workspace history query failed/,
    );
  });

  it("throws rather than serving a malformed history row", async () => {
    const { client } = createFakeClient({ data: okState }, [
      { data: okState },
      { data: roomRow },
      { data: [{ id: "broken" }] },
    ]);

    await expect(getFocusWorkspace(client as never, ROOM)).rejects.toThrow(
      /Unexpected focus session payload/,
    );
  });
});
