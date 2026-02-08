import { chromium } from "@playwright/test";

const LOGIN_URL =
  "https://juliusbaer.smartenspaces.com/spacemanagementV2/#/login";

const USER = process.env.SMARTEN_USER;
const PASS = process.env.SMARTEN_PASS;

// Desired seat info (entityId is optional now; we'll resolve if missing)
const SEAT_NUMBER = process.env.SEAT_NUMBER || "171";
const SEAT_ENTITY_ID = process.env.SEAT_ENTITY_ID
  ? Number(process.env.SEAT_ENTITY_ID)
  : null;
const SEAT_DISPLAY_NAME = process.env.SEAT_DISPLAY_NAME || null;

const BUILDING_ID = Number(process.env.BUILDING_ID || "10");
const BUILDING_NAME = process.env.BUILDING_NAME || "ONE@CHANGI CITY";
const ZONE_ID = Number(process.env.ZONE_ID || "14");

const START_TIME_LABEL = process.env.START_TIME_LABEL || "09:45 AM";
const END_TIME_LABEL = process.env.END_TIME_LABEL || "11:59 PM";

const DAYS_AHEAD = Number(process.env.DAYS_AHEAD || "14");

// Debug controls
const HEADFUL = process.env.HEADFUL === "1";
const SLOWMO = Number(process.env.SLOWMO || "0");
const VERBOSE = process.env.VERBOSE === "1";

if (!USER || !PASS) {
  console.error("Missing SMARTEN_USER / SMARTEN_PASS");
  process.exit(1);
}

/* ----------------------------
 * Logging helpers
 * ---------------------------- */
function ts() {
  return new Date().toISOString();
}
function logStep(msg) {
  console.log(`[${ts()}] ${msg}`);
}
function logVerbose(msg) {
  if (VERBOSE) console.log(`[${ts()}] ${msg}`);
}

/* ----------------------------
 * Auth header capture
 * ---------------------------- */
let capturedAmenityHeaders = {};
let lastMapEntities = [];

function sanitizeHeaders(headers) {
  const deny = new Set([
    "content-length",
    "host",
    "connection",
    "accept-encoding",
    "content-type",
    "accept",
  ]);
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (deny.has(key)) continue;
    out[key] = v;
  }
  return out;
}

function hasHeader(headers, name) {
  const want = name.toLowerCase();
  return Object.keys(headers || {}).some((k) => k.toLowerCase() === want);
}

/* ----------------------------
 * Small helpers
 * ---------------------------- */
async function safeWaitVisible(locator, timeout = 60_000) {
  await locator.waitFor({ state: "visible", timeout });
}
async function safeClick(locator, timeout = 30_000) {
  await locator.click({ timeout });
}
async function safeFill(locator, value, timeout = 30_000) {
  await locator.fill(value, { timeout });
}

/* ----------------------------
 * Date helpers
 * ---------------------------- */
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function monthYearLabel(d) {
  return d.toLocaleString("en-US", { month: "long", year: "numeric" });
}
function dayNum(d) {
  return d.getDate();
}

// Payload expects UTC midnight ms for that calendar date
function utcMidnightMsForLocalDate(dateObj) {
  const y = dateObj.getFullYear();
  const m = dateObj.getMonth();
  const d = dateObj.getDate();
  return Date.UTC(y, m, d, 0, 0, 0, 0);
}

/* ----------------------------
 * Time helpers
 * ---------------------------- */
function parseTimeLabelToMinutes(label) {
  const s = label.trim().replace(/\s+/g, " ");
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) throw new Error(`Bad time label: "${label}"`);
  let hh = Number(m[1]);
  const mm = Number(m[2]);
  const ap = m[3].toUpperCase();

  if (ap === "AM") {
    if (hh === 12) hh = 0;
  } else {
    if (hh !== 12) hh += 12;
  }
  return hh * 60 + mm;
}

function toHHmm(label) {
  const mins = parseTimeLabelToMinutes(label);
  const hh = String(Math.floor(mins / 60)).padStart(2, "0");
  const mm = String(mins % 60).padStart(2, "0");
  return `${hh}${mm}`;
}

/* ----------------------------
 * Calendar driver
 * ---------------------------- */
async function getCurrentMonthLabel(page) {
  const monthRegex =
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/;

  const candidates = page.locator(`text=${monthRegex}`);
  const n = await candidates.count().catch(() => 0);

  for (let i = 0; i < n; i++) {
    const t = (await candidates.nth(i).innerText().catch(() => ""))
      .trim()
      .replace(/\s+/g, " ");
    if (monthRegex.test(t) && t.length <= 30) return t;
  }
  return null;
}

async function navigateToMonth(page, targetLabel) {
  for (let tries = 0; tries < 24; tries++) {
    const cur = await getCurrentMonthLabel(page);
    logVerbose(`Calendar month label now: "${cur}" target="${targetLabel}"`);
    if (cur && cur.toLowerCase() === targetLabel.toLowerCase()) return;

    const nextBtn =
      page.locator('button:has-text("navigate_next")').first()
        .or(page.locator('button[aria-label*="next" i]').first())
        .or(page.locator('button:has-text(">")').first());

    const prevBtn =
      page.locator('button:has-text("navigate_before")').first()
        .or(page.locator('button[aria-label*="prev" i]').first())
        .or(page.locator('button:has-text("<")').first());

    let clicked = false;

    if ((await nextBtn.count().catch(() => 0)) > 0) {
      try {
        await nextBtn.click({ timeout: 1500 });
        clicked = true;
      } catch {}
    }
    if (!clicked && (await prevBtn.count().catch(() => 0)) > 0) {
      try {
        await prevBtn.click({ timeout: 1500 });
        clicked = true;
      } catch {}
    }
    if (!clicked) throw new Error("Could not find calendar next/prev buttons.");

    await page.waitForTimeout(150);
  }

  throw new Error(`Failed to navigate calendar to "${targetLabel}".`);
}

async function clickDayCell(page, day) {
  const cell = page
    .locator("div")
    .filter({ hasText: new RegExp(`^${day}$`) })
    .first();
  await safeWaitVisible(cell, 30_000);
  await safeClick(cell, 30_000);
}

async function pickDateDaysAhead(page, daysAhead) {
  const target = addDays(new Date(), daysAhead);
  const targetLabel = monthYearLabel(target);
  const targetDay = dayNum(target);

  logStep(`Target booking date: ${target.toDateString()} (${targetLabel})`);

  const calendarIcon = page.locator(".cursor-pointer.iconSize").first();
  await safeWaitVisible(calendarIcon, 60_000);
  await safeClick(calendarIcon);

  await page.waitForTimeout(200);
  await navigateToMonth(page, targetLabel);

  logStep(`Selecting day: ${targetDay}`);
  await clickDayCell(page, targetDay);

  return target;
}

/* ----------------------------
 * Time dropdown selection
 * ---------------------------- */
async function openStartTimeDropdown(page) {
  const trigger = page.locator("#startTime .mat-select-trigger").first();
  await safeWaitVisible(trigger, 60_000);
  await trigger.click();
}
async function openEndTimeDropdown(page) {
  const trigger = page.locator("#endTime .mat-select-trigger").first();
  await safeWaitVisible(trigger, 60_000);
  await trigger.click();
}

function normalizeText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

async function pickTimeOptionRobust(page, label, { timeout = 8000 } = {}) {
  const panelOptions = page.locator(".cdk-overlay-container mat-option");
  await panelOptions.first().waitFor({ state: "visible", timeout });

  const count = await panelOptions.count().catch(() => 0);
  if (count === 0) throw new Error("No mat-option items found in overlay.");

  const want = normalizeText(label).toLowerCase();

  // 1) exact match
  for (let i = 0; i < Math.min(count, 200); i++) {
    const opt = panelOptions.nth(i);
    const txt = normalizeText(await opt.innerText().catch(() => ""));
    if (!txt) continue;
    if (txt.toLowerCase() === want) {
      await opt.click({ timeout: 3000 });
      await page.keyboard.press("Escape").catch(() => {});
      return true;
    }
  }

  // 2) contains match
  for (let i = 0; i < Math.min(count, 200); i++) {
    const opt = panelOptions.nth(i);
    const txt = normalizeText(await opt.innerText().catch(() => ""));
    if (!txt) continue;
    if (txt.toLowerCase().includes(want)) {
      await opt.click({ timeout: 3000 });
      await page.keyboard.press("Escape").catch(() => {});
      return true;
    }
  }

  // dump sample
  const sample = [];
  for (let i = 0; i < Math.min(count, 40); i++) {
    const txt = normalizeText(
      await panelOptions.nth(i).innerText().catch(() => "")
    );
    if (txt) sample.push(txt);
  }
  throw new Error(
    `Time option "${label}" not found. First options: ${JSON.stringify(sample)}`
  );
}

/* ----------------------------
 * Capture userId from browser XHR (/ems/user/myProfile)
 * ---------------------------- */
let CAPTURED_USER_ID = null;

function tryExtractUserIdFromMyProfileJson(data) {
  // Seen shapes:
  // { response: { userId: 1262, ... }, ... }
  // or { userId: 1262, ... }
  const user =
    data?.response?.userId ? data.response : data?.userId ? data : null;
  return user?.userId ?? null;
}

async function waitForCapturedUserId(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (CAPTURED_USER_ID) return CAPTURED_USER_ID;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Timed out waiting for captured userId from /ems/user/myProfile");
}

/* ----------------------------
 * Seat lookup from map data
 * ---------------------------- */
function extractEntitiesFromMapValue(value) {
  const out = [];
  const seen = new Set();

  const addEntity = (e) => {
    if (!e) return;
    if (typeof e.id === "number" && typeof e.displayName === "string") {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        out.push({ id: e.id, displayName: e.displayName });
      }
    }
  };

  const addFromArray = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const e of arr) addEntity(e);
  };

  // Prefer known top-level arrays in map payload
  if (value && typeof value === "object") {
    const knownKeys = [
      "availableEntities",
      "occupiedEntities",
      "occupiedNotCheckedInEntities",
      "socialDistancedEntities",
      "disabledEntities",
      "blockedEntities",
      "allEntities",
    ];
    for (const k of knownKeys) {
      if (Array.isArray(value[k])) addFromArray(value[k]);
    }
  }

  // Fallback: deep scan for arrays with entity-like objects
  if (out.length === 0) {
    const stack = [value];
    let steps = 0;
    while (stack.length && steps < 8000) {
      const cur = stack.pop();
      steps += 1;
      if (!cur) continue;
      if (Array.isArray(cur)) {
        for (const item of cur) {
          if (item && typeof item === "object" && "id" in item && "displayName" in item) {
            addEntity(item);
          } else {
            stack.push(item);
          }
        }
        continue;
      }
      if (typeof cur === "object") {
        for (const v of Object.values(cur)) stack.push(v);
      }
    }
  }

  return out;
}

function mergeEntities(existing, next) {
  const map = new Map();
  for (const e of existing || []) map.set(e.id, e);
  for (const e of next || []) map.set(e.id, e);
  return Array.from(map.values());
}

async function waitForMapEntities(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (lastMapEntities.length > 0) return lastMapEntities;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Timed out waiting for map entities from availability data.");
}

function normalizeSeatLabel(label) {
  return (label || "").toString().trim().toLowerCase();
}

function buildDesiredSeatLabels() {
  const labels = new Set();
  if (SEAT_DISPLAY_NAME) labels.add(normalizeSeatLabel(SEAT_DISPLAY_NAME));
  if (SEAT_NUMBER) {
    const n = String(SEAT_NUMBER).trim();
    labels.add(normalizeSeatLabel(n));
    labels.add(normalizeSeatLabel(`6-${n}`));
  }
  return labels;
}

async function resolveSeatFromMap() {
  const entities = await waitForMapEntities(30_000);
  const desired = buildDesiredSeatLabels();

  if (SEAT_ENTITY_ID) {
    const byId = entities.find((e) => e.id === SEAT_ENTITY_ID);
    if (byId) return byId;
    const fallbackName =
      SEAT_DISPLAY_NAME || (SEAT_NUMBER ? `6-${SEAT_NUMBER}` : "UNKNOWN");
    return { id: SEAT_ENTITY_ID, displayName: fallbackName };
  }

  for (const e of entities) {
    const dn = normalizeSeatLabel(e.displayName);
    if (desired.has(dn)) return e;
  }

  // fallback: try endsWith for seat number
  const num = String(SEAT_NUMBER).trim();
  if (num) {
    const match = entities.find((e) =>
      normalizeSeatLabel(e.displayName).endsWith(`-${num}`)
    );
    if (match) return match;
  }

  throw new Error(
    `Could not resolve seat "${SEAT_NUMBER}" from map data. Found ${entities.length} entities.`
  );
}

/* ----------------------------
 * API booking (use context.request so cookies are shared)
 * ---------------------------- */
async function bookSeatViaApi(context, { userId, targetLocalDate, seat }) {
  const dateStartUtcMs = utcMidnightMsForLocalDate(targetLocalDate);
  const endMinutes = parseTimeLabelToMinutes(END_TIME_LABEL);
  const endTimeMs = dateStartUtcMs + endMinutes * 60_000;

  const payload = [
    {
      requestDetails: {
        entityInfos: [
          {
            id: seat.id,
            displayName: seat.displayName,
            specialRequest: [],
            serviceRequestEnabled: false,
          },
        ],
        startTime: dateStartUtcMs,
        endTime: endTimeMs,
        demandType: "USER_DEPARTMENT",
        demandId: 1,
        userId,
        rosterId: null,
        floorId: null,
        floorName: null,
        buildingId: BUILDING_ID,
        buildingName: BUILDING_NAME,
        recurringStartTime: toHHmm(START_TIME_LABEL),
        recurringEndTime: toHHmm(END_TIME_LABEL),
        zoneId: ZONE_ID,
        count: null,
        featureKey: null,
        workingDays: null,
        specialRequests: [],
        meetingCategoryId: null,
        srTicketDtoList: [],
      },
      isWFHRequest: true,
    },
  ];

  const url = `https://juliusbaer.smartenspaces.com/amenitybooking/booking/create/wfh/v3?isRosterUpdation=true&userId=${encodeURIComponent(
    String(userId)
  )}`;

  logStep(
    `🚀 Calling booking API for seat ${SEAT_NUMBER} (${seat.displayName}, entityId=${seat.id})...`
  );

  // Add browser-like headers (helps some setups)
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...capturedAmenityHeaders,
  };
  if (!hasHeader(headers, "origin")) {
    headers.Origin = "https://juliusbaer.smartenspaces.com";
  }
  if (!hasHeader(headers, "referer")) {
    headers.Referer = "https://juliusbaer.smartenspaces.com/spacemanagementV2/";
  }

  logVerbose(`Booking API headers: ${Object.keys(headers).join(", ")}`);
  const res = await context.request.post(url, { data: payload, headers });

  const body = await res.text().catch(() => "");
  if (!res.ok()) {
    throw new Error(
      `Booking API failed: ${res.status()} ${res.statusText()} :: ${body.slice(
        0,
        1600
      )}`
    );
  }

  logStep(`✅ Booking API returned ${res.status()}`);
  logVerbose(`Response: ${body.slice(0, 1500)}`);
  return body;
}

/* ----------------------------
 * Main flow
 * ---------------------------- */
(async () => {
  logStep(
    `Starting booking run (seat=${SEAT_NUMBER}, ${START_TIME_LABEL} -> ${END_TIME_LABEL}, daysAhead=${DAYS_AHEAD})`
  );

  const browser = await chromium.launch({
    headless: !HEADFUL,
    slowMo: SLOWMO,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // Capture myProfile response body to extract userId
  page.on("response", async (res) => {
    try {
      const url = res.url();
      if (url.includes("/amenitybooking/entity/availabilityMapViewForListOfDaysOptimized")) {
        const json = await res.json().catch(() => null);
        const value = json?.response?.value ?? json?.response ?? json?.value ?? json;
        if (value) {
          const entities = extractEntitiesFromMapValue(value);
          if (entities.length > 0) {
            lastMapEntities = mergeEntities(lastMapEntities, entities);
            if (VERBOSE) {
              logStep(`Map entities captured: ${lastMapEntities.length}`);
            }
          }
        }
      }
      if (!url.includes("/ems/user/myProfile")) return;
      // Only parse when OK
      if (!res.ok()) return;
      const data = await res.json().catch(() => null);
      const uid = tryExtractUserIdFromMyProfileJson(data);
      if (uid && !CAPTURED_USER_ID) {
        CAPTURED_USER_ID = uid;
        logStep(`✅ Captured userId from myProfile XHR: ${CAPTURED_USER_ID}`);
      }
    } catch {
      // ignore
    }
  });

  page.on("console", (msg) => {
    if (VERBOSE) {
      console.log(`[${ts()}] BROWSER ${msg.type()}: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    if (VERBOSE) console.log(`[${ts()}] PAGEERROR: ${err.message}`);
  });
  page.on("requestfailed", (req) => {
    if (VERBOSE) {
      console.log(
        `[${ts()}] REQ FAILED: ${req.method()} ${req.url()} :: ${req.failure()?.errorText}`
      );
    }
  });
  page.on("request", (req) => {
    const t = req.resourceType();
    if (t !== "xhr" && t !== "fetch") return;
    const url = req.url();
    if (!url.includes("/amenitybooking/")) return;

    const allAmenity = sanitizeHeaders(req.headers());
    if (Object.keys(allAmenity).length > 0) {
      capturedAmenityHeaders = { ...capturedAmenityHeaders, ...allAmenity };
      logVerbose(
        `Captured amenity headers: ${Object.keys(allAmenity).join(", ")}`
      );
    }
  });

  const hb = setInterval(() => {
    if (VERBOSE) console.log(`[${ts()}] ...still running`);
  }, 5000);

  try {
    // 1) Login
    logStep("Opening login page...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    const email = page.getByRole("textbox", { name: "Eg. email@domain.com" });
    await safeWaitVisible(email, 60_000);

    logStep("Filling email...");
    await safeFill(email, USER);

    logStep("Clicking Proceed...");
    await safeClick(page.getByRole("button", { name: "Proceed" }), 30_000);

    const pw = page.getByRole("textbox", { name: "Enter Password" });
    await safeWaitVisible(pw, 60_000);

    logStep("Filling password...");
    await safeFill(pw, PASS);

    logStep("Clicking Terms checkbox (if present)...");
    await page.locator(".mat-checkbox-inner-container").click().catch(() => {});

    logStep("Clicking Login...");
    await safeClick(page.getByRole("button", { name: "Login" }), 30_000);

    logStep("Waiting for post-login UI (Booking link)...");
    await page
      .getByRole("link", { name: "Booking" })
      .waitFor({ timeout: 60_000 });

    // 2) Booking -> Book Now
    logStep("Opening Booking...");
    await safeClick(page.getByRole("link", { name: "Booking" }), 30_000);

    logStep("Clicking Book Now...");
    await safeClick(page.getByRole("button", { name: "Book Now" }), 30_000);

    // 3) Pick date
    logStep("Selecting booking date...");
    const targetLocalDate = await pickDateDaysAhead(page, DAYS_AHEAD);

    logStep("Clicking Next (to time confirmation modal)...");
    await safeClick(page.getByRole("button", { name: "Next" }), 30_000);

    // 4) Select Start Time
    logStep("Selecting Start Time...");
    await openStartTimeDropdown(page);
    await page.waitForTimeout(150);
    await pickTimeOptionRobust(page, START_TIME_LABEL, { timeout: 8000 });

    // 5) Select End Time — bounded + non-blocking
    const endExists =
      (await page.locator("#endTime .mat-select-trigger").count().catch(() => 0)) >
      0;

    if (endExists) {
      logStep("Selecting End Time...");
      try {
        await openEndTimeDropdown(page);
        await page.waitForTimeout(150);
        await pickTimeOptionRobust(page, END_TIME_LABEL, { timeout: 8000 });
      } catch (e) {
        console.log(
          `[${ts()}] ⚠️ End time selection failed (continuing anyway): ${
            e?.message || e
          }`
        );
        await page.keyboard.press("Escape").catch(() => {});
      }
    } else {
      logVerbose("No #endTime detected; skipping end time selection.");
    }

    // Click Proceed if present
    const proceedBtn = page.getByRole("button", { name: /proceed/i });
    if ((await proceedBtn.count().catch(() => 0)) > 0) {
      logStep("Clicking Proceed...");
      await proceedBtn.click().catch(() => {});
    }

    // 6) Get userId from captured myProfile XHR (NO API CALL)
    logStep("Waiting for captured userId from browser XHR...");
    const userId = await waitForCapturedUserId(30_000);
    logStep(`Resolved userId=${userId}`);

    // 7) Resolve seat from map data (unless entity id is provided)
    const resolvedSeat = await resolveSeatFromMap();
    logStep(`Resolved seat: ${resolvedSeat.displayName} (id=${resolvedSeat.id})`);

    // 8) Book seat via API
    if (Object.keys(capturedAmenityHeaders).length === 0) {
      logStep("⚠️ No amenity headers captured; booking may fail.");
    }
    await bookSeatViaApi(context, {
      userId,
      targetLocalDate,
      seat: resolvedSeat,
    });

    logStep(`✅ Completed booking via API (seat ${SEAT_NUMBER}).`);

  } catch (e) {
    console.error(`[${ts()}] ❌ Failed:`, e);

    process.exitCode = 1;
  } finally {
    clearInterval(hb);
    await browser.close();
  }
})();
