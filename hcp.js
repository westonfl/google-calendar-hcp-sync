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

  const cached = cacheGet("customer_id");
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
      params: { page, per_page: 100 },
    });
    const list = Array.isArray(res.data?.data) ? res.data.data : res.data;
    const found = list?.find(
      (c) => (c.name || "").toLowerCase().trim() === name.toLowerCase().trim()
    );
    if (found) {
      cacheSet("customer_id", String(found.id));
      return String(found.id);
    }
    if (!res.data?.next_page) break;
    page++;
  }

  throw new Error(
    `Could not resolve HCP customer_id for "${name}". Set HCP_CUSTOMER_ID in .env.`
  );
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
  const res = await api.post(`/jobs`, payload);
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
  await api.patch(`/jobs/${hcpJobId}`, payload);
}

export async function deleteJob(hcpJobId) {
  const api = hcp();
  // Some HCP tenants prefer marking canceled instead of deleting. If delete is not allowed, replace with a status update.
  await api.delete(`/jobs/${hcpJobId}`);
}
