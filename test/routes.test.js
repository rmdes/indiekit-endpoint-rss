import test from "node:test";
import assert from "node:assert/strict";

import RssEndpoint from "../index.js";

// Indiekit's lib/routes.js reads each getter twice while mounting:
//   if (endpoint.mountPath && endpoint.routes)
//   router.use(endpoint.mountPath, limit, endpoint.routes)
const readTwice = (endpoint, property) => [
  endpoint[property],
  endpoint[property],
];

test("mounting reads the routes getter twice without duplicating handlers", () => {
  const endpoint = new RssEndpoint();
  const [first, second] = readTwice(endpoint, "routes");

  assert.equal(first, second, "each read must return the same router");
  assert.equal(first.stack.length, 8, "8 protected routes, registered once");
});

test("public routes are registered once too", () => {
  const endpoint = new RssEndpoint();
  const [first, second] = readTwice(endpoint, "routesPublic");

  assert.equal(first, second);
  assert.equal(first.stack.length, 4, "4 public routes, registered once");
});

test("two instances do not share a router", () => {
  const one = new RssEndpoint();
  const other = new RssEndpoint({ mountPath: "/elsewhere" });

  assert.notEqual(one.routes, other.routes);
  assert.equal(one.routes.stack.length, other.routes.stack.length);
});
