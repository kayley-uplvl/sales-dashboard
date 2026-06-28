#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.GHL_API_KEY;
const BASE_URL = 'services.leadconnectorhq.com';
const LOCATION_ID = 'KXjUx7xQ9u08VIUK4hNk';

const FORM_VSL     = 'NW4NyHJWgWuOcPquUTPs'; // Book a Call (Skyler's) — VSL survey
const FORM_CONTACT = 'hAzymKnmEvJBNj7iO7ab'; // UPLVL Work w/Us Form — Contact Page

if (!API_KEY) { console.error('ERROR: GHL_API_KEY not set.'); process.exit(1); }

// ─── Date windows ─────────────────────────────────────────────────────────────
const now   = new Date();
const MS_28 = 28 * 24 * 60 * 60 * 1000;
const cut28 = new Date(now.getTime() - MS_28);
const cut56 = new Date(now.getTime() - 2 * MS_28);

function inLast4Weeks(dateStr)  { const d = new Date(dateStr); return d >= cut28 && d <= now; }
function inPrior4Weeks(dateStr) { const d = new Date(dateStr); return d >= cut56 && d < cut28; }

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: BASE_URL, path: urlPath, method: 'GET',
        headers: { Authorization: `Bearer ${API_KEY}`, Version: '2021-07-28', Accept: 'application/json' } },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(raw)); }
            catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
          } else {
            reject(new Error(`HTTP ${res.statusCode} for ${urlPath}: ${raw.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ─── Paginated fetcher ────────────────────────────────────────────────────────
async function fetchAll(buildUrl, extractBatch, label) {
  const all = [];
  let page = 1;
  while (true) {
    try {
      const response = await get(buildUrl(page));
      const batch = extractBatch(response);
      if (!batch || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < 20) break;
      page++;
    } catch (err) {
      console.error(`  Warning [${label}] page ${page}:`, err.message);
      break;
    }
  }
  return all;
}

// ─── Fetchers ─────────────────────────────────────────────────────────────────
function fetchSurveySubmissions(surveyId) {
  return fetchAll(
    (p) => `/surveys/submissions?locationId=${LOCATION_ID}&surveyId=${surveyId}&page=${p}&limit=20`,
    (r) => r.submissions || r.data?.submissions || [],
    `survey:${surveyId}`
  );
}

function fetchFormSubmissions(formId) {
  return fetchAll(
    (p) => `/forms/submissions?locationId=${LOCATION_ID}&formId=${formId}&page=${p}&limit=20`,
    (r) => r.submissions || r.data?.submissions || [],
    `form:${formId}`
  );
}

// Fetch ALL opportunities for location, then filter client-side by stage name
function fetchAllOpportunities() {
  return fetchAll(
    (p) => `/opportunities/search?location_id=${LOCATION_ID}&limit=100&page=${p}`,
    (r) => r.opportunities || r.data?.opportunities || [],
    'all-opps'
  );
}

// Fetch pipeline stages to map pipelineStageId -> stage name
async function fetchPipelineStageMap() {
  try {
    const r = await get(`/opportunities/pipelines?locationId=${LOCATION_ID}`);
    const pipelines = r.pipelines || r.data?.pipelines || [];
    console.log(`  Pipelines found: ${pipelines.length}`);
    const map = {};
    pipelines.forEach((pl) => {
      (pl.stages || []).forEach((st) => {
        map[st.id] = (st.name || '').toLowerCase();
      });
    });
    console.log(`  Stage map: ${JSON.stringify(map)}`);
    return map;
  } catch (err) {
    console.error('  Warning: could not fetch pipelines:', err.message);
    return {};
  }
}

// Fetch lost reason definitions to map lostReasonId -> name
async function fetchLostReasons() {
  try {
    // Try v2 endpoint
    const r = await get(`/opportunities/lost-reasons/?locationId=${LOCATION_ID}`);
    const reasons = r.lostReasons || r.data?.lostReasons || r.lost_reasons || [];
    console.log(`  Lost reasons fetched: ${reasons.length}`);
    if (reasons.length > 0) console.log(`  Sample: ${JSON.stringify(reasons[0])}`);
    const map = {};
    reasons.forEach((lr) => { map[lr.id] = (lr.name || lr.reason || '').toLowerCase(); });
    return map;
  } catch (err) {
    console.error('  Warning: could not fetch lost reasons:', err.message);
    return {};
  }
}

// Fetch calendars to get IDs for appointment lookup
async function fetchCalendarIds() {
  try {
    const r = await get(`/calendars/?locationId=${LOCATION_ID}`);
    const cals = r.calendars || r.data?.calendars || [];
    console.log(`  Calendars found: ${cals.length}`);
    return cals.map((c) => c.id);
  } catch (err) {
    console.error('  Warning: could not fetch calendars:', err.message);
    return [];
  }
}

async function fetchAppointmentsForCalendar(calendarId, startISO, endISO) {
  return fetchAll(
    (p) => `/calendars/events?locationId=${LOCATION_ID}&calendarId=${calendarId}&startTime=${encodeURIComponent(startISO)}&endTime=${encodeURIComponent(endISO)}&page=${p}&limit=20`,
    (r) => r.events || r.data?.events || [],
    `cal:${calendarId}`
  );
}

// ─── Period stats ─────────────────────────────────────────────────────────────
function periodStats(items, dateFn) {
  return {
    total:       items.length,
    last4Weeks:  items.filter((i) => inLast4Weeks(dateFn(i))).length,
    prior4Weeks: items.filter((i) => inPrior4Weeks(dateFn(i))).length,
  };
}

const subDateFn = (s) => s.dateAdded || s.createdAt || s.date_added;
const oppDateFn = (o) => o.dateAdded || o.createdAt || o.date_added || o.lastStatusChangeAt;

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Starting GHL data fetch…\n');

  const thirtyDaysOut = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // ── Form/Survey Submissions ───────────────────────────────────────────────
  console.log('Fetching VSL survey submissions…');
  let vslSubs = await fetchSurveySubmissions(FORM_VSL);
  if (vslSubs.length === 0) {
    console.log('  Falling back to forms endpoint…');
    vslSubs = await fetchFormSubmissions(FORM_VSL);
  }
  console.log(`  VSL: ${vslSubs.length} total`);

  console.log('Fetching Contact Page form submissions…');
  const contactSubs = await fetchFormSubmissions(FORM_CONTACT);
  console.log(`  Contact: ${contactSubs.length} total`);

  const vslStats     = periodStats(vslSubs, subDateFn);
  const contactStats = periodStats(contactSubs, subDateFn);

  const allSubs       = [...vslSubs, ...contactSubs];
  const qualifiedSubs = allSubs.filter((s) => s.status !== 'disqualified');
  const qualifiedStats = periodStats(qualifiedSubs, subDateFn);

  // ── All Opportunities (fetch once, filter by stage) ───────────────────────
  console.log('Fetching all opportunities…');
  const allOpps = await fetchAllOpportunities();
  console.log(`  Total opps: ${allOpps.length}`);

  // Fetch pipeline stage ID -> name map
  console.log('Fetching pipeline stage map…');
  const stageMap = await fetchPipelineStageMap();

  const stageName = (o) => stageMap[o.pipelineStageId] || '';

  const callBookedOpps = allOpps.filter((o) => stageName(o) === 'call booked');
  const followUpOpps   = allOpps.filter((o) => stageName(o) === 'follow up');
  const closedOpps     = allOpps.filter((o) => stageName(o) === 'closed' && o.status === 'won');
  const lostOpps       = allOpps.filter((o) => o.status === 'lost');

  console.log(`  Call Booked: ${callBookedOpps.length}, Follow Up: ${followUpOpps.length}, Closed(won): ${closedOpps.length}, Lost: ${lostOpps.length}`);

  const callsBookedStats = periodStats(callBookedOpps, oppDateFn);
  const followingUp      = followUpOpps.length;
  const closedStats      = periodStats(closedOpps, oppDateFn);

  // ── Lost Reasons (map ID -> name) ─────────────────────────────────────────
  console.log('Fetching lost reason definitions…');
  const lostReasonMap = await fetchLostReasons();
  console.log(`  Lost reason map: ${JSON.stringify(lostReasonMap)}`);

  // Debug first few lost opps
  if (lostOpps.length > 0) {
    const s = lostOpps[0];
    console.log(`  Lost opp[0] lostReasonId: ${s.lostReasonId}, name via map: ${lostReasonMap[s.lostReasonId]}`);
  }

  const getLostReasonName = (o) => lostReasonMap[o.lostReasonId] || (o.lostReason || '').toLowerCase();
  const noShows  = lostOpps.filter((o) => getLostReasonName(o).includes('no show'));
  const notAFits = lostOpps.filter((o) => getLostReasonName(o).includes('not a fit'));
  console.log(`  No Shows: ${noShows.length}, Not a Fits: ${notAFits.length}`);

  const canceledLast4Weeks  = lostOpps.filter((o) => inLast4Weeks(oppDateFn(o))).length;
  const canceledPrior4Weeks = lostOpps.filter((o) => inPrior4Weeks(oppDateFn(o))).length;

  // ── Calendar Events ───────────────────────────────────────────────────────
  console.log('Fetching calendars…');
  const calendarIds = await fetchCalendarIds();
  let upcomingCalls = 0;
  for (const calId of calendarIds) {
    try {
      const events = await fetchAppointmentsForCalendar(calId, now.toISOString(), thirtyDaysOut.toISOString());
      const confirmed = events.filter((e) => {
        const status = (e.status || e.appointmentStatus || '').toLowerCase();
        return status === 'confirmed';
      }).length;
      upcomingCalls += confirmed;
      console.log(`  Calendar ${calId}: ${confirmed} confirmed upcoming`);
    } catch (err) {
      console.error(`  Warning calendar ${calId}:`, err.message);
    }
  }

  // ── Write data.json ───────────────────────────────────────────────────────
  const output = {
    lastUpdated:        now.toISOString(),
    vslSubmissions:     vslStats,
    contactSubmissions: contactStats,
    qualifiedLeads:     qualifiedStats,
    callsBooked:        callsBookedStats,
    upcomingCalls,
    noShows:            noShows.length,
    notAFits:           notAFits.length,
    canceledLast4Weeks,
    canceledPrior4Weeks,
    followingUp,
    closedSales:        closedStats,
  };

  const outPath = path.join(__dirname, '..', 'data.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\ndata.json written successfully`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
