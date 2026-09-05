import { sanitizeHtml, stripHtml } from "./utils.js";

/**
 * Discovery property pre-filled for each post type. Form defaults only —
 * any combination the user sets is accepted.
 */
const LINK_PROPERTY_DEFAULTS = {
  bookmark: "bookmark-of",
  like: "like-of",
  repost: "repost-of",
  reply: "in-reply-to",
  video: "video",
  photo: "photo",
};

const PLACEHOLDERS = {
  title: (item) => stripHtml(item.title),
  link: (item) => item.link,
  description: (item) => stripHtml(item.description),
  content: (item) => sanitizeHtml(item.content),
  author: (item) => stripHtml(item.author),
  sourceTitle: (item) => stripHtml(item.sourceTitle),
};

/**
 * Link property offered when a post type is chosen
 * @param {string} postType - Post type key
 * @returns {string|null} Property name, or null when the type needs none
 */
export const defaultLinkProperty = (postType) =>
  LINK_PROPERTY_DEFAULTS[postType] || null;

/**
 * Content template offered when a post type is chosen
 * @param {string} postType - Post type key
 * @returns {string} Template string
 */
export const defaultContent = (postType) =>
  postType === "article" ? "{{content}}" : "{{description}}";

/**
 * Render a feed item into a content string
 * @param {string} template - Template with {{placeholder}} tokens
 * @param {object} item - RSS item document
 * @returns {string} Rendered content
 */
export function renderTemplate(template, item) {
  return template.replaceAll(/\{\{(\w+)\}\}/g, (match, key) => {
    const source = PLACEHOLDERS[key];
    return source ? (source(item) ?? "") : match;
  });
}

/**
 * Build JF2 properties for one feed item.
 *
 * The post type is never sent: getPostType() derives it from the properties
 * present, so `publish.postType` decides which discovery property to set.
 * @param {object} item - RSS item document
 * @param {object} publish - Feed publish configuration
 * @returns {object} JF2 properties
 */
export function buildJf2(item, publish) {
  const template = publish.content || defaultContent(publish.postType);
  const rendered = renderTemplate(template, item);
  const isHtml = template.includes("{{content}}");

  const properties = {
    type: "entry",
    content: isHtml ? { html: rendered } : rendered,
  };

  // A `name` next to content makes discovery return "article" — see
  // post-type-discovery.js: `if (content && properties.name) return "article"`.
  // A note must therefore carry none.
  const name = stripHtml(item.title);
  if (publish.postType !== "note" && name) {
    properties.name = name;
  }

  if (publish.linkProperty) {
    const value =
      publish.linkProperty === "photo" ? item.imageUrl : item.link;

    if (!value) {
      throw new Error(
        `Item has no value for "${publish.linkProperty}": ${item.guid}`,
      );
    }

    properties[publish.linkProperty] = value;
  }

  if (item.pubDate) {
    properties.published =
      item.pubDate instanceof Date ? item.pubDate.toISOString() : item.pubDate;
  }

  if (item.categories?.length) {
    properties.category = item.categories;
  }

  if (publish.declareSyndication && item.link) {
    properties.syndication = [item.link];
  }

  properties["post-status"] =
    publish.status === "published" ? "published" : "draft";

  if (publish.syndicateTo?.length) {
    properties["mp-syndicate-to"] = publish.syndicateTo;
  }

  return properties;
}
