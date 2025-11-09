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

// Find or create the "GOOGLE CALENDAR EVENT" customer
// All calendar events should use this customer with first_name="GOOGLE" and last_name="CALENDAR EVENT"
export async function resolveGoogleCalendarCustomerId() {
  const cacheKey = "google_calendar_customer_id";
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const api = hcp();
  const firstName = "GOOGLE";
  const lastName = "CALENDAR EVENT";

  // First, try to find existing customer
  let page = 1;
  const MAX_PAGES = 5;

  while (page <= MAX_PAGES) {
    try {
      const res = await rateLimitedCall(() =>
        api.get(`/customers`, {
          params: { page, page_size: 100 },
        })
      );

      const list = Array.isArray(res.data?.customers)
        ? res.data.customers
        : Array.isArray(res.data)
        ? res.data
        : [];

      const found = list.find((c) => {
        const cFirst = (c.first_name || "").trim().toUpperCase();
        const cLast = (c.last_name || "").trim().toUpperCase();
        return cFirst === firstName && cLast === lastName;
      });

      if (found) {
        const customerId = String(found.id);
        await cacheSet(cacheKey, customerId);
        return customerId;
      }

      const totalPages = Number(res.data?.total_pages) || page;
      if (page >= totalPages) break;
      page++;
    } catch (e) {
      console.error("Error searching for GOOGLE CALENDAR EVENT customer:", {
        message: e?.message,
        status: e?.response?.status,
      });
      break;
    }
  }

  // If not found, try to create it
  try {
    const createRes = await rateLimitedCall(() =>
      api.post(`/customers`, {
        first_name: firstName,
        last_name: lastName,
      })
    );

    const customerId =
      createRes.data?.id ||
      createRes.data?.customer?.id ||
      createRes.data?.customer_id ||
      null;

    if (customerId) {
      await cacheSet(cacheKey, String(customerId));
      return String(customerId);
    }
  } catch (createErr) {
    console.error("Error creating GOOGLE CALENDAR EVENT customer:", {
      message: createErr?.message,
      status: createErr?.response?.status,
      data: createErr?.response?.data,
    });
  }

  throw new Error(
    `Could not find or create GOOGLE CALENDAR EVENT customer. Please create it manually in HCP.`
  );
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

// Resolve HCP employee ID by email address
// Since each tech uses the same email for Google Calendar and HCP,
// we can match the calendar owner's email to the HCP employee email
export async function resolveEmployeeIdByEmail(email) {
  if (!email) return null;

  const normalizedEmail = email.toLowerCase().trim();

  // Check cache first (key format: employee_email_<email>)
  const cacheKey = `employee_email_${normalizedEmail}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  // Query HCP employees API to find employee by email
  const api = hcp();
  let page = 1;
  const MAX_PAGES = 5;

  while (page <= MAX_PAGES) {
    try {
      const res = await rateLimitedCall(() =>
        api.get(`/employees`, {
          params: { page, page_size: 100 },
        })
      );

      // HCP API response structure might be similar to customers
      // Try both structures: res.data.employees or res.data
      const list = Array.isArray(res.data?.employees)
        ? res.data.employees
        : Array.isArray(res.data)
        ? res.data
        : [];

      // Find employee by email (case-insensitive)
      const found = list.find((emp) => {
        const empEmail = (emp.email || "").toLowerCase().trim();
        return empEmail === normalizedEmail;
      });

      if (found) {
        const employeeId = String(found.id);
        await cacheSet(cacheKey, employeeId);
        return employeeId;
      }

      // Check if there are more pages
      const totalPages = Number(res.data?.total_pages) || page;
      if (page >= totalPages) break;
      page++;
    } catch (e) {
      // If employees endpoint doesn't exist or returns error, log and return null
      console.error("resolveEmployeeIdByEmail error:", {
        email: normalizedEmail,
        message: e?.message,
        status: e?.response?.status,
        data: e?.response?.data,
      });
      return null;
    }
  }

  // Employee not found - return null (don't throw, allow fallback to default)
  console.warn(
    `Could not resolve HCP employee_id for email "${normalizedEmail}". Employee may not exist in HCP or email doesn't match.`
  );
  return null;
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
  notes,
  assignedEmployeeId,
}) {
  const api = hcp();
  const payload = {
    customer_id,
    scheduled_start: startISO,
    scheduled_end: endISO,
    description: description || title || "Calendar job",
    notes: notes || description || title || "Calendar job", // Add notes field (title + description)
    // Add other fields your account allows. Example:
    // job_type: "Service"
  };
  const res = await rateLimitedCall(() => api.post(`/jobs`, payload));

  // Try multiple possible response structures
  const jobId =
    res.data?.id ||
    res.data?.job?.id ||
    res.data?.job_id ||
    res.data?.data?.id ||
    res.data?.job_id ||
    (res.data?.job && typeof res.data.job === "object" && res.data.job.id) ||
    null;

  // Log response structure only for debugging (very verbose)
  // console.log("createJob response:", {
  //   status: res.status,
  //   hasId: !!jobId,
  //   jobId: jobId,
  //   dataKeys: Object.keys(res.data || {}),
  //   sampleData: JSON.stringify(res.data).substring(0, 300),
  //   schedule: res.data?.schedule || null,
  //   hasSchedule: !!res.data?.schedule,
  // });

  if (!jobId) {
    console.error(
      "createJob: Could not extract job ID from response - check logs above"
    );
    return null;
  }

  // Check if schedule was set - if not, set it explicitly via schedule endpoint
  // HCP may require schedule to be set separately for jobs to appear on calendar
  if (
    startISO &&
    endISO &&
    (!res.data?.schedule || !res.data?.schedule?.scheduled_start)
  ) {
    // Silently set schedule if not set in response

    // HCP schedule endpoint might require full ISO datetime strings, not date-only
    // If date-only format (YYYY-MM-DD), convert to full datetime
    let scheduleStart = startISO;
    let scheduleEnd = endISO;

    if (startISO && startISO.length === 10) {
      // Date-only format - convert to start of day in ISO format
      scheduleStart = new Date(startISO + "T00:00:00").toISOString();
      // Silently convert date-only format
    }

    if (endISO && endISO.length === 10) {
      // Date-only format - convert to end of day in ISO format
      scheduleEnd = new Date(endISO + "T23:59:59").toISOString();
      // Silently convert date-only format
    }

    // HCP schedule endpoint expects start_time and end_time (not scheduled_start/scheduled_end)
    // Also supports assigned_employees or dispatched_employees for technician assignment
    const schedulePayload = {
      start_time: scheduleStart,
      end_time: scheduleEnd,
    };

    // Add employee assignment if provided
    if (assignedEmployeeId) {
      schedulePayload.dispatched_employees = [
        { employee_id: assignedEmployeeId },
      ];
    }

    // Silently set schedule

    try {
      await rateLimitedCall(() =>
        api.put(`/jobs/${jobId}/schedule`, schedulePayload)
      );
      // Schedule set successfully (silent)
    } catch (scheduleErr) {
      console.error(`createJob: Failed to set schedule for job ${jobId}:`, {
        status: scheduleErr?.response?.status,
        data: scheduleErr?.response?.data,
        url: `/jobs/${jobId}/schedule`,
        payload: schedulePayload,
        startISO_original: startISO,
        endISO_original: endISO,
      });
      // Don't fail the whole operation - job was created, just schedule might not be visible
    }
  }

  return jobId;
}

export async function updateJob(
  hcpJobId,
  { startISO, endISO, title, description, notes, assignedEmployeeId }
) {
  const api = hcp();
  // HCP doesn't have a direct "update job" endpoint
  // Use "Update job schedule" endpoint instead: PUT /jobs/{id}/schedule
  // HCP expects start_time and end_time (not scheduled_start/scheduled_end)
  const payload = {
    start_time: startISO,
    end_time: endISO,
    // Note: description/title/notes updates may not be supported via schedule endpoint
  };

  // Add employee assignment if provided
  if (assignedEmployeeId) {
    payload.dispatched_employees = [{ employee_id: assignedEmployeeId }];
  }
  try {
    await rateLimitedCall(() => api.put(`/jobs/${hcpJobId}/schedule`, payload));
    // Update successful (logged in index.js)
  } catch (err) {
    console.error(`updateJob: failed for job ${hcpJobId}:`, {
      status: err?.response?.status,
      data: err?.response?.data,
      url: `/jobs/${hcpJobId}/schedule`,
    });
    throw err;
  }
}

export async function deleteJob(hcpJobId) {
  const api = hcp();
  // HCP API doesn't have a "Delete Job" endpoint according to docs
  // Jobs can't be deleted via API - they may need to be cancelled/deleted in the UI
  // Or there might be a "Delete job schedule" endpoint to remove the schedule
  try {
    // Try "Delete job schedule" endpoint if it exists: DELETE /jobs/{id}/schedule
    await rateLimitedCall(() => api.delete(`/jobs/${hcpJobId}/schedule`));
    // Delete successful (logged in index.js)
  } catch (err) {
    // If schedule delete fails, job deletion isn't supported via API
    console.warn(
      `deleteJob: cannot delete job ${hcpJobId} via API - HCP doesn't support job deletion. Error:`,
      {
        status: err?.response?.status,
        data: err?.response?.data,
        url: `/jobs/${hcpJobId}/schedule`,
      }
    );
    // Don't throw - just log warning since deletion isn't supported
    // The mapping will still be cleared in index.js
  }
}
