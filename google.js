import { google } from "googleapis";
import crypto from "crypto";
import axios from "axios";
import {
  getRefreshToken,
  saveRefreshToken,
  getWatchState,
  saveWatchState,
  saveNextSyncToken,
} from "./storage.js";

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  GOOGLE_CALENDAR_ID,
  BASE_URL,
} = process.env;

function oauth2Client() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

export function getAuthUrl() {
  const oAuth2 = oauth2Client();
  const scopes = ["https://www.googleapis.com/auth/calendar.readonly"];
  return oAuth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
  });
}

export async function exchangeCodeForTokens(code) {
  const oAuth2 = oauth2Client();
  const { tokens } = await oAuth2.getToken(code);
  if (tokens.refresh_token) {
    await saveRefreshToken(tokens.refresh_token);
  }
  return tokens;
}

async function clientWithRefresh() {
  const refresh = await getRefreshToken();
  if (!refresh)
    throw new Error("No Google refresh token stored. Authorize first.");
  const oAuth2 = oauth2Client();
  oAuth2.setCredentials({ refresh_token: refresh });
  return oAuth2;
}

export async function ensureWatchChannel() {
  // 1) Get a nextSyncToken to start from a clean state
  const auth = await clientWithRefresh();
  const calendar = google.calendar({ version: "v3", auth });

  // Seed a nextSyncToken if missing
  let { next_sync_token } = await getWatchState();
  if (!next_sync_token) {
    const seed = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      singleEvents: true,
      showDeleted: true,
      maxResults: 1,
    });
    if (seed.data.nextSyncToken) {
      next_sync_token = seed.data.nextSyncToken;
      await saveWatchState({
        channel_id: "",
        resource_id: "",
        expiration: "",
        next_sync_token,
      });
    }
  }

  // 2) Create a watch channel
  const channelId = crypto.randomUUID();
  const address = `${BASE_URL}/webhook/google`;

  const watch = await calendar.events.watch({
    calendarId: GOOGLE_CALENDAR_ID,
    requestBody: {
      id: channelId,
      type: "web_hook",
      address,
    },
  });

  const resourceId = watch.data?.resourceId || "";
  const expiration = watch.data?.expiration || "";

  await saveWatchState({
    channel_id: channelId,
    resource_id: resourceId,
    expiration,
    next_sync_token,
  });

  return { channelId, resourceId, expiration };
}

// Called when Google notifies us. We then pull changes using nextSyncToken.
export async function pullChanges(handler) {
  const auth = await clientWithRefresh();
  const calendar = google.calendar({ version: "v3", auth });

  const state = await getWatchState();
  if (!state?.next_sync_token) {
    // As a fallback, reseed a token
    const seed = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      singleEvents: true,
      showDeleted: true,
      maxResults: 1,
    });
    if (seed.data.nextSyncToken) {
      await saveNextSyncToken(seed.data.nextSyncToken);
      return;
    }
  }

  let pageToken = undefined;
  let newNextSync = null;

  do {
    const res = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      singleEvents: true,
      showDeleted: true,
      syncToken: state.next_sync_token,
      pageToken,
    });

    // Process changes
    const events = res.data.items || [];
    for (const ev of events) {
      await handler(ev);
    }

    pageToken = res.data.nextPageToken || null;
    newNextSync = res.data.nextSyncToken || newNextSync;
  } while (pageToken);

  if (newNextSync) {
    await saveNextSyncToken(newNextSync);
  }
}
