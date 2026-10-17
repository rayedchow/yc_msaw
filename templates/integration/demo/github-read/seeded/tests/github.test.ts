// Unit tests with a FAKE fetch (no network in the sandbox).
import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubError, readFile } from "../src/github.ts";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "x-github-request-id": "TEST:1" } })) as typeof fetch;
}

test("decodes a base64 file", async () => {
  const f = await readFile({ owner: "o", repo: "r", path: "README.md" }, { baseUrl: "http://127.0.0.1:9", fetchImpl: fakeFetch(200, { type: "file", encoding: "base64", content: Buffer.from("hello").toString("base64"), sha: "abc", size: 5 }) });
  assert.equal(f.text, "hello");
  assert.equal(f.github.requestId, "TEST:1");
});

test("surfaces GitHub errors with status and message", async () => {
  await assert.rejects(
    readFile({ owner: "o", repo: "r", path: "missing.md" }, { baseUrl: "http://127.0.0.1:9", fetchImpl: fakeFetch(404, { message: "Not Found" }) }),
    (e: unknown) => e instanceof GithubError && e.status === 404 && e.message === "Not Found",
  );
});
