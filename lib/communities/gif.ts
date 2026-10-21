/**
 * GIF search/fetch for the community composer. Two deliberate boundaries:
 *
 * 1. The browser never talks to the GIF provider. Search results and the GIF
 *    bytes themselves pass through the server (`/api/communities/gif/*`), so
 *    the provider never learns a user id, room, or community — only "a
 *    signed-in user searched for X" / "a signed-in user fetched this id".
 * 2. `fetchGif` only accepts URLs on the provider's known hosts (SSRF
 *    allow-list), re-checks the response type is `image/gif`, and caps the
 *    body at 5 MB before returning it. The attachment path then encrypts
 *    these bytes client-side like any other attachment.
 *
 * Configuration is read server-side only (no `NEXT_PUBLIC_`), mirroring
 * `lib/ai/config.ts`. With no provider configured both endpoints answer 503
 * and the composer honestly hides the GIF tab.
 */

export const GIF_MAX_BYTES = 5 * 1024 * 1024;

export type GifResult = {
  id: string;
  preview_url: string;
  full_url: string;
  width: number;
  height: number;
};

export type GifConfig = {
  provider: "tenor" | "giphy" | null;
  apiKey: string | null;
};

export function gifConfig(): GifConfig {
  const provider = (process.env.GIF_PROVIDER ?? "").trim().toLowerCase();
  const apiKey = (process.env.GIF_API_KEY ?? "").trim() || null;

  if (!apiKey || (provider !== "tenor" && provider !== "giphy")) {
    return { provider: null, apiKey: null };
  }
  return { provider, apiKey };
}

/** Hosts the fetch proxy will ever download from, per provider. */
const ALLOWED_HOSTS: Record<"tenor" | "giphy", readonly string[]> = {
  tenor: ["media.tenor.com", "tenor.googleapis.com", "www.googleapis.com"],
  giphy: ["media.giphy.com", "i.giphy.com", "api.giphy.com"],
};

export class GifProxyError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "GifProxyError";
    this.code = code;
    this.status = status;
  }
}

type ProviderSearchResponse =
  | {
      results: Array<{
        id: string;
        media_formats?: Record<
          string,
          { url: string; dims?: [number, number] }
        >;
        media_formats_gifv?: unknown;
      }>;
    }
  | {
      data: Array<{
        id: string;
        images: Record<string, { url: string; width?: string; height?: string }>;
      }>;
    };

function normalizeTenor(
  body: Extract<ProviderSearchResponse, { results: unknown }>,
): GifResult[] {
  return (body.results ?? []).slice(0, 24).map((item) => {
    const gif = item.media_formats?.gif;
    const tiny = item.media_formats?.tinygif;
    return {
      id: item.id,
      preview_url: tiny?.url ?? gif?.url ?? "",
      full_url: gif?.url ?? "",
      width: gif?.dims?.[0] ?? 0,
      height: gif?.dims?.[1] ?? 0,
    };
  });
}

function normalizeGiphy(
  body: Extract<ProviderSearchResponse, { data: unknown }>,
): GifResult[] {
  return (body.data ?? []).slice(0, 24).map((item) => {
    const original = item.images.original;
    const preview = item.images.fixed_width_small ?? original;
    return {
      id: item.id,
      preview_url: preview.url,
      full_url: original.url,
      width: Number(original.width) || 0,
      height: Number(original.height) || 0,
    };
  });
}

/** Search the configured provider. Throws `GifProxyError` on provider failure. */
export async function searchGifs(
  query: string,
  options: { config?: GifConfig; fetchImpl?: typeof fetch } = {},
): Promise<GifResult[]> {
  const config = options.config ?? gifConfig();
  const doFetch = options.fetchImpl ?? fetch;

  if (!config.provider || !config.apiKey) {
    throw new GifProxyError(
      "gif_unavailable",
      "GIF search is not configured on this server.",
      503,
    );
  }

  const trimmed = query.trim();
  if (!trimmed || trimmed.length > 60) {
    throw new GifProxyError(
      "validation",
      "Search must be 1–60 characters.",
      400,
    );
  }

  const url =
    config.provider === "tenor"
      ? `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(trimmed)}&key=${encodeURIComponent(config.apiKey)}&client_key=sdyroom&limit=24&media_filter=gif,tinygif`
      : `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(config.apiKey)}&q=${encodeURIComponent(trimmed)}&limit=24&rating=g&lang=en`;

  const response = await doFetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    throw new GifProxyError(
      "gif_provider_failed",
      "The GIF provider could not be reached.",
      502,
    );
  }

  const body = (await response.json()) as ProviderSearchResponse;
  const results =
    config.provider === "tenor"
      ? normalizeTenor(body as Extract<ProviderSearchResponse, { results: unknown }>)
      : normalizeGiphy(body as Extract<ProviderSearchResponse, { data: unknown }>);

  return results.filter((r) => r.full_url !== "" && r.preview_url !== "");
}

/**
 * Download one GIF by URL, enforcing the host allow-list, the `image/gif`
 * response type and the size cap. Returns the raw bytes.
 */
export async function fetchGif(
  rawUrl: string,
  options: { config?: GifConfig; fetchImpl?: typeof fetch } = {},
): Promise<{ bytes: Uint8Array }> {
  const config = options.config ?? gifConfig();
  const doFetch = options.fetchImpl ?? fetch;

  if (!config.provider || !config.apiKey) {
    throw new GifProxyError(
      "gif_unavailable",
      "GIF fetching is not configured on this server.",
      503,
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new GifProxyError("validation", "That GIF URL is not valid.", 400);
  }

  if (url.protocol !== "https:") {
    throw new GifProxyError("validation", "That GIF URL is not valid.", 400);
  }

  const allowed = ALLOWED_HOSTS[config.provider];
  if (!allowed.includes(url.hostname)) {
    throw new GifProxyError(
      "validation",
      "Only provider GIF URLs can be fetched.",
      400,
    );
  }

  const response = await doFetch(url.toString(), {
    signal: AbortSignal.timeout(10_000),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new GifProxyError(
      "gif_provider_failed",
      "The GIF could not be downloaded.",
      502,
    );
  }

  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType !== "image/gif") {
    throw new GifProxyError(
      "validation",
      "That URL did not return a GIF.",
      400,
    );
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength === 0 || buffer.byteLength > GIF_MAX_BYTES) {
    throw new GifProxyError(
      "validation",
      "That GIF is empty or larger than 5 MB.",
      400,
    );
  }

  return { bytes: buffer };
}
