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

test("description carrying a script tag is stripped, not passed through", () => {
  const jf2 = buildJf2(
    { ...item, description: "<script>alert(1)</script>evil text" },
    { postType: "note", content: "{{description}}", linkProperty: null, status: "draft" },
  );

  assert.doesNotMatch(jf2.content, /script/);
  assert.doesNotMatch(jf2.content, /</);
});

test("title with a break-out payload cannot inject markup into name", () => {
  const jf2 = buildJf2(
    { ...item, title: "before</script><img src=x onerror=alert(1)>after" },
    { postType: "bookmark", content: "{{description}}", linkProperty: "bookmark-of", status: "draft" },
  );

  assert.equal(jf2.name, "beforeafter");
});

test("{{content}} still yields sanitized html, not stripped text", () => {
  const jf2 = buildJf2(item, {
    postType: "article",
    content: "{{content}}",
    linkProperty: null,
    status: "published",
  });

  assert.equal(typeof jf2.content, "object");
  assert.match(jf2.content.html, /<p>Full body<\/p>/);
  assert.doesNotMatch(jf2.content.html, /script/);
});

test("a null description or numeric title never throws", () => {
  assert.doesNotThrow(() =>
    buildJf2(
      { ...item, description: null, title: 12345 },
      { postType: "note", content: "{{description}}", linkProperty: null, status: "draft" },
    ),
  );
});

test("{{content}} keeps a code block's language class for syntax highlighting", () => {
  const jf2 = buildJf2(
    { ...item, content: '<pre><code class="language-js">const x = 1;</code></pre>' },
    { postType: "article", content: "{{content}}", linkProperty: null, status: "published" },
  );

  assert.match(jf2.content.html, /class="language-js"/);
});

test("a non-language class on code is dropped", () => {
  const jf2 = buildJf2(
    { ...item, content: '<code class="evil-class">x</code>' },
    { postType: "article", content: "{{content}}", linkProperty: null, status: "published" },
  );

  assert.doesNotMatch(jf2.content.html, /evil-class/);
});

test("defaults are offered per post type", () => {
  assert.equal(defaultLinkProperty("bookmark"), "bookmark-of");
  assert.equal(defaultLinkProperty("note"), null);
  assert.equal(defaultContent("article"), "{{content}}");
  assert.equal(defaultContent("bookmark"), "{{description}}");
});

test("items sharing a title prefix get different slugs", () => {
  // Indiekit slugs from the first five words of the name. Three GitHub
  // timeline entries shared that prefix, resolved to one URL, and
  // postData.create's replaceOne silently overwrote each previous post.
  const base = { postType: "article", content: "{{description}}", linkProperty: null, status: "published" };
  const titled = (guid, title) => ({ ...item, guid, title, link: `https://example.com/${guid}` });

  const a = buildJf2(titled("g1", "getindiekit added rmdes to getindiekit/jekyll-starter"), base);
  const b = buildJf2(titled("g2", "getindiekit added rmdes to getindiekit/hugo-starter"), base);

  assert.notEqual(a["mp-slug"], b["mp-slug"]);
  // Still readable: the leading words survive, a short guid hash follows.
  assert.match(a["mp-slug"], /^getindiekit added rmdes to \S+ [\da-f]{6}$/);
});

test("the slug is stable for the same item", () => {
  const base = { postType: "note", content: "{{description}}", linkProperty: null, status: "draft" };

  assert.equal(buildJf2(item, base)["mp-slug"], buildJf2(item, base)["mp-slug"]);
});

test("an indented description does not become a code block", () => {
  // Markdown reads an indented line as code. A GitHub entry rendered as
  // <pre><code> for exactly this reason.
  const indented = { ...item, description: "  getindiekit\n    added\n    rmdes\n" };
  const jf2 = buildJf2(indented, {
    postType: "note",
    content: "{{description}}",
    linkProperty: null,
    status: "draft",
  });

  assert.equal(jf2.content, "getindiekit added rmdes");
});
