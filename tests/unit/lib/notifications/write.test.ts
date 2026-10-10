import { notify, reportDedupeKey, roomDedupeKey } from "@/lib/notifications/write";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, consoleError } = vi.hoisted(() => ({
  rpc: vi.fn(),
  consoleError: vi.fn(),
}));

vi.spyOn(console, "error").mockImplementation(consoleError);

const TARGET_ALIAS = "studybuddy";
const TARGET_ID = "55555555-5555-4555-8555-555555555555";
const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const REPORT_ID = "66666666-6666-4666-8666-666666666666";

function client(): SupabaseClient {
  return { rpc } as unknown as SupabaseClient;
}

const ROOM_EVENT = {
  kind: "room",
  type: "muted",
  roomId: ROOM_ID,
  targetAlias: TARGET_ALIAS,
  payload: { title: "You were muted", body: "Hidden for an hour." },
  dedupeKey: roomDedupeKey("muted", ROOM_ID),
} as const;

beforeEach(() => {
  rpc.mockReset();
});

describe("notify", () => {
  it("resolves the alias then pushes with the RPC's exact arguments", async () => {
    rpc
      .mockResolvedValueOnce({ data: TARGET_ID, error: null })
      .mockResolvedValueOnce({ data: { code: "created", id: "x" }, error: null });

    await notify(client(), ROOM_EVENT);

    expect(rpc).toHaveBeenNthCalledWith(1, "moderation_resolve_alias", {
      p_alias: TARGET_ALIAS,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "push_notification", {
      p_user_id: TARGET_ID,
      p_type: "muted",
      p_payload: ROOM_EVENT.payload,
      p_room_id: ROOM_ID,
      p_dedupe_key: roomDedupeKey("muted", ROOM_ID),
    });
  });

  it("passes null dedupe keys through rather than inventing one", async () => {
    rpc
      .mockResolvedValueOnce({ data: TARGET_ID, error: null })
      .mockResolvedValueOnce({ data: { code: "created", id: "x" }, error: null });

    await notify(client(), { ...ROOM_EVENT, dedupeKey: undefined });

    expect(rpc).toHaveBeenNthCalledWith(2, "push_notification", {
      p_user_id: TARGET_ID,
      p_type: "muted",
      p_payload: ROOM_EVENT.payload,
      p_room_id: ROOM_ID,
      p_dedupe_key: null,
    });
  });

  it("stops when the alias does not resolve (no push, no throw)", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });

    await expect(notify(client(), ROOM_EVENT)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
  });

  it("sends report events straight to the report RPC — no alias, no uuid", async () => {
    rpc.mockResolvedValueOnce({ data: { code: "created", id: "x" }, error: null });

    await notify(client(), {
      kind: "report",
      type: "report_resolved",
      reportId: REPORT_ID,
      payload: { title: "Report resolved", body: "A moderator acted." },
      dedupeKey: reportDedupeKey(REPORT_ID),
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("push_report_notification", {
      p_report_id: REPORT_ID,
      p_type: "report_resolved",
      p_payload: { title: "Report resolved", body: "A moderator acted." },
      p_dedupe_key: reportDedupeKey(REPORT_ID),
    });
  });

  it("treats the preference system's 'muted' as a success, not a failure", async () => {
    rpc
      .mockResolvedValueOnce({ data: TARGET_ID, error: null })
      .mockResolvedValueOnce({ data: { code: "muted" }, error: null });

    await expect(notify(client(), ROOM_EVENT)).resolves.toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("swallows a rejecting RPC — the caller's action must not fail", async () => {
    rpc.mockRejectedValue(new Error("database exploded"));

    await expect(notify(client(), ROOM_EVENT)).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
  });

  it("swallows an RPC error envelope without throwing", async () => {
    rpc
      .mockResolvedValueOnce({ data: TARGET_ID, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "boom" } });

    await expect(notify(client(), ROOM_EVENT)).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
  });

  it("logs unexpected envelope codes (a forge attempt would land here)", async () => {
    rpc
      .mockResolvedValueOnce({ data: TARGET_ID, error: null })
      .mockResolvedValueOnce({ data: { code: "not_authorized" }, error: null });

    await notify(client(), ROOM_EVENT);
    expect(consoleError).toHaveBeenCalled();
  });
});

describe("dedupe keys", () => {
  it("names the subject so the unread collapse is per (user, subject)", () => {
    expect(roomDedupeKey("muted", ROOM_ID)).toBe(`muted:${ROOM_ID}`);
    expect(reportDedupeKey(REPORT_ID)).toBe(`report_resolved:${REPORT_ID}`);
  });
});
