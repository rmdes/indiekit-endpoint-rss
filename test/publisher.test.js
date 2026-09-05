import test from "node:test";
import assert from "node:assert/strict";

import { mintToken, postToMicropub } from "../lib/publisher.js";

test("mintToken signs a create-scoped token with the site secret", async () => {
  process.env.SECRET = "test-secret-value";

  const token = mintToken("https://example.com/");
  const jwt = (await import("jsonwebtoken")).default;
  const claims = jwt.verify(token, "test-secret-value");

  assert.equal(claims.me, "https://example.com/");
  assert.equal(claims.scope, "create");
});

test("mintToken refuses to run without a secret", () => {
  delete process.env.SECRET;

  assert.throws(() => mintToken("https://example.com/"), /SECRET/);
});

test("postToMicropub returns the Location header on success", async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 201,
      headers: new Headers({ location: "https://example.com/notes/1" }),
      text: async () => "",
    };
  };

  const url = await postToMicropub(
    "http://localhost:8080/micropub",
    "tok",
    { type: "entry", content: "hi" },
    { fetchImpl: fakeFetch },
  );

  assert.equal(url, "https://example.com/notes/1");
  assert.equal(calls[0].options.headers.authorization, "Bearer tok");
  // The endpoint parses JSON bodies as mf2, so mf2 is what must be sent.
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.type, ["h-entry"]);
  assert.deepEqual(body.properties.content, ["hi"]);
});

test("postToMicropub throws with status and body on failure", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 400,
    headers: new Headers(),
    text: async () => '{"error":"invalid_request"}',
  });

  await assert.rejects(
    () =>
      postToMicropub("http://localhost:8080/micropub", "tok", { type: "entry" }, {
        fetchImpl: fakeFetch,
      }),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /invalid_request/);
      return true;
    },
  );
});
