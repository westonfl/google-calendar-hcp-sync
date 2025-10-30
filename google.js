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
  GOOGLE_CALENDAR_ID = "primary", // Default to primary calendar
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
  try {
    console.log("exchangeCodeForTokens: requesting tokens");
    const { tokens } = await oAuth2.getToken(code);
    console.log("exchangeCodeForTokens: tokens received", {
      hasAccessToken: Boolean(tokens.access_token),
      hasRefreshToken: Boolean(tokens.refresh_token),
      expiry_date: tokens.expiry_date,
    });
    if (tokens.refresh_token) {
      await saveRefreshToken(tokens.refresh_token);
      console.log("exchangeCodeForTokens: refresh token saved");
    }
    return tokens;
  } catch (e) {
    // Surface the exact OAuth failure to the caller
    const details = {
      message: e?.message,
      code: e?.code,
      response: e?.response?.data,
    };
    throw Object.assign(
      new Error(details.message || "OAuth token exchange failed"),
      details
    );
  }
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
  console.log("ensureWatchChannel: current watch state", { next_sync_token });
  if (!next_sync_token) {
    try {
      const seed = await calendar.events.list({
        calendarId: GOOGLE_CALENDAR_ID,
        singleEvents: true,
        showDeleted: true,
        maxResults: 1,
      });
      if (seed.data.nextSyncToken) {
        next_sync_token = seed.data.nextSyncToken;
        console.log("ensureWatchChannel: seeded nextSyncToken");
        await saveWatchState({
          channel_id: "",
          resource_id: "",
          expiration: "",
          next_sync_token: next_sync_token ?? null,
        });
      }
    } catch (error) {
      const status = error?.response?.status;
      console.error(
        `Error accessing calendar ${GOOGLE_CALENDAR_ID}:`,
        status || error?.code || error?.message
      );
      if (status === 404 || error?.code === 404) {
        throw new Error(
          `Calendar '${GOOGLE_CALENDAR_ID}' not found. Please check your GOOGLE_CALENDAR_ID environment variable. Use 'primary' for your main calendar.`
        );
      }
      throw error;
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
  console.log("ensureWatchChannel: watch created", {
    channelId,
    resourceId,
    expiration,
    address,
  });

  await saveWatchState({
    channel_id: channelId,
    resource_id: resourceId,
    expiration,
    next_sync_token: next_sync_token ?? null,
  });
  console.log("ensureWatchChannel: watch state saved");

  return { channelId, resourceId, expiration };
}

// Called when Google notifies us. We then pull changes using nextSyncToken.
export async function pullChanges(handler) {
  const auth = await clientWithRefresh();
  const calendar = google.calendar({ version: "v3", auth });

  const state = await getWatchState();
  console.log("pullChanges: loaded state", state);
  if (!state?.next_sync_token) {
    // As a fallback, reseed a token
    try {
      const seed = await calendar.events.list({
        calendarId: GOOGLE_CALENDAR_ID,
        singleEvents: true,
        showDeleted: true,
        maxResults: 1,
      });
      if (seed.data.nextSyncToken) {
        await saveNextSyncToken(seed.data.nextSyncToken);
        console.log("pullChanges: reseeded nextSyncToken (no state)");
        return;
      }
    } catch (error) {
      const status = error?.response?.status;
      console.error(
        `Error accessing calendar ${GOOGLE_CALENDAR_ID}:`,
        status || error?.code || error?.message
      );
      if (status === 404 || error?.code === 404) {
        throw new Error(
          `Calendar '${GOOGLE_CALENDAR_ID}' not found. Please check your GOOGLE_CALENDAR_ID environment variable. Use 'primary' for your main calendar.`
        );
      }
      throw error;
    }
  }

  let pageToken = undefined;
  let newNextSync = null;

  do {
    let res;
    try {
      res = await calendar.events.list({
        calendarId: GOOGLE_CALENDAR_ID,
        singleEvents: true,
        showDeleted: true,
        syncToken: state.next_sync_token,
        pageToken,
      });
      console.log("pullChanges: page received", {
        items: (res.data.items || []).length,
        nextPageToken: res.data.nextPageToken,
        nextSyncToken: res.data.nextSyncToken ? "yes" : "no",
      });
    } catch (error) {
      // If the calendar or token became invalid (404), reseed a fresh nextSyncToken and exit
      const status = error?.response?.status;
      if (status === 404 || error?.code === 404) {
        try {
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
        } catch (seedErr) {
          console.error(
            "Reseed after 404 failed:",
            seedErr?.message || seedErr
          );
        }
      }
      console.error("pullChanges: events.list failed", {
        message: error?.message,
        code: error?.code,
        status: error?.response?.status,
        data: error?.response?.data,
      });
      throw error;
    }

    // Process changes
    const events = res.data.items || [];
    for (const ev of events) {
      try {
        await handler(ev);
      } catch (e) {
        console.error("handleCalendarEvent error", {
          eventId: ev?.id,
          message: e?.message,
          code: e?.code,
          status: e?.response?.status,
          data: e?.response?.data,
          url: e?.config?.url || e?.response?.config?.url,
        });
        // Continue to next event so that we can still advance the sync token
      }
    }

    pageToken = res.data.nextPageToken || null;
    newNextSync = res.data.nextSyncToken || newNextSync;
  } while (pageToken);

  if (newNextSync) {
    await saveNextSyncToken(newNextSync);
    console.log("pullChanges: saved new nextSyncToken");
  }
}
