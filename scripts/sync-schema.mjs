/**
 * scripts/sync-schema.mjs — #4: refresh the vendored GitHub GraphQL SDL that
 * anchors codegen (src/graphql/schema.graphql).
 *
 * Why vendored instead of `@octokit/graphql-schema`: that package's
 * auto-update pipeline went stale (last publish 2025-11-24) and its snapshot
 * predates the issue-dependencies GA (blockedBy / addBlockedBy, 2025-08-21),
 * while the live API still serves them — compiling the recorded templates
 * against it fails on fields the real API accepts. This script introspects
 * the live API once and commits the result, keeping CI offline (codegen only
 * ever reads the committed file).
 *
 * Usage: pnpm schema:sync   (needs GH_TOKEN or a logged-in `gh`)
 */

import { buildClientSchema, getIntrospectionQuery, printSchema } from "graphql";
import { writeFileSync } from "node:fs";

const target = new URL("../src/graphql/schema.graphql", import.meta.url);

const token = process.env.GH_TOKEN;
if (token === undefined || token === "") {
  throw new Error("GH_TOKEN not set — export a token with read access to the public schema");
}
const response = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "pm-autopilot schema-sync (#4)",
  },
  body: JSON.stringify({ query: getIntrospectionQuery({ descriptions: true }) }),
  signal: AbortSignal.timeout(120_000),
});
if (!response.ok) {
  throw new Error(`introspection ${String(response.status)}: ${await response.text()}`);
}
const payload = await response.json();
if (payload.errors !== undefined) {
  throw new Error(`introspection errors: ${payload.errors.map((e) => e.message).join("; ")}`);
}

const sdl = printSchema(buildClientSchema(payload.data), { commentDescriptions: true });
const stamped = [
  `# GitHub GraphQL schema SDL — vendored via \`pnpm schema:sync\` on ${new Date().toISOString()}`,
  "# (live-API introspection; @octokit/graphql-schema is stale since 2025-11 and misses",
  "# the issue-dependencies axis — see scripts/sync-schema.mjs). Committed so codegen",
  "# and CI never touch the network. Refresh only when the drift gate or a new GitHub",
  "# feature demands it; expect a large diff when you do.",
  sdl,
  "",
].join("\n");
writeFileSync(target, stamped);
console.log(`schema.graphql written: ${stamped.length} bytes`);
