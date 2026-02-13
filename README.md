# @rmdes/indiekit-endpoint-rss

RSS feed reader endpoint for Indiekit. Aggregates multiple feeds, caches in MongoDB, displays on frontend.

## Features

- **Multi-Feed Aggregation** - Subscribe to unlimited RSS/Atom/JSON feeds
- **Background Sync** - Automatic updates every 15 minutes (configurable)
- **MongoDB Caching** - Fast access to cached feed items
- **Admin Dashboard** - Add/remove feeds, view recent items, trigger manual sync
- **Public JSON API** - Read-only endpoints for frontend display
- **Feed Management** - Enable/disable feeds, view sync status and errors
- **Automatic Cleanup** - Prunes items older than 30 days (configurable)
- **Format Support** - RSS 2.0, Atom, JSON Feed, Google Reader API (FreshRSS)
- **Concurrency Control** - Fetches 3 feeds in parallel to avoid overwhelming servers
- **HTML Sanitization** - Strips dangerous tags, keeps basic formatting

## Installation

```bash
npm install @rmdes/indiekit-endpoint-rss
```

## Configuration

Add to your `indiekit.config.js`:

```javascript
import RssEndpoint from "@rmdes/indiekit-endpoint-rss";

export default {
  plugins: [
    new RssEndpoint({
      mountPath: "/rssapi",          // Default: /rssapi
      syncInterval: 900_000,         // 15 minutes (in milliseconds)
      maxItemsPerFeed: 50,           // Max items per feed to cache
      fetchTimeout: 10_000,          // 10 second timeout per feed
      maxConcurrentFetches: 3,       // Parallel feed fetches
      retentionDays: 30              // Days to keep items
    })
  ],
  // MongoDB database is REQUIRED
  mongodbUrl: process.env.MONGODB_URL
};
```

## Usage

### Admin Dashboard

Navigate to `/rssapi` (or your configured `mountPath`) to access the admin dashboard.

**Features:**
- View all subscribed feeds
- Add new feeds by URL
- Enable/disable feeds
- Remove feeds
- View recent items
- Manual sync trigger
- Clear cache and re-sync

### Adding Feeds

**Via Admin UI:**
1. Go to `/rssapi`
2. Enter feed URL in the "Add Feed" form
3. Click "Add Feed"

**Via API:**
```bash
curl -X POST https://yoursite.com/rssapi/api/feeds \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"url": "https://example.com/feed.xml"}'
```

### Public API Endpoints

**List All Feeds:**
```bash
GET /rssapi/api/feeds
```

**List Feed Items (Paginated):**
```bash
GET /rssapi/api/items?page=1&limit=20&feedId=FEED_ID&includeContent=true
```

**Get Single Item:**
```bash
GET /rssapi/api/items/:id
```

**Sync Status:**
```bash
GET /rssapi/api/status
```

### Example: Display Items in Eleventy

```javascript
// _data/rssItems.js
export default async function () {
  const response = await fetch("https://yoursite.com/rssapi/api/items?limit=10");
  const data = await response.json();
  return data.items;
}
```

```nunjucks
<!-- index.njk -->
<h2>Latest News</h2>
{% for item in rssItems %}
  <article>
    <h3><a href="{{ item.link }}">{{ item.title }}</a></h3>
    <p class="meta">{{ item.feedTitle }} - {{ item.pubDate | date("PPp") }}</p>
    <p>{{ item.description }}</p>
    {% if item.imageUrl %}
      <img src="{{ item.imageUrl }}" alt="">
    {% endif %}
  </article>
{% endfor %}
```

## Supported Feed Formats

- **RSS 2.0** - Standard blog feeds
- **Atom** - GitHub releases, podcasts, etc.
- **JSON Feed** - jsonfeed.org spec (v1.0, v1.1)
- **Google Reader API** - FreshRSS, NewsBlur, Miniflux (use `?f=json` or `?f=greader`)

## FreshRSS Integration

This plugin has special support for FreshRSS (and other Google Reader API compatible aggregators):

1. Get your FreshRSS API feed URL (Settings → Authentication → API feed URL)
2. Add `?f=json` or `?f=greader` to the URL
3. Add the URL to Indiekit RSS endpoint

**Example:**
```
https://freshrss.example.com/api/greader.php/reader/api/0/stream/contents/reading-list?f=json&n=50&user=admin&apiKey=YOUR_API_KEY
```

**Features:**
- Preserves original feed source (via `origin` object)
- Filters out internal FreshRSS categories
- Extracts images from media content
- Handles FreshRSS timestamps (Unix seconds, microseconds)

## API Reference

### GET /api/feeds

List all feeds.

**Response:**
```json
{
  "feeds": [
    {
      "id": "507f1f77bcf86cd799439011",
      "url": "https://example.com/feed.xml",
      "title": "Example Blog",
      "siteUrl": "https://example.com",
      "description": "A blog about things",
      "imageUrl": "https://example.com/icon.png",
      "enabled": true,
      "addedAt": "2025-02-01T12:00:00.000Z",
      "lastFetchedAt": "2025-02-13T14:30:00.000Z",
      "lastError": null,
      "itemCount": 42
    }
  ],
  "total": 1
}
```

### GET /api/items

List feed items with pagination.

**Query Parameters:**
- `page` (number, default: 1) - Page number
- `limit` (number, default: 20, max: 100) - Items per page
- `feedId` (string, optional) - Filter by feed ID
- `includeContent` (boolean, default: false) - Include full HTML content

**Response:**
```json
{
  "items": [
    {
      "id": "507f1f77bcf86cd799439012",
      "feedId": "507f1f77bcf86cd799439011",
      "feedTitle": "Example Blog",
      "guid": "https://example.com/post-1",
      "title": "Hello World",
      "link": "https://example.com/post-1",
      "description": "A short summary...",
      "author": "John Doe",
      "pubDate": "2025-02-13T12:00:00.000Z",
      "imageUrl": "https://example.com/image.jpg",
      "categories": ["tech", "web"],
      "fetchedAt": "2025-02-13T14:30:00.000Z",
      "sourceTitle": "Original Feed Title",
      "sourceUrl": "https://original-source.com"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5,
    "hasNext": true,
    "hasPrev": false
  }
}
```

### GET /api/items/:id

Get a single item by ID.

**Response:**
```json
{
  "item": {
    "id": "507f1f77bcf86cd799439012",
    "feedId": "507f1f77bcf86cd799439011",
    "feedTitle": "Example Blog",
    "title": "Hello World",
    "link": "https://example.com/post-1",
    "description": "A short summary...",
    "content": "<p>Full sanitized HTML content...</p>",
    "author": "John Doe",
    "pubDate": "2025-02-13T12:00:00.000Z",
    "imageUrl": "https://example.com/image.jpg",
    "categories": ["tech", "web"],
    "enclosure": {
      "url": "https://example.com/podcast.mp3",
      "type": "audio/mpeg",
      "length": 12345678
    },
    "fetchedAt": "2025-02-13T14:30:00.000Z"
  }
}
```

### GET /api/status

Get sync status and statistics.

**Response:**
```json
{
  "status": "idle",
  "lastSync": "2025-02-13T14:30:00.000Z",
  "nextSync": "2025-02-13T14:45:00.000Z",
  "lastError": null,
  "stats": {
    "feedsCount": 5,
    "enabledFeedsCount": 4,
    "itemsCount": 200,
    "lastFeedsProcessed": 4,
    "lastItemsAdded": 12
  },
  "config": {
    "syncInterval": 900000,
    "maxItemsPerFeed": 50
  }
}
```

## Requirements

- **Indiekit** >= 1.0.0-beta.25
- **MongoDB** database
- **Node.js** >= 20

## License

MIT

## Author

Ricardo Mendes - https://rmendes.net

## Repository

https://github.com/rmdes/indiekit-endpoint-rss
