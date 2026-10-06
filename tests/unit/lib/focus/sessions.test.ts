import {
  endFocusSession,
  FocusSessionError,
  pauseFocusSession,
  readFocusState,
  resumeFocusSession,
  startFocusSession,
  toFocusSession,
} from "@/lib/focus/sessions";
import { createFakeClient } from "../../helpers/fake-supabase";
import { describe, expect, it } from "vitest";

const ROOM = "11111111-1111-4111-8111-111111111111";

const sessionRow = {
  id: "22222222-2222-4222-8222-222222222222",
  room_id: ROOM,
  state: "running",
  duration_seconds: 1500,
  started_at: "2026-10-06T07:00:00+00:00",
  ends_at: "2026-10-06T07:25:00+00:00",
  paused_at: null,
  paused_seconds: 0,
  ended_at: null,
  // A column that exists on the row but must never reach a client.
  created_at: "2026-10-06T07:00:00+00:00",
};

const exposedKeys = [
  "duration_seconds",
  "ended_at",
  "ends_at",
  "id",
  "paused_at",
  "paused_seconds",
  "room_id",
  "started_at",
  "state",
];

describe("toFocusSession", () => {
  it("keeps exactly the exposed fields and drops everything else", () => {
    const session = toFocusSession(sessionRow);

    expect(Object.keys(session).sort()).toEqual(exposedKeys);
    expect(session.state).toBe("running");
  });

  it.each([
    ["unknown state", { ...sessionRow, state: "cancelled" }],
    ["missing id", { ...sessionRow, id: undefined }],
    ["non-numeric duration", { ...sessionRow, duration_seconds: "1500" }],
    ["number instead of timestamp", { ...sessionRow, ends_at: 5 }],
    ["present ended_at on a running session", { ...sessionRow, ended_at: "2026-10-06T07:10:00+00:00" }],
    ["non-object", "running"],
    ["null", null],
  ])("rejects a malformed payload (%s)", (_label, value) => {
    expect(() => toFocusSession(value)).toThrow(/Unexpected focus session payload|Missing focus session payload/);
  });
});

describe("readFocusState", () => {
  it("reads the state with only the room id", async () => {
    const { client, rpcCalls } = createFakeClient({
      data: {
        code: "ok",
        session: sessionRow,
        viewer_role: "owner",
        server_now_ms: 1791298800000,
        member_count: 3,
      },
    });

    const state = await readFocusState(client as never, ROOM);

    expect(rpcCalls).toEqual([
      { fn: "focus_session_state", args: { p_room_id: ROOM } },
    ]);
    expect(state).toEqual({
      session: toFocusSession(sessionRow),
      viewer_role: "owner",
      server_now_ms: 1791298800000,
      member_count: 3,
    });
  });

  it("reports no session when the room has none running", async () => {
    const { client } = createFakeClient({
      data: {
        code: "ok",
        session: null,
        viewer_role: "student",
        server_now_ms: 1791298800000,
        member_count: 2,
      },
    });

    const state = await readFocusState(client as never, ROOM);

    expect(state.session).toBeNull();
    expect(state.viewer_role).toBe("student");
  });

  it("maps room_not_found onto a 404", async () => {
    const { client } = createFakeClient({ data: { code: "room_not_found" } });

    const error = await readFocusState(client as never, ROOM).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(FocusSessionError);
    expect(error).toMatchObject({ code: "not_found", status: 404 });
  });

  it("keeps SQL details out of the message a client would see", async () => {
    const { client } = createFakeClient({ data: { code: "room_not_found" } });

    const error = (await readFocusState(client as never, ROOM).catch(
      (e: unknown) => e,
    )) as FocusSessionError;

    expect(error.message).toBe(
      "That room does not exist or is not available.",
    );
    expect(error.message).not.toMatch(/sql|relation|policy|select/i);
  });

  it("throws a plain error for an unexpected envelope", async () => {
    const { client } = createFakeClient({ data: { code: "surprise" } });

    await expect(readFocusState(client as never, ROOM)).rejects.toThrow(
      /Unexpected focus state result/,
    );
  });

  it("throws when the envelope is missing the clock or the role", async () => {
    const { client } = createFakeClient({
      data: { code: "ok", session: null, viewer_role: "owner" },
    });

    await expect(readFocusState(client as never, ROOM)).rejects.toThrow(
      /Unexpected focus state result/,
    );
  });

  it("throws a plain error when the RPC call itself fails", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { message: "fetch failed" },
    });

    const error = await readFocusState(client as never, ROOM).catch(
      (e: unknown) => e,
    );

    expect(error).not.toBeInstanceOf(FocusSessionError);
    expect((error as Error).message).toContain(
      "focus_session_state failed",
    );
  });

  it("maps the duration check onto a 400 if validation was bypassed", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { code: "22023", message: "duration must be between..." },
    });

    const error = await startFocusSession(client as never, ROOM, 30).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(FocusSessionError);
    expect(error).toMatchObject({ code: "invalid", status: 400 });
  });
});

describe("session controls", () => {
  it("sends the room id and the duration for a start", async () => {
    const { client, rpcCalls } = createFakeClient({
      data: { code: "started", session: sessionRow },
    });

    const result = await startFocusSession(client as never, ROOM, 1500);

    expect(rpcCalls).toEqual([
      {
        fn: "start_focus_session",
        args: { p_room_id: ROOM, p_duration_seconds: 1500 },
      },
    ]);
    expect(result.action).toBe("started");
    expect(result.session.state).toBe("running");
  });

  it("reports a repeat start as already_active with the running session", async () => {
    const { client } = createFakeClient({
      data: { code: "already_active", session: sessionRow },
    });

    const result = await startFocusSession(client as never, ROOM, 600);

    expect(result).toEqual({
      action: "already_active",
      session: toFocusSession(sessionRow),
    });
  });

  it("sends only the room id for pause, resume and end", async () => {
    const paused = { ...sessionRow, state: "paused", paused_at: "2026-10-06T07:10:00+00:00" };
    const { client, rpcCalls } = createFakeClient({
      data: { code: "paused", session: paused },
    });

    await pauseFocusSession(client as never, ROOM);
    expect(rpcCalls.at(-1)).toEqual({
      fn: "pause_focus_session",
      args: { p_room_id: ROOM },
    });

    const { client: resumeClient, rpcCalls: resumeCalls } = createFakeClient({
      data: { code: "resumed", session: sessionRow },
    });
    await resumeFocusSession(resumeClient as never, ROOM);
    expect(resumeCalls.at(-1)).toEqual({
      fn: "resume_focus_session",
      args: { p_room_id: ROOM },
    });

    const { client: endClient, rpcCalls: endCalls } = createFakeClient({
      data: {
        code: "completed",
        session: { ...sessionRow, state: "completed", ended_at: "2026-10-06T07:12:00+00:00" },
      },
    });
    const ended = await endFocusSession(endClient as never, ROOM);
    expect(endCalls.at(-1)).toEqual({
      fn: "end_focus_session",
      args: { p_room_id: ROOM },
    });
    expect(ended.action).toBe("completed");
  });

  it.each([
    ["start", "room_not_found", "not_found", 404],
    ["start", "not_owner", "not_owner", 403],
    ["pause", "no_active_session", "no_active_session", 409],
    ["pause", "invalid_state", "invalid_state", 409],
    ["resume", "no_active_session", "no_active_session", 409],
    ["end", "no_active_session", "no_active_session", 409],
  ])("maps %s / %s onto %s %d", async (control, code, expected, status) => {
    const { client } = createFakeClient({ data: { code } });

    const call =
      control === "start"
        ? startFocusSession(client as never, ROOM, 60)
        : control === "pause"
          ? pauseFocusSession(client as never, ROOM)
          : control === "resume"
            ? resumeFocusSession(client as never, ROOM)
            : endFocusSession(client as never, ROOM);

    const error = await call.catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FocusSessionError);
    expect(error).toMatchObject({ code: expected, status });
  });

  it("throws a plain error for an unexpected success envelope", async () => {
    const { client } = createFakeClient({
      data: { code: "paused", session: null },
    });

    await expect(pauseFocusSession(client as never, ROOM)).rejects.toThrow(
      /focus session payload/,
    );
  });

  it("does not forward a failed RPC's message to the caller", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { code: "XX000", message: 'relation "public.focus_sessions" does not exist' },
    });

    const error = (await pauseFocusSession(client as never, ROOM).catch(
      (e: unknown) => e,
    )) as Error;

    expect(error).not.toBeInstanceOf(FocusSessionError);
    expect(error.message).toContain("pause_focus_session failed");
  });
});
