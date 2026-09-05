import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";

import { feedsController } from "../lib/controllers/feeds.js";

const FEED_ID = new ObjectId();

/**
 * Minimal Express-ish request/response pair plus a fake feeds collection.
 * @param {object} feed - Existing feed document
 * @param {object} body - Request body
 * @param {object} [publication] - Publication config exposed on app.locals
 * @returns {object} request, response, and a peek at the stored feed
 */
function harness(feed, body, publication = { postTypes: { note: {}, bookmark: {} } }) {
  let stored = { _id: FEED_ID, ...feed };
  const sent = {};

  const feedsCollection = {
    findOne: async () => stored,
    findOneAndUpdate: async (filter, update) => {
      stored = { ...stored, ...update.$set };
      return stored;
    },
  };

  const request = {
    params: { id: FEED_ID.toString() },
    body,
    app: {
      locals: {
        application: { getRssDb: () => ({ collection: () => feedsCollection }) },
        publication,
      },
    },
  };

  const response = {
    locals: { __: (key) => key },
    status(code) {
      sent.status = code;
      return this;
    },
    json(payload) {
      sent.body = payload;
      return this;
    },
  };

  return { request, response, sent, feed: () => stored };
}

test("enabling publishing stamps a watermark", async () => {
  const { request, response, feed } = harness(
    { url: "https://example.com/feed", enabled: true },
    { publish: { enabled: true, postType: "bookmark" } },
  );

  await feedsController.toggle(request, response);

  const { since } = feed().publish;
  assert.equal(typeof since, "string");
  assert.equal(since, new Date(since).toISOString());
});

test("the watermark is stamped once, not reset on later edits", async () => {
  const original = "2026-01-01T00:00:00.000Z";
  const { request, response, feed } = harness(
    {
      url: "https://example.com/feed",
      publish: { enabled: true, postType: "note", since: original },
    },
    { publish: { enabled: true, postType: "bookmark" } },
  );

  await feedsController.toggle(request, response);

  assert.equal(feed().publish.since, original);
});

test("defaults are filled in from the post type", async () => {
  const { request, response, feed } = harness(
    { url: "https://example.com/feed" },
    { publish: { enabled: true, postType: "bookmark" } },
  );

  await feedsController.toggle(request, response);

  assert.equal(feed().publish.linkProperty, "bookmark-of");
  assert.equal(feed().publish.content, "{{description}}");
});

test("an explicit null linkProperty is respected, not overwritten", async () => {
  const { request, response, feed } = harness(
    { url: "https://example.com/feed" },
    { publish: { enabled: true, postType: "bookmark", linkProperty: null } },
  );

  await feedsController.toggle(request, response);

  assert.equal(feed().publish.linkProperty, null);
});

test("a post type the site does not have is rejected", async () => {
  // postData.create throws notImplemented for an unconfigured type, and the
  // failure would be buried in the sync loop. chardonsbleus has audio, event,
  // jam and rsvp disabled, so this is a live hazard.
  const { request, response, sent } = harness(
    { url: "https://example.com/feed" },
    { publish: { enabled: true, postType: "audio" } },
  );

  await feedsController.toggle(request, response);

  assert.equal(sent.status, 400);
  assert.match(sent.body.error, /audio/);
});

test("enabled and publish can still be sent independently", async () => {
  const { request, response, feed } = harness(
    { url: "https://example.com/feed", enabled: true },
    { enabled: false },
  );

  await feedsController.toggle(request, response);

  assert.equal(feed().enabled, false);
  assert.equal(feed().publish, undefined);
});

test("missing post type configuration fails closed, not open", async () => {
  // A gate that silently disappears when its own config is missing is worse
  // than no gate: it looks like protection while providing none.
  const { request, response, sent } = harness(
    { url: "https://example.com/feed" },
    { publish: { enabled: true, postType: "bookmark" } },
    {},
  );

  await feedsController.toggle(request, response);

  assert.equal(sent.status, 500);
});

test("a request changing nothing is rejected", async () => {
  const { request, response, sent } = harness(
    { url: "https://example.com/feed" },
    {},
  );

  await feedsController.toggle(request, response);

  assert.equal(sent.status, 400);
});
