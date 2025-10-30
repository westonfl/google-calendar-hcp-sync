import initSqlJs from "sql.js";
import fs from "fs";

let db;
let SQL;

export async function getDb() {
  if (!db) {
    if (!SQL) {
      SQL = await initSqlJs();
    }

    const dbPath = "./data.sqlite";
    let data;

    try {
      data = fs.readFileSync(dbPath);
    } catch (e) {
      // Database doesn't exist yet, create it
      data = undefined;
    }

    db = new SQL.Database(data);

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

function saveDb() {
  if (db) {
    const data = db.export();
    fs.writeFileSync("./data.sqlite", data);
  }
}

export async function saveRefreshToken(refreshToken) {
  const db = await getDb();
  db.run(
    `INSERT INTO google_tokens (id, refresh_token)
     VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET refresh_token=excluded.refresh_token`,
    [refreshToken]
  );
  saveDb();
}

export async function getRefreshToken() {
  const db = await getDb();
  const result = db.exec(`SELECT refresh_token FROM google_tokens WHERE id=1`);
  return result[0]?.values[0]?.[0] || null;
}

export async function saveWatchState({
  channel_id,
  resource_id,
  expiration,
  next_sync_token,
}) {
  const db = await getDb();
  db.run(
    `INSERT INTO google_watch (id, channel_id, resource_id, expiration, next_sync_token)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       channel_id=excluded.channel_id,
       resource_id=excluded.resource_id,
       expiration=excluded.expiration,
       next_sync_token=excluded.next_sync_token`,
    [channel_id, resource_id, expiration, next_sync_token]
  );
  saveDb();
}

export async function getWatchState() {
  const db = await getDb();
  const result = db.exec(
    `SELECT channel_id, resource_id, expiration, next_sync_token FROM google_watch WHERE id=1`
  );
  if (result[0]?.values[0]) {
    const [channel_id, resource_id, expiration, next_sync_token] =
      result[0].values[0];
    return { channel_id, resource_id, expiration, next_sync_token };
  }
  return {};
}

export async function saveNextSyncToken(token) {
  const db = await getDb();
  db.run(`UPDATE google_watch SET next_sync_token=? WHERE id=1`, [token]);
  saveDb();
}

export async function putMapping(googleId, hcpId) {
  const db = await getDb();
  db.run(
    `INSERT OR REPLACE INTO mappings (google_event_id, hcp_job_id) VALUES (?, ?)`,
    [googleId, hcpId]
  );
  saveDb();
}

export async function getMapping(googleId) {
  const db = await getDb();
  const result = db.exec(
    `SELECT hcp_job_id FROM mappings WHERE google_event_id=?`,
    [googleId]
  );
  return result[0]?.values[0]?.[0] || null;
}

export async function deleteMapping(googleId) {
  const db = await getDb();
  db.run(`DELETE FROM mappings WHERE google_event_id=?`, [googleId]);
  saveDb();
}

export async function cacheSet(key, value) {
  const db = await getDb();
  db.run(
    `INSERT INTO hcp_cache (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    [key, value]
  );
  saveDb();
}

export async function cacheGet(key) {
  const db = await getDb();
  const result = db.exec(`SELECT value FROM hcp_cache WHERE key=?`, [key]);
  return result[0]?.values[0]?.[0] || null;
}

// Utility to clear the stored Google refresh token
export async function clearRefreshToken() {
  const db = await getDb();
  db.run(`DELETE FROM google_tokens WHERE id=1`);
  saveDb();
}
