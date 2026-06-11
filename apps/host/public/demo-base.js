// Shared front-end runtime for the demo pages — loaded as a plain <script>
// before each page's inline script; no build step, everything lands in page
// scope. This file owns the cross-page plumbing: DOM/format helpers, the
// JSON POST wrapper, and the wire-trace renderer that turns the host's
// captured plugin-hook events into the "what just happened on the wire"
// panels. Pages keep their own rendering and pass `opts` where they differ
// (page 01: per-event topology pulses; page 02: long-trace capping).

const $ = (id) => document.getElementById(id);

// Machines are untrusted third parties: escape every API-derived value
// before it lands in innerHTML.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const post = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && data.error === undefined) data.error = `HTTP ${res.status}`;
  return data;
};

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmtBytes = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

// Eased number tween for metric count-ups; snaps instantly under reduced motion.
function countUp(el, from, to, fmt = (v) => String(Math.round(v))) {
  if (REDUCED || from === to || !Number.isFinite(from)) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 550;
  const step = (t) => {
    const k = Math.min((t - t0) / dur, 1);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------- wire traces: render the host-captured hook events ---------- */
const chainHtml = (...actors) => actors
  .map((a) => `<span class="actor ${a[0]}">${a[1]}</span>`)
  .join('<span style="color:var(--ink-faint)">→</span>');

function wireHopHtml(e) {
  if (e.type === 'attach') {
    const boot = e.url
      ? `fetched <code>GET ${esc(e.url)}/mf-manifest.json</code>, negotiated version`
      : `booted it (process driver), read its manifest, negotiated version`;
    return `<div class="whop">
      <span class="wchain">${chainHtml(['host', 'host'], ['machine', esc(e.machine)])}</span>
      <span class="wdetail"><b>${e.url ? 'attach' : 'boot'}</b> — resolved entry <code>${esc(e.entry)}</code>,
        ${boot}
        <b>${esc(e.version ?? '?')}</b>${e.requires ? ` against required <b>${esc(e.requires)}</b>` : ''}
        (${esc(e.runtime ?? 'unknown runtime')})${e.pulledFrom
          ? `<br />provenance: this machine was pulled from <code>${esc(e.pulledFrom)}</code> and boots from the local cache`
          : ''}</span>
    </div>`;
  }
  if (e.type === 'call') {
    return `<div class="whop">
      <span class="wchain">${chainHtml(['host', 'host'], ['machine', esc(e.machine)])}</span>
      <span class="wdetail"><b>rpc</b> <code>POST ${esc(e.url ?? '')}/mf/call</code>
        <span class="wreq">${esc(`{"module":"${e.module}","fn":"${e.fn}","args":${e.args}}`)}</span>
        → <span class="wres">${esc(e.result)}</span> <span class="wms">${e.ms.toFixed(1)}ms</span></span>
    </div>`;
  }
  if (e.type === 'snapshot') {
    return `<div class="whop">
      <span class="wchain">${chainHtml(['host', 'host'], ['machine', esc(e.machine)])}</span>
      <span class="wdetail"><b>snapshot</b> — state frozen into <code>${esc(e.snapFile)}</code></span>
    </div>`;
  }
  if (e.type === 'artifact') {
    const origin = esc(e.origin ?? '');
    const snapshotHop = e.artifact === 'snapshot'
      ? ` → <code>GET ${origin}/mf-snapshot</code> (<b>no-store</b> — every GET is a fresh fork point)`
      : '';
    // A ?digest= pin on the entry is part of the deployment config, shown
    // verbatim: the resolver refuses artifacts that don't match it.
    const pin = new URLSearchParams((e.entry ?? '').split('?')[1] ?? '').get('digest');
    const pinHop = pin
      ? `<br />entry pins <code>${esc(pin.slice(0, 19))}…</code> — the resolver verified the pulled image against the pin before boot`
      : '';
    return `<div class="whop">
      <span class="wchain">${chainHtml(['host', 'host'], ['machine', 'origin'])}</span>
      <span class="wdetail"><b>pull ${esc(e.artifact)}</b> (resolver-level fetch — bypasses the call circuit breaker by design) — resolved <code>${esc(e.entry)}</code>:
        <code>GET ${origin}/mf-manifest.json</code> (version negotiated <b>before</b> any artifact bytes moved)${snapshotHop}
        → image digest <b>${e.cacheHit ? 'HIT — image served from the local cache' : 'MISS — fetched + sha256-verified'}</b>${
          e.digest ? ` <code>${esc(String(e.digest).slice(0, 19))}…</code>` : ''}
        → <span class="wres">${fmtBytes(e.bytes)} moved</span> in <span class="wms">${e.ms}ms</span>, clone boots from the cache${pinHop}</span>
    </div>`;
  }
  if (e.type === 'crash') {
    return `<div class="whop">
      <span class="wchain">${chainHtml(['host', 'host'], ['machine', esc(e.machine)])}</span>
      <span class="wdetail"><b class="whot">crash</b> — transport failure: <span class="whot">${esc(e.error)}</span>
        — the runtime evicted the dead machine and emitted <code>onMachineCrash</code></span>
    </div>`;
  }
  if (e.type === 'circuit') {
    return e.state === 'open'
      ? `<div class="whop">
          <span class="wchain">${chainHtml(['host', 'host'], ['machine', esc(e.machine)])}</span>
          <span class="wdetail"><b class="whot">circuit open</b> — consecutive transport failures hit the
            breaker threshold; calls to <b>${esc(e.machine)}</b> now fail fast without touching the
            network (<code>onCircuitOpen</code>)</span>
        </div>`
      : `<div class="whop">
          <span class="wchain">${chainHtml(['host', 'host'], ['machine', esc(e.machine)])}</span>
          <span class="wdetail"><b class="wres">circuit closed</b> — a half-open probe call succeeded;
            calls flow to <b>${esc(e.machine)}</b> again (<code>onCircuitClose</code>)</span>
        </div>`;
  }
  if (e.type === 'reject') {
    return `<div class="whop">
      <span class="wchain">${chainHtml(['host', 'host'], ['machine', esc(e.machine)])}</span>
      <span class="wdetail"><b class="whot">attach refused</b> — resolved entry <code>${esc(e.entry)}</code>,
        fetched the manifest and negotiated the entry's required <b>${esc(e.required)}</b> →
        <span class="whot">${esc(e.error)}</span></span>
    </div>`;
  }
  // Unknown event type (server ahead of this renderer): show a generic hop
  // rather than silently dropping it — the hop count must stay honest.
  return `<div class="whop">
    <span class="wchain">${chainHtml(['host', 'host'], ['machine', esc(e.machine ?? '?')])}</span>
    <span class="wdetail"><b>${esc(e.type)}</b> event</span>
  </div>`;
}

/**
 * Fill a card's collapsible trace with one response's wire events.
 * opts.cap        render at most this many hops, collapsing the middle
 * opts.capNote    annotation inside the collapsed-middle marker
 * opts.onEvent    called once per wire event after rendering (page effects)
 */
function renderWire(detailsId, apiLabel, wire, { cap, capNote, onEvent } = {}) {
  const details = $(detailsId);
  if (!details) return;
  details.hidden = false;
  const body = details.querySelector('.wirebody');
  const browserHop = `<div class="whop">
    <span class="wchain">${chainHtml(['browser', 'browser'], ['host', 'host'])}</span>
    <span class="wdetail"><b>http</b> <code>${esc(apiLabel)}</code> — the browser never runs
      federation; loadRemote executes inside the host process</span>
  </div>`;
  const events = wire ?? [];
  let hops;
  if (cap && events.length > cap) {
    const skipped = events.length - cap + 1;
    hops = events.slice(0, cap - 1).map(wireHopHtml).join('') +
      `<div class="wskip">… ${skipped} more identical RPCs${capNote ? ` — ${esc(capNote)}` : ''} …</div>` +
      wireHopHtml(events[events.length - 1]);
  } else {
    hops = events.map(wireHopHtml).join('');
  }
  body.innerHTML = browserHop + (hops || '<div class="wempty">no machine traffic — containers were already cached in the host</div>');
  details.querySelector('.wcount').textContent = `${1 + events.length} hops`;
  if (onEvent) for (const e of events) onEvent(e);
}
