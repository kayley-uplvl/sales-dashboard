#!/usr/bin/env node

/**
 * fetch-data.js
 * Fetches sales pipeline data from Go High Level (GHL) API v2
 * and writes the result to data.json for the GitHub Pages dashboard.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.GHL_API_KEY;
const BASE_URL = 'services.leadconnectorhq.com';
const LOCATION_ID = 'KXjUx7xQ9u08VIUK4hNk';

const FORM_VSL     = 'NW4NyHJWgWuOcPquUTPs'; // Book a Call (Skyler's) — VSL
const FORM_CONTACT = 'hAzymKnmEvJBNj7iO7ab'; // UPLVL Work w/Us Form — Contact Page

if (!API_KEY) {
  console.error('ERROR: GHL_API_KEY environment variable is not set.');
  process.exit(1);
}

// ─── Date windows ─────────────────────────────────────────────────────────────

const now      = new Date();
const MS_28    = 28 * 24 * 60 * 60 * 1000;
const cut28    = new Date(now.getTime() - MS_28);      // 28 days ago
const cut56    = new Date(now.getTime() - 2 * MS_28); // 56 days ago

function inLast4Weeks(dateStr)  { const d = new Date(dateStr); return d >= cut28 && d <= now; }
function inPrior4Weeks(dateStr) { const d = new Date(dateStr); return d >= cut56 && d < cut28; }

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: BASE_URL,
        path: urlPath,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Version: '2021-07-28',
          Accept: 'application/json',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(raw)); }
            catch (e) { reject(new Error(`JSON parse error for ${urlPath}: ${e.message}`)); }
          } else {
            reject(new Error(`HTTP ${res.statusCode} for ${urlPath}: ${raw.slice(0, 300)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ─── Generic paginated fetcher ────────────────────────────────────────────────

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

// ─── Specific fetchers ────────────────────────────────────────────────────────

function fetchFormSubmissions(formId) {
  return fetchAll(
    (p) => `/forms/submissions?locationId=${LOCATION_ID}&formId=${formId}&page=${p}&limit=20`,
    (r) => r.submissions || r.data?.submissions || [],
    `form:${formId}`
  );
}

function fetchSurveySubmissions(surveyId) {
  return fetchAll(
    (p) => `/surveys/submissions?locationId=${LOCATION_ID}&surveyId=${surveyId}&page=${p}&limit=20`,
    (r) => r.submissions || r.data?.submissions || [],
    `survey:${surveyId}`
  );
}

function fetchOpportunitiesByStage(stageName) {
  const enc = encodeURIComponent(stageName);
  return fetchAll(
    (p) => `/opportunities/search?location_id=${LOCATION_ID}&pipeline_stage_name=${enc}&limit=20&page=${p}`,
    (r) => {
      const opps = r.opportunities || r.data?.opportunities || [];
      if (p === 1) console.log(`  [${stageName}] API keys: ${Object.keys(r).join(', ')}, count: ${opps.length}`);
      return opps;
    },
    `stage:${stageName}`
  );
}

function fetchLostOpportunities() {
  return fetchAll(
    (p) => `/opportunities/search?location_id=${LOCATION_ID}&status=lost&page=${p}&limit=20`,
    (r) => r.opportunities || r.data?.opportunities || [],
    'lost-opps'
  );
}

function fetchCalendarEvents(startISO, endISO) {
  return fetchAll(
    (p) => `/calendars/events?locationId=${LOCATION_ID}&startTime=${encodeURIComponent(startISO)}&endTime=${encodeURIComponent(endISO)}&page=${p}&limit=20`,
    (r) => r.events || r.data?.events || [],
    'calendar-events'
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
const oppDateFn = (o) => o.dateAdded || o.createdAt || o.date_added;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting GHL data fetch…\n');

  const thirtyDaysOut = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // ── Form Submissions ──────────────────────────────────────────────────────
  console.log('Fetching VSL survey submissions…');
  let vslSubs = await fetchSurveySubmissions(FORM_VSL);
  if (vslSubs.length === 0) {
    console.log('  VSL survey returned 0, trying forms endpoint as fallback…');
    vslSubs = await fetchFormSubmissions(FORM_VSL);
  }
  console.log(`  VSL: ${vslSubs.length} total`);

  console.log('Fetching Contact Page form submissions…');
  const contactSubs = await fetchFormSubmissions(FORM_CONTACT);
  console.log(`  Contact: ${contactSubs.length} total`);

  const vslStats     = periodStats(vslSubs,     subDateFn);
  const contactStats = periodStats(contactSubs, subDateFn);

  // Qualified = not disqualified, across both forms
  const allSubs        = [...vslSubs, ...contactSubs];
  const qualifiedSubs  = allSubs.filter((s) => s.status !== 'disqualified');
  const qualifiedStats = periodStats(qualifiedSubs, subDateFn);

  // ── Pipeline: Call Booked ─────────────────────────────────────────────────
  console.log('Fetching Call Booked stage…');
  const callBookedOpps   = await fetchOpportunitiesByStage('Call Booked');
  const callsBookedStats = periodStats(callBookedOpps, oppDateFn);
  console.log(`  Call Booked: ${callsBookedStats.total} total`);

  // ── Pipeline: Follow Up ───────────────────────────────────────────────────
  console.log('Fetching Follow Up stage…');
  const followUpOpps = await fetchOpportunitiesByStage('Follow Up');
  const followingUp  = followUpOpps.length;
  console.log(`  Follow Up: ${followingUp}`);

  // ── Pipeline: Closed (won) ────────────────────────────────────────────────
  console.log('Fetching Closed stage…');
  const closedOpps   = await fetchOpportunitiesByStage('Closed');
  const wonOpps      = closedOpps.filter((o) => o.status === 'won');
  const closedStats  = periodStats(wonOpps, oppDateFn);
  console.log(`  Closed (won): ${closedStats.total} total`);

  // ── Lost Opportunities ────────────────────────────────────────────────────
  console.log('Fetching lost opportunities…');
  const lostOpps = await fetchLostOpportunities();
  console.log(`  Lost: ${lostOpps.length} total`);

  // Debug: log first lost opp keys and lostReason variants to find correct field name
  if (lostOpps.length > 0) {
    const sample = lostOpps[0];
    console.log(`  Lost opp sample keys: ${Object.keys(sample).join(', ')}`);
    console.log(`  lostReason: ${JSON.stringify(sample.lostReason)}, lost_reason: ${JSON.stringify(sample.lost_reason)}, lostReasonId: ${JSON.stringify(sample.lostReasonId)}`);
  }

  const getLostReason = (o) => (o.lostReason || o.lost_reason || o.lostReasonId || '').toString().toLowerCase();
  const noShows  = lostOpps.filter((o) => getLostReason(o).includes('no show'));
  const notAFits = lostOpps.filter((o) => getLostReason(o).includes('not a fit'));

  const canceledLast4Weeks  = lostOpps.filter((o) => inLast4Weeks(oppDateFn(o))).length;
  const canceledPrior4Weeks = lostOpps.filter((o) => inPrior4Weeks(oppDateFn(o))).length;
  console.log(`  No Shows: ${noShows.length}, Not a Fits: ${notAFits.length}`);

  // ── Calendar Events ───────────────────────────────────────────────────────
  console.log('Fetching upcoming calendar events…');
  let upcomingCalls = 0;
  try {
    const events = await fetchCalendarEvents(now.toISOString(), thirtyDaysOut.toISOString());
    upcomingCalls = events.filter((e) => {
      const status = (e.status || e.appointmentStatus || '').toLowerCase();
      const start  = new Date(e.startTime || e.start || 0);
      return status === 'confirmed' && start > now;
    }).length;
    console.log(`  Upcoming confirmed: ${upcomingCalls}`);
  } catch (err) {
    console.error('  Warning: calendar events failed:', err.message);
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
  console.log(`\ndata.json written to ${outPath}`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
