/**
 * BASTARD Feedback API — Cloudflare Worker + D1
 *
 * POST /events   — receive anonymous telemetry events
 * GET  /insights — return aggregate stats (cached 1h)
 * GET  /health   — liveness check
 */

interface Env {
  DB: D1Database;
}

// ── Event validation ──────────────────────────────────────────────────────────

const VALID_EVENTS = [
  'project_init', 'project_complete', 'gate_check',
  'round_advance', 'slop_scan', 'design_scan', 'coherence_scan',
] as const;

const VALID_SCORES = ['A', 'B', 'C', 'D', 'F', '-'];

interface IncomingEvent {
  bastardVersion: string;
  nodeVersion?: string;
  os?: string;
  sessionHash: string;
  event: string;
  timestamp?: string;
  roundId?: number;
  gatePassed?: boolean;
  gateChecks?: Record<string, boolean>;
  slopScore?: string;
  slopPatterns?: Record<string, number>;
  designScore?: string;
  designChecksPassed?: number;
  coherenceScore?: number;
  coherenceIssueTypes?: Record<string, number>;
  roundDurationMinutes?: number;
  parentsInstalled?: string[];
  totalRoundsCompleted?: number;
}

function validateEvent(data: unknown): IncomingEvent | null {
  if (!data || typeof data !== 'object') return null;
  const e = data as Record<string, unknown>;

  if (typeof e.bastardVersion !== 'string') return null;
  if (typeof e.sessionHash !== 'string' || e.sessionHash.length < 8) return null;
  if (typeof e.event !== 'string' || !VALID_EVENTS.includes(e.event as typeof VALID_EVENTS[number])) return null;
  if (e.slopScore && !VALID_SCORES.includes(e.slopScore as string)) return null;
  if (e.designScore && !VALID_SCORES.includes(e.designScore as string)) return null;
  if (e.coherenceScore !== undefined && (typeof e.coherenceScore !== 'number' || e.coherenceScore < 0 || e.coherenceScore > 100)) return null;

  return e as unknown as IncomingEvent;
}

// ── Rate limiting (simple in-memory, resets on worker restart) ─────────────────

const rateLimits = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const limit = rateLimits.get(ip);

  if (!limit || limit.resetAt < now) {
    rateLimits.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }

  limit.count++;
  return limit.count > 100; // 100 events/minute per IP
}

// ── POST /events ──────────────────────────────────────────────────────────────

async function handlePostEvent(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (isRateLimited(ip)) {
    return new Response('Rate limited', { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const event = validateEvent(body);
  if (!event) {
    return new Response('Invalid event schema', { status: 400 });
  }

  await env.DB.prepare(`
    INSERT INTO events (
      session_hash, event_type, bastard_version, node_version, os,
      round_id, gate_passed, round_duration_minutes, total_rounds_completed,
      slop_score, design_score, design_checks_passed, coherence_score,
      gate_checks, slop_patterns, coherence_issue_types, parents_installed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    event.sessionHash,
    event.event,
    event.bastardVersion,
    event.nodeVersion ?? null,
    event.os ?? null,
    event.roundId ?? null,
    event.gatePassed !== undefined ? (event.gatePassed ? 1 : 0) : null,
    event.roundDurationMinutes ?? null,
    event.totalRoundsCompleted ?? null,
    event.slopScore ?? null,
    event.designScore ?? null,
    event.designChecksPassed ?? null,
    event.coherenceScore ?? null,
    event.gateChecks ? JSON.stringify(event.gateChecks) : null,
    event.slopPatterns ? JSON.stringify(event.slopPatterns) : null,
    event.coherenceIssueTypes ? JSON.stringify(event.coherenceIssueTypes) : null,
    event.parentsInstalled ? JSON.stringify(event.parentsInstalled) : null,
  ).run();

  return new Response('ok', { status: 201 });
}

// ── GET /insights ─────────────────────────────────────────────────────────────

async function computeInsights(env: Env): Promise<object> {
  // Total unique projects
  const totalResult = await env.DB.prepare(
    'SELECT COUNT(DISTINCT session_hash) as total FROM events',
  ).first<{ total: number }>();
  const totalProjects = totalResult?.total ?? 0;

  // Top slop pattern
  const slopRows = await env.DB.prepare(
    "SELECT slop_patterns FROM events WHERE slop_patterns IS NOT NULL AND created_at > datetime('now', '-30 days')",
  ).all<{ slop_patterns: string }>();

  const patternCounts: Record<string, number> = {};
  let slopEventCount = 0;
  for (const row of slopRows.results) {
    try {
      const patterns = JSON.parse(row.slop_patterns);
      slopEventCount++;
      for (const [name, count] of Object.entries(patterns)) {
        patternCounts[name] = (patternCounts[name] ?? 0) + (count as number);
      }
    } catch { /* skip malformed */ }
  }

  const topPattern = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
  const topSlopPattern = topPattern && slopEventCount > 0
    ? { name: topPattern[0], percentage: Math.round((topPattern[1] / slopEventCount) * 100) }
    : null;

  // Average coherence score
  const coherenceResult = await env.DB.prepare(
    'SELECT AVG(coherence_score) as avg FROM events WHERE coherence_score IS NOT NULL',
  ).first<{ avg: number }>();
  const averageCoherenceScore = Math.round(coherenceResult?.avg ?? 0);

  // Most failed gate (round with highest failure rate)
  const gateResults = await env.DB.prepare(`
    SELECT round_id, gate_passed, COUNT(*) as cnt
    FROM events WHERE event_type = 'gate_check' AND round_id IS NOT NULL
    GROUP BY round_id, gate_passed
  `).all<{ round_id: number; gate_passed: number; cnt: number }>();

  const roundStats: Record<number, { pass: number; fail: number }> = {};
  for (const row of gateResults.results) {
    if (!roundStats[row.round_id]) roundStats[row.round_id] = { pass: 0, fail: 0 };
    if (row.gate_passed) roundStats[row.round_id].pass += row.cnt;
    else roundStats[row.round_id].fail += row.cnt;
  }

  let mostFailedGate: { description: string; percentage: number } | null = null;
  let highestFailRate = 0;
  for (const [round, stats] of Object.entries(roundStats)) {
    const total = stats.pass + stats.fail;
    const failRate = total > 0 ? (stats.fail / total) * 100 : 0;
    if (failRate > highestFailRate) {
      highestFailRate = failRate;
      mostFailedGate = { description: `Round ${round} gate`, percentage: Math.round(failRate) };
    }
  }

  // Average time to Round 5
  const durationResult = await env.DB.prepare(`
    SELECT AVG(round_duration_minutes) as avg
    FROM events WHERE event_type = 'round_advance' AND round_id <= 5
  `).first<{ avg: number }>();
  const avgMinutes = durationResult?.avg ?? 0;
  const averageTimeToRound5Hours = Math.round((avgMinutes * 5) / 60 * 10) / 10; // rough estimate

  // Completion rate
  const completedResult = await env.DB.prepare(
    "SELECT COUNT(DISTINCT session_hash) as cnt FROM events WHERE event_type = 'project_complete'",
  ).first<{ cnt: number }>();
  const completionRate = totalProjects > 0
    ? Math.round(((completedResult?.cnt ?? 0) / totalProjects) * 100)
    : 0;

  // Parent adoption
  const parentRows = await env.DB.prepare(
    'SELECT parents_installed FROM events WHERE parents_installed IS NOT NULL',
  ).all<{ parents_installed: string }>();

  const parentCounts: Record<string, number> = {};
  let parentEvents = 0;
  for (const row of parentRows.results) {
    try {
      const parents: string[] = JSON.parse(row.parents_installed);
      parentEvents++;
      for (const p of parents) parentCounts[p] = (parentCounts[p] ?? 0) + 1;
    } catch { /* skip */ }
  }

  const parentAdoption: Record<string, number> = {};
  if (parentEvents > 0) {
    for (const [name, count] of Object.entries(parentCounts)) {
      parentAdoption[name] = Math.round((count / parentEvents) * 100);
    }
  }

  return {
    totalProjects,
    topSlopPattern,
    averageCoherenceScore,
    mostSkippedRound: null, // TODO: derive from round_advance gaps
    mostFailedGate,
    parentAdoption,
    averageTimeToRound5Hours,
    completionRate,
  };
}

async function handleGetInsights(env: Env): Promise<Response> {
  // Check cache (1 hour TTL)
  const cached = await env.DB.prepare(
    "SELECT data, updated_at FROM insights_cache WHERE id = 1 AND updated_at > datetime('now', '-1 hour')",
  ).first<{ data: string; updated_at: string }>();

  if (cached) {
    return new Response(cached.data, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
    });
  }

  // Compute fresh
  const insights = await computeInsights(env);
  const json = JSON.stringify(insights);

  // Upsert cache
  await env.DB.prepare(
    "INSERT INTO insights_cache (id, data, updated_at) VALUES (1, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET data = ?, updated_at = datetime('now')",
  ).bind(json, json).run();

  return new Response(json, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
}

// ── Router ────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    let response: Response;

    if (url.pathname === '/events' && request.method === 'POST') {
      response = await handlePostEvent(request, env);
    } else if (url.pathname === '/insights' && request.method === 'GET') {
      response = await handleGetInsights(env);
    } else if (url.pathname === '/health') {
      response = new Response(JSON.stringify({ status: 'ok', version: '1.0.0' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } else {
      response = new Response('Not found', { status: 404 });
    }

    // Add CORS headers to all responses
    for (const [key, value] of Object.entries(cors)) {
      response.headers.set(key, value);
    }

    return response;
  },
};
