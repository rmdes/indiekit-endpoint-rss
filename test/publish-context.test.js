import test from "node:test";
import assert from "node:assert/strict";

import { resolvePublishContext } from "../lib/publisher.js";

test("an absolute micropub endpoint is used as configured", () => {
  const context = resolvePublishContext(
    { micropubEndpoint: "https://example.com/micropub", port: "8080" },
    { me: "https://example.com/" },
  );

  assert.equal(context.micropubEndpoint, "https://example.com/micropub");
  assert.equal(context.me, "https://example.com/");
});

test("a relative endpoint resolves against localhost, not the public url", () => {
  // Background sync has no request to resolve against, and looping back
  // through the public hostname would traverse DNS, TLS and the proxy.
  const context = resolvePublishContext(
    { micropubEndpoint: "/micropub", port: "8080" },
    { me: "https://example.com/" },
  );

  assert.equal(context.micropubEndpoint, "http://localhost:8080/micropub");
});

test("the port falls back to Indiekit's own default", () => {
  const context = resolvePublishContext(
    { micropubEndpoint: "/micropub" },
    { me: "https://example.com/" },
  );

  assert.equal(context.micropubEndpoint, "http://localhost:3000/micropub");
});

test("a malformed port yields null rather than throwing", () => {
  // This runs before runSync's try block. A throw here would abort the whole
  // cycle — fetch, inserts and prune included — not just publishing.
  assert.equal(
    resolvePublishContext(
      { micropubEndpoint: "/micropub", port: "80 80" },
      { me: "https://example.com/" },
    ),
    null,
  );
});

test("missing configuration yields null rather than a broken url", () => {
  assert.equal(resolvePublishContext({}, {}), null);
  assert.equal(resolvePublishContext({ micropubEndpoint: "/micropub" }, {}), null);
  assert.equal(resolvePublishContext({}, { me: "https://example.com/" }), null);
});
