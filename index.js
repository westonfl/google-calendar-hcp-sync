import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import {
  getAuthUrl,
  exchangeCodeForTokens,
  ensureWatchChannel,
  pullChanges,
} from "./google.js";
import { resolveCustomerId, createJob, updateJob, deleteJob } from "./hcp.js";
import {
  getMapping,
  putMapping,
  deleteMapping,
  clearRefreshToken,
} from "./storage.js";

const app = express();
app.use(bodyParser.json());

// 1) Start Google auth
app.get("/auth/google", (req, res) => {
  res.redirect(getAuthUrl());
});

// 2) OAuth callback
app.get("/oauth2/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) {
      return res.status(400).send("No authorization code received");
    }

    await exchangeCodeForTokens(code);
    await ensureWatchChannel();
    res.send(
      "Google authorized. Watch channel set. You can close this window."
    );
  } catch (e) {
    // Log raw error + extracted details for maximum visibility in Render logs
    console.error("OAuth callback error RAW:", e);
    const details = {
      message: e?.message,
      code: e?.code,
      response: e?.response?.data,
      queryHasCode: Boolean(req?.query?.code),
    };
    console.error("OAuth callback error DETAILS:", details);
    res.status(500).send(`Auth error: ${details.message || "unknown"}`);
  }
});

// 3) Webhook for Google notifications
app.post("/webhook/google", async (req, res) => {
  // Google sends headers. We do not trust body for Calendar push.
  // Always respond quickly, then pull changes using sync tokens.
  res.sendStatus(200);

  try {
    await pullChanges(handleCalendarEvent);
  } catch (e) {
    // Quietly ignore missing authorization to avoid noisy logs until OAuth is completed
    if (String(e?.message || "").includes("No Google refresh token")) return;
    console.error("pullChanges error:", e?.message || e);
  }
});

// Helper to force a clean OAuth by clearing the stored refresh token
app.post("/auth/reset", async (_req, res) => {
  try {
    await clearRefreshToken();
    res.send("Refresh token cleared. Visit /auth/google to re-authorize.");
  } catch (e) {
    res.status(500).send("Failed to clear token");
  }
});

// Also expose GET for convenience (triggerable from browser address bar)
app.get("/auth/reset", async (_req, res) => {
  try {
    await clearRefreshToken();
    res.send("Refresh token cleared. Visit /auth/google to re-authorize.");
  } catch (e) {
    res.status(500).send("Failed to clear token");
  }
});

// Minimal debug endpoint to confirm runtime config (safe values only)
app.get("/debug/env", (_req, res) => {
  res.json({
    BASE_URL: process.env.BASE_URL,
    GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
    GOOGLE_CALENDAR_ID: process.env.GOOGLE_CALENDAR_ID || "primary",
    NODE_ENV: process.env.NODE_ENV,
  });
});

// Handler that maps a single Google event to HCP
async function handleCalendarEvent(googleEvent) {
  // googleEvent.status can be "cancelled"
  const evtId = googleEvent.id;
  const status = googleEvent.status;

  // Basic normalization
  const title = googleEvent.summary || "Calendar job";
  const description = googleEvent.description || "";
  const startISO = googleEvent.start?.dateTime || googleEvent.start?.date;
  let endISO = googleEvent.end?.dateTime || googleEvent.end?.date;

  // If no end provided, default to +60 minutes
  if (!endISO && startISO && startISO.length > 10) {
    const startDate = new Date(startISO);
    endISO = new Date(startDate.getTime() + 60 * 60000).toISOString();
  }

  const existing = await getMapping(evtId);

  if (status === "cancelled") {
    if (existing) {
      await deleteJob(existing).catch((err) =>
        console.error("deleteJob", err.message)
      );
      await deleteMapping(evtId);
    }
    return;
  }

  if (!startISO || !endISO) {
    console.warn("Event missing start or end, skipping", evtId);
    return;
  }

  const customerId = await resolveCustomerId();

  if (existing) {
    await updateJob(existing, { startISO, endISO, title, description }).catch(
      (err) => console.error("updateJob", err.message)
    );
  } else {
    const hcpId = await createJob({
      customer_id: customerId,
      startISO,
      endISO,
      title,
      description,
    }).catch((err) => {
      console.error("createJob", err.response?.data || err.message);
      throw err;
    });
    if (hcpId) {
      await putMapping(evtId, String(hcpId));
    }
  }
}

app.get("/", (req, res) => {
  res.send("HCP Calendar Sync is running");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server on ${port}`);
  console.log(`1) Visit /auth/google to link the calendar`);
});
