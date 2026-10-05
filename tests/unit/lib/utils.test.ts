import { afterEach, describe, expect, it, vi } from "vitest";

const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

afterEach(() => {
  vi.resetModules();
  restoreEnv("NEXT_PUBLIC_SUPABASE_URL", originalUrl);
  restoreEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", originalKey);
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("cn", () => {
  it("joins independent class names in order", async () => {
    const { cn } = await import("@/lib/utils");
    expect(cn("p-2", "text-sm")).toBe("p-2 text-sm");
  });

  it("lets the last value win when Tailwind utilities conflict", async () => {
    const { cn } = await import("@/lib/utils");
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
    expect(cn("px-2 py-2", "px-4")).toBe("py-2 px-4");
  });

  it("drops falsy values and expands class objects", async () => {
    const { cn } = await import("@/lib/utils");
    expect(
      cn("p-2", false && "hidden", undefined, null, {
        "font-bold": true,
        "font-normal": false,
      }),
    ).toBe("p-2 font-bold");
  });
});

describe("hasEnvVars", () => {
  async function loadHasEnvVars(env: Record<string, string | undefined>) {
    vi.resetModules();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    const { hasEnvVars } = await import("@/lib/utils");
    return Boolean(hasEnvVars);
  }

  it("is truthy only when both Supabase variables are present", async () => {
    expect(
      await loadHasEnvVars({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
      }),
    ).toBe(true);

    expect(
      await loadHasEnvVars({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined,
      }),
    ).toBe(false);

    expect(
      await loadHasEnvVars({
        NEXT_PUBLIC_SUPABASE_URL: undefined,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined,
      }),
    ).toBe(false);
  });
});
