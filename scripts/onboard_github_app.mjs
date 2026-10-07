/**
 * pm-autopilot/scripts/onboard_github_app.mjs — one-command GitHub App
 * onboarding (#7; ADR-0002). Drives GitHub's App manifest flow and writes the
 * user-level credential store, once per machine:
 *
 *   1. Prints the manifest URL (`https://github.com/settings/apps/new?state=…`);
 *      the user approves App creation in the browser.
 *   2. GitHub redirects to the manifest `redirect_url` with `?code=…`; the
 *      user pastes that code here (no local callback server — the plugin is
 *      not trusted infrastructure yet, so this is a plain node script).
 *   3. `POST /app-manifests/{code}/conversions` exchanges the code for the
 *      App credentials (id + PEM).
 *   4. Writes `~/.config/pm-autopilot/credentials.json` (0600, dir 0700,
 *      XDG_CONFIG_HOME-aware) with `app_id`, `private_key`,
 *      `default_installation_id` — create-or-update; refuses to clobber a
 *      different App's store without `--force`.
 *   5. Verification: mints one installation token through the written
 *      credentials and reports success/failure (never printing the token).
 *
 * Zero new deps, `globalThis.fetch`, plain `node` — this runs BEFORE the
 * plugin is installed/trusted, so it must not import `src/*.ts`. The store
 * path resolution therefore duplicates the four lines of
 * `src/identity.ts` `credentialsStorePath()` (the canonical twin); keep the
 * two in sync.
 *
 * Structure: pure, importable functions (vitest imports them directly, with
 * fetch injected and XDG redirected to tmp dirs) + a thin CLI entry guarded
 * by an `import.meta.url` main-check. Secrets discipline: the PEM and minted
 * tokens are never printed or returned by any code path below.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const API_ROOT = "https://api.github.com";
const REPO_URL = "https://github.com/Samuka007/pm-autopilot";
/** Where GitHub hands back `?code=…` and where the OAuth callback allowlist
 *  points — a placeholder, because the user pastes the code manually. */
const PLACEHOLDER_CALLBACK = "https://example.com/pm-autopilot/callback";

/** `~/.config/pm-autopilot/credentials.json`, XDG_CONFIG_HOME-aware.
 *  Canonical twin: `src/identity.ts` `credentialsStorePath()` (#5). */
export function credentialsStorePath(env = process.env) {
  const configHome =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(configHome, "pm-autopilot", "credentials.json");
}

/**
 * The App manifest this repo registers under: name `pm-autopilot`, repo
 * homepage, placeholder callback (user pastes the code manually), private
 * app, the three permissions the plugin needs, no webhooks. Manifest field
 * for permissions is `default_permissions` per GitHub's schema.
 */
export function manifestPayload() {
  return {
    name: "pm-autopilot",
    url: REPO_URL,
    redirect_url: PLACEHOLDER_CALLBACK,
    callback_urls: [PLACEHOLDER_CALLBACK],
    hook_attributes: { url: PLACEHOLDER_CALLBACK, active: false },
    public: false,
    default_permissions: { metadata: "read", issues: "write", projects: "write" },
  };
}

/** `https://github.com/settings/apps/new?state=<url-encoded manifest JSON>`. */
export function buildManifestUrl(manifest) {
  return `https://github.com/settings/apps/new?state=${encodeURIComponent(JSON.stringify(manifest))}`;
}

/**
 * Exchanges the redirect `code` for App credentials via
 * `POST /app-manifests/{code}/conversions` (unauthenticated endpoint).
 * Errors carry the status + GitHub's message, never the response body (it
 * contains the fresh PEM). `fetchImpl` defaults to globalThis.fetch.
 * @returns {Promise<{ id: number | string, slug: string, pem: string } & Record<string, unknown>>}
 */
export async function convertCode(code, { fetch: fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${API_ROOT}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`manifest conversion failed (HTTP ${response.status}): ${body?.message ?? "unknown error"}`);
  }
  return body;
}

/** Store document: canonical keys only (`default_installation_id`, never the
 *  legacy `first_installation_id` alias). Installation id omitted when none
 *  was discovered. */
export function buildStoreDoc(conversion, defaultInstallationId) {
  return {
    app_id: conversion.id,
    private_key: conversion.pem,
    ...(defaultInstallationId === undefined || defaultInstallationId === null
      ? {}
      : { default_installation_id: defaultInstallationId }),
  };
}

/**
 * Create-or-update the 0600 store (parent dir 0700, enforced either way).
 * Without `force`: a same-`app_id` store is updated in place (unknown keys
 * preserved via merge); a different App's store, or an unparseable file,
 * refuses to clobber. With `force`: full replace. Returns
 * `{ created, updated }`.
 * @returns {{ created: boolean, updated: boolean }}
 */
export function writeStore(storePath, doc, { force = false } = {}) {
  const storeDir = dirname(storePath);
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  chmodSync(storeDir, 0o700);

  let payload = doc;
  let result = { created: true, updated: false };
  if (existsSync(storePath)) {
    result = { created: false, updated: true };
    let existing;
    try {
      existing = JSON.parse(readFileSync(storePath, "utf8"));
    } catch {
      if (!force) {
        throw new Error(`${storePath} exists but is not valid JSON — fix or delete it, or pass --force to replace it`);
      }
      existing = undefined;
    }
    if (existing !== undefined) {
      const existingAppId = existing.app_id;
      if (
        !force &&
        existingAppId !== undefined &&
        doc.app_id !== undefined &&
        String(existingAppId) !== String(doc.app_id)
      ) {
        throw new Error(
          `${storePath} already holds credentials for App ${existingAppId} — refusing to clobber; pass --force to replace`,
        );
      }
      if (!force) payload = { ...existing, ...doc };
    }
  }
  writeFileSync(storePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  chmodSync(storePath, 0o600);
  return result;
}

/** Zero-dep RS256 App JWT (10-minute claim window, 1-minute clock skew). */
export function mintAppJwt(appId, privateKey, { now = Math.floor(Date.now() / 1000) } = {}) {
  const b64urlJson = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${b64urlJson({ alg: "RS256", typ: "JWT" })}.${b64urlJson({
    iat: now - 60,
    exp: now + 540,
    iss: String(appId),
  })}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * First installation of the App, via app-JWT `GET /app/installations`;
 * `null` when the App has no installation yet (GitHub's manifest flow does
 * not guarantee one). Non-404 errors throw; the response never carries
 * secrets but is not echoed either.
 */
export async function findFirstInstallation(appId, privateKey, { fetch: fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${API_ROOT}/app/installations?per_page=100`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${mintAppJwt(appId, privateKey)}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status === 404) return null;
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`installation lookup failed (HTTP ${response.status}): ${body?.message ?? "unknown error"}`);
  }
  return Array.isArray(body) && body.length > 0 ? (body[0]?.id ?? null) : null;
}

/**
 * Post-write verification: reads the store back from `storePath` and mints
 * ONE installation token through exactly those credentials — proving the
 * written file works end to end. Uses the store's
 * `default_installation_id` when present, else discovers the first
 * installation. Returns `{ ok: true, installationId }` or
 * `{ ok: false, reason }`; the token itself never crosses this boundary.
 * @returns {Promise<{ ok: true, installationId: number } | { ok: false, reason: string }>}
 */
export async function verifyInstallationToken(storePath, { fetch: fetchImpl = fetch } = {}) {
  let store;
  try {
    store = JSON.parse(readFileSync(storePath, "utf8"));
  } catch (err) {
    return { ok: false, reason: `store unreadable: ${(err instanceof Error ? err.message : String(err))}` };
  }
  const { app_id: appId, private_key: privateKey } = store ?? {};
  if (appId === undefined || typeof privateKey !== "string" || privateKey.length === 0) {
    return { ok: false, reason: `store ${storePath} lacks app_id/private_key` };
  }
  try {
    let installationId =
      store.default_installation_id === undefined || store.default_installation_id === null
        ? await findFirstInstallation(appId, privateKey, { fetch: fetchImpl })
        : Number(store.default_installation_id);
    if (installationId === null || !Number.isInteger(installationId) || installationId <= 0) {
      return {
        ok: false,
        reason:
          "no installation found — open the App's page → 'Install App' on the target account/repo, then re-run this script",
      };
    }
    const response = await fetchImpl(`${API_ROOT}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${mintAppJwt(appId, privateKey)}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    const body = await response.json();
    if (!response.ok || typeof body?.token !== "string" || body.token.length === 0) {
      return { ok: false, reason: `token mint failed (HTTP ${response.status}): ${body?.message ?? "no token"}` };
    }
    return { ok: true, installationId };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

const USAGE = `Usage: node scripts/onboard_github_app.mjs [--force]

One-command GitHub App onboarding (pm-autopilot #7):
  1. Open the printed manifest URL and approve App creation.
  2. GitHub redirects to ${PLACEHOLDER_CALLBACK}?code=<code> — paste that code here.
  3. Credentials are written to ~/.config/pm-autopilot/credentials.json
     (0600, machine-level, reused by every project) and verified by
     minting one installation token.

--force  Replace an existing store belonging to a different App.`;

/**
 * Thin CLI entry. Injectable `input`/`output`/`env`/`fetch` keep the whole
 * flow unit-testable offline; defaults wire the real world. Returns the
 * process exit code (0 ok / 1 failure); secrets never reach `output`.
 * @param {{ argv?: string[], input?: import("node:stream").Readable,
 *          output?: import("node:stream").Writable, env?: NodeJS.ProcessEnv,
 *          fetch?: typeof fetch }} [options]
 * @returns {Promise<number>}
 */
export async function main({
  argv = process.argv.slice(2),
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  fetch: fetchImpl = fetch,
} = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    output.write(`${USAGE}\n`);
    return 0;
  }
  const force = argv.includes("--force");
  const knownFlags = new Set(["--force", "--help", "-h"]);
  if (argv.some((arg) => arg.startsWith("-") && !knownFlags.has(arg))) {
    output.write(`${USAGE}\n`);
    return 1;
  }

  const write = (line) => output.write(`${line}\n`);
  const storePath = credentialsStorePath(env);

  write("pm-autopilot GitHub App onboarding (#7)");
  write("");
  write("1. Open this URL and approve App creation (name it pm-autopilot if asked):");
  write(`   ${buildManifestUrl(manifestPayload())}`);
  write("2. After approval GitHub redirects to a placeholder page:");
  write(`   ${PLACEHOLDER_CALLBACK}?code=<code>`);
  write("   Copy the `code` query parameter from the address bar.");

  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input, output });
  let code;
  while (code === undefined || code.length === 0) {
    code = (await rl.question("3. Paste the code: ")).trim();
  }
  rl.close();

  let conversion;
  try {
    conversion = await convertCode(code, { fetch: fetchImpl });
  } catch (err) {
    write(`Conversion failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  write(`App created: id ${conversion.id}, slug ${conversion.slug}`);

  const discovery = await findFirstInstallation(conversion.id, conversion.pem, { fetch: fetchImpl }).catch(
    (err) => ({ error: err instanceof Error ? err.message : String(err) }),
  );
  const installationId = typeof discovery === "number" ? discovery : undefined;
  if (installationId === undefined) {
    write(
      typeof discovery === "object" && discovery !== null && "error" in discovery
        ? `Installation lookup failed (${discovery.error}) — continuing without default_installation_id.`
        : "No installation found yet — continuing without default_installation_id.",
    );
  }

  let storeResult;
  try {
    storeResult = writeStore(storePath, buildStoreDoc(conversion, installationId), { force });
  } catch (err) {
    write(`Store write failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  write(`Store ${storeResult.created ? "created" : "updated"}: ${storePath} (0600, dir 0700)`);

  const verification = await verifyInstallationToken(storePath, { fetch: fetchImpl });
  if (verification.ok) {
    write(`Verified: minted an installation token for installation ${verification.installationId}.`);
    write("Done — every project now resolves the pm-autopilot[bot] identity from this store.");
    return 0;
  }
  write(`Verification failed: ${verification.reason}`);
  return 1;
}

/* Thin entry: run only when executed directly (`node scripts/…`), not when
 * imported by the vitest suite. */
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  });
}
