// Admin mode: the site owner triggers the "Refresh market data" GitHub
// Actions workflow from the page. The gate is GitHub itself — dispatching a
// workflow needs a token with write access to the repo, so visitors cannot
// trigger anything even if they find this code.
import { SITE } from './config.js';
import { ago, esc, openModal, sleep, store, toast } from './core.js';

const TOKEN_KEY = 'rupevo-admin-token';
const API = 'https://api.github.com';
const { owner, name: repo, branch, workflow } = SITE.repo;
const REPO_PATH = `/repos/${owner}/${repo}`;
const WORKFLOW_URL = `https://github.com/${owner}/${repo}/actions/workflows/${workflow}`;
const MARKET_TITLES = {
  india: 'Nifty 100', us: 'US stocks (NASDAQ-100 and NYSE top 100)', both: 'both stock rankings',
  mf: 'mutual funds', all: 'everything (stock rankings and mutual funds)',
};
// Rough run times shown before a refresh starts (AMFI allows about one request a second).
const MARKET_MINUTES = { india: '3–6', us: '3–6', both: '4–8', mf: '10–20', all: '15–25' };

export const getToken = () => store.get(TOKEN_KEY, 'session') || store.get(TOKEN_KEY) || '';
export const isAdmin = () => Boolean(getToken());

function setToken(token, remember) {
  store.remove(TOKEN_KEY);
  store.set(TOKEN_KEY, token, remember ? 'local' : 'session');
  window.dispatchEvent(new CustomEvent('rupevo:admin-change'));
}
function forgetToken() {
  store.remove(TOKEN_KEY);
  window.dispatchEvent(new CustomEvent('rupevo:admin-change'));
}

class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function gh(path, { method = 'GET', body, token = getToken() } = {}) {
  const res = await fetch(API + path, {
    method,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GitHubError(res.status, data.message || res.statusText);
  return data;
}

function explain(err) {
  if (err.status === 401) return 'GitHub rejected the token (expired or mistyped). Paste a new one from the admin panel.';
  if (err.status === 403) return 'The token cannot run workflows. Give it “Actions: Read and write” on this repository.';
  if (err.status === 404) return 'Workflow not found. Make sure .github/workflows/refresh-data.yml is pushed to main.';
  if (err.status === 422) return `GitHub refused the request: ${err.message}`;
  return err.message || 'Unexpected error talking to GitHub.';
}

async function latestRuns(count = 5) {
  const data = await gh(`${REPO_PATH}/actions/workflows/${workflow}/runs?per_page=${count}`);
  return data?.workflow_runs || [];
}

function runLabel(run) {
  if (!run) return 'Waiting for GitHub to queue the run…';
  if (run.status === 'completed') {
    return run.conclusion === 'success' ? 'Finished — new data deployed.' : `Finished: ${run.conclusion}.`;
  }
  return run.status === 'queued' ? 'Queued on GitHub Actions…' : 'Running: downloading prices and scoring…';
}

let activeRefresh = null;

/** Confirm, dispatch the workflow and follow the run until it completes. */
export function startRefresh(market, { onDone } = {}) {
  if (activeRefresh) {
    toast('A refresh is already running — follow it on GitHub Actions.');
    return;
  }
  const title = MARKET_TITLES[market] || market;
  openModal({
    title: `Refresh ${title}?`,
    body: `<p>This runs the <strong>Refresh market data</strong> workflow on GitHub Actions:
      it downloads the latest data, recomputes the ${market === 'mf' ? 'comparison' : 'ranking'}, commits
      the new snapshot and redeploys the site. It usually takes ${MARKET_MINUTES[market] || '3–6'} minutes.</p>`,
    actions: [
      { label: 'Cancel', kind: 'alt' },
      { label: 'Run refresh', onClick: ({ close }) => { close(); dispatchAndFollow(market, title, onDone); } },
    ],
  });
}

async function dispatchAndFollow(market, title, onDone) {
  const ui = openModal({
    title: `Refreshing ${title}`,
    body: `<div class="status-line" id="run-status">Starting…</div>
      <p class="small muted">You can close this window — the refresh keeps running on GitHub.
      <a href="${WORKFLOW_URL}" target="_blank" rel="noopener">Open GitHub Actions</a></p>`,
  });
  const status = ui.body.querySelector('#run-status');
  const show = (html, cls = '') => {
    status.className = `status-line ${cls}`.trim();
    status.innerHTML = html;
  };

  activeRefresh = { market };
  const started = Date.now();
  try {
    const before = (await latestRuns(1))[0]?.id || 0;
    await gh(`${REPO_PATH}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST', body: { ref: branch, inputs: { market } },
    });
    show('Dispatched. Waiting for GitHub to queue the run…');

    let run = null;
    while (Date.now() - started < 30 * 60 * 1000) {
      await sleep(6000);
      const runs = await latestRuns(5);
      run = runs.find((r) => r.id > before && r.event === 'workflow_dispatch') || run;
      const mins = Math.floor((Date.now() - started) / 60000);
      const secs = Math.floor(((Date.now() - started) / 1000) % 60);
      const link = run ? ` <a href="${esc(run.html_url)}" target="_blank" rel="noopener">View run</a>` : '';
      show(`${esc(runLabel(run))} <span class="muted">(${mins}:${String(secs).padStart(2, '0')})</span>${link}`);
      if (run?.status === 'completed') break;
    }

    if (run?.status === 'completed' && run.conclusion === 'success') {
      show('Finished — loading the new data…', 'ok');
      await onDone?.();
      show(`Done. The ${esc(title)} data on this page is up to date.`, 'ok');
      toast(`${title} refreshed.`, 'ok');
    } else if (run?.status === 'completed') {
      show(`The run finished with “${esc(run.conclusion)}”. The previous data is still live.
        <a href="${esc(run.html_url)}" target="_blank" rel="noopener">See the log</a>`, 'bad');
      toast(`Refresh ${run.conclusion}.`, 'bad');
    } else {
      show('Still running after 30 minutes — check GitHub Actions.', 'bad');
    }
  } catch (err) {
    show(esc(explain(err)), 'bad');
    toast('Refresh could not start.', 'bad');
  } finally {
    activeRefresh = null;
  }
}

function runRow(run) {
  const result = run.status === 'completed' ? run.conclusion : run.status;
  const cls = result === 'success' ? 'pos' : (result === 'failure' || result === 'cancelled') ? 'neg' : 'muted';
  const market = (run.display_title || run.name || '').replace(/^Refresh market data\s*/i, '');
  return `<li><a href="${esc(run.html_url)}" target="_blank" rel="noopener">#${esc(run.run_number)}</a>
    <span class="${cls}">${esc(result)}</span> <span class="muted">${esc(market)} · ${esc(ago(run.created_at))}</span></li>`;
}

/** Footer "Admin" link: enable admin mode, or run refreshes when enabled.
 * `onEnabled` runs once a pasted token is verified; `reason` explains why the panel opened. */
export function openAdminPanel({ onRefreshed, onEnabled, reason = '' } = {}) {
  if (!isAdmin()) {
    const ui = openModal({
      title: 'Admin mode',
      body: `${reason ? `<div class="callout"><p>${esc(reason)}</p></div>` : ''}
        <p>Admin mode lets the site owner refresh the rankings from this page. It needs a GitHub
        fine-grained personal access token that can run this repository's workflows.</p>
        <ol>
          <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → Fine-grained tokens → Generate new token</a>.</li>
          <li>Repository access: <strong>Only select repositories → ${esc(owner)}/${esc(repo)}</strong>.</li>
          <li>Permissions → Repository permissions → <strong>Actions: Read and write</strong>.</li>
          <li>Generate, copy and paste it here.</li>
        </ol>
        <label class="field">Token
          <input type="password" id="admin-token" autocomplete="off" spellcheck="false" placeholder="github_pat_…">
        </label>
        <label class="small"><input type="checkbox" id="admin-remember" checked> Remember on this device</label>
        <p class="small muted">The token stays in this browser and is only ever sent to api.github.com.</p>
        <div id="admin-status" hidden></div>`,
      actions: [
        { label: 'Cancel', kind: 'alt' },
        {
          label: 'Verify & enable',
          onClick: async ({ close, btn }) => {
            const input = ui.body.querySelector('#admin-token');
            const out = ui.body.querySelector('#admin-status');
            const token = input.value.trim();
            if (!token) { input.focus(); return; }
            btn.disabled = true;
            out.hidden = false;
            out.className = 'status-line';
            out.textContent = 'Checking the token with GitHub…';
            try {
              const info = await gh(REPO_PATH, { token });
              const p = info.permissions || {};
              if (!(p.admin || p.maintain || p.push)) {
                throw new GitHubError(403, 'This token belongs to an account without write access to the repository.');
              }
              setToken(token, ui.body.querySelector('#admin-remember').checked);
              close();
              toast('Admin mode enabled on this browser.', 'ok');
              onEnabled?.();
            } catch (err) {
              out.className = 'status-line bad';
              out.textContent = err.status === 403 ? err.message : explain(err);
              btn.disabled = false;
            }
          },
        },
      ],
    });
    ui.body.querySelector('#admin-token').focus();
    return;
  }

  const ui = openModal({
    title: 'Admin mode',
    body: `
      <p>Admin mode is on for this browser. Refreshing runs the GitHub Actions workflow, commits
      the new snapshot and redeploys the site.</p>
      <div class="footer-row">
        <button class="btn" type="button" data-market="india">Refresh Nifty 100</button>
        <button class="btn" type="button" data-market="us">Refresh US (NASDAQ + NYSE)</button>
        <button class="btn" type="button" data-market="mf">Refresh mutual funds</button>
        <button class="btn alt" type="button" data-market="all">Refresh all</button>
      </div>
      <p class="small muted" style="margin:0">Automatic refreshes: both stock rankings every Tuesday to
        Saturday at 06:47 IST, mutual funds every Saturday at 09:17 IST.</p>
      <div><h3 class="small muted" style="margin:0 0 6px">Recent refresh runs</h3>
        <ul class="tile-list" id="admin-runs"><li class="muted">Loading…</li></ul></div>`,
    actions: [
      { label: 'Forget token', kind: 'alt', onClick: ({ close }) => { forgetToken(); close(); toast('Admin token removed from this browser.'); } },
      { label: 'Close' },
    ],
  });
  ui.body.querySelectorAll('[data-market]').forEach((btn) => btn.addEventListener('click', () => {
    ui.close();
    startRefresh(btn.dataset.market, { onDone: onRefreshed });
  }));
  latestRuns(5).then((runs) => {
    ui.body.querySelector('#admin-runs').innerHTML = runs.length
      ? runs.map(runRow).join('') : '<li class="muted">No runs yet.</li>';
  }).catch((err) => {
    ui.body.querySelector('#admin-runs').innerHTML = `<li class="neg">${esc(explain(err))}</li>`;
  });
}

// ── Refresh links in request emails ──
// A visitor's "Request refresh" email carries a link to the page with ?refresh=<market>.
// Opened in a browser where admin mode is on, the page asks to confirm and runs the
// refresh; anywhere else it asks for the token first. The link itself grants nothing.
const REFRESH_PARAM = 'refresh';
export const WORKFLOW_PAGE = WORKFLOW_URL;

export function refreshLink(market, href = window.location.href) {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  url.searchParams.set(REFRESH_PARAM, market);
  return url.href;
}

/** Act on ?refresh=<market> in the page URL (then drop it). Returns true when present. */
export function handleRefreshLink(pageMarket, { onDone } = {}) {
  const url = new URL(window.location.href);
  const wanted = url.searchParams.get(REFRESH_PARAM);
  if (wanted === null) return false;
  url.searchParams.delete(REFRESH_PARAM);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  const market = MARKET_TITLES[wanted] ? wanted : pageMarket;
  if (isAdmin()) {
    startRefresh(market, { onDone });
  } else {
    openAdminPanel({
      reason: `This link refreshes ${MARKET_TITLES[market] || market}. Only the site owner can run a refresh:
        paste your admin token to continue.`,
      onEnabled: () => startRefresh(market, { onDone }),
      onRefreshed: onDone,
    });
  }
  return true;
}
