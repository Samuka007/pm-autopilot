/**
 * pm-autopilot/src/identity.ts — GitHub App agent identity (#5; ADR-0001 §2,
 * ADR-0002 §2–4). Replaces the hand-rolled token chain with @octokit/auth-app
 * whenever App credentials are present, so board writes attribute to the
 * `pm-autopilot[bot]` identity instead of the human account.
 *
 * Attribution fact: only a GitHub App's installation (server-to-server) token
 * authors issues as `pm-autopilot[bot]`; user tokens (PAT / `gh auth token` /
 * OAuth user-to-server) always show the human user. No code path may rely on
 * the display name — the credential IS the identity (ADR-0001 §2).
 *
 * Credential resolution order (ADR-0002 §3):
 *   1. process env — `PM_GITHUB_APP_ID` + (`PM_GITHUB_APP_PRIVATE_KEY` PEM |
 *      `PM_GITHUB_APP_KEY_PATH`); the CI/herdr-lane override surface.
 *   2. user store — `~/.config/pm-autopilot/credentials.json` (0600,
 *      XDG_CONFIG_HOME-aware): the cross-project default written once by the
 *      onboarding flow (#7).
 *   3. repo `.env.local` — deliberately NOT read for App credentials (#5):
 *      a gitignored identity file must not silently bind one project, and
 *      env is the only repo-level surface.
 *
 * Absent everywhere → `resolveAppCredentials()` returns null and the caller
 * stays on the legacy chain (GH_TOKEN → `gh auth token`) with byte-identical
 * behavior. PARTIALLY present (id without key, store missing required keys)
 * → throw: a half-configured identity must never silently degrade into
 * user-token writes misattributed to the human account.
 *
 * Installation ids resolve per target repo (ADR-0002 §4):
 * `PM_GITHUB_INSTALLATION_ID` overrides; otherwise
 * `GET /repos/{owner}/{repo}/installation` (app-JWT Bearer), cached
 * in-process per repo; the store's `default_installation_id` (legacy alias
 * `first_installation_id`) is the fallback when the lookup finds no
 * installation. Token minting/caching/re-minting (~1h expiry) is auth-app's
 * own hook machinery, not ours.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createAppAuth } from "@octokit/auth-app";
import { request as octokitRequest } from "@octokit/request";

export type FetchFn = typeof fetch;

export interface AppCredentials {
  appId: string;
  privateKey: string;
  /** Fallback installation id when the per-repo lookup finds none — single-
   *  repo onboardings write it into the store (#7). */
  defaultInstallationId?: number;
}

export type InstallationTokenProvider = (repo: string) => Promise<string>;

export interface InstallationTokenProviderOptions {
  /** Test seam: routes auth-app's mint exchange AND the per-repo lookup
   *  through the same stub fetch as the gql transport. Default: global. */
  fetch?: FetchFn;
  /** Env surface (tests inject an isolated object). Default: process.env. */
  env?: NodeJS.ProcessEnv;
}

/** Env convention: an empty string is an unset variable (as resolveToken does
 *  for GH_TOKEN). */
function envStr(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

/** App private keys arrive PEM-encoded; env vars and JSON stores are routinely
 *  single-line with escaped newlines (the exact shape auth-app's own error
 *  message recommends). Restore real newlines when none survived. */
function normalizePem(raw: string): string {
  return raw.includes("\n") ? raw : raw.replaceAll("\\n", "\n");
}

function positiveInteger(value: unknown, what: string): number | undefined {
  if (value === undefined) return undefined;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`[pm-autopilot] ${what} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return id;
}

/** `~/.config/pm-autopilot/credentials.json`, XDG_CONFIG_HOME-aware. */
export function credentialsStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = envStr(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
  return join(configHome, "pm-autopilot", "credentials.json");
}

interface CredentialStore {
  app_id?: string | number;
  private_key?: string;
  private_key_path?: string;
  default_installation_id?: string | number;
  /** Legacy alias for default_installation_id (#5 contract spelling). */
  first_installation_id?: string | number;
}

/**
 * App-level credentials per the resolution order above; null = no App
 * credentials configured → caller keeps the legacy token chain unchanged.
 * Throws on a partially-configured identity (see module doc): silent fallback
 * would misattribute writes to the human account.
 */
export function resolveAppCredentials(env: NodeJS.ProcessEnv = process.env): AppCredentials | null {
  const appId = envStr(env.PM_GITHUB_APP_ID);
  const pem = envStr(env.PM_GITHUB_APP_PRIVATE_KEY);
  const keyPath = envStr(env.PM_GITHUB_APP_KEY_PATH);

  if (appId !== undefined || pem !== undefined || keyPath !== undefined) {
    if (appId === undefined) {
      throw new Error(
        "[pm-autopilot] PM_GITHUB_APP_PRIVATE_KEY/PM_GITHUB_APP_KEY_PATH set without PM_GITHUB_APP_ID — set PM_GITHUB_APP_ID or unset the key vars",
      );
    }
    if (pem !== undefined && keyPath !== undefined) {
      throw new Error(
        "[pm-autopilot] PM_GITHUB_APP_PRIVATE_KEY and PM_GITHUB_APP_KEY_PATH are mutually exclusive",
      );
    }
    if (pem === undefined && keyPath === undefined) {
      throw new Error(
        "[pm-autopilot] PM_GITHUB_APP_ID set without PM_GITHUB_APP_PRIVATE_KEY or PM_GITHUB_APP_KEY_PATH — provide the App private key (PEM) or a path to it",
      );
    }
    return { appId, privateKey: pem !== undefined ? normalizePem(pem) : readFileSync(keyPath as string, "utf8") };
  }

  const storePath = credentialsStorePath(env);
  let raw: string;
  try {
    raw = readFileSync(storePath, "utf8");
  } catch {
    return null; // no store → no App credentials anywhere → legacy chain
  }
  let store: CredentialStore;
  try {
    store = JSON.parse(raw) as CredentialStore;
  } catch (err) {
    throw new Error(`[pm-autopilot] ${storePath} is not valid JSON: ${(err as Error).message}`);
  }
  if (store.app_id === undefined && store.private_key === undefined && store.private_key_path === undefined) {
    return null; // not an App-credentials store
  }
  if (store.app_id === undefined) {
    throw new Error(`[pm-autopilot] ${storePath} missing "app_id"`);
  }
  let privateKey: string;
  if (typeof store.private_key === "string" && store.private_key.length > 0) {
    privateKey = normalizePem(store.private_key);
  } else if (typeof store.private_key_path === "string" && store.private_key_path.length > 0) {
    // Relative paths anchor at the store's own directory.
    privateKey = readFileSync(resolve(dirname(storePath), store.private_key_path), "utf8");
  } else {
    throw new Error(
      `[pm-autopilot] ${storePath} has "app_id" but neither "private_key" (PEM) nor "private_key_path"`,
    );
  }
  const defaultInstallationId = positiveInteger(
    store.default_installation_id ?? store.first_installation_id,
    `${storePath} default_installation_id`,
  );
  return {
    appId: String(store.app_id),
    privateKey,
    ...(defaultInstallationId === undefined ? {} : { defaultInstallationId }),
  };
}

const API_ROOT = "https://api.github.com";

/**
 * Builds the per-repo installation-token provider wired into the transport
 * factory. Each call resolves the installation for `repo` ("owner/name") and
 * returns a fresh-or-cached installation token: `PM_GITHUB_INSTALLATION_ID`
 * overrides; else the in-process per-repo cache; else the app-JWT
 * `GET /repos/{owner}/{repo}/installation` lookup; else the store's default
 * installation id. auth-app's own cache mints once per installation and
 * re-mints transparently as tokens age out (~1h expiry, refreshed 1min
 * early) — long PM sessions never see an expired Bearer.
 */
export function createInstallationTokenProvider(
  credentials: AppCredentials,
  options: InstallationTokenProviderOptions = {},
): InstallationTokenProvider {
  const fetchFn = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  // The injected fetch reaches auth-app's own mint exchange
  // (POST /app/installations/{id}/access_tokens) through the same seam.
  const authApp = createAppAuth({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    request: octokitRequest.defaults({ request: { fetch: fetchFn } }),
  });
  // In-process per-repo cache (#5): installation ids are stable per
  // (App, repo), so the cache never needs invalidation.
  const installationIds = new Map<string, number>();

  const installationIdFor = async (repo: string): Promise<number> => {
    const override = envStr(env.PM_GITHUB_INSTALLATION_ID);
    if (override !== undefined) {
      const id = positiveInteger(override, "PM_GITHUB_INSTALLATION_ID");
      if (id === undefined) throw new Error("[pm-autopilot] PM_GITHUB_INSTALLATION_ID is empty");
      return id;
    }
    const cached = installationIds.get(repo);
    if (cached !== undefined) return cached;
    // App JWT — minted locally per lookup (never sent anywhere else).
    const appAuth = await authApp({ type: "app" });
    const response = await fetchFn(`${API_ROOT}/repos/${repo}/installation`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${appAuth.token}`,
        accept: "application/vnd.github+json",
        "user-agent": "pm-autopilot (#5)",
      },
    });
    if (response.ok) {
      const body = (await response.json()) as { id?: unknown };
      const id = positiveInteger(body.id, `installation lookup for ${repo}`);
      if (id === undefined) throw new Error(`[pm-autopilot] installation lookup for ${repo} returned no id`);
      installationIds.set(repo, id);
      return id;
    }
    if (response.status === 404 && credentials.defaultInstallationId !== undefined) {
      // App not installed on this exact repo — the store's single-repo
      // onboarding default stands in rather than failing the session.
      return credentials.defaultInstallationId;
    }
    throw new Error(
      `[pm-autopilot] no GitHub App installation found for ${repo} (HTTP ${response.status}) — install the App on the repo or set PM_GITHUB_INSTALLATION_ID`,
    );
  };

  return async (repo) => {
    const installationId = await installationIdFor(repo);
    const installation = await authApp({ type: "installation", installationId });
    return installation.token;
  };
}
