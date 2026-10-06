import {
  createGoal,
  deleteGoal,
  GoalError,
  listGoals,
  toStudyGoal,
  updateGoal,
} from "@/lib/goals/queries";
import { createFakeClient } from "../../helpers/fake-supabase";
import { describe, expect, it } from "vitest";

const ROOM = "11111111-1111-4111-8111-111111111111";
const USER = "user-1";
const GOAL = "44444444-4444-4444-8444-444444444444";

const goalRow = {
  id: GOAL,
  room_id: ROOM,
  title: "Finish chapter 4",
  target_seconds: 1500,
  target_count: null,
  status: "active",
  completed_at: null,
  created_at: "2026-10-06T07:00:00+00:00",
  updated_at: "2026-10-06T07:00:00+00:00",
  user_id: USER,
};

describe("toStudyGoal", () => {
  it("keeps the exposed fields and drops the rest", () => {
    const goal = toStudyGoal(goalRow);

    expect(goal).toEqual({
      id: GOAL,
      room_id: ROOM,
      title: "Finish chapter 4",
      target_seconds: 1500,
      target_count: null,
      status: "active",
      completed_at: null,
      created_at: "2026-10-06T07:00:00+00:00",
      updated_at: "2026-10-06T07:00:00+00:00",
    });
    expect(goal).not.toHaveProperty("user_id");
  });

  it.each([
    ["unknown status", { ...goalRow, status: "archived" }],
    ["completed without a timestamp", { ...goalRow, status: "completed" }],
    ["active with a timestamp", { ...goalRow, completed_at: "2026-10-06T08:00:00+00:00" }],
    ["missing title", { ...goalRow, title: undefined }],
    ["non-object", {}],
  ])("rejects a malformed payload (%s)", (_label, value) => {
    expect(() => toStudyGoal(value)).toThrow(
      /Unexpected study goal payload|Missing study goal payload/,
    );
  });
});

describe("listGoals", () => {
  it("lists this room's goals ordered newest first", async () => {
    const { client, state } = createFakeClient({ data: [goalRow] });

    const goals = await listGoals(client as never, ROOM);

    expect(state.select).toEqual([
      "id, room_id, title, target_seconds, target_count, status, completed_at, created_at, updated_at",
    ]);
    expect(state.eq).toEqual([["room_id", ROOM]]);
    expect(state.order).toEqual([["created_at", { ascending: false }]]);
    expect(goals).toHaveLength(1);
    expect(goals[0].title).toBe("Finish chapter 4");
  });

  it("throws a plain error when the query fails", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { message: "connection lost" },
    });

    await expect(listGoals(client as never, ROOM)).rejects.toThrow(
      /listGoals failed/,
    );
  });
});

describe("createGoal", () => {
  it("inserts the caller's own goal and normalises absent targets to null", async () => {
    const { client, state } = createFakeClient({ data: goalRow });

    const goal = await createGoal(client as never, {
      roomId: ROOM,
      userId: USER,
      title: "Finish chapter 4",
    });

    expect(state.insert).toEqual([
      {
        user_id: USER,
        room_id: ROOM,
        title: "Finish chapter 4",
        target_seconds: null,
        target_count: null,
      },
    ]);
    expect(goal.id).toBe(GOAL);
  });

  it("maps the duplicate-active-title index onto a 409", async () => {
    const { client } = createFakeClient({
      data: null,
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "study_goals_active_title_key"',
      },
    });

    const error = await createGoal(client as never, {
      roomId: ROOM,
      userId: USER,
      title: "Finish chapter 4",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GoalError);
    expect(error).toMatchObject({ code: "duplicate_goal", status: 409 });
    expect((error as Error).message).not.toMatch(/key|constraint|index/i);
  });

  it.each(["42501", "23503"])(
    "maps an RLS or foreign key rejection (%s) onto the room 404",
    async (code) => {
      const { client } = createFakeClient({
        data: null,
        error: { code, message: "violates row-level security policy" },
      });

      const error = await createGoal(client as never, {
        roomId: ROOM,
        userId: USER,
        title: "Whatever",
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(GoalError);
      expect(error).toMatchObject({ code: "not_found", status: 404 });
    },
  );

  it("throws a plain error for an unexpected failure", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { code: "XX000", message: 'relation "public.study_goals" is locked' },
    });

    const error = await createGoal(client as never, {
      roomId: ROOM,
      userId: USER,
      title: "Whatever",
    }).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(GoalError);
    expect((error as Error).message).toContain("createGoal failed");
  });
});

describe("updateGoal", () => {
  it("sends only the client-editable columns", async () => {
    const { client, state } = createFakeClient({
      data: { ...goalRow, title: "Revised", status: "active" },
    });

    const goal = await updateGoal(client as never, GOAL, {
      title: "Revised",
    });

    expect(state.updates).toEqual([{ title: "Revised" }]);
    expect(state.eq).toEqual([["id", GOAL]]);
    expect(goal.title).toBe("Revised");
  });

  it("reports a goal that is not the caller's (or is gone) as a 404", async () => {
    const { client } = createFakeClient({ data: null });

    const error = await updateGoal(client as never, GOAL, {
      status: "completed",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GoalError);
    expect(error).toMatchObject({ code: "not_found", status: 404 });
  });

  it("maps an RLS rejection onto the same 404", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { code: "42501", message: "violates row-level security policy" },
    });

    const error = await updateGoal(client as never, GOAL, {
      status: "completed",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GoalError);
    expect(error).toMatchObject({ code: "not_found", status: 404 });
  });
});

describe("deleteGoal", () => {
  it("deletes by id and returns nothing", async () => {
    const { client, state } = createFakeClient({ data: [{ id: GOAL }] });

    await expect(deleteGoal(client as never, GOAL)).resolves.toBeUndefined();
    expect(state.deletes).toBe(1);
    expect(state.eq).toEqual([["id", GOAL]]);
  });

  it("reports a goal that matched no row as a 404", async () => {
    const { client } = createFakeClient({ data: [] });

    const error = await deleteGoal(client as never, GOAL).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(GoalError);
    expect(error).toMatchObject({ code: "not_found", status: 404 });
  });
});
