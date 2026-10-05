import {
  createProfile,
  getProfile,
  ProfileError,
  ProfileQueryError,
} from "@/lib/profiles/queries";
import { createFakeClient } from "../../helpers/fake-supabase";
import { describe, expect, it } from "vitest";

describe("getProfile", () => {
  it("reads only id and alias for the given user", async () => {
    const { client, state } = createFakeClient({
      data: { id: "user-1", alias: "examnerd" },
    });

    const profile = await getProfile(client as never, "user-1");

    expect(profile).toEqual({ id: "user-1", alias: "examnerd" });
    expect(state.select).toEqual(["id, alias"]);
    expect(state.eq).toEqual([["id", "user-1"]]);
  });

  it("returns null when the caller has no profile row", async () => {
    const { client } = createFakeClient({ data: null, error: null });

    await expect(getProfile(client as never, "user-1")).resolves.toBeNull();
  });

  it("throws when the query fails", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { message: "connection lost" },
    });

    await expect(getProfile(client as never, "user-1")).rejects.toThrow(
      ProfileQueryError,
    );
  });
});

describe("createProfile", () => {
  it("inserts only the caller's own id and alias", async () => {
    const { client, state } = createFakeClient({
      data: { id: "user-1", alias: "examnerd" },
    });

    const profile = await createProfile(client as never, "user-1", "examnerd");

    expect(profile).toEqual({ id: "user-1", alias: "examnerd" });
    expect(state.insert).toEqual([{ id: "user-1", alias: "examnerd" }]);
    expect(state.select).toEqual(["id, alias"]);
  });

  it("maps a case-insensitive alias collision to alias_taken", async () => {
    const { client } = createFakeClient({
      data: null,
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "profiles_alias_lower_key"',
      },
    });

    await expect(createProfile(client as never, "user-1", "ExamNerd")).rejects.toMatchObject({
      name: "ProfileError",
      code: "alias_taken",
      status: 409,
    });
  });

  it("maps a primary key collision to already_exists", async () => {
    const { client } = createFakeClient({
      data: null,
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "profiles_pkey"',
      },
    });

    await expect(createProfile(client as never, "user-1", "examnerd")).rejects.toMatchObject({
      code: "already_exists",
      status: 409,
    });
  });

  it("maps an RLS violation to forbidden and anything else to query_failed", async () => {
    const forbidden = createFakeClient({
      data: null,
      error: { code: "42501", message: "row-level security" },
    });
    await expect(
      createProfile(forbidden.client as never, "user-1", "examnerd"),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });

    const broken = createFakeClient({
      data: null,
      error: { code: "XX000", message: "boom" },
    });
    await expect(
      createProfile(broken.client as never, "user-1", "examnerd"),
    ).rejects.toMatchObject({ code: "query_failed", status: 500 });

    const silent = createFakeClient({ data: null, error: null });
    await expect(
      createProfile(silent.client as never, "user-1", "examnerd"),
    ).rejects.toBeInstanceOf(ProfileError);
  });
});
