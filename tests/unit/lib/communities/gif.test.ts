import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchGif,
  GIF_MAX_BYTES,
  GifProxyError,
  gifConfig,
  searchGifs,
} from "@/lib/communities/gif";

const TENOR: { provider: "tenor" | "giphy"; apiKey: string | null } = {
  provider: "tenor",
  apiKey: "test-key",
};
const GIPHY: { provider: "tenor" | "giphy"; apiKey: string | null } = {
  provider: "giphy",
  apiKey: "test-key",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("gifConfig", () => {
  it("requires both a known provider and a non-blank key", () => {
    vi.stubEnv("GIF_PROVIDER", "tenor");
    vi.stubEnv("GIF_API_KEY", "  secret  ");
    expect(gifConfig()).toEqual({ provider: "tenor", apiKey: "secret" });

    vi.stubEnv("GIF_PROVIDER", "imgur");
    expect(gifConfig()).toEqual({ provider: null, apiKey: null });

    vi.stubEnv("GIF_PROVIDER", "tenor");
    vi.stubEnv("GIF_API_KEY", "");
    expect(gifConfig()).toEqual({ provider: null, apiKey: null });

    vi.stubEnv("GIF_PROVIDER", "tenor");
    vi.stubEnv("GIF_API_KEY", "k");
    expect(gifConfig()).toEqual({ provider: "tenor", apiKey: "k" });
  });

  it("defaults to unavailable when nothing is configured", () => {
    expect(gifConfig()).toEqual({ provider: null, apiKey: null });
  });
});

describe("searchGifs", () => {
  it("answers gif_unavailable/503 when no provider is configured", async () => {
    const error = await searchGifs("party", {
      config: { provider: null, apiKey: null },
      fetchImpl: vi.fn(),
    }).catch((e: GifProxyError) => e);
    expect(error).toBeInstanceOf(GifProxyError);
    expect((error as GifProxyError).code).toBe("gif_unavailable");
    expect((error as GifProxyError).status).toBe(503);
  });

  it("validates the query length without contacting the provider", async () => {
    const fetchImpl = vi.fn();
    for (const query of ["", "   ", "q".repeat(61)]) {
      await expect(
        searchGifs(query, { config: TENOR, fetchImpl }),
      ).rejects.toMatchObject({ code: "validation", status: 400 });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("normalizes tenor results and caps the page at 24", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        results: Array.from({ length: 30 }, (_, i) => ({
          id: `t${i}`,
          media_formats: {
            gif: { url: `https://media.tenor.com/${i}.gif`, dims: [100, 80] },
            tinygif: { url: `https://media.tenor.com/${i}-tiny.gif` },
          },
        })),
      }),
    );
    const results = await searchGifs("cats", { config: TENOR, fetchImpl });
    expect(results).toHaveLength(24);
    expect(results[0]).toEqual({
      id: "t0",
      preview_url: "https://media.tenor.com/0-tiny.gif",
      full_url: "https://media.tenor.com/0.gif",
      width: 100,
      height: 80,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toContain(
      "https://tenor.googleapis.com/v2/search",
    );
  });

  it("normalizes giphy results and filters entries with no full url", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: "g1",
            images: {
              original: { url: "https://media.giphy.com/g1.gif", width: "50", height: "40" },
              fixed_width_small: { url: "https://media.giphy.com/g1-s.gif" },
            },
          },
          { id: "g2", images: { original: { url: "", width: "1", height: "1" } } },
        ],
      }),
    );
    const results = await searchGifs("wave", { config: GIPHY, fetchImpl });
    expect(results).toEqual([
      {
        id: "g1",
        preview_url: "https://media.giphy.com/g1-s.gif",
        full_url: "https://media.giphy.com/g1.gif",
        width: 50,
        height: 40,
      },
    ]);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("api.giphy.com");
  });

  it("maps provider failures to gif_provider_failed/502", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(
      searchGifs("cats", { config: TENOR, fetchImpl }),
    ).rejects.toMatchObject({ code: "gif_provider_failed", status: 502 });
  });
});

describe("fetchGif", () => {
  it("answers gif_unavailable/503 when unconfigured", async () => {
    await expect(
      fetchGif("https://media.tenor.com/x.gif", {
        config: { provider: null, apiKey: null },
        fetchImpl: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "gif_unavailable", status: 503 });
  });

  it("blocks non-https, non-provider and malformed URLs (SSRF allow-list)", async () => {
    const fetchImpl = vi.fn();
    const config = TENOR;
    const blocked = [
      "http://media.tenor.com/x.gif",
      "https://evil.example.com/x.gif",
      "https://media.tenor.com.evil.example.com/x.gif",
      "not a url",
    ];
    for (const url of blocked) {
      await expect(fetchGif(url, { config, fetchImpl })).rejects.toMatchObject({
        code: "validation",
        status: 400,
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts provider hosts and returns the bytes", async () => {
    const bytes = new Uint8Array([71, 73, 70]); // GIF-ish
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/gif" },
      }),
    );
    const result = await fetchGif("https://media.tenor.com/x.gif", {
      config: TENOR,
      fetchImpl,
    });
    expect(Array.from(result.bytes)).toEqual([71, 73, 70]);
  });

  it("rejects non-gif content types", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("<html>hi</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    await expect(
      fetchGif("https://media.tenor.com/x.gif", { config: TENOR, fetchImpl }),
    ).rejects.toMatchObject({ code: "validation", status: 400 });
  });

  it("rejects empty and over-cap bodies", async () => {
    const empty = vi.fn().mockResolvedValue(
      new Response(new Uint8Array(0), {
        status: 200,
        headers: { "content-type": "image/gif" },
      }),
    );
    await expect(
      fetchGif("https://media.tenor.com/x.gif", { config: TENOR, fetchImpl: empty }),
    ).rejects.toThrow(/empty or larger/);

    const huge = vi.fn().mockResolvedValue(
      new Response(new Uint8Array(GIF_MAX_BYTES + 1), {
        status: 200,
        headers: { "content-type": "image/gif" },
      }),
    );
    await expect(
      fetchGif("https://media.tenor.com/x.gif", { config: TENOR, fetchImpl: huge }),
    ).rejects.toThrow(/empty or larger/);
  });

  it("maps provider download failures to gif_provider_failed/502", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("gone", { status: 404 }));
    await expect(
      fetchGif("https://media.tenor.com/x.gif", { config: TENOR, fetchImpl }),
    ).rejects.toMatchObject({ code: "gif_provider_failed", status: 502 });
  });
});
