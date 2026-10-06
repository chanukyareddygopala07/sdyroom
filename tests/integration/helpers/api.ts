import { NextRequest } from "next/server";

export type ApiRequest = {
  path: string;
  method?: string;
  body?: unknown;
  /** Pre-serialized body, for malformed-JSON cases `body` cannot express. */
  rawBody?: string;
  headers?: Record<string, string>;
};

/**
 * Invokes a route handler directly with a real `NextRequest`, so the suite
 * exercises the production handler (auth guard, validation, RPC mapping and
 * response shaping) rather than a re-implementation of it. No dev server is
 * required: the only request-scoped dependency, `next/headers` `cookies()`,
 * is provided by the cookie seam in `cookie-jar.ts`.
 */
export async function callApi(
  handler: (request: NextRequest) => Promise<Response>,
  request: ApiRequest,
): Promise<Response> {
  return handler(toNextRequest(request));
}

/**
 * The same seam for dynamic routes, whose handlers also receive a route
 * context (`{ params }`) — `/api/rooms/[id]/join` and `/leave` resolve their
 * room id from it.
 */
export async function callApiWithParams<C>(
  handler: (
    request: NextRequest,
    context: { params: Promise<C> },
  ) => Promise<Response>,
  request: ApiRequest,
  params: C,
): Promise<Response> {
  return handler(toNextRequest(request), { params: Promise.resolve(params) });
}

function toNextRequest(request: ApiRequest): NextRequest {
  const url = new URL(request.path, "http://127.0.0.1:3000");
  const init: { method: string; headers: Headers; body?: string } = {
    method: request.method ?? "GET",
    headers: new Headers({ "content-type": "application/json", ...request.headers }),
  };
  if (request.rawBody !== undefined) {
    init.body = request.rawBody;
  } else if (request.body !== undefined) {
    init.body = JSON.stringify(request.body);
  }

  return new NextRequest(url, init);
}

/** Reads a JSON response body as an object, failing loudly if it is not one. */
export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Expected a JSON body, got: ${text.slice(0, 200)}`);
  }
}

export type ErrorEnvelope = { error: { code: string; message: string; issues?: { path: string; message: string }[] } };

export function errorOf(body: Record<string, unknown>): ErrorEnvelope["error"] {
  const error = body.error;
  if (!error || typeof error !== "object") {
    throw new Error(`Expected { error: ... }, got: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return error as ErrorEnvelope["error"];
}
