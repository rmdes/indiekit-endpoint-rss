# CLAUDE.md - indiekit-endpoint-rss

## Package Overview

**Package:** `@rmdes/indiekit-endpoint-rss`
**Version:** 1.0.11
**Type:** Indiekit endpoint plugin
**Purpose:** RSS/Atom/JSON feed aggregator with MongoDB caching and frontend display

This plugin aggregates multiple RSS/Atom/JSON feeds, caches them in MongoDB, and provides both an admin dashboard and public JSON API. It supports background sync with configurable intervals, feed management (add/remove/enable/disable), and automatic cleanup of old items.

## Architecture

### Data Flow

```
Background Sync Timer (every N minutes)
    ↓
sync.js (runSync) → Fetch enabled feeds from MongoDB
    ↓
RssClient.fetchFeed() → Parse RSS/Atom/JSON (supports FreshRSS Google Reader API)
    ↓
Transform items → Normalize to common schema
    ↓
Upsert to rssItems collection (dedup by feedId + guid)
    ↓
Update feed metadata (lastFetchedAt, itemCount, errors)
    ↓
Prune old items (older than retentionDays)
```

### Route Architecture

**Protected Routes** (require authentication, mounted at `/rssapi`):
- `GET /` - Admin dashboard (view feeds, recent items, sync status)
- `POST /sync` - Manual sync trigger (POST + redirect pattern)
- `POST /clear-resync` - Clear all items and re-sync
- `POST /api/feeds` - Add a new feed
- `DELETE /api/feeds/:id` - Remove a feed
- `PATCH /api/feeds/:id` - Toggle feed enabled/disabled
- `POST /api/refresh` - Manual refresh trigger

**Public Routes** (no auth, mounted at `/rssapi`):
- `GET /api/feeds` - List all feeds (read-only JSON)
- `GET /api/items` - Paginated feed items (query: page, limit, feedId, includeContent)
- `GET /api/items/:id` - Get single item by ID
- `GET /api/status` - Sync status and stats

## Key Files

### index.js
- Main plugin class `RssEndpoint`
- Registers two routers: `routes` (protected) and `routesPublic` (public)
- Default mount path: `/rssapi`
- Adds MongoDB collections: `rssFeeds`, `rssItems`
- Stores config in `application.rssConfig` for controller access
- Starts background sync via `startSync()`

### lib/sync.js
Core background sync logic:
- `startSync()` - Initializes recurring sync with interval (default: 15 minutes)
- `runSync()` - Single sync cycle (fetch all enabled feeds, upsert items, prune old data)
- `syncFeed()` - Sync a single feed (fetch, parse, upsert items, update metadata)
- `createIndexes()` - Ensure MongoDB indexes on feeds and items
- `pruneOldItems()` - Delete items older than `retentionDays` (default: 30)
- `processFeedsWithLimit()` - Concurrency-limited feed processing (default: 3 concurrent)

**Sync State:**
- Global `syncState` object tracks: `syncing`, `lastSync`, `lastError`, `feedsProcessed`, `itemsAdded`
- `getSyncState()` returns a snapshot for controllers

### lib/rss-client.js
RSS/Atom/JSON feed parser using `rss-parser`:
- `fetchFeed(url)` - Fetch and parse any feed format
- **Format Detection:**
  - JSON Feed spec (https://jsonfeed.org/)
  - Google Reader API format (FreshRSS, NewsBlur, etc.)
  - RSS 2.0 / Atom (via rss-parser)
- **Normalization:**
  - Extracts: guid, title, link, description, content, author, pubDate, imageUrl, categories, enclosure
  - For FreshRSS: Preserves `origin` object (real source feed) and denormalizes `sourceTitle`/`sourceUrl`
  - Filters out internal FreshRSS categories (state/com.google/*, user/*)
- **Image Extraction:** Supports media:content, enclosures, HTML img tags
- **Date Parsing:** Handles Unix timestamps (FreshRSS `published`), microseconds (`timestampUsec`), ISO strings

### lib/utils.js
Formatting and sanitization utilities:
- `formatItem()` - Convert MongoDB item to API response (strips HTML, truncates description)
- `formatFeed()` - Convert MongoDB feed to API response
- `sanitizeHtml()` - Strip dangerous tags, keep basic formatting (p, a, strong, etc.)
- `stripHtml()` - Remove all HTML tags
- `truncateText()` - Truncate to N chars with ellipsis
- `toISO()` - Convert Date objects to ISO strings (handles old MongoDB data)
- `isValidUrl()` / `normalizeUrl()` - URL validation and normalization

### lib/controllers/
**dashboard.js:**
- `get()` - Render admin dashboard with feeds, recent items, sync state
- `sync()` - Trigger manual sync (POST + redirect with flash messages)
- `clearResync()` - Clear all items, re-sync all feeds

**feeds.js:**
- `list()` - Get all feeds (public)
- `add()` - Add feed (validates URL, fetches metadata, inserts)
- `remove()` - Delete feed and its items
- `toggle()` - Enable/disable feed

**items.js:**
- `list()` - Paginated items (query: page, limit, feedId, includeContent)
- `get()` - Single item by ID

**status.js:**
- `status()` - Sync status, stats (feedsCount, itemsCount, lastSync, nextSync)
- `refresh()` - Trigger manual sync (async, returns immediately)

### locales/en.json
I18n strings for UI (title, labels, errors, success messages)

### views/
Nunjucks templates for admin dashboard (not public-facing)

## MongoDB Schema

### Collection: rssFeeds
```javascript
{
  _id: ObjectId,
  url: String (unique),          // Feed URL
  title: String,                 // Feed title
  siteUrl: String,               // Site home page URL
  description: String,           // Feed description
  imageUrl: String,              // Feed icon/image
  enabled: Boolean,              // Active/paused
  addedAt: Date,                 // When feed was added
  lastFetchedAt: Date,           // Last sync time
  lastError: String,             // Last fetch error (if any)
  itemCount: Number              // Number of cached items
}
```

**Indexes:**
- `url: 1` (unique)
- `enabled: 1`

### Collection: rssItems
```javascript
{
  _id: ObjectId,
  feedId: ObjectId,              // Reference to rssFeeds._id
  feedTitle: String,             // Denormalized feed title
  guid: String,                  // Item unique ID from feed
  title: String,                 // Item title
  link: String,                  // Item URL
  description: String,           // Summary/snippet
  content: String,               // Full HTML content
  author: String,                // Author name
  pubDate: Date,                 // Publication date
  imageUrl: String,              // Featured image URL
  categories: [String],          // Tags/categories
  enclosure: {                   // Podcast/media attachment
    url: String,
    type: String,
    length: Number
  },
  fetchedAt: Date,               // When item was fetched

  // FreshRSS-specific metadata
  origin: {                      // Real source feed (for aggregators)
    streamId: String,
    title: String,
    htmlUrl: String,
    feedUrl: String
  },
  sourceTitle: String,           // Denormalized origin.title
  sourceUrl: String              // Denormalized origin.htmlUrl
}
```

**Indexes:**
- `feedId: 1, guid: 1` (unique)
- `feedId: 1`
- `pubDate: -1`
- `fetchedAt: -1`

## Configuration

### Constructor Options (indiekit.config.js)
```javascript
new RssEndpoint({
  mountPath: "/rssapi",          // Endpoint path (default: /rssapi)
  syncInterval: 900_000,         // Sync interval in ms (default: 15 min)
  maxItemsPerFeed: 50,           // Max items per feed to cache (default: 50)
  fetchTimeout: 10_000,          // Feed fetch timeout in ms (default: 10s)
  maxConcurrentFetches: 3,       // Concurrent feed fetches (default: 3)
  retentionDays: 30              // Days to keep items (default: 30)
})
```

### Environment Requirements
- MongoDB database URL must be configured in Indiekit
- No environment variables required by this plugin

### Feed Management
Feeds are managed via admin UI or JSON API:
1. Add feed via `POST /rssapi/api/feeds` with `{ url: "https://..." }`
2. Plugin validates URL, fetches metadata, stores in DB
3. Background sync fetches new items every `syncInterval` ms
4. Old items are pruned after `retentionDays` days

## Inter-Plugin Relationships

### Dependencies
- **@indiekit/indiekit** - Core plugin API
- **@indiekit/error** - IndiekitError for error handling
- **express** - Routing
- **rss-parser** - RSS/Atom parsing
- **sanitize-html** - HTML sanitization

### Integration Points
- **Navigation:** Adds item to Indiekit sidebar (`navigationItems`)
- **Shortcuts:** Adds shortcut to dashboard (`shortcutItems`)
- **Database:** Requires MongoDB via `Indiekit.database`
- **Locales:** Registers `locales/en.json` for i18n

### Usage with Other Plugins
- **Homepage Builder:** RSS items can be displayed as widgets/sections (not yet implemented in this plugin, but possible)
- **Frontend Theme:** Public JSON API (`/rssapi/api/items`) can be consumed by Eleventy templates

## Known Gotchas

### Date Handling
**CRITICAL:** Dates MUST be stored as ISO strings (`new Date().toISOString()`), NOT Date objects. This plugin stores dates correctly:
- `addedAt: new Date()` in feeds.js line 88 should be `new Date().toISOString()`
- `lastFetchedAt: new Date().toISOString()` (correct)
- `fetchedAt: new Date().toISOString()` (correct)

**BUG FIX NEEDED:** `feeds.js:88` stores `addedAt: new Date()` (Date object). Should be `.toISOString()`.

The `utils.js` `toISO()` helper exists to handle old data but new data should use ISO strings from the start.

### FreshRSS Integration
When fetching from FreshRSS (Google Reader API format):
- Use `?f=json` or `?f=greader` in feed URL
- Plugin preserves `origin` object (real source feed) and denormalizes `sourceTitle`/`sourceUrl`
- Internal FreshRSS categories are filtered out
- Author field prefers actual author, NOT origin title (to avoid "Feed Title" as author)

### Sync State Management
- `syncState` is a global singleton (NOT per-instance)
- Multiple sync requests are blocked if `syncing: true`
- Flash messages use Indiekit's native notification banner (consumeFlashMessage helper)

### Duplicate Handling
- Items are upserted with `{ feedId, guid }` unique index
- Duplicate key errors (code 11000) are silently ignored
- If GUID is missing, plugin generates one from `feedUrl#timestamp`

### Pagination
- Default page size: 20 items
- Max page size: 100 items
- Page numbers start at 1 (not 0)

### Content Sanitization
- `formatItem()` sanitizes HTML by default
- Use `includeContent: true` query param to get full content
- Descriptions are auto-truncated to 200 chars (configurable)

## API Endpoints Summary

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | Admin dashboard |
| POST | `/sync` | Yes | Manual sync trigger |
| POST | `/clear-resync` | Yes | Clear items and re-sync |
| POST | `/api/feeds` | Yes | Add feed |
| DELETE | `/api/feeds/:id` | Yes | Remove feed |
| PATCH | `/api/feeds/:id` | Yes | Toggle enabled |
| POST | `/api/refresh` | Yes | Manual refresh |
| GET | `/api/feeds` | No | List feeds (JSON) |
| GET | `/api/items` | No | List items (JSON, paginated) |
| GET | `/api/items/:id` | No | Get item (JSON) |
| GET | `/api/status` | No | Sync status (JSON) |

## Dependencies

```json
{
  "@indiekit/error": "^1.0.0-beta.25",
  "express": "^5.0.0",
  "rss-parser": "^3.13.0",
  "sanitize-html": "^2.13.0"
}
```

## Development Notes

### Testing
No automated tests. Manual testing against real feeds:
- RSS 2.0: Standard blog feeds
- Atom: GitHub releases, etc.
- JSON Feed: jsonfeed.org examples
- FreshRSS: Google Reader API format

### Error Handling
- Feed fetch errors are logged but don't crash sync
- Failed feeds have `lastError` stored in DB
- Sync continues even if some feeds fail
- HTTP errors use `IndiekitError.fromFetch()`

### Performance Considerations
- Background sync runs every 15 minutes by default
- Concurrency limited to 3 feeds at a time
- Items older than 30 days are auto-pruned
- Indexes on feedId, guid, pubDate for fast queries

### Future Enhancements
- Homepage widget integration
- Category filtering
- Full-text search
- Export to OPML
- Favorite/bookmark items
- Read/unread status
