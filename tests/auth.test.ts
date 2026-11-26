import { test } from "node:test";
import assert from "node:assert/strict";
import { checkChallenge, createChallenge, createSession, generateCode, readSession, signToken, verifyToken } from "../server/auth.ts";

const SECRET = "x".repeat(40);

test("codes are 8 digits", () => {
  for (let i = 0; i < 200; i++) assert.match(generateCode(), /^\d{8}$/);
});

test("correct code verifies, wrong code does not", async () => {
  const ch = await createChallenge(SECRET, "me@x.com", "12345678");
  assert.deepEqual((await checkChallenge(SECRET, ch, "1234 5678"))?.email, "me@x.com");
  assert.equal(await checkChallenge(SECRET, ch, "12345679"), null);
  assert.equal(await checkChallenge(SECRET, ch, ""), null);
});

test("challenge signed with another secret is rejected", async () => {
  const ch = await createChallenge("y".repeat(40), "me@x.com", "12345678");
  assert.equal(await checkChallenge(SECRET, ch, "12345678"), null);
});

test("tampered payload is rejected", async () => {
  const ch = await createChallenge(SECRET, "me@x.com", "12345678");
  const [body, sig] = ch.split(".");
  const json = JSON.parse(Buffer.from(body, "base64url").toString());
  json.e = "attacker@x.com";
  const forged = `${Buffer.from(JSON.stringify(json)).toString("base64url")}.${sig}`;
  assert.equal(await checkChallenge(SECRET, forged, "12345678"), null);
});

test("expired tokens are rejected", async () => {
  const t = await signToken(SECRET, { t: "s", e: "a@b.co", v: "1", x: Date.now() - 1 });
  assert.equal(await verifyToken(SECRET, t), null);
});

test("sessions round-trip and respect SESSION_VERSION", async () => {
  const s = await createSession(SECRET, "me@x.com", 7, "1");
  assert.deepEqual(await readSession(SECRET, s, "1"), { email: "me@x.com" });
  assert.equal(await readSession(SECRET, s, "2"), null);
  assert.equal(await readSession(SECRET, `${s}x`, "1"), null);
});
