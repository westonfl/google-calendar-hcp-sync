import Database from "better-sqlite3";

let db;

export function getDb() {
  if (!db) {
    db = new Database("./data.sqlite");
    db.pragma("journal_mode = WAL");

    db.exec(`
      CREATE TABLE IF NOT EXISTS google_tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        refresh_token TEXT
      );

      CREATE TABLE IF NOT EXISTS google_watch (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        channel_id TEXT,
        resource_id TEXT,
        expiration TEXT,
        next_sync_token TEXT
      );

      CREATE TABLE IF NOT EXISTS mappings (
        google_event_id TEXT PRIMARY KEY,
        hcp_job_id TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hcp_cache (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }
  return db;
}

export function saveRefreshToken(refreshToken) {
  const db = getDb();
  db.prepare(
    `INSERT INTO google_tokens (id, refresh_token)
     VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET refresh_token=excluded.refresh_token`
  ).run(refreshToken);
}

export function getRefreshToken() {
  const db = getDb();
  const row = db
    .prepare(`SELECT refresh_token FROM google_tokens WHERE id=1`)
    .get();
  return row?.refresh_token || null;
}

export function saveWatchState({
  channel_id,
  resource_id,
  expiration,
  next_sync_token,
}) {
  const db = getDb();
  db.prepare(
    `INSERT INTO google_watch (id, channel_id, resource_id, expiration, next_sync_token)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       channel_id=excluded.channel_id,
       resource_id=excluded.resource_id,
       expiration=excluded.expiration,
       next_sync_token=excluded.next_sync_token`
  ).run(channel_id, resource_id, expiration, next_sync_token);
}

export function getWatchState() {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT channel_id, resource_id, expiration, next_sync_token FROM google_watch WHERE id=1`
    )
    .get();
  return row || {};
}

export function saveNextSyncToken(token) {
  const db = getDb();
  db.prepare(`UPDATE google_watch SET next_sync_token=? WHERE id=1`).run(token);
}

export function putMapping(googleId, hcpId) {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO mappings (google_event_id, hcp_job_id) VALUES (?, ?)`
  ).run(googleId, hcpId);
}

export function getMapping(googleId) {
  const db = getDb();
  const row = db
    .prepare(`SELECT hcp_job_id FROM mappings WHERE google_event_id=?`)
    .get(googleId);
  return row?.hcp_job_id || null;
}

export function deleteMapping(googleId) {
  const db = getDb();
  db.prepare(`DELETE FROM mappings WHERE google_event_id=?`).run(googleId);
}

export function cacheSet(key, value) {
  const db = getDb();
  db.prepare(
    `INSERT INTO hcp_cache (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(key, value);
}

export function cacheGet(key) {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM hcp_cache WHERE key=?`).get(key);
  return row?.value || null;
}
