import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { makeGql } from "../src/core.js";
import type { FetchFn } from "../src/core.js";
import {
  createInstallationTokenProvider,
  credentialsStorePath,
  resolveAppCredentials,
} from "../src/identity.js";
import type { AppCredentials } from "../src/identity.js";

/**
 * Offline probe of the GitHub App identity path (#5): a throwaway RSA keypair
 * signs the App JWT locally, and a routing stub fetch serves the per-repo
 * installation lookup + auth-app's JWT→installation-token exchange + the
 * GraphQL endpoint. Zero network.
 */

const { privateKey: THROWAWAY_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const APP_CREDS: AppCredentials = { appId: "12345", privateKey: THROWAWAY_PEM };

const PM_ENV_KEYS = [
  "PM_GITHUB_APP_ID",
  "PM_GITHUB_APP_PRIVATE_KEY",
  "PM_GITHUB_APP_KEY_PATH",
  "PM_GITHUB_INSTALLATION_ID",
] as const;

/** Isolated env surface containing only the PM_GITHUB_* knobs under test. */
function pmEnvs(values: Partial<Record<(typeof PM_ENV_KEYS)[number], string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PM_ENV_KEYS) {
    const value = values[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface WireCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * Routes the three wire shapes this identity path produces:
 *   GET  /repos/{owner}/{repo}/installation  → { id } (or 404 when unlisted)
 *   POST /app/installations/{id}/access_tokens → { token, expires_at }
 *   POST https://api.github.com/graphql → canned GraphQL data
 * Mint #n returns `ghs_installation_{n}` so cache hits vs re-mints are
 * observable; expires_at rides the (fakeable) current clock.
 */
function identityStub(installations: Record<string, number | null>): {
  fn: FetchFn;
  calls: WireCall[];
  mints: string[];
} {
  const calls: WireCall[] = [];
  const mints: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  const fn: FetchFn = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, headers });
    const lookup = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url);
    if (method === "GET" && lookup !== null) {
      const repo = lookup[1] as string;
      const id = installations[repo];
      if (id === undefined || id === null) return json({ message: "Not Found" }, 404);
      return json({ id, app_id: 12345, repository_selection: "selected" });
    }
    const mint = /^https:\/\/api\.github\.com\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
    if (method === "POST" && mint !== null) {
      mints.push(mint[1] as string);
      return json({
        token: `ghs_installation_${mints.length}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: { metadata: "read", issues: "write", projects: "write" },
        repository_selection: "selected",
      });
    }
    if (method === "POST" && url === "https://api.github.com/graphql") {
      return json({ data: { repository: { id: "R_1" } } });
    }
    return json({ message: `identity stub: unexpected ${method} ${url}` }, 500);
  };
  return { fn, calls, mints };
}

afterEach(() => {
  vi.useRealTimers();
});

test("resolveAppCredentials: nothing configured → null (legacy chain stays)", () => {
  expect(resolveAppCredentials(pmEnvs({}))).toBeNull();
});

test("resolveAppCredentials: env arm — PEM and key-path variants", () => {
  expect(
    resolveAppCredentials(
      pmEnvs({ PM_GITHUB_APP_ID: "12345", PM_GITHUB_APP_PRIVATE_KEY: THROWAWAY_PEM }),
    ),
  ).toEqual({ appId: "12345", privateKey: THROWAWAY_PEM });

  // Single-line PEM with escaped newlines (the env-var shape auth-app's own
  // error message recommends) is restored to real newlines.
  expect(
    resolveAppCredentials(
      pmEnvs({
        PM_GITHUB_APP_ID: "12345",
        PM_GITHUB_APP_PRIVATE_KEY: THROWAWAY_PEM.replaceAll("\n", "\\n"),
      }),
    ),
  ).toEqual({ appId: "12345", privateKey: THROWAWAY_PEM });

  const dir = mkdtempSync(join(tmpdir(), "pm-identity-"));
  try {
    const keyPath = join(dir, "app-key.pem");
    writeFileSync(keyPath, THROWAWAY_PEM);
    expect(
      resolveAppCredentials(pmEnvs({ PM_GITHUB_APP_ID: "12345", PM_GITHUB_APP_KEY_PATH: keyPath })),
    ).toEqual({ appId: "12345", privateKey: THROWAWAY_PEM });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAppCredentials: partial env configuration throws (misattribution guard)", () => {
  expect(() => resolveAppCredentials(pmEnvs({ PM_GITHUB_APP_ID: "12345" }))).toThrow(
    /without PM_GITHUB_APP_PRIVATE_KEY/,
  );
  expect(() => resolveAppCredentials(pmEnvs({ PM_GITHUB_APP_PRIVATE_KEY: THROWAWAY_PEM }))).toThrow(
    /without PM_GITHUB_APP_ID/,
  );
  expect(() =>
    resolveAppCredentials(
      pmEnvs({
        PM_GITHUB_APP_ID: "12345",
        PM_GITHUB_APP_PRIVATE_KEY: THROWAWAY_PEM,
        PM_GITHUB_APP_KEY_PATH: "/tmp/key.pem",
      }),
    ),
  ).toThrow(/mutually exclusive/);
});

test("resolveAppCredentials: user store — PEM, key path, default + legacy installation ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-identity-"));
  try {
    const storeDir = join(dir, "pm-autopilot");
    mkdirSync(storeDir, { recursive: true });
    const storeEnv: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: dir };
    const storePath = join(storeDir, "credentials.json");
    const writeStore = (value: unknown): void => {
      writeFileSync(storePath, JSON.stringify(value));
    };

    // No store file → no App credentials.
    expect(resolveAppCredentials(storeEnv)).toBeNull();
    expect(credentialsStorePath(storeEnv)).toBe(storePath);

    // Full store: inline PEM + canonical default_installation_id.
    writeStore({ app_id: 12345, private_key: THROWAWAY_PEM, default_installation_id: 1001 });
    expect(resolveAppCredentials(storeEnv)).toEqual({
      appId: "12345",
      privateKey: THROWAWAY_PEM,
      defaultInstallationId: 1001,
    });

    // private_key_path anchors at the store's own directory.
    writeFileSync(join(storeDir, "app-key.pem"), THROWAWAY_PEM);
    writeStore({ app_id: "12345", private_key_path: "app-key.pem" });
    expect(resolveAppCredentials(storeEnv)).toEqual({ appId: "12345", privateKey: THROWAWAY_PEM });

    // Legacy alias (first_installation_id) fills the same field.
    writeStore({ app_id: 12345, private_key: THROWAWAY_PEM, first_installation_id: 2002 });
    expect(resolveAppCredentials(storeEnv)?.defaultInstallationId).toBe(2002);

    // Malformed store shapes throw loudly — never silently fall back to the
    // user token (that would misattribute writes to the human account).
    writeFileSync(storePath, "{not json");
    expect(() => resolveAppCredentials(storeEnv)).toThrow(/not valid JSON/);
    writeStore({ app_id: 12345 });
    expect(() => resolveAppCredentials(storeEnv)).toThrow(/neither "private_key"/);
    writeStore({ private_key: THROWAWAY_PEM });
    expect(() => resolveAppCredentials(storeEnv)).toThrow(/missing "app_id"/);
    writeStore({ app_id: 12345, private_key: THROWAWAY_PEM, default_installation_id: "x" });
    expect(() => resolveAppCredentials(storeEnv)).toThrow(/positive integer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installation tokens mint, cache, and re-mint after expiry", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T00:00:00Z"));
  const { fn, calls, mints } = identityStub({ "octo-org/board": 1001 });
  const provider = createInstallationTokenProvider(APP_CREDS, { fetch: fn, env: pmEnvs({}) });

  const token1 = await provider("octo-org/board");
  expect(token1).toBe("ghs_installation_1");
  expect(mints).toEqual(["1001"]);
  // The lookup rode the locally-minted App JWT (three base64url segments).
  const lookup = calls.find((c) => c.url.endsWith("/repos/octo-org/board/installation"));
  expect(lookup?.headers.authorization).toMatch(/^Bearer ey[Jhb]/);
  expect(lookup?.headers.authorization?.split(".")).toHaveLength(3);

  // Second call same repo: auth-app's cache serves the token — no re-mint.
  expect(await provider("octo-org/board")).toBe("ghs_installation_1");
  expect(mints).toEqual(["1001"]);

  // +61min: past auth-app's 59-minute cache TTL → transparent re-mint.
  vi.setSystemTime(new Date("2026-10-07T01:01:00Z"));
  const token2 = await provider("octo-org/board");
  expect(token2).toBe("ghs_installation_2");
  expect(mints).toEqual(["1001", "1001"]);
});

test("a second repo resolves its own installation independently", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T00:00:00Z"));
  const { fn, calls, mints } = identityStub({ "octo-org/one": 1001, "octo-org/two": 2002 });
  const provider = createInstallationTokenProvider(APP_CREDS, { fetch: fn, env: pmEnvs({}) });

  const tokenOne = await provider("octo-org/one");
  const tokenTwo = await provider("octo-org/two");
  expect(tokenOne).toBe("ghs_installation_1");
  expect(tokenTwo).toBe("ghs_installation_2");
  expect(mints).toEqual(["1001", "2002"]);
  expect(calls.filter((c) => c.url.endsWith("/installation")).map((c) => c.url)).toEqual([
    "https://api.github.com/repos/octo-org/one/installation",
    "https://api.github.com/repos/octo-org/two/installation",
  ]);

  // Per-repo cache: returning to repo one re-uses both the id and the token.
  expect(await provider("octo-org/one")).toBe("ghs_installation_1");
  expect(mints).toEqual(["1001", "2002"]);
  expect(calls.filter((c) => c.url.endsWith("/installation"))).toHaveLength(2);
});

test("PM_GITHUB_INSTALLATION_ID overrides the per-repo lookup entirely", async () => {
  const { fn, calls, mints } = identityStub({ "octo-org/board": 1001 });
  const provider = createInstallationTokenProvider(APP_CREDS, {
    fetch: fn,
    env: pmEnvs({ PM_GITHUB_INSTALLATION_ID: "42" }),
  });
  expect(await provider("octo-org/board")).toBe("ghs_installation_1");
  expect(mints).toEqual(["42"]);
  expect(calls.filter((c) => c.url.endsWith("/installation"))).toHaveLength(0);
});

test("store default_installation_id stands in on a 404 lookup; absence throws", async () => {
  const { fn, mints } = identityStub({ "octo-org/other": 1001 });
  const fallback = createInstallationTokenProvider(
    { ...APP_CREDS, defaultInstallationId: 3003 },
    { fetch: fn, env: pmEnvs({}) },
  );
  expect(await fallback("octo-org/unlisted")).toBe("ghs_installation_1");
  expect(mints).toEqual(["3003"]);

  const strict = createInstallationTokenProvider(APP_CREDS, { fetch: fn, env: pmEnvs({}) });
  await expect(strict("octo-org/unlisted")).rejects.toThrow(
    /no GitHub App installation found for octo-org\/unlisted/,
  );
});

test("makeGql with App credentials: installation token rides the #3 wire shape", async () => {
  const saved = PM_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  try {
    process.env.PM_GITHUB_APP_ID = "12345";
    process.env.PM_GITHUB_APP_PRIVATE_KEY = THROWAWAY_PEM;
    delete process.env.PM_GITHUB_INSTALLATION_ID;

    const { fn, calls, mints } = identityStub({ "Samuka007/cloudflare-agent-project": 1001 });
    const gql = makeGql(fn);

    const data = await gql(
      "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}",
      { owner: "Samuka007", name: "cloudflare-agent-project" },
    );

    expect(data).toEqual({ repository: { id: "R_1" } });
    // lookup → mint → graphql, one pass; REPO (the board target) resolved
    // the installation.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/Samuka007/cloudflare-agent-project/installation",
      "POST https://api.github.com/app/installations/1001/access_tokens",
      "POST https://api.github.com/graphql",
    ]);
    expect(mints).toEqual(["1001"]);
    const graphql = calls[2];
    if (graphql === undefined) throw new Error("unreachable: call sequence asserted above");
    expect(graphql.headers.authorization).toBe("Bearer ghs_installation_1");
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
