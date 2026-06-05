# fa-jellyfin-sync

Small Node.js service that synchronizes FilmAffinity ratings into Jellyfin and can also apply the rating as a badge on the Jellyfin poster image.

The container starts two processes with `npm start`:

- `scripts/scheduler.js`: runs the automatic Jellyfin sync once per interval.
- `scripts/manual-web.js`: serves a small manual web UI for pasting a FilmAffinity URL and applying a badge to a selected Jellyfin item.

## What It Does

The automatic sync:

1. Connects to Jellyfin.
2. Gets the latest Jellyfin movies/series, usually through `/Users/{userId}/Items/Latest`.
3. Skips items that are already marked as processed by FilmAffinity.
4. Resolves FilmAffinity ratings through the `filmaffinity-scores-api` service.
5. Writes the FilmAffinity rating to `CommunityRating`.
6. Adds a configurable marker tag, by default `FilmAffinity`.
7. Optionally overlays a rating badge on the primary poster image.

The marker tag is important: Jellyfin may already have `CommunityRating` values from other metadata providers. The sync does not treat those generic ratings as FilmAffinity ratings. It only skips an item when the marker tag is present.

## Current Default Workflow

The intended production configuration is:

- Run once per day.
- Read the latest 50 movies/series from Jellyfin.
- Process only items that do not have the `FilmAffinity` marker tag.
- Add the rating, poster badge, and marker tag after a successful update.

This avoids repeatedly touching already processed posters while still allowing new Jellyfin items with generic ratings from other scrapers to be processed.

## Docker Compose

In the home-server stack this service is built from `./fa-jellyfin-sync` and exposed on port `8097` for the manual web UI:

```yaml
fa-jellyfin-sync:
  build:
    context: ./fa-jellyfin-sync
  container_name: fa-jellyfin-sync
  env_file:
    - ./fa-jellyfin-sync/.env
  depends_on:
    - jellyfin
    - filmaffinity-scores-api
  ports:
    - "${MANUAL_WEB_PORT:-8097}:8097"
  restart: unless-stopped
  networks:
    - media_net
```

## Environment Variables

### Required

| Variable | Description |
| --- | --- |
| `JELLYFIN_BASE_URL` | Jellyfin base URL from inside Docker, for example `http://jellyfin:8096`. |
| `JELLYFIN_API_KEY` | Jellyfin API key. |
| `FILMAFFINITY_API_BASE_URL` | FilmAffinity ratings API base URL, for example `http://filmaffinity-scores-api:8085`. |

### Automatic Sync

| Variable | Default | Description |
| --- | --- | --- |
| `SLEEP_SECONDS` | `86400` | Scheduler interval in seconds. `86400` means once per day. |
| `SYNC_JELLYFIN_LIMIT` | `0` | Max number of items to fetch/process. Use `50` for the latest 50 items. |
| `SYNC_JELLYFIN_PAGE_SIZE` | `100` | Page size when using the regular `/Items` endpoint. |
| `SYNC_JELLYFIN_USE_LATEST` | `false` | When `true`, uses `/Users/{userId}/Items/Latest` instead of sorting `/Items`. Recommended for latest-added sync. |
| `SYNC_JELLYFIN_SORT_BY` | `SortName` | Sort field for the regular `/Items` endpoint. Kept for full-library mode. |
| `SYNC_JELLYFIN_SORT_ORDER` | `Ascending` | Sort order for the regular `/Items` endpoint. |
| `SYNC_JELLYFIN_INCLUDE_ITEM_TYPES` | `Movie,Series` | Jellyfin item types to include. |
| `SYNC_JELLYFIN_SKIP_EXISTING_RATINGS` | `false` | When `true`, skips items that already contain the marker tag. |
| `SYNC_JELLYFIN_MARKER_TAG` | `FilmAffinity` | Tag used to mark items already processed by this sync. |
| `SYNC_JELLYFIN_BATCH_SIZE` | `5` | Number of items sent to the FilmAffinity API per batch. |
| `SYNC_JELLYFIN_DELAY_MS` | `1000` | Delay between poster updates. |
| `SYNC_JELLYFIN_RETRIES` | `3` | Generic Jellyfin retry count. |
| `SYNC_JELLYFIN_RETRY_DELAY` | `1000` | Base retry delay in milliseconds. |
| `SYNC_JELLYFIN_RATING_BATCH_RETRIES` | `min(retries, 2)` | Batch rating API retry count. |
| `SYNC_JELLYFIN_RATING_SINGLE_RETRIES` | `min(retries, 2)` | Single-item fallback rating retry count. |
| `SYNC_JELLYFIN_POSTER_RETRIES` | `min(retries, 2)` | Poster download/upload retry count. |
| `SYNC_JELLYFIN_DRY_RUN` | `false` | Logs actions without writing metadata or posters. |
| `SYNC_JELLYFIN_FORCE` | `false` | Forces metadata/poster update even when values appear unchanged. |
| `SYNC_JELLYFIN_SET_CRITIC` | `false` | Also writes `CriticRating` as FilmAffinity rating x 10. |
| `JELLYFIN_USER_ID` | empty | Optional Jellyfin user id. If omitted, the service picks an admin user or the first user. |

Recommended daily latest-items configuration:

```env
SYNC_JELLYFIN_LIMIT=50
SYNC_JELLYFIN_PAGE_SIZE=50
SYNC_JELLYFIN_USE_LATEST=true
SYNC_JELLYFIN_SKIP_EXISTING_RATINGS=true
SYNC_JELLYFIN_MARKER_TAG=FilmAffinity
SYNC_JELLYFIN_INCLUDE_ITEM_TYPES=Movie,Series
SLEEP_SECONDS=86400
```

### Poster Badge

| Variable | Default | Description |
| --- | --- | --- |
| `ENABLE_POSTER_BADGES` | `true` | Enables poster badge generation during automatic sync. |
| `POSTER_BADGE_POSITION` | `top-left` | Badge position: `top-left`, `top-right`, `bottom-left`, `bottom-right`. |
| `POSTER_BADGE_SIZE` | `0.3` | Badge size factor relative to poster width. |

### Manual Web UI

| Variable | Default | Description |
| --- | --- | --- |
| `MANUAL_WEB_HOST` | `0.0.0.0` | Host used by the manual web server. |
| `MANUAL_WEB_PORT` | `8097` | Port used by the manual web server. |
| `MANUAL_WEB_INCLUDE_ITEM_TYPES` | same as sync | Item types shown in manual Jellyfin search. |
| `MANUAL_WEB_REFRESH_WAIT_MS` | `6000` | Wait after requesting Jellyfin poster refresh before applying a badge. |
| `FILMAFFINITY_TIMEOUT_MS` | `15000` | Timeout for fetching a FilmAffinity page manually. |
| `FILMAFFINITY_USER_AGENT` | browser-like UA | Optional custom user-agent for FilmAffinity page fetches. |

The manual UI is available at:

```text
http://<host>:8097
```

Manual badge application also writes `CommunityRating` and adds the marker tag, so the automatic sync will not process that item again.

## Commands

Install dependencies:

```bash
npm ci
```

Run the combined service locally:

```bash
npm start
```

Run only the automatic scheduler:

```bash
npm run scheduler
```

Run one sync cycle directly:

```bash
npm run sync
```

Run only the manual web UI:

```bash
npm run manual-web
```

When running locally outside Docker, override `JELLYFIN_BASE_URL` if the Docker hostname is not resolvable:

```bash
JELLYFIN_BASE_URL=http://127.0.0.1:8096 npm run manual-web
```

## MCP / One-Off Runs

A remote MCP script can trigger a one-off run with Docker Compose. The sync reads the same `.env` configuration, so make sure the one-off container joins the Compose network and sees:

- `JELLYFIN_BASE_URL=http://jellyfin:8096`
- `FILMAFFINITY_API_BASE_URL=http://filmaffinity-scores-api:8085`
- `SYNC_JELLYFIN_USE_LATEST=true`
- `SYNC_JELLYFIN_SKIP_EXISTING_RATINGS=true`

Example:

```bash
docker compose run --rm fa-jellyfin-sync npm run sync
```

## Notes

- The sync intentionally uses a marker tag instead of checking `CommunityRating` alone, because Jellyfin ratings can come from providers other than FilmAffinity.
- `/Users/{userId}/Items/Latest` is preferred for latest-added workflows. Sorting `/Items` by `DateCreated` does not always match Jellyfin's latest-added list.
- Poster badge updates overwrite the primary poster image in Jellyfin. Use manual mode carefully when experimenting.
