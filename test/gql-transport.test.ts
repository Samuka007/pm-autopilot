import { afterEach, expect, test } from "vitest";
import { makeGql } from "../src/core.js";
import type { FetchFn } from "../src/core.js";

/**
 * Offline probe of the REAL Octokit transport path (#3): a stub fetch records
 * the wire shape octokit produces for `makeGql` — no `_inject` here (that seam
 * replaces the transport entirely; this suite exercises the library path the
 * injected mocks stand in for). Zero network.
 */

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(payload: unknown): { fn: FetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn: FetchFn = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
  return { fn, calls };
}

afterEach(() => {
  delete process.env.GH_TOKEN;
});

test("makeGql request shape: graphql URL, POST, Bearer from token resolution, {query, variables} body", async () => {
  process.env.GH_TOKEN = "ghp_offline_token";
  const { fn, calls } = stubFetch({ data: { repository: { id: "R_1" } } });
  const gql = makeGql(fn);

  const data = await gql(
    "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}",
    { owner: "Samuka007", name: "pm-autopilot" },
  );

  expect(data).toEqual({ repository: { id: "R_1" } });
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (call === undefined) throw new Error("unreachable: call recorded above");
  expect(call.url).toBe("https://api.github.com/graphql");
  expect(call.init.method).toBe("POST");
  expect(call.init.headers as Record<string, string>).toMatchObject({
    authorization: "Bearer ghp_offline_token",
  });
  expect(JSON.parse(String(call.init.body))).toEqual({
    query: "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}",
    variables: { owner: "Samuka007", name: "pm-autopilot" },
  });
});

test("makeGql error propagation: GraphQL errors surface in the thrown message", async () => {
  process.env.GH_TOKEN = "ghp_offline_token";
  const { fn } = stubFetch({
    data: null,
    errors: [{ message: "Field 'zzz' doesn't exist on type 'Query'" }],
  });
  const gql = makeGql(fn);

  // Callers only stringify (err.message) — the library error text must survive.
  await expect(gql("query { zzz }", {})).rejects.toThrow(/doesn't exist on type 'Query'/);
  await expect(gql("query { zzz }", {})).rejects.toThrow("Request failed due to following response errors");
});
