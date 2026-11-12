// ==UserScript==
// @name         QuickApprove
// @namespace    http://rix0r.nl/
// @version      0.1.0
// @description  Quickly Approve GitHub Deployments
// @author       Rico
// @require      http://code.jquery.com/jquery-latest.js
// @match        https://github.com/*
// ==/UserScript==

const BUTTONS_CLASS = 'quick-approve-buttons';
const JOB_URL_RE = /\/[^/\s]+\/[^/\s]+\/actions\/runs\/(\d+)\/job\/(\d+)/;
const APPROVAL_INFO_TTL_MS = 30_000;

interface WaitingJob {
  readonly runId: string;
  readonly jobUrl: string;
}

interface ApprovalInfo {
  readonly form: HTMLFormElement;
  readonly environments: string[];
}

interface PendingDeployment extends WaitingJob {
  readonly environments: string[];
}

interface Cached<A> {
  readonly at: number;
  readonly value: Promise<A>;
}

const approvalInfoCache = new Map<string, Cached<ApprovalInfo | undefined>>();
const approvedRuns = new Set<string>();

let scanTimer: number | undefined;
let scanning = false;
let rescanRequested = false;

// GitHub renders PR pages with a mix of Turbo navigations, React updates and
// live-updated partials, none of which reliably announces itself. Watch the
// whole document and rescan (debounced) whenever something changes.
new MutationObserver((mutations) => {
  if (mutations.every(isOwnMutation)) {
    return;
  }
  scheduleScan();
}).observe(document.documentElement, { childList: true, subtree: true });

document.addEventListener('turbo:load', scheduleScan);
window.addEventListener('popstate', scheduleScan);
scheduleScan();

function isOwnMutation(m: MutationRecord) {
  return m.target instanceof Element && m.target.closest(`.${BUTTONS_CLASS}`) !== null;
}

function scheduleScan() {
  window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(runScan, 300);
}

async function runScan() {
  if (scanning) {
    rescanRequested = true;
    return;
  }
  scanning = true;
  try {
    for (const box of findDeploymentBoxes()) {
      await scanBox(box);
    }
  } catch (e) {
    console.error('QuickApprove:', e);
  } finally {
    scanning = false;
    if (rescanRequested) {
      rescanRequested = false;
      scheduleScan();
    }
  }
}

/**
 * The "This branch is waiting for a deployment approval" boxes on the page
 */
function findDeploymentBoxes(): HTMLElement[] {
  return $('.branch-action-item').filter((_, el) => $(el).find('.status-heading').length > 0
    && $(el).find('.branch-action-item-icon .octicon-rocket').length > 0).get();
}

async function scanBox(box: HTMLElement) {
  const heading = $(box).find('.status-heading').first();
  const waiting = /waiting/i.test(heading.text())
    ? waitingJobsInBox(box).filter((job) => !approvedRuns.has(job.runId))
    : [];

  const pending: PendingDeployment[] = [];
  for (const job of waiting) {
    const info = await approvalInfo(job.jobUrl);
    if (info) {
      pending.push({ ...job, environments: info.environments });
    }
  }

  renderButtons(box, pending);
}

/**
 * The jobs linked from the environment rows of a deployments box, one per run
 */
function waitingJobsInBox(box: HTMLElement): WaitingJob[] {
  const byRun = new Map<string, WaitingJob>();
  $(box).find('.merge-status-list a[href*="/actions/runs/"]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    if (JOB_URL_RE.test(href)) {
      const job = waitingJob(href);
      byRun.set(job.runId, job);
    }
  });
  return Array.from(byRun.values());
}

function waitingJob(url: string): WaitingJob {
  const jobUrl = new URL(url, window.location.origin);
  jobUrl.search = '';
  const runId = jobUrl.pathname.match(JOB_URL_RE)?.[1] ?? '';
  return { runId, jobUrl: jobUrl.toString() };
}

/**
 * Load the job page and find the "Review deployments" form on it.
 *
 * Returns `undefined` if there is nothing to approve, or the user can't approve it.
 */
function approvalInfo(jobUrl: string): Promise<ApprovalInfo | undefined> {
  return cached(approvalInfoCache, jobUrl, APPROVAL_INFO_TTL_MS, async () => {
    const response = await fetch(jobUrl);
    if (!response.ok) {
      return undefined;
    }
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    const form = Array.from(page.querySelectorAll('form'))
      .find((f) => f.getAttribute('action')?.endsWith('approve_or_reject'));
    if (!form) {
      return undefined;
    }
    return { form, environments: environmentNames(form) };
  });
}

function environmentNames(form: HTMLFormElement): string[] {
  const names = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).map((cb) => {
    const label = cb.closest('label') ?? (cb.id ? form.querySelector(`label[for="${CSS.escape(cb.id)}"]`) : null);
    const text = (label ?? cb.parentElement)?.textContent ?? '';
    return text.trim().split(/\s+/)[0];
  }).filter(Boolean);
  return Array.from(new Set(names));
}

async function approve(job: PendingDeployment) {
  // Always use a fresh form, the token in a cached one may have expired
  approvalInfoCache.delete(job.jobUrl);
  const info = await approvalInfo(job.jobUrl);
  const action = info?.form.getAttribute('action');
  if (!info || !action) {
    throw new Error(`Nothing to approve for ${job.jobUrl}`);
  }

  const response = await fetch(action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: collectFormData(info.form),
  });
  if (!response.ok) {
    throw new Error(`Approval failed: ${response.status} ${response.statusText}`);
  }

  approvedRuns.add(job.runId);
  approvalInfoCache.delete(job.jobUrl);
}

/**
 * From the "Review deployments" form, collect the data that approves all environments.
 */
function collectFormData(form: HTMLFormElement) {
  const ret = new URLSearchParams();

  form.querySelectorAll<HTMLInputElement>('input').forEach((el) => {
    if (!el.name || ['submit', 'button', 'image', 'reset'].includes(el.type)) {
      return;
    }
    // Checkboxes are the environments to approve; tick all of them
    ret.append(el.name, (el.type === 'checkbox' || el.type === 'radio') ? (el.value || 'on') : el.value);
  });
  form.querySelectorAll<HTMLTextAreaElement>('textarea').forEach((el) => {
    if (el.name) {
      ret.append(el.name, el.value);
    }
  });

  const submits = Array.from(form.querySelectorAll<HTMLButtonElement>('button[type="submit"]')).filter((b) => b.name);
  const approveButton = submits.find((b) => /approve/i.test(`${b.value} ${b.textContent}`)) ?? submits[submits.length - 1];
  if (approveButton) {
    ret.set(approveButton.name, approveButton.value);
  }

  return ret;
}

/**
 * Put a row of approve buttons, right aligned, below the text of the box
 */
function renderButtons(box: HTMLElement, pending: PendingDeployment[]) {
  const existing = $(box).find(`.${BUTTONS_CLASS}`);

  if (pending.length === 0) {
    // Keep showing the result of an approval until the box updates
    if (existing.find('button[data-done]').length === 0) {
      existing.remove();
    }
    return;
  }

  const signature = pending.map((p) => `${p.runId}:${p.environments.join(',')}`).join(';');
  if (existing.length > 0 && existing.attr('data-signature') === signature) {
    return;
  }
  // Don't replace buttons while an approval is running
  if (existing.find('button[data-busy]').length > 0) {
    return;
  }

  const row = $('<div>')
    .addClass(`${BUTTONS_CLASS} d-flex flex-wrap flex-justify-end gap-2 mt-2`)
    .attr('data-signature', signature);
  for (const p of pending) {
    row.append(approveButton(p));
  }

  const meta = $(box).find('.status-meta').first();
  if (existing.length > 0) {
    existing.replaceWith(row);
  } else if (meta.length > 0) {
    meta.after(row);
  } else {
    $(box).find('.status-heading').first().after(row);
  }
}

function approveButton(p: PendingDeployment) {
  const envs = p.environments.length > 0 ? p.environments : ['deployment'];
  const label = $('<span>').append('Approve ');
  envs.forEach((env, i) => label.append(i > 0 ? ', ' : '', $('<code>').text(env)));
  label.append(p.environments.length > 1 ? ' deployments' : (p.environments.length === 1 ? ' deployment' : ''));
  const status = $('<span>');

  return $('<button>')
    .attr('type', 'button')
    .addClass('btn btn-sm')
    .append(status, label)
    .on('click', async (ev) => {
      const btn = $(ev.currentTarget);
      btn.attr({ disabled: 'true', 'data-busy': 'true' });
      status.text('⏳ ');
      try {
        await approve(p);
        status.text('✅ ');
        btn.removeAttr('data-busy').attr('data-done', 'true');
      } catch (e) {
        console.error('QuickApprove:', e);
        status.text('❌ ');
        btn.removeAttr('disabled data-busy').addClass('btn-danger');
      }
    });
}

function cached<A>(cache: Map<string, Cached<A>>, key: string, ttl: number, fn: () => Promise<A>): Promise<A> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) {
    return hit.value;
  }
  const value = fn();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}
