import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql, psqlExpectingFailure } from "./helpers/admin";
import { createProfile } from "@/lib/profiles/queries";
import { createRoom } from "@/lib/rooms/create";
import { createRoomSchema } from "@/lib/validation/rooms";
import {
  createUser,
  deleteUsers,
  uniqueAlias,
  uniqueName,
  type TestUser,
} from "./helpers/users";

/**
 * SQL-level proof of the private-channel policies written by
 * `supabase/migrations/0006_realtime_private_channels.sql`.
 *
 * Each probe replays the transaction shape the realtime service runs for a
 * private join and for a presence `track`: `set local role`, the claims from
 * the socket's JWT, an insert of the probe row (`topic` + `extension` only,
 * so `private` takes its column default), and a select of that row back as
 * the caller — then a rollback, because nothing the service probes may
 * persist. The probes drive `psql` against the local container, the repo's
 * established pattern for policy proofs; the realtime server itself is
 * never contacted from this suite (presence over a socket is e2e's job).
 */

/** One probe transaction in the caller's JWT context, rolled back. */
function probeAs(options: {
  role: "authenticated" | "anon";
  userId?: string;
  statements: string[];
}): string {
  const lines = ["begin;", `set local role ${options.role};`];
  if (options.userId) {
    lines.push(`set local request.jwt.claim.sub = '${options.userId}';`);
    lines.push(
      `set local request.jwt.claims = '${JSON.stringify({ sub: options.userId })}';`,
    );
  }
  lines.push(...options.statements, "rollback;");
  return lines.join("\n");
}

function insertProbe(topic: string, extension = "presence"): string {
  return `insert into realtime.messages (topic, extension) values ('${topic}', '${extension}') returning 'inserted';`;
}

function expectRefused(sql: string): void {
  const { status, output } = psqlExpectingFailure(sql);
  expect(status).not.toBe(0);
  // Either denial is a refusal: RLS rejects the row, or (for a role with no
  // policy at all) the table privilege check fires first.
  expect(output).toMatch(/row-level security|permission denied/);
}

describe("private presence channel policies", () => {
  let member: TestUser;
  let outsider: TestUser;
  let memberRoomId: string;
  let outsiderRoomId: string;

  beforeAll(async () => {
    [member, outsider] = await Promise.all([
      createUser("presence-member"),
      createUser("presence-outsider"),
    ]);
    await Promise.all([
      createProfile(member.client, member.id, uniqueAlias("PM")),
      createProfile(outsider.client, outsider.id, uniqueAlias("PX")),
    ]);
    memberRoomId = (
      await createRoom(
        member.client,
        createRoomSchema.parse({
          name: uniqueName("Presence A"),
          capacity: 4,
          visibility: "private",
        }),
      )
    ).id;
    outsiderRoomId = (
      await createRoom(
        outsider.client,
        createRoomSchema.parse({
          name: uniqueName("Presence B"),
          capacity: 4,
          visibility: "private",
        }),
      )
    ).id;
  });

  afterAll(async () => {
    await deleteUsers([member, outsider]);
  });

  it("installed exactly the two 0006 policies, for authenticated only", () => {
    const rows = psql(
      "select policyname || ':' || cmd || ':' || array_to_string(roles, ',') " +
        "from pg_policies " +
        "where schemaname = 'realtime' and tablename = 'messages' " +
        "and policyname like 'room_presence_%' " +
        "order by policyname;",
    );
    expect(rows.split("\n").filter(Boolean)).toEqual([
      "room_presence_insert_member:INSERT:authenticated",
      "room_presence_select_member:SELECT:authenticated",
    ]);
  });

  it("lets a member insert and read the probe row for their own room", () => {
    const topic = `room-presence-${memberRoomId}`;
    const output = psql(
      probeAs({
        role: "authenticated",
        userId: member.id,
        statements: [
          // Both extensions realtime probes with on a join, then the read
          // half that authorizes it.
          insertProbe(topic, "broadcast"),
          insertProbe(topic, "presence"),
          `select count(*) from realtime.messages where topic = '${topic}';`,
        ],
      }),
    );
    const lines = output.split("\n");
    expect(lines).toContain("inserted");
    expect(lines).toContain("2");
  });

  it("refuses a non-member's insert for the room's topic", () => {
    expectRefused(
      probeAs({
        role: "authenticated",
        userId: outsider.id,
        statements: [insertProbe(`room-presence-${memberRoomId}`)],
      }),
    );
  });

  it("refuses a member's insert for another room's topic", () => {
    expectRefused(
      probeAs({
        role: "authenticated",
        userId: member.id,
        statements: [insertProbe(`room-presence-${outsiderRoomId}`)],
      }),
    );
  });

  it("refuses the anon role", () => {
    expectRefused(
      probeAs({
        role: "anon",
        statements: [insertProbe(`room-presence-${memberRoomId}`)],
      }),
    );
  });

  it("shows a non-member nothing when a probe row is already there", () => {
    // The read half of a join: realtime inserts the probe, then selects it
    // back as the caller. For a non-member the select must come back empty
    // (0 rows, no error) — which is exactly what fails the join.
    const topic = `room-presence-${memberRoomId}`;
    const output = psql(
      [
        "begin;",
        `insert into realtime.messages (topic, extension) values ('${topic}', 'presence');`,
        "set local role authenticated;",
        `set local request.jwt.claim.sub = '${outsider.id}';`,
        `set local request.jwt.claims = '${JSON.stringify({ sub: outsider.id })}';`,
        `select count(*) from realtime.messages where topic = '${topic}';`,
        "rollback;",
      ].join("\n"),
    );
    const lines = output.split("\n");
    // The probe's only data row is the count: 0 rows visible.
    expect(lines.filter((line) => /^\d+$/.test(line))).toEqual(["0"]);
  });

  it("keeps topics and extensions outside the grant refused", () => {
    expectRefused(
      probeAs({
        role: "authenticated",
        userId: member.id,
        // The messages channel's topic is not the grant's shape.
        statements: [insertProbe(`room-messages-${memberRoomId}`)],
      }),
    );
    expectRefused(
      probeAs({
        role: "authenticated",
        userId: member.id,
        // A presence topic, but an extension no join or track probe uses.
        statements: [
          insertProbe(`room-presence-${memberRoomId}`, "persistence"),
        ],
      }),
    );
  });
});
