import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type IntegrationEnv = {
  apiUrl: string;
  publishableKey: string;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Credential-shaped environment variables this suite must never read. Admin
 * access for these tests comes from the local container (`docker exec psql`),
 * so no service-role or secret key is ever part of the test environment.
 */
const FORBIDDEN_ENV_VARS = [
  "SUPABASE_SECRET_KEY",
  "SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];

/**
 * Vitest does not load `.env.local` on its own, and the shell that starts the
 * run may not export the values either. Both cases are supported: already
 * exported variables win, then `.env.local` fills in the gaps.
 */
function loadLocalEnvFile(): void {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) {
    return;
  }

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const withoutExport = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const separator = withoutExport.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = withoutExport.slice(0, separator).trim();
    let value = withoutExport.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function missing(name: string): never {
  throw new Error(
    `Integration tests need ${name}. Start the local stack and migrations ` +
      `("npx supabase start" && "npx supabase db reset"), then either export ` +
      `${name} from "npx supabase status -o json" or keep it in .env.local ` +
      `(see tests/integration/README.md).`,
  );
}

function resolveEnv(): IntegrationEnv {
  loadLocalEnvFile();

  for (const name of FORBIDDEN_ENV_VARS) {
    if (process.env[name]) {
      throw new Error(
        `${name} is set, but this suite runs every query through the roles it ` +
          `is testing and never uses a service-role/secret key. Unset it; admin ` +
          `access comes from "docker exec" on the local container instead.`,
      );
    }
  }

  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? missing("NEXT_PUBLIC_SUPABASE_URL");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(
      `NEXT_PUBLIC_SUPABASE_URL is not a valid URL: ${JSON.stringify(rawUrl)}.`,
    );
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `Refusing to run integration tests against a non-local Supabase API ` +
        `(host "${url.hostname}"). These tests only ever target the local ` +
        `stack on 127.0.0.1/localhost; remote and production projects are ` +
        `never accepted.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `NEXT_PUBLIC_SUPABASE_URL must be http(s), got "${url.protocol}".`,
    );
  }

  const publishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    missing("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  if (publishableKey.startsWith("sb_secret_")) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY holds a secret key (sb_secret_*). " +
        "Only the publishable/anon key belongs in client code and tests.",
    );
  }

  return { apiUrl: url.origin, publishableKey };
}

let cached: IntegrationEnv | null = null;

export function integrationEnv(): IntegrationEnv {
  if (cached === null) {
    cached = resolveEnv();
  }
  return cached;
}

/**
 * Bounded readiness poll instead of a fixed sleep: the stack answers
 * `/auth/v1/health` with 200 as soon as GoTrue is accepting requests.
 */
async function waitForApi(apiUrl: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiUrl}/auth/v1/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        return;
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Supabase API at ${apiUrl} did not become ready within ${timeoutMs}ms ` +
      `(last result: ${last}). Start it with "npx supabase start".`,
  );
}

/**
 * Resolves and validates the environment, waits for the API and confirms the
 * migrations are applied. Throwing here fails every test in the file with an
 * actionable message rather than silently skipping the suite.
 */
export async function prepareIntegrationEnv(): Promise<void> {
  const env = integrationEnv();
  await waitForApi(env.apiUrl);
}
