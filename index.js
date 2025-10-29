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
import { getMapping, putMapping, deleteMapping } from "./storage.js";

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
    console.error("OAuth callback error:", e.message);
    res.status(500).send(`Auth error: ${e.message}`);
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
    console.error("pullChanges error:", e.message);
  }
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
