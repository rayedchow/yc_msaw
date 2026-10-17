import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyBearer } from "../src/auth.ts";

const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
function mint(privateKey: import("node:crypto").KeyObject, claims: Record<string, unknown>) {
  const input = `${b64u(JSON.stringify({ alg: "EdDSA", typ: "JWT" }))}.${b64u(JSON.stringify(claims))}`;
  return `${input}.${b64u(sign(null, Buffer.from(input), privateKey))}`;
}

test("verifyBearer accepts only correctly signed, scoped, unexpired tokens for this audience", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const cfg = { key: publicKey, issuer: "iss", audience: "urn:aud" };
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: "iss", aud: "urn:aud", sub: "u", scope: "integration:call", iat: now, exp: now + 60 };
  assert.equal(verifyBearer(cfg, `Bearer ${mint(privateKey, good)}`).ok, true);
  assert.deepEqual(verifyBearer(cfg, undefined), { ok: false, reason: "missing_bearer" });
  assert.equal(verifyBearer(cfg, `Bearer ${mint(other.privateKey, good)}`).ok, false);
  assert.equal(verifyBearer(cfg, `Bearer ${mint(privateKey, { ...good, aud: "urn:other" })}`).ok, false);
  assert.equal(verifyBearer(cfg, `Bearer ${mint(privateKey, { ...good, exp: now - 1 })}`).ok, false);
});
