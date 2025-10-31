import axios from "axios";
import { cacheGet, cacheSet } from "./storage.js";

const base = process.env.HCP_API_BASE;
const key = process.env.HCP_API_KEY;

function hcp() {
  return axios.create({
    baseURL: base,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });
}

// Optional helper in case you do not know customer_id.
// If HCP supports a search endpoint, use it. If not, ask Ben for the id.
export async function resolveCustomerId() {
  const configured = process.env.HCP_CUSTOMER_ID?.trim();
  if (configured) return configured;

  const cached = await cacheGet("customer_id");
  if (cached) return cached;

  // Fallback strategy:
  // 1) Try a simple customers list and filter by name on client (not ideal for huge accounts).
  // If the API provides a search query param, use it instead.
  const name = process.env.HCP_CUSTOMER_NAME || "Ben King";

  // Try a paginated fetch of first N customers and find a match by name.
  // Replace with official search once you confirm the docs endpoint.
  const api = hcp();
  let page = 1;
  const MAX_PAGES = 5;

  while (page <= MAX_PAGES) {
    const res = await api.get(`/customers`, {
      params: { page, page_size: 100 },
    });
    const list = Array.isArray(res.data?.customers)
      ? res.data.customers
      : Array.isArray(res.data)
      ? res.data
      : [];
    const target = name.toLowerCase().trim();
    const found = list.find((c) => {
      const full = `${c.first_name || ""} ${c.last_name || ""}`
        .trim()
        .toLowerCase();
      const single = (c.name || "").toLowerCase().trim();
      const company = (c.company_name || "").toLowerCase().trim();
      return full === target || single === target || company === target;
    });
    if (found) {
      await cacheSet("customer_id", String(found.id));
      return String(found.id);
    }
    const totalPages = Number(res.data?.total_pages) || page;
    if (page >= totalPages) break;
    page++;
  }

  throw new Error(
    `Could not resolve HCP customer_id for "${name}". Set HCP_CUSTOMER_ID in .env.`
  );
}

// Simple rate limiter with exponential backoff for 429 errors
let lastCallTime = 0;
const MIN_DELAY_MS = 2000; // Minimum 2 seconds between calls to avoid rate limiting

async function rateLimitedCall(fn) {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_DELAY_MS) {
    await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed));
  }
  lastCallTime = Date.now();

  let retries = 3;
  let delay = 1000;
  while (retries > 0) {
    try {
      return await fn();
    } catch (e) {
      if (e?.response?.status === 429 && retries > 0) {
        console.warn(`HCP rate limited (429), waiting ${delay}ms before retry`);
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2; // Exponential backoff
        retries--;
      } else {
        throw e;
      }
    }
  }
  throw new Error("HCP rate limit exceeded after retries");
}

export async function createJob({
  customer_id,
  startISO,
  endISO,
  title,
  description,
}) {
  const api = hcp();
  const payload = {
    customer_id,
    scheduled_start: startISO,
    scheduled_end: endISO,
    description: description || title || "Calendar job",
    // Add other fields your account allows. Example:
    // job_type: "Service"
  };
  const res = await rateLimitedCall(() => api.post(`/jobs`, payload));
  return res.data?.id || res.data?.job?.id || res.data?.data?.id;
}

export async function updateJob(
  hcpJobId,
  { startISO, endISO, title, description }
) {
  const api = hcp();
  const payload = {
    scheduled_start: startISO,
    scheduled_end: endISO,
    description: description || title || "Calendar job",
  };
  await rateLimitedCall(() => api.patch(`/jobs/${hcpJobId}`, payload));
}

export async function deleteJob(hcpJobId) {
  const api = hcp();
  // Some HCP tenants prefer marking canceled instead of deleting. If delete is not allowed, replace with a status update.
  await rateLimitedCall(() => api.delete(`/jobs/${hcpJobId}`));
}
