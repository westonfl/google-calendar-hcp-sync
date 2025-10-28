import sqlite3 from "sqlite3";
import { open } from "sqlite";

let dbPromise;

export async function getDb() {
  if (!dbPromise) {
    dbPromise = open({
      filename: "./data.sqlite",
      driver: sqlite3.Database,
    });
    const db = await dbPromise;
    await db.exec(`
      PRAGMA journal_mode = WAL;

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
  return dbPromise;
}

export async function saveRefreshToken(refreshToken) {
  const db = await getDb();
  await db.run(
    `INSERT INTO google_tokens (id, refresh_token)
     VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET refresh_token=excluded.refresh_token`,
    [refreshToken]
  );
}

export async function getRefreshToken() {
  const db = await getDb();
  const row = await db.get(
    `SELECT refresh_token FROM google_tokens WHERE id=1`
  );
  return row?.refresh_token || null;
}

export async function saveWatchState({
  channel_id,
  resource_id,
  expiration,
  next_sync_token,
}) {
  const db = await getDb();
  await db.run(
    `INSERT INTO google_watch (id, channel_id, resource_id, expiration, next_sync_token)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       channel_id=excluded.channel_id,
       resource_id=excluded.resource_id,
       expiration=excluded.expiration,
       next_sync_token=excluded.next_sync_token`,
    [channel_id, resource_id, expiration, next_sync_token]
  );
}

export async function getWatchState() {
  const db = await getDb();
  const row = await db.get(
    `SELECT channel_id, resource_id, expiration, next_sync_token FROM google_watch WHERE id=1`
  );
  return row || {};
}

export async function saveNextSyncToken(token) {
  const db = await getDb();
  await db.run(`UPDATE google_watch SET next_sync_token=? WHERE id=1`, [token]);
}

export async function putMapping(googleId, hcpId) {
  const db = await getDb();
  await db.run(
    `INSERT OR REPLACE INTO mappings (google_event_id, hcp_job_id) VALUES (?, ?)`,
    [googleId, hcpId]
  );
}

export async function getMapping(googleId) {
  const db = await getDb();
  const row = await db.get(
    `SELECT hcp_job_id FROM mappings WHERE google_event_id=?`,
    [googleId]
  );
  return row?.hcp_job_id || null;
}

export async function deleteMapping(googleId) {
  const db = await getDb();
  await db.run(`DELETE FROM mappings WHERE google_event_id=?`, [googleId]);
}

export async function cacheSet(key, value) {
  const db = await getDb();
  await db.run(
    `INSERT INTO hcp_cache (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    [key, value]
  );
}

export async function cacheGet(key) {
  const db = await getDb();
  const row = await db.get(`SELECT value FROM hcp_cache WHERE key=?`, [key]);
  return row?.value || null;
}
