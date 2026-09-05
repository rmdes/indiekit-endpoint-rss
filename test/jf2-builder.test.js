import test from "node:test";
import assert from "node:assert/strict";

import { buildJf2, defaultContent, defaultLinkProperty } from "../lib/jf2-builder.js";

const item = {
  title: "A headline",
  link: "https://example.com/post",
  description: "A short summary.",
  content: "<p>Full body</p><script>alert(1)</script>",
  author: "Someone",
  sourceTitle: "Origin Feed",
  imageUrl: "https://example.com/img.jpg",
  pubDate: new Date("2026-09-05T10:00:00.000Z"),
  categories: ["ai", "web"],
};

test("bookmark sets bookmark-of and keeps a name", () => {
  const jf2 = buildJf2(item, {
    postType: "bookmark",
    content: "{{description}}",
    linkProperty: "bookmark-of",
    status: "draft",
  });

  assert.equal(jf2["bookmark-of"], "https://example.com/post");
  assert.equal(jf2.name, "A headline");
  assert.equal(jf2.content, "A short summary.");
});

test("note carries no name, or discovery would call it an article", () => {
  const jf2 = buildJf2(item, {
    postType: "note",
    content: "{{title}} — {{description}} ({{link}})",
    linkProperty: null,
    status: "published",
  });

  assert.equal(jf2.name, undefined);
  assert.equal(jf2.content, "A headline — A short summary. (https://example.com/post)");
});

test("{{content}} is sent as html and is sanitized", () => {
  const jf2 = buildJf2(item, {
    postType: "article",
    content: "{{content}}",
    linkProperty: null,
    status: "published",
  });

  assert.equal(typeof jf2.content, "object");
  assert.match(jf2.content.html, /Full body/);
  assert.doesNotMatch(jf2.content.html, /script/);
});

test("photo takes the image url, not the article link", () => {
  const jf2 = buildJf2(item, {
    postType: "photo",
    content: "{{description}}",
    linkProperty: "photo",
    status: "draft",
  });

  assert.equal(jf2.photo, "https://example.com/img.jpg");
});

test("a missing value for the chosen link property is a hard error", () => {
  assert.throws(
    () =>
      buildJf2(
        { ...item, link: null },
        { postType: "bookmark", content: "{{description}}", linkProperty: "bookmark-of", status: "draft" },
      ),
    /bookmark-of/,
  );
});

test("post-status reflects the feed setting", () => {
  const base = { postType: "note", content: "{{description}}", linkProperty: null };

  assert.equal(buildJf2(item, { ...base, status: "draft" })["post-status"], "draft");
  assert.equal(buildJf2(item, { ...base, status: "published" })["post-status"], "published");
});

test("syndication is silent unless targets are named", () => {
  const base = { postType: "note", content: "{{description}}", linkProperty: null, status: "draft" };

  assert.equal(buildJf2(item, base)["mp-syndicate-to"], undefined);
  assert.deepEqual(
    buildJf2(item, { ...base, syndicateTo: ["https://mastodon.example/@me"] })["mp-syndicate-to"],
    ["https://mastodon.example/@me"],
  );
});

test("declareSyndication records the source as an existing copy", () => {
  const base = { postType: "video", content: "{{description}}", linkProperty: "video", status: "published" };

  assert.equal(buildJf2(item, base).syndication, undefined);
  assert.deepEqual(
    buildJf2(item, { ...base, declareSyndication: true }).syndication,
    ["https://example.com/post"],
  );
});

test("published is an ISO string, never a Date", () => {
  const jf2 = buildJf2(item, { postType: "note", content: "{{description}}", linkProperty: null, status: "draft" });

  assert.equal(jf2.published, "2026-09-05T10:00:00.000Z");
});

test("defaults are offered per post type", () => {
  assert.equal(defaultLinkProperty("bookmark"), "bookmark-of");
  assert.equal(defaultLinkProperty("note"), null);
  assert.equal(defaultContent("article"), "{{content}}");
  assert.equal(defaultContent("bookmark"), "{{description}}");
});
