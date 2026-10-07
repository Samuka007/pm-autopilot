import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import {
  buildManifestUrl,
  buildStoreDoc,
  convertCode,
  credentialsStorePath,
  findFirstInstallation,
  main,
  manifestPayload,
  mintAppJwt,
  verifyInstallationToken,
  writeStore,
} from "../scripts/onboard_github_app.mjs";

/**
 * Offline probe of the #7 onboarding flow: the manifest URL, the code→
 * credentials conversion (injected fetch), the 0600 user-store write against
 * a redirected-XDG tmp dir (modes + content + clobber refusal + --force),
 * and the post-write verification mint. A buffered-stream end-to-end run of
 * `main()` additionally asserts the PEM never reaches the printed output.
 * Zero network, throwaway RSA key only.
 */

const { privateKey: THROWAWAY_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const CONVERSION = {
  id: 12345,
  slug: "samuka007-pm-autopilot",
  pem: THROWAWAY_PEM,
  webhook_secret: "whsec_dropped_on_the_floor",
};

interface WireCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** Fetch stub serving the three wire shapes the flow produces:
 *  POST /app-manifests/{code}/conversions → CONVERSION;
 *  GET  /app/installations → [{ id }] (or 404);
 *  POST /app/installations/{id}/access_tokens → { token }. */
function onboardingStub({ installation = 4242 as number | null, token = "ghs_onboard_stub" } = {}) {
  const calls: WireCall[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({
      url: href,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]),
      ),
    });
    if (href.includes("/app-manifests/") && init?.method === "POST") {
      return new Response(JSON.stringify(CONVERSION), { status: 201 });
    }
    if (href.endsWith("/app/installations?per_page=100")) {
      if (installation === null) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      return new Response(JSON.stringify([{ id: installation }]), { status: 200 });
    }
    if (href.includes("/access_tokens") && init?.method === "POST") {
      return new Response(JSON.stringify({ token, expires_at: "2026-10-07T01:00:00Z" }), { status: 201 });
    }
    return new Response(JSON.stringify({ message: "unexpected wire call" }), { status: 500 });
  }) as typeof fetch;
  return { fn, calls };
}

/** XDG-redirected store path inside a fresh tmp dir (mirrors identity.test.ts). */
function tmpStore(): { storePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pm-onboard-"));
  mkdirSync(join(dir, "pm-autopilot"), { recursive: true });
  return {
    storePath: join(dir, "pm-autopilot", "credentials.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("manifest URL: settings/apps/new?state=<url-encoded manifest>", () => {
  const manifest = manifestPayload();
  expect(manifest).toEqual({
    name: "pm-autopilot",
    url: "https://github.com/Samuka007/pm-autopilot",
    redirect_url: "https://example.com/pm-autopilot/callback",
    callback_urls: ["https://example.com/pm-autopilot/callback"],
    hook_attributes: { url: "https://example.com/pm-autopilot/callback", active: false },
    public: false,
    default_permissions: { metadata: "read", issues: "write", projects: "write" },
  });

  const url = buildManifestUrl(manifest);
  expect(url).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=/);
  const decoded = JSON.parse(decodeURIComponent(url.split("state=")[1] ?? ""));
  expect(decoded).toEqual(manifest);
});

test("convertCode: unauthenticated POST of the code, credentials parsed back", async () => {
  const { fn, calls } = onboardingStub();
  const conversion = await convertCode("abc-code-123", { fetch: fn });

  expect(conversion.id).toBe(12345);
  expect(conversion.pem).toBe(THROWAWAY_PEM);
  expect(calls).toHaveLength(1);
  const call = calls[0];
  expect(call?.method).toBe("POST");
  expect(call?.url).toContain("/app-manifests/abc-code-123/conversions");
  // Unauthenticated endpoint: no Bearer material on the wire.
  expect(call?.headers.authorization).toBeUndefined();

  // Non-2xx: status + GitHub's message, response body (PEM) never surfaces.
  const failing = (async () => new Response(JSON.stringify({ message: "code expired" }), { status: 422 })) as typeof fetch;
  await expect(convertCode("stale", { fetch: failing })).rejects.toThrow(/422.*code expired/);
});

test("buildStoreDoc: canonical keys only, default_installation_id spelled exactly", () => {
  expect(buildStoreDoc(CONVERSION, 4242)).toEqual({
    app_id: 12345,
    private_key: THROWAWAY_PEM,
    default_installation_id: 4242,
  });
  expect(buildStoreDoc(CONVERSION, undefined)).toEqual({ app_id: 12345, private_key: THROWAWAY_PEM });
  expect(JSON.stringify(buildStoreDoc(CONVERSION, 1))).not.toContain("first_installation_id");
});

test("writeStore: fresh create enforces 0600 file + 0700 dir", () => {
  const { storePath, cleanup } = tmpStore();
  try {
    const result = writeStore(storePath, buildStoreDoc(CONVERSION, 4242));
    expect(result).toEqual({ created: true, updated: false });

    expect(statSync(storePath).mode & 0o777).toBe(0o600);
    expect(statSync(join(storePath, "..")).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(storePath, "utf8"))).toEqual(buildStoreDoc(CONVERSION, 4242));
  } finally {
    cleanup();
  }
});

test("writeStore: same App updates in place preserving unknown keys; different App refuses without --force", () => {
  const { storePath, cleanup } = tmpStore();
  try {
    writeStore(storePath, buildStoreDoc(CONVERSION, 4242));

    // Same app_id → merge-update: key rotation lands, unknown keys survive.
    writeFileSync(
      storePath,
      JSON.stringify({ ...buildStoreDoc(CONVERSION, 4242), webhook_secret: "whsec_keep_me" }),
    );
    const { privateKey: rotatedPem } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const result = writeStore(storePath, { app_id: 12345, private_key: rotatedPem });
    expect(result).toEqual({ created: false, updated: true });
    const merged = JSON.parse(readFileSync(storePath, "utf8"));
    expect(merged).toEqual({
      app_id: 12345,
      private_key: rotatedPem,
      default_installation_id: 4242,
      webhook_secret: "whsec_keep_me",
    });

    // Different app_id → clobber refusal, store untouched.
    expect(() => writeStore(storePath, { app_id: 99999, private_key: THROWAWAY_PEM })).toThrow(
      /refusing to clobber.*--force/,
    );
    expect(JSON.parse(readFileSync(storePath, "utf8")).app_id).toBe(12345);

    // --force replaces outright.
    writeStore(storePath, { app_id: 99999, private_key: THROWAWAY_PEM }, { force: true });
    expect(JSON.parse(readFileSync(storePath, "utf8"))).toEqual({
      app_id: 99999,
      private_key: THROWAWAY_PEM,
    });

    // Unparseable store → refusal without --force, replace with it.
    writeFileSync(storePath, "{not json");
    expect(() => writeStore(storePath, buildStoreDoc(CONVERSION, 4242))).toThrow(/not valid JSON.*--force/);
    writeStore(storePath, buildStoreDoc(CONVERSION, 4242), { force: true });
    expect(JSON.parse(readFileSync(storePath, "utf8")).app_id).toBe(12345);
  } finally {
    cleanup();
  }
});

test("mintAppJwt: RS256 three segments, iss = app id, 10-minute window", () => {
  const now = 1_790_000_000;
  const jwt = mintAppJwt("12345", THROWAWAY_PEM, { now });
  const [header, payload, signature] = jwt.split(".");
  expect(header).toBeDefined();
  expect(payload).toBeDefined();
  expect(signature).toBeDefined();
  expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
  expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toEqual({
    iat: now - 60,
    exp: now + 540,
    iss: "12345",
  });
});

test("findFirstInstallation: first id via app-JWT Bearer; 404 → null", async () => {
  const { fn, calls } = onboardingStub({ installation: 4242 });
  expect(await findFirstInstallation("12345", THROWAWAY_PEM, { fetch: fn })).toBe(4242);
  expect(calls[0]?.url).toContain("/app/installations");
  const auth = calls[0]?.headers.authorization ?? "";
  expect(auth).toMatch(/^Bearer ey[Jhb]/);
  expect(auth.split(".")).toHaveLength(3); // locally-minted JWT

  const none = onboardingStub({ installation: null });
  expect(await findFirstInstallation("12345", THROWAWAY_PEM, { fetch: none.fn })).toBeNull();
});

test("verifyInstallationToken: mints through the written store; token never returned", async () => {
  const { storePath, cleanup } = tmpStore();
  try {
    writeStore(storePath, buildStoreDoc(CONVERSION, 4242));
    const { fn, calls } = onboardingStub();

    const result = await verifyInstallationToken(storePath, { fetch: fn });
    expect(result).toEqual({ ok: true, installationId: 4242 });
    expect(JSON.stringify(result)).not.toContain("ghs_");
    // Store's default_installation_id short-circuits the lookup — only the mint rides the wire.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/app/installations/4242/access_tokens");

    // Without a stored id: discovery runs first.
    writeStore(storePath, { app_id: 12345, private_key: THROWAWAY_PEM }, { force: true });
    const discovered = onboardingStub({ installation: 777 });
    expect(await verifyInstallationToken(storePath, { fetch: discovered.fn })).toEqual({
      ok: true,
      installationId: 777,
    });
    expect(discovered.calls[0]?.method).toBe("GET");

    // No installation anywhere → guided failure, not a crash.
    const barren = onboardingStub({ installation: null });
    const failure = await verifyInstallationToken(storePath, { fetch: barren.fn });
    if (!failure.ok) {
      expect(failure.reason).toMatch(/Install App/);
    } else {
      expect.unreachable("verification must fail without any installation");
    }
  } finally {
    cleanup();
  }
});

test("main(): end-to-end offline — store written, verification reported, PEM never printed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-onboard-e2e-"));
  try {
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: dir };
    const storePath = credentialsStorePath(env);
    const { fn } = onboardingStub();

    let printed = "";
    const exit = await main({
      argv: [],
      input: Readable.from(["redirect-code-abc\n"]),
      output: new Writable({
        write(chunk, _encoding, callback) {
          printed += String(chunk);
          callback();
        },
      }),
      env,
      fetch: fn,
    });

    expect(exit).toBe(0);
    // Flow surface: manifest URL → code prompt → store → verification.
    expect(printed).toContain("https://github.com/settings/apps/new?state=");
    expect(printed).toContain("Paste the code");
    expect(printed).toContain(`Store created: ${storePath}`);
    expect(printed).toContain("Verified: minted an installation token for installation 4242");
    // Secrets discipline: PEM and minted token never reach the output.
    expect(printed).not.toContain(THROWAWAY_PEM);
    expect(printed).not.toContain("ghs_");
    expect(printed).not.toContain(CONVERSION.webhook_secret);

    const store = JSON.parse(readFileSync(storePath, "utf8"));
    expect(store).toEqual(buildStoreDoc(CONVERSION, 4242));
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main(): --help exits 0 with usage; unknown flag exits 1", async () => {
  const collect = () => {
    let text = "";
    return {
      output: new Writable({
        write(chunk, _encoding, callback) {
          text += String(chunk);
          callback();
        },
      }),
      text: () => text,
    };
  };
  const help = collect();
  expect(await main({ argv: ["--help"], output: help.output })).toBe(0);
  expect(help.text()).toMatch(/--force/);

  const bogus = collect();
  expect(await main({ argv: ["--wat"], output: bogus.output })).toBe(1);
  expect(bogus.text()).toMatch(/Usage:/);
});
