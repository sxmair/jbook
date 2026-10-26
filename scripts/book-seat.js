import { randomUUID } from "node:crypto";

const env = (k, d) => process.env[k] || d;
const { SMARTEN_USER, SMARTEN_PASS } = process.env;
if (!SMARTEN_USER || !SMARTEN_PASS) throw new Error("Missing SMARTEN_USER / SMARTEN_PASS");

const BASE = "https://juliusbaer.smartenspaces.com";
const SEATS = [env("SEAT_NUMBER", "171"), ...env("SEAT_FALLBACKS", "").split(",")]
  .map((s) => s.trim())
  .filter(Boolean);
const START = env("START_TIME_LABEL", "09:45 AM");
const END = env("END_TIME_LABEL", "11:59 PM");
const DAYS_AHEAD = Number(env("DAYS_AHEAD", "14"));
const BUILDING_ID = Number(env("BUILDING_ID", "10"));
const BUILDING_NAME = env("BUILDING_NAME", "ONE@CHANGI CITY");
const ZONE_ID = Number(env("ZONE_ID", "14"));
const DRY_RUN = process.env.DRY_RUN === "1";
const BOOK_AT_SGT = process.env.WAIT_BEFORE_BOOK === "1" ? process.env.BOOK_AT_SGT : null; // e.g. "07:00:15"
const LOGIN_LEAD_MS = 120_000; // log in this long before BOOK_AT_SGT, so the session is fresh
const RETRY_MS = Number(env("RETRY_SECS", "90")) * 1000; // keep trying this long after the booking time
const RETRY_GAP_MS = 400;

const SGT_MS = 8 * 3600_000;
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

// "09:45 AM" -> minutes since midnight
function minutes(label) {
  const m = label.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) throw new Error(`Bad time label: "${label}"`);
  return ((Number(m[1]) % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0)) * 60 + Number(m[2]);
}
const hhmm = (label) => {
  const t = minutes(label);
  return String(Math.floor(t / 60)).padStart(2, "0") + String(t % 60).padStart(2, "0");
};

// Epoch ms of today's HH:MM[:SS] in SGT.
function sgtToday(time) {
  const [hh, mm, ss = 0] = time.split(":").map(Number);
  const s = new Date(Date.now() + SGT_MS);
  return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate(), hh, mm, ss) - SGT_MS;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sleepUntil(ms) {
  while (Date.now() < ms) await sleep(Math.min(1000, ms - Date.now()));
}

async function call(path, { method = "GET", body, session, ss = {}, timeout = 20_000 } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      feature_key: "PRE_INVITE",
      "ss-header": JSON.stringify({
        version: "1.0",
        clientKey: "ADMIN_WEB_APP",
        correlationId: randomUUID(),
        locale: "en",
        ...(session && { zoneId: session.zoneId, moduleId: 12001, gecId: "1", sessionId: session.id }),
        ...ss,
      }),
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split("?")[0]} -> ${res.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function login() {
  for (let attempt = 1; ; attempt++) {
    try {
      // The login page sends its dropdown placeholder as adDomain.
      const { response: u } = await call("/ems/user/login", {
        method: "POST",
        body: { email: SMARTEN_USER, password: SMARTEN_PASS, adDomain: "Select here" },
      });
      return { id: u.sessionId, userId: u.userId, zoneId: u.defaultZoneId };
    } catch (e) {
      if (attempt === 3 || /-> 4\d\d /.test(e.message)) throw e;
      log(`Login attempt ${attempt} failed (${e.message}); retrying...`);
      await sleep(5000);
    }
  }
}

// Seats on the map for the date + time window: { all, free } as Maps of id -> displayName.
async function seatMap(session, day) {
  const j = await call("/amenitybooking/entity/availabilityMapViewForListOfDaysOptimized", {
    method: "POST",
    session,
    body: {
      zoneId: ZONE_ID,
      availabilityRequestDto: [
        {
          zoneId: ZONE_ID,
          request: {
            requestDetails: {
              userId: String(session.userId),
              startTime: day,
              endTime: day + 86_399_000,
              recurringStartTime: hhmm(START),
              recurringEndTime: hhmm(END),
            },
          },
        },
      ],
    },
  });
  const v = j.response?.value ?? j.response ?? j;
  const lists = Object.entries(v).filter(([, a]) => Array.isArray(a));
  const toMap = (arrs) => new Map(arrs.flat().filter((e) => e?.displayName).map((e) => [e.id, e.displayName]));
  return {
    all: toMap(lists.map(([, a]) => a)),
    free: toMap(lists.filter(([k]) => k === "availableEntities").map(([, a]) => a)),
    hasFree: lists.some(([k]) => k === "availableEntities"),
  };
}

const findSeat = (map, n) => {
  const want = n.toLowerCase();
  return [...map].find(([, name]) => [want, `6-${want}`].includes(name.toLowerCase()))
    ?? [...map].find(([, name]) => name.toLowerCase().endsWith(`-${want}`));
};

async function book(session, day, [id, displayName]) {
  const payload = [
    {
      isWFHRequest: true,
      requestDetails: {
        entityInfos: [{ id, displayName, specialRequest: [], serviceRequestEnabled: false }],
        startTime: day,
        endTime: day + minutes(END) * 60_000,
        demandType: "USER_DEPARTMENT",
        demandId: 1,
        userId: session.userId,
        rosterId: null,
        floorId: null,
        floorName: null,
        buildingId: BUILDING_ID,
        buildingName: BUILDING_NAME,
        recurringStartTime: hhmm(START),
        recurringEndTime: hhmm(END),
        zoneId: ZONE_ID,
        count: null,
        featureKey: null,
        workingDays: null,
        specialRequests: [],
        meetingCategoryId: null,
        srTicketDtoList: [],
      },
    },
  ];
  if (DRY_RUN) return log(`DRY_RUN: would book ${displayName} (id=${id}): ${JSON.stringify(payload)}`);
  const r = await call(`/amenitybooking/booking/create/wfh/v3?isRosterUpdation=true&userId=${session.userId}`, {
    method: "POST",
    session,
    body: payload,
    timeout: 30_000,
  });
  log(`Booking response: ${r.message} ${r.response?.validRequests?.[0]?.ticketId ?? ""}`);
}

try {
  // Run may start before or after the release time: wait if early, go now if late.
  const target = BOOK_AT_SGT ? sgtToday(BOOK_AT_SGT) : Date.now();
  if (target > Date.now()) {
    log(`Waiting until SGT ${BOOK_AT_SGT} (login ${LOGIN_LEAD_MS / 1000}s before)...`);
    await sleepUntil(target - LOGIN_LEAD_MS);
  } else if (BOOK_AT_SGT) {
    log(`SGT ${BOOK_AT_SGT} already passed; booking now.`);
  }

  const session = await login();
  log(`Logged in (user ${session.userId}).`);
  await sleepUntil(target);
  const s = new Date(Date.now() + SGT_MS);
  const day = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() + DAYS_AHEAD);
  log(`Booking ${new Date(day).toISOString().slice(0, 10)} ${START}-${END}, seats: ${SEATS.join(", ")}`);

  // Before release the date is not bookable yet, and right at release seats get snapped up:
  // each round re-reads the map and walks the seat list in priority order.
  const deadline = Math.max(Date.now(), target) + RETRY_MS;
  for (let round = 1; ; round++) {
    try {
      const map = await seatMap(session, day);
      log(`Round ${round}: ${map.all.size} seats, ${map.free.size} free`);
      for (const n of SEATS) {
        const seat = findSeat(map.all, n);
        if (!seat) { log(`Seat ${n}: not on map`); continue; }
        if (map.hasFree && !map.free.has(seat[0])) { log(`Seat ${seat[1]}: taken`); continue; }
        try {
          await book(session, day, seat);
          log(`Booked ${seat[1]}`);
          process.exit(0);
        } catch (e) {
          log(`Seat ${seat[1]} failed: ${e.message}`);
        }
      }
    } catch (e) {
      log(`Round ${round} error: ${e.message}`);
    }
    if (Date.now() + RETRY_GAP_MS > deadline) break;
    await sleep(RETRY_GAP_MS);
  }
  throw new Error("No seat could be booked before the retry window closed.");
} catch (e) {
  console.error(`[${new Date().toISOString()}] Failed:`, e.message);
  process.exitCode = 1;
}
