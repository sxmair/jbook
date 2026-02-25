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
const SEAT_FALLBACKS = (process.env.SEAT_FALLBACKS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Debug controls
const HEADFUL = process.env.HEADFUL === "1";
const SLOWMO = Number(process.env.SLOWMO || "0");
const VERBOSE = process.env.VERBOSE === "1";
const BOOK_AT_SGT = process.env.BOOK_AT_SGT || null; // e.g. "00:00" or "00:00:00"
const WAIT_BEFORE_BOOK = process.env.WAIT_BEFORE_BOOK === "1";
const BLOCK_ASSETS = process.env.BLOCK_ASSETS !== "0";
const PREOPEN_BOOKING = process.env.PREOPEN_BOOKING === "1";
const UI_SETTLE_MS = Number(process.env.UI_SETTLE_MS || "40");

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
async function waitForUiNotBlocked(page, timeout = 10_000) {
  const selectors = [
    "app-loader .spinner-container",
    ".spinner-container.ng-star-inserted",
    "app-loader",
  ];
  const deadline = Date.now() + timeout;
  for (const selector of selectors) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await page
      .locator(selector)
      .first()
      .waitFor({ state: "hidden", timeout: remaining })
      .catch(() => {});
  }
}
async function dismissOverlayBackdrop(page) {
  const backdrop = page.locator(".cdk-overlay-backdrop").first();
  const visible = await backdrop.isVisible().catch(() => false);
  if (visible) {
    await backdrop.click({ timeout: 1200 }).catch(() => {});
  }
}
async function safeClick(locator, timeout = 30_000) {
  const page = locator.page();
  const deadline = Date.now() + timeout;
  let lastErr = null;
  let tries = 0;

  while (Date.now() < deadline) {
    tries += 1;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    await waitForUiNotBlocked(page, Math.min(remaining, 4_000));
    try {
      await locator.waitFor({ state: "visible", timeout: Math.min(remaining, 2_000) });
      await locator.click({ timeout: Math.min(remaining, 2_000) });
      return;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || "");
      const retryable =
        msg.includes("Timeout") ||
        msg.includes("waiting for") ||
        msg.includes("intercepts pointer events") ||
        msg.includes("element is not attached") ||
        msg.includes("not visible") ||
        msg.includes("not stable");
      if (!retryable) throw err;
      await page.waitForTimeout(Math.min(600, 50 * tries));
    }
  }

  if (lastErr) throw lastErr;
  await locator.click({ timeout: 1 });
}
async function safeFill(locator, value, timeout = 30_000) {
  await locator.fill(value, { timeout });
}

/* ----------------------------
 * Date helpers
 * ---------------------------- */
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function getSgtYmd(daysAhead = 0) {
  const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
  const nowSgt = new Date(Date.now() + SGT_OFFSET_MS);
  const base = new Date(
    Date.UTC(nowSgt.getUTCFullYear(), nowSgt.getUTCMonth(), nowSgt.getUTCDate())
  );
  base.setUTCDate(base.getUTCDate() + daysAhead);
  return {
    y: base.getUTCFullYear(),
    m: base.getUTCMonth(),
    d: base.getUTCDate(),
  };
}

function monthYearLabelFromYmd({ y, m }) {
  return `${MONTH_NAMES[m]} ${y}`;
}

function dateObjFromYmd({ y, m, d }) {
  return new Date(Date.UTC(y, m, d));
}

function fmtYmd({ y, m, d }) {
  const mm = String(m + 1).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

function fmtSgtNow() {
  const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
  const now = new Date(Date.now() + SGT_OFFSET_MS);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `${fmtYmd({ y, m, d })} ${hh}:${mm}:${ss}`;
}

function parseHhmmss(value) {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error(`Bad time format: "${value}" (expected HH:MM or HH:MM:SS)`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3] || "0");
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) {
    throw new Error(`Bad time value: "${value}"`);
  }
  return { hh, mm, ss };
}

function getSgtNowParts() {
  const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
  const now = new Date(Date.now() + SGT_OFFSET_MS);
  return {
    y: now.getUTCFullYear(),
    m: now.getUTCMonth(),
    d: now.getUTCDate(),
    hh: now.getUTCHours(),
    mm: now.getUTCMinutes(),
    ss: now.getUTCSeconds(),
  };
}

function nextSgtTimestampMs(hh, mm, ss) {
  const now = getSgtNowParts();
  let target = new Date(Date.UTC(now.y, now.m, now.d, hh, mm, ss, 0));
  const nowMs = Date.UTC(now.y, now.m, now.d, now.hh, now.mm, now.ss, 0);
  if (target.getTime() <= nowMs) {
    target = new Date(Date.UTC(now.y, now.m, now.d + 1, hh, mm, ss, 0));
  }
  return target.getTime() - 8 * 60 * 60 * 1000; // back to UTC epoch ms
}

async function waitUntilSgtTime(label) {
  const { hh, mm, ss } = parseHhmmss(label);
  const targetUtcMs = nextSgtTimestampMs(hh, mm, ss);
  const targetSgt = new Date(targetUtcMs + 8 * 60 * 60 * 1000);
  logStep(
    `Waiting until SGT ${String(hh).padStart(2, "0")}:${String(mm).padStart(
      2,
      "0"
    )}:${String(ss).padStart(2, "0")} (target ${fmtYmd({
      y: targetSgt.getUTCFullYear(),
      m: targetSgt.getUTCMonth(),
      d: targetSgt.getUTCDate(),
    })})`
  );

  for (;;) {
    const now = Date.now();
    const remaining = targetUtcMs - now;
    if (remaining <= 0) break;
    const sleepMs = Math.min(remaining, 1_000);
    await new Promise((r) => setTimeout(r, sleepMs));
  }
}

// Payload expects UTC midnight ms for that calendar date
function utcMidnightMsForLocalDate(dateObj) {
  // Use UTC fields so host timezone does not shift the booking date.
  const y = dateObj.getUTCFullYear();
  const m = dateObj.getUTCMonth();
  const d = dateObj.getUTCDate();
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
    /(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s*,?\s+\d{4}/i;
  const monthToIndex = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  };

  const normalizeMonthYear = (text) => {
    const t = String(text || "").trim().replace(/\s+/g, " ");
    const m = t.match(monthRegex);
    if (!m) return null;
    const hit = m[0].replace(",", " ");
    const p = hit.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (!p) return null;
    const mon = p[1].slice(0, 3).toLowerCase();
    const y = Number(p[2]);
    const idx = monthToIndex[mon];
    if (idx == null || !Number.isFinite(y)) return null;
    return `${MONTH_NAMES[idx]} ${y}`;
  };

  const periodBtn = page
    .locator("button.mat-calendar-period-button, .mat-calendar-period-button")
    .first();
  if ((await periodBtn.count().catch(() => 0)) > 0) {
    const t = (await periodBtn.innerText().catch(() => ""))
      .trim()
      .replace(/\s+/g, " ");
    const norm = normalizeMonthYear(t);
    if (norm) return norm;
  }

  const candidates = page.locator("button, div, span").filter({
    hasText: monthRegex,
  });
  const n = await candidates.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const t = (await candidates.nth(i).innerText().catch(() => ""))
      .trim()
      .replace(/\s+/g, " ");
    const norm = normalizeMonthYear(t);
    if (norm) return norm;
  }

  return null;
}

async function navigateToMonth(page, targetLabel) {
  function monthIndexFromLabel(label) {
    const m = String(label || "").trim().match(
      /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/i
    );
    if (!m) return null;
    const monthIdx = MONTH_NAMES.findIndex(
      (name) => name.toLowerCase() === m[1].toLowerCase()
    );
    if (monthIdx < 0) return null;
    return Number(m[2]) * 12 + monthIdx;
  }

  async function tryClickNav(which) {
    const isNext = which === "next";
    const iconText = isNext ? "navigate_next" : "navigate_before";
    const selectors = isNext
      ? [
          "button.mat-calendar-next-button",
          ".mat-calendar-next-button",
          '[aria-label*="next month" i]',
          '[aria-label*="next" i]',
        ]
      : [
          "button.mat-calendar-previous-button",
          ".mat-calendar-previous-button",
          '[aria-label*="previous month" i]',
          '[aria-label*="previous" i]',
          '[aria-label*="prev" i]',
        ];

    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if ((await loc.count().catch(() => 0)) > 0) {
        try {
          await loc.click({ timeout: 1200 });
          return true;
        } catch {}
      }
    }

    // Fallback from your codegen: icon text nodes can be directly clickable.
    const icon = page.getByText(iconText, { exact: true }).first();
    if ((await icon.count().catch(() => 0)) > 0) {
      try {
        await icon.click({ timeout: 1200 });
        return true;
      } catch {}
      try {
        await icon.locator("xpath=ancestor::button[1]").click({ timeout: 1200 });
        return true;
      } catch {}
    }

    return false;
  }

  for (let tries = 0; tries < 36; tries++) {
    const cur = await getCurrentMonthLabel(page);
    logVerbose(`Calendar month label now: "${cur}" target="${targetLabel}"`);
    if (cur && cur.toLowerCase() === targetLabel.toLowerCase()) return;

    const curIdx = monthIndexFromLabel(cur);
    const targetIdx = monthIndexFromLabel(targetLabel);

    let clicked = false;
    if (curIdx != null && targetIdx != null) {
      if (curIdx < targetIdx) {
        clicked = await tryClickNav("next");
      } else if (curIdx > targetIdx) {
        clicked = await tryClickNav("prev");
      }
    }
    if (!clicked) {
      clicked = (await tryClickNav("next")) || (await tryClickNav("prev"));
    }
    if (!clicked) {
      throw new Error(
        `Could not find calendar next/prev buttons (monthHeader="${cur || "unknown"}").`
      );
    }

    await page.waitForTimeout(UI_SETTLE_MS);
  }

  throw new Error(`Failed to navigate calendar to "${targetLabel}".`);
}

async function clickDayCell(page, day, targetYmd = null) {
  if (targetYmd) {
    const month = MONTH_NAMES[targetYmd.m];
    const ariaRegex = new RegExp(`${month}\\s+${targetYmd.d},\\s+${targetYmd.y}`, "i");
    const byAria = page.locator("[aria-label]");
    const n = await byAria.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const node = byAria.nth(i);
      const aria = (await node.getAttribute("aria-label").catch(() => "")) || "";
      if (!ariaRegex.test(aria)) continue;
      try {
        await node.click({ timeout: 1500 });
        return;
      } catch {}
    }
  }

  const cell = page
    .locator(".mat-calendar-body-cell-content, .mat-mdc-calendar-body-cell-content, div")
    .filter({ hasText: new RegExp(`^${day}$`) })
    .first();
  await safeWaitVisible(cell, 30_000);
  await safeClick(cell, 30_000);
}

async function pickDateDaysAhead(page, daysAhead) {
  const targetYmd = getSgtYmd(daysAhead);
  const targetLabel = monthYearLabelFromYmd(targetYmd);
  const targetDay = targetYmd.d;

  logStep(`Target booking date (SGT): ${fmtYmd(targetYmd)} (${targetLabel})`);

  await waitForUiNotBlocked(page, 15_000);
  await dismissOverlayBackdrop(page);
  const calendarIcon = page.locator(".cursor-pointer.iconSize").first();
  await safeWaitVisible(calendarIcon, 60_000);
  await safeClick(calendarIcon);
  await page
    .locator(".mat-calendar-period-button, .mat-mdc-calendar-period-button")
    .first()
    .waitFor({ state: "visible", timeout: 3000 })
    .catch(async () => {
      await page.waitForTimeout(Math.max(UI_SETTLE_MS, 60));
    });
  await navigateToMonth(page, targetLabel);

  logStep(`Selecting day: ${targetDay}`);
  await clickDayCell(page, targetDay, targetYmd);

  return dateObjFromYmd(targetYmd);
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

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pickTimeOptionRobust(page, label, { timeout = 8000 } = {}) {
  const panelOptions = page.locator(".cdk-overlay-container mat-option");
  await panelOptions.first().waitFor({ state: "visible", timeout });

  const count = await panelOptions.count().catch(() => 0);
  if (count === 0) throw new Error("No mat-option items found in overlay.");

  const want = normalizeText(label).toLowerCase();

  // Fast path: direct locator match usually beats scanning all options.
  const exactMatcher = new RegExp(`^\\s*${escapeRegex(label)}\\s*$`, "i");
  const exact = panelOptions.filter({ hasText: exactMatcher }).first();
  if ((await exact.count().catch(() => 0)) > 0) {
    await exact.click({ timeout: 2000 });
    await page.keyboard.press("Escape").catch(() => {});
    return true;
  }

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
    await new Promise((r) => setTimeout(r, 80));
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
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error("Timed out waiting for map entities from availability data.");
}

function normalizeSeatLabel(label) {
  return (label || "").toString().trim().toLowerCase();
}

function buildDesiredSeatLabels(seatNumber, seatDisplayName) {
  const labels = new Set();
  if (seatDisplayName) labels.add(normalizeSeatLabel(seatDisplayName));
  if (seatNumber) {
    const n = String(seatNumber).trim();
    labels.add(normalizeSeatLabel(n));
    labels.add(normalizeSeatLabel(`6-${n}`));
  }
  return labels;
}

async function resolveSeatFromMap(seatNumber, { entityId, displayName } = {}) {
  const entities = await waitForMapEntities(30_000);
  const desired = buildDesiredSeatLabels(seatNumber, displayName);

  if (entityId) {
    const byId = entities.find((e) => e.id === entityId);
    if (byId) return byId;
    const fallbackName =
      displayName || (seatNumber ? `6-${seatNumber}` : "UNKNOWN");
    return { id: entityId, displayName: fallbackName };
  }

  for (const e of entities) {
    const dn = normalizeSeatLabel(e.displayName);
    if (desired.has(dn)) return e;
  }

  // fallback: try endsWith for seat number
  const num = String(seatNumber || "").trim();
  if (num) {
    const match = entities.find((e) =>
      normalizeSeatLabel(e.displayName).endsWith(`-${num}`)
    );
    if (match) return match;
  }

  throw new Error(
    `Could not resolve seat "${seatNumber}" from map data. Found ${entities.length} entities.`
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
    `🚀 Calling booking API for seat ${seat.displayName} (entityId=${seat.id})...`
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

function isSeatTakenError(err) {
  const msg = (err && err.message ? err.message : String(err || "")).toLowerCase();
  return (
    msg.includes("got booked by someone else") ||
    msg.includes("space you were trying to book got booked") ||
    msg.includes("please try to book another space") ||
    msg.includes("oops!") ||
    (msg.includes("booking api failed") && msg.includes("500"))
  );
}

/* ----------------------------
 * Main flow
 * ---------------------------- */
(async () => {
  logStep(
    `Starting booking run (seat=${SEAT_NUMBER}, ${START_TIME_LABEL} -> ${END_TIME_LABEL}, daysAhead=${DAYS_AHEAD})`
  );
  logStep(`Now (SGT): ${fmtSgtNow()}`);

  const browser = await chromium.launch({
    headless: !HEADFUL,
    slowMo: SLOWMO,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  if (BLOCK_ASSETS) {
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media" || type === "font") {
        return route.abort();
      }
      return route.continue();
    });
  }

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

    let waitedForBookTime = false;
    let bookingScreenReady = false;

    if (PREOPEN_BOOKING) {
      logStep("Pre-opening Booking/Book Now before wait for faster trigger execution...");
      await safeClick(page.getByRole("link", { name: "Booking" }), 30_000);
      await safeClick(page.getByRole("button", { name: "Book Now" }), 30_000);
      bookingScreenReady = true;
    }

    // 2) Wait for trigger time first, so all date logic is based on post-wait SGT date.
    if (WAIT_BEFORE_BOOK && BOOK_AT_SGT) {
      await waitUntilSgtTime(BOOK_AT_SGT);
      waitedForBookTime = true;
    }

    // 3) Booking -> Book Now
    if (!bookingScreenReady) {
      logStep("Opening Booking...");
      await safeClick(page.getByRole("link", { name: "Booking" }), 30_000);

      logStep("Clicking Book Now...");
      await safeClick(page.getByRole("button", { name: "Book Now" }), 30_000);
    }

    // 4) Pick date (computed from current SGT date at selection time)
    logStep("Selecting booking date...");
    const targetLocalDate = await pickDateDaysAhead(page, DAYS_AHEAD);

    logStep("Clicking Next (to time confirmation modal)...");
    await safeClick(page.getByRole("button", { name: "Next" }), 30_000);

    // 5) Select Start Time
    logStep("Selecting Start Time...");
    await openStartTimeDropdown(page);
    await pickTimeOptionRobust(page, START_TIME_LABEL, { timeout: 8000 });

    // 6) Select End Time — bounded + non-blocking
    const endExists =
      (await page.locator("#endTime .mat-select-trigger").count().catch(() => 0)) >
      0;

    if (endExists) {
      logStep("Selecting End Time...");
      try {
        await openEndTimeDropdown(page);
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

    // 7) Get userId from captured myProfile XHR (NO API CALL)
    logStep("Waiting for captured userId from browser XHR...");
    const userId = await waitForCapturedUserId(30_000);
    logStep(`Resolved userId=${userId}`);

    // 8) Resolve seat + book (with fallbacks)
    const seatCandidates = [SEAT_NUMBER, ...SEAT_FALLBACKS];
    logStep(`Seat candidates: ${seatCandidates.join(", ")}`);
    let bookedSeat = null;

    for (let i = 0; i < seatCandidates.length; i++) {
      const seatNum = seatCandidates[i];
      const resolvedSeat = await resolveSeatFromMap(seatNum, {
        entityId: i === 0 ? SEAT_ENTITY_ID : null,
        displayName: i === 0 ? SEAT_DISPLAY_NAME : null,
      });
      logStep(`Resolved seat: ${resolvedSeat.displayName} (id=${resolvedSeat.id})`);

      if (Object.keys(capturedAmenityHeaders).length === 0) {
        logStep("⚠️ No amenity headers captured; booking may fail.");
      }

      try {
        if (!waitedForBookTime && WAIT_BEFORE_BOOK && BOOK_AT_SGT) {
          await waitUntilSgtTime(BOOK_AT_SGT);
          waitedForBookTime = true;
        }
        await bookSeatViaApi(context, {
          userId,
          targetLocalDate,
          seat: resolvedSeat,
        });
        bookedSeat = resolvedSeat;
        break;
      } catch (e) {
        if (i < seatCandidates.length - 1 && isSeatTakenError(e)) {
          logStep(
            `Seat ${resolvedSeat.displayName} just got booked. Trying next fallback...`
          );
          continue;
        }
        throw e;
      }
    }

    if (!bookedSeat) {
      throw new Error("No seat could be booked from the fallback list.");
    }

    logStep(`✅ Completed booking via API (seat ${bookedSeat.displayName}).`);

  } catch (e) {
    console.error(`[${ts()}] ❌ Failed:`, e);

    process.exitCode = 1;
  } finally {
    clearInterval(hb);
    await browser.close();
  }
})();
