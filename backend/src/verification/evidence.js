/**
 * Independent evidence collection.
 *
 * The verification engine must not take the automation agent's word for
 * anything. This module builds the evidence model it *is* allowed to trust:
 *
 *   pages[]      — page content re-fetched by FlowFix itself, after the run
 *                  (step HTML artifacts when available, otherwise the target
 *                  URL). Independent of the agent.
 *   agent_report — the agent's own COMPLETE result payload, explicitly marked
 *                  as non-independent self-report.
 *   steps[]      — step observations from the record (context, non-independent).
 *   artifacts[]  — screenshots, recordings, streams (references only).
 *
 * Fetch failures are recorded as facts, never as success: an unreachable page
 * yields EVIDENCE_UNREACHABLE downstream, which can only make a verdict more
 * conservative (INCONCLUSIVE), never PASS.
 */

const MAX_TEXT_CHARS = 200_000;

/** Named entities that matter for assertions (prices, punctuation, quotes). */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  pound: '£',
  euro: '€',
  dollar: '$',
  rsquo: '\u2019',
  lsquo: '\u2018',
  rdquo: '\u201D',
  ldquo: '\u201C',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  middot: '\u00B7',
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  times: '\u00D7',
};

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** HTML → readable text. Good enough for assertions, not a full parser. */
export function htmlToText(html) {
  if (typeof html !== 'string') return '';
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = withoutBlocks
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
}

/** Default fetcher: plain HTTP GET with a timeout, returning text. */
export function createHttpFetcher({ timeoutMs = 5_000 } = {}) {
  return async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'FlowFix-AI-Verifier/1.0 (+independent-evidence)' },
        redirect: 'follow',
      });
      const body = await res.text();
      return { ok: res.ok, status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  };
}

function collectPageCandidates(record, targetUrl) {
  const candidates = [];
  const seen = new Set();
  const push = (url, kind, stepId = null) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, kind, step_id: stepId });
  };

  for (const item of record?.evidence ?? []) {
    if (item.kind === 'step_html' && item.url) push(item.url, 'step_html', item.step_id);
  }
  if (candidates.length === 0 && targetUrl) push(targetUrl, 'target_url');
  return candidates;
}

/**
 * Build the evidence model for one execution.
 *
 * @param {{
 *   record: object|null,
 *   targetUrl?: string,
 *   fetcher?: (url: string) => Promise<{ ok: boolean, status: number, body: string }>,
 *   maxPages?: number,
 * }} input
 */
export async function collectEvidence({ record, targetUrl = null, fetcher = null, maxPages = 3 }) {
  const doFetch = fetcher ?? createHttpFetcher();

  const candidates = collectPageCandidates(record, targetUrl).slice(0, maxPages);
  const pages = [];
  for (const candidate of candidates) {
    try {
      const res = await doFetch(candidate.url);
      pages.push({
        url: candidate.url,
        kind: candidate.kind,
        step_id: candidate.step_id,
        ok: Boolean(res.ok),
        status: res.status ?? null,
        text: htmlToText(res.body ?? ''),
        fetched_at: new Date().toISOString(),
        source: 'flowfix_independent_fetch',
        error: res.ok ? null : `HTTP ${res.status}`,
      });
    } catch (err) {
      pages.push({
        url: candidate.url,
        kind: candidate.kind,
        step_id: candidate.step_id,
        ok: false,
        status: null,
        text: '',
        fetched_at: new Date().toISOString(),
        source: 'flowfix_independent_fetch',
        error: err?.message ?? String(err),
      });
    }
  }

  const agentResult = (record?.observations ?? []).find((o) => o.kind === 'agent_result') ?? null;
  const artifacts = (record?.evidence ?? []).filter((item) => item.kind !== 'raw_event_log');

  return {
    pages,
    agent_report: agentResult
      ? {
          present: true,
          value: agentResult.result?.value ?? agentResult.result?.full_payload ?? null,
          raw: agentResult.result ?? null,
          source: agentResult.source ?? 'tinyfish_sse:COMPLETE.result',
          independent: false,
        }
      : { present: false, value: null, raw: null, source: null, independent: false },
    steps: (record?.observations ?? []).filter((o) => o.kind === 'agent_step'),
    artifacts,
    page_fetch_ok: pages.length > 0 && pages.every((p) => p.ok),
    page_fetch_attempted: pages.length > 0,
  };
}

/** Evidence reference strings for the verdict (stable, auditable). */
export function evidenceReferences(evidence, checks = []) {
  const refs = [];
  for (const page of evidence.pages ?? []) {
    refs.push(`${page.ok ? 'page' : 'page(unreachable)'}:${page.url}`);
  }
  if (evidence.agent_report?.present) refs.push(`agent_report:${evidence.agent_report.source}`);
  for (const artifact of evidence.artifacts ?? []) {
    if (artifact.url) refs.push(`${artifact.kind}:${artifact.url}`);
    else if (artifact.kind === 'raw_event_log') refs.push(`raw_event_log:${artifact.event_count ?? 0} events`);
  }
  for (const check of checks) {
    if (check.evidence_ref) refs.push(check.evidence_ref);
  }
  return [...new Set(refs)];
}
