import {
  PRESENCE_HEARTBEAT_MS,
  presenceChannelTopic,
  toParticipants,
  type PresenceState,
} from "@/lib/chat/presence";
import { describe, expect, it } from "vitest";

function state(input: Record<string, PresenceState[string]>): PresenceState {
  return input;
}

describe("presenceChannelTopic", () => {
  it("pins the topic shape the migration authorizes", () => {
    const roomId = "11111111-1111-4111-8111-111111111111";
    expect(presenceChannelTopic(roomId)).toBe(
      `room-presence-${roomId}`,
    );
  });
});

describe("toParticipants", () => {
  it("reads aliases and drops entries it cannot use", () => {
    expect(
      toParticipants(
        state({
          ok: [{ presence_ref: "1", alias: "Ada", studying: false }],
          missing: [{ presence_ref: "2" }],
          notAString: [{ presence_ref: "3", alias: 42 }],
          blank: [{ presence_ref: "4", alias: "   " }],
        }),
        "Ada",
      ),
    ).toEqual([{ alias: "Ada", studying: false }]);
  });

  it("clamps a spoofed alias to the profile ceiling and trims padding", () => {
    const padded = `  ${"x".repeat(64)}  `;

    const participants = toParticipants(
      state({
        long: [{ presence_ref: "1", alias: padded, studying: false }],
        padded: [{ presence_ref: "2", alias: "StudyStar    ", studying: false }],
        clean: [{ presence_ref: "3", alias: "StudyStar", studying: false }],
      }),
      "",
    );

    const aliases = participants.map((p) => p.alias);
    // Padding must not manufacture a second badge.
    expect(aliases.filter((alias) => alias.startsWith("StudyStar"))).toEqual([
      "StudyStar",
    ]);
    // A spoofed length is clamped to the profile ceiling, never DOM-ready.
    expect(aliases.find((alias) => alias.startsWith("x"))).toHaveLength(32);
  });

  it("treats studying as true only for the literal true", () => {
    expect(
      toParticipants(
        state({
          literal: [{ presence_ref: "1", alias: "Ada", studying: true }],
          truthyString: [
            { presence_ref: "2", alias: "Grace", studying: "true" },
          ],
          truthyOne: [{ presence_ref: "3", alias: "Lin", studying: 1 }],
        }),
        "",
      ),
    ).toEqual([
      { alias: "Ada", studying: true },
      { alias: "Grace", studying: false },
      { alias: "Lin", studying: false },
    ]);
  });

  it("collapses two copies of one alias into one badge, studying OR-merged", () => {
    const participants = toParticipants(
      state({
        tabA: [{ presence_ref: "1", alias: "studystar", studying: false }],
        tabB: [{ presence_ref: "2", alias: "StudyStar", studying: true }],
        partner: [{ presence_ref: "3", alias: "Partner", studying: false }],
      }),
      "StudyStar",
    );

    expect(participants).toHaveLength(2);
    const own = participants[0];
    expect(own.alias.toLowerCase()).toBe("studystar");
    expect(own.studying).toBe(true);
  });

  it("sorts the viewer's alias first, then case-insensitively", () => {
    const participants = toParticipants(
      state({
        b: [{ presence_ref: "1", alias: "zeta", studying: false }],
        a: [{ presence_ref: "2", alias: "Alpha", studying: false }],
        me: [{ presence_ref: "3", alias: "studystar", studying: false }],
        c: [{ presence_ref: "4", alias: "beta", studying: false }],
      }),
      "StudyStar",
    );

    expect(participants.map((p) => p.alias)).toEqual([
      "studystar",
      "Alpha",
      "beta",
      "zeta",
    ]);
  });

  it("returns an empty list for an empty state or empty own alias", () => {
    expect(toParticipants(state({}), "Ada")).toEqual([]);
    expect(
      toParticipants(
        state({ a: [{ presence_ref: "1", alias: "Ada", studying: false }] }),
        "",
      ),
    ).toHaveLength(1);
  });

  it("tolerates a key whose value is missing or null", () => {
    expect(
      toParticipants(
        { ghost: undefined } as unknown as PresenceState,
        "Ada",
      ),
    ).toEqual([]);
  });
});

describe("PRESENCE_HEARTBEAT_MS", () => {
  it("is the documented re-track bound", () => {
    expect(PRESENCE_HEARTBEAT_MS).toBe(60_000);
  });
});
