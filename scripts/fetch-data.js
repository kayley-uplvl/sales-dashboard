#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.GHL_API_KEY;
const BASE_URL = 'services.leadconnectorhq.com';
const LOCATION_ID = 'KXjUx7xQ9u08VIUK4hNk';

const SURVEY_VSL   = 'NW4NyHJWgWuOcPquUTPs'; // Book a Call (Skyler's) — VSL survey
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

function fetchAllOpportunities() {
  return fetchAll(
    (p) => `/opportunities/search?location_id=${LOCATION_ID}&limit=100&page=${p}`,
    (r) => r.opportunities || r.data?.opportunities || [],
    'all-opps'
  );
}

async function fetchPipelineStageMap() {
  try {
    const r = await get(`/opportunities/pipelines?locationId=${LOCATION_ID}`);
    const pipelines = r.pipelines || r.data?.pipelines || [];
    const map = {};
    pipelines.forEach((pl) => {
      (pl.stages || []).forEach((st) => { map[st.id] = (st.name || '').toLowerCase(); });
    });
    console.log(`  Stage map built: ${Object.keys(map).length} stages`);
    return map;
  } catch (err) {
    console.error('  Warning: could not fetch pipelines:', err.message);
    return {};
  }
}

// Fetch appointments for a calendar without pagination params (GHL doesn't support them)
async function fetchAppointmentsForCalendar(calendarId, startISO, endISO) {
  try {
    const r = await get(`/calendars/events?locationId=${LOCATION_ID}&calendarId=${calendarId}&startTime=${encodeURIComponent(startISO)}&endTime=${encodeURIComponent(endISO)}`);
    return r.events || r.data?.events || [];
  } catch (err) {
    console.error(`  Warning calendar ${calendarId}:`, err.message);
    return [];
  }
}

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

  // ── VSL Survey Submissions ────────────────────────────────────────────────
  console.log('Fetching VSL survey submissions…');
  let vslSubs = await fetchSurveySubmissions(SURVEY_VSL);
  if (vslSubs.length === 0) {
    console.log('  Falling back to forms endpoint…');
    vslSubs = await fetchFormSubmissions(SURVEY_VSL);
  }
  console.log(`  VSL total: ${vslSubs.length}`);

  // Qualified VSL = VSL submissions that were NOT disqualified
  const vslQualified = vslSubs.filter((s) => s.status !== 'disqualified');
  console.log(`  VSL qualified (not disqualified): ${vslQualified.length}`);
  if (vslSubs.length > 0) {
    const statuses = [...new Set(vslSubs.map((s) => s.status))];
    console.log(`  VSL submission statuses: ${JSON.stringify(statuses)}`);
  }

  // ── Contact Page Submissions ──────────────────────────────────────────────
  console.log('Fetching Contact Page form submissions…');
  const contactSubs = await fetchFormSubmissions(FORM_CONTACT);
  console.log(`  Contact total: ${contactSubs.length}`);

  const vslStats          = periodStats(vslSubs, subDateFn);
  const contactStats      = periodStats(contactSubs, subDateFn);
  const vslQualifiedStats = periodStats(vslQualified, subDateFn);

  // Total leads = all submissions across both forms
  const allSubs      = [...vslSubs, ...contactSubs];
  const totalLeadStats = periodStats(allSubs, subDateFn);

  // ── All Opportunities ─────────────────────────────────────────────────────
  console.log('Fetching all opportunities…');
  const allOpps = await fetchAllOpportunities();
  console.log(`  Total opps: ${allOpps.length}`);

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

  // ── No Shows / Not a Fits ─────────────────────────────────────────────────
  // Log all unique lostReasonIds to understand what IDs are in use
  const lostReasonIds = [...new Set(lostOpps.map((o) => o.lostReasonId).filter(Boolean))];
  console.log(`  Unique lostReasonIds: ${JSON.stringify(lostReasonIds)}`);

  // Also check if any lost opps have stage names matching no-show / not a fit
  const noShowStage  = allOpps.filter((o) => stageName(o).includes('no'));
  const notAFitStage = allOpps.filter((o) => stageName(o).includes('declined') || stageName(o).includes('fit'));
  console.log(`  Stages with 'no': ${[...new Set(noShowStage.map(o => stageName(o)))].join(', ')}`);
  console.log(`  Stages with 'fit'/'declined': ${[...new Set(notAFitStage.map(o => stageName(o)))].join(', ')}`);

  // For now count all lost as canceled; no-show/not-a-fit will be 0 until lost reasons API is resolved
  const noShowsCount  = noShowStage.filter((o) => stageName(o) === 'no-show').length;
  const notAFitsCount = notAFitStage.filter((o) => stageName(o) === 'declined / not a fit').length;
  console.log(`  No Shows: ${noShowsCount}, Not a Fits: ${notAFitsCount}`);

  const canceledLast4Weeks  = lostOpps.filter((o) => inLast4Weeks(oppDateFn(o))).length;
  const canceledPrior4Weeks = lostOpps.filter((o) => inPrior4Weeks(oppDateFn(o))).length;

  // ── Calendar Events ───────────────────────────────────────────────────────
  console.log('Fetching calendars…');
  const calendarIds = await fetchCalendarIds();
  let upcomingCalls = 0;
  for (const calId of calendarIds) {
    const events = await fetchAppointmentsForCalendar(calId, now.toISOString(), thirtyDaysOut.toISOString());
    const confirmed = events.filter((e) => {
      const status = (e.status || e.appointmentStatus || '').toLowerCase();
      return status === 'confirmed' || status === 'booked';
    }).length;
    if (confirmed > 0) console.log(`  Calendar ${calId}: ${confirmed} upcoming`);
    upcomingCalls += confirmed;
  }
  console.log(`  Total upcoming confirmed: ${upcomingCalls}`);

  // ── Write data.json ───────────────────────────────────────────────────────
  const output = {
    lastUpdated:          now.toISOString(),
    vslSubmissions:       vslStats,
    contactSubmissions:   contactStats,
    totalLeads:           totalLeadStats,
    qualifiedLeads:       vslQualifiedStats,  // VSL only, not disqualified
    callsBooked:          callsBookedStats,
    upcomingCalls,
    noShows:              noShowsCount,
    notAFits:             notAFitsCount,
    canceledTotal:        lostOpps.length,
    canceledLast4Weeks,
    canceledPrior4Weeks,
    followingUp,
    closedSales:          closedStats,
  };

  const outPath = path.join(__dirname, '..', 'data.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\ndata.json written successfully`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
