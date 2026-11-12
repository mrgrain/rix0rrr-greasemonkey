"use strict";
// ==UserScript==
// @name         QuickApprove
// @namespace    http://rix0r.nl/
// @version      0.2.0
// @description  Quickly Approve GitHub Deployments
// @author       Rico
// @require      http://code.jquery.com/jquery-latest.js
// @match        https://github.com/*
// ==/UserScript==
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
const SECTION_CLASS = 'quick-approve-section';
const JOB_URL_RE = /\/[^/\s]+\/[^/\s]+\/actions\/runs\/(\d+)\/job\/(\d+)/;
const STATUS_CHECKS_TTL_MS = 10000;
const APPROVAL_INFO_TTL_MS = 30000;
const statusChecksCache = new Map();
const approvalInfoCache = new Map();
const approvedRuns = new Set();
let scanTimer;
let scanning = false;
let rescanRequested = false;
// GitHub renders PR pages with a mix of Turbo navigations and React updates,
// neither of which reliably announces itself. Watch the whole document and
// rescan (debounced) whenever something changes.
new MutationObserver((mutations) => {
    if (mutations.every(isOwnMutation)) {
        return;
    }
    scheduleScan();
}).observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('turbo:load', scheduleScan);
window.addEventListener('popstate', scheduleScan);
scheduleScan();
function isOwnMutation(m) {
    return m.target instanceof Element && m.target.closest(`.${SECTION_CLASS}`) !== null;
}
function scheduleScan() {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(runScan, 300);
}
function runScan() {
    return __awaiter(this, void 0, void 0, function* () {
        if (scanning) {
            rescanRequested = true;
            return;
        }
        scanning = true;
        try {
            yield scan();
        }
        catch (e) {
            console.error('QuickApprove:', e);
        }
        finally {
            scanning = false;
            if (rescanRequested) {
                rescanRequested = false;
                scheduleScan();
            }
        }
    });
}
function scan() {
    return __awaiter(this, void 0, void 0, function* () {
        const pr = currentPullRequest();
        const anchors = pr ? findChecksSections() : [];
        if (!pr || anchors.length === 0) {
            $(`.${SECTION_CLASS}`).remove();
            return;
        }
        // Only look at the checks of the current head commit. Older runs (e.g. from
        // the timeline) may still be waiting, but approving them is pointless.
        const fromStatusChecks = yield waitingJobsFromStatusChecks(pr.url);
        const waiting = dedupeByRun(fromStatusChecks.length > 0 ? fromStatusChecks : waitingJobsFromDom())
            .filter((job) => !approvedRuns.has(job.runId));
        const pending = [];
        for (const job of waiting) {
            const info = yield approvalInfo(job.jobUrl);
            if (info) {
                pending.push(Object.assign(Object.assign({}, job), { environments: info.environments }));
            }
        }
        // The DOM may have changed while we were fetching
        for (const anchor of findChecksSections()) {
            renderSection(anchor, pending);
        }
    });
}
function currentPullRequest() {
    const m = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return m ? { url: `/${m[1]}/${m[2]}/pull/${m[3]}` } : undefined;
}
/**
 * The elements to put our section in front of
 *
 * - New (React) merge box: `<section aria-label="Checks">`, inline and in the "Merge status" panel.
 * - Classic merge box: the `.branch-action-item` that holds the checks list.
 */
function findChecksSections() {
    const react = $('section[aria-label="Checks"]').get();
    const classic = $('.merge-status-list').closest('.branch-action-item').get();
    return [...react, ...classic];
}
/**
 * Ask GitHub for the PR's status checks, the same way the merge box does.
 *
 * We don't depend on the exact response shape: any object that has a `WAITING`
 * value and a link to an Actions job counts as a job waiting for a deployment.
 */
function waitingJobsFromStatusChecks(prUrl) {
    return cached(statusChecksCache, prUrl, STATUS_CHECKS_TTL_MS, () => __awaiter(this, void 0, void 0, function* () {
        try {
            const response = yield fetch(`${prUrl}/page_data/status_checks`, {
                headers: {
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'GitHub-Verified-Fetch': 'true',
                    'GitHub-Is-React': 'true',
                },
            });
            if (!response.ok) {
                return [];
            }
            const ret = [];
            collectWaitingJobs(yield response.json(), ret);
            return ret;
        }
        catch (e) {
            console.warn('QuickApprove: could not fetch status checks', e);
            return [];
        }
    }));
}
function collectWaitingJobs(node, into) {
    if (Array.isArray(node)) {
        node.forEach((x) => collectWaitingJobs(x, into));
        return;
    }
    if (!node || typeof node !== 'object') {
        return;
    }
    const obj = node;
    const values = Object.keys(obj).map((k) => obj[k]);
    const isWaiting = values.some((v) => typeof v === 'string' && v.toUpperCase() === 'WAITING');
    const jobUrl = values.find((v) => typeof v === 'string' && JOB_URL_RE.test(v));
    if (isWaiting && jobUrl) {
        const name = [obj.displayName, obj.name].find((v) => typeof v === 'string');
        into.push(waitingJob(jobUrl, name));
    }
    values.forEach((v) => collectWaitingJobs(v, into));
}
/**
 * Fallback for when the status checks endpoint isn't available: check rows in
 * the merge box that say "Waiting".
 */
function waitingJobsFromDom() {
    const ret = [];
    for (const section of findChecksSections()) {
        $(section).find('a[href*="/actions/runs/"]').each((_, a) => {
            var _a;
            const href = (_a = $(a).attr('href')) !== null && _a !== void 0 ? _a : '';
            if (!JOB_URL_RE.test(href)) {
                return;
            }
            const row = $(a).closest('li, [role="listitem"], .merge-status-item');
            if (/\bWaiting\b/.test(row.text())) {
                ret.push(waitingJob(href, $(a).text().trim() || undefined));
            }
        });
    }
    return ret;
}
function waitingJob(url, name) {
    const jobUrl = new URL(url, window.location.origin);
    jobUrl.search = '';
    return { runId: jobUrl.pathname.match(JOB_URL_RE)[1], jobUrl: jobUrl.toString(), name };
}
function dedupeByRun(jobs) {
    const byRun = new Map();
    for (const job of jobs) {
        const existing = byRun.get(job.runId);
        if (!existing || (!existing.name && job.name)) {
            byRun.set(job.runId, job);
        }
    }
    return Array.from(byRun.values());
}
/**
 * Load the job page and find the "Review deployments" form on it.
 *
 * Returns `undefined` if there is nothing to approve, or the user can't approve it.
 */
function approvalInfo(jobUrl) {
    return cached(approvalInfoCache, jobUrl, APPROVAL_INFO_TTL_MS, () => __awaiter(this, void 0, void 0, function* () {
        const response = yield fetch(jobUrl);
        if (!response.ok) {
            return undefined;
        }
        const page = new DOMParser().parseFromString(yield response.text(), 'text/html');
        const form = Array.from(page.querySelectorAll('form'))
            .find((f) => { var _a; return (_a = f.getAttribute('action')) === null || _a === void 0 ? void 0 : _a.endsWith('approve_or_reject'); });
        if (!form) {
            return undefined;
        }
        return { form, environments: environmentNames(form) };
    }));
}
function environmentNames(form) {
    const names = Array.from(form.querySelectorAll('input[type="checkbox"]')).map((cb) => {
        var _a, _b, _c;
        const label = (_a = cb.closest('label')) !== null && _a !== void 0 ? _a : (cb.id ? form.querySelector(`label[for="${CSS.escape(cb.id)}"]`) : null);
        const text = (_c = (_b = (label !== null && label !== void 0 ? label : cb.parentElement)) === null || _b === void 0 ? void 0 : _b.textContent) !== null && _c !== void 0 ? _c : '';
        return text.trim().split(/\s+/)[0];
    }).filter(Boolean);
    return Array.from(new Set(names));
}
function approve(job) {
    return __awaiter(this, void 0, void 0, function* () {
        // Always use a fresh form, the token in a cached one may have expired
        approvalInfoCache.delete(job.jobUrl);
        const info = yield approvalInfo(job.jobUrl);
        if (!info) {
            throw new Error(`Nothing to approve for ${job.jobUrl}`);
        }
        const response = yield fetch(info.form.getAttribute('action'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: collectFormData(info.form),
        });
        if (!response.ok) {
            throw new Error(`Approval failed: ${response.status} ${response.statusText}`);
        }
        approvedRuns.add(job.runId);
        approvalInfoCache.delete(job.jobUrl);
        statusChecksCache.clear();
    });
}
/**
 * From the "Review deployments" form, collect the data that approves all environments.
 */
function collectFormData(form) {
    var _a;
    const ret = new URLSearchParams();
    form.querySelectorAll('input').forEach((el) => {
        if (!el.name || ['submit', 'button', 'image', 'reset'].includes(el.type)) {
            return;
        }
        // Checkboxes are the environments to approve; tick all of them
        ret.append(el.name, (el.type === 'checkbox' || el.type === 'radio') ? (el.value || 'on') : el.value);
    });
    form.querySelectorAll('textarea').forEach((el) => {
        if (el.name) {
            ret.append(el.name, el.value);
        }
    });
    const submits = Array.from(form.querySelectorAll('button[type="submit"]')).filter((b) => b.name);
    const approveButton = (_a = submits.find((b) => /approve/i.test(`${b.value} ${b.textContent}`))) !== null && _a !== void 0 ? _a : submits[submits.length - 1];
    if (approveButton) {
        ret.set(approveButton.name, approveButton.value);
    }
    return ret;
}
function renderSection(anchor, pending) {
    const existing = $(anchor).prevAll(`.${SECTION_CLASS}`).first();
    if (pending.length === 0) {
        existing.remove();
        return;
    }
    const signature = pending.map((p) => `${p.runId}:${p.environments.join(',')}`).join(';');
    if (existing.length > 0 && existing.attr('data-signature') === signature) {
        return;
    }
    // Don't replace a section while an approval is running in it
    if (existing.find('button[data-busy]').length > 0) {
        return;
    }
    const section = $('<section>')
        .addClass(`${SECTION_CLASS} d-flex flex-items-center gap-2 p-3`)
        .addClass(anchor.matches('section') ? 'border-bottom color-border-subtle' : 'branch-action-item')
        .attr('aria-label', 'Deployments')
        .attr('data-signature', signature);
    section.append($('<div>')
        .addClass('d-flex flex-items-center flex-justify-center flex-shrink-0 circle')
        .css({
        width: '32px',
        height: '32px',
        color: 'var(--fgColor-onEmphasis, #fff)',
        backgroundColor: 'var(--bgColor-attention-emphasis, #9a6700)',
    })
        .html(ROCKET_ICON));
    const plural = pending.length > 1 || pending[0].environments.length > 1;
    const subtitle = $('<div>').addClass('fgColor-muted color-fg-muted');
    pending.forEach((p, i) => {
        var _a;
        subtitle.append(i > 0 ? ', ' : '', $('<a>').addClass('Link--secondary').attr({ href: p.jobUrl, target: '_blank' }).text((_a = p.name) !== null && _a !== void 0 ? _a : `run ${p.runId}`));
    });
    subtitle.append(pending.length > 1 ? ' are waiting for a reviewer.' : ' is waiting for a reviewer.');
    section.append($('<div>').addClass('flex-auto').append($('<h3>').addClass('h4').text(plural ? 'Some deployments are waiting for approval' : 'A deployment is waiting for approval'), subtitle));
    const buttons = $('<div>').addClass('d-flex flex-column flex-md-row flex-shrink-0 gap-2');
    for (const p of pending) {
        buttons.append(approveButton(p));
    }
    section.append(buttons);
    if (existing.length > 0) {
        existing.replaceWith(section);
    }
    else {
        $(anchor).before(section);
    }
}
function approveButton(p) {
    const envs = p.environments.length > 0 ? p.environments : ['deployment'];
    const label = $('<span>').append('Approve ');
    envs.forEach((env, i) => label.append(i > 0 ? ', ' : '', $('<code>').text(env)));
    label.append(p.environments.length > 1 ? ' deployments' : (p.environments.length === 1 ? ' deployment' : ''));
    const status = $('<span>');
    return $('<button>')
        .attr('type', 'button')
        .addClass('btn btn-sm')
        .append(status, label)
        .on('click', (ev) => __awaiter(this, void 0, void 0, function* () {
        const btn = $(ev.currentTarget);
        btn.attr({ disabled: 'true', 'data-busy': 'true' });
        status.text('⏳ ');
        try {
            yield approve(p);
            status.text('✅ ');
            btn.removeAttr('data-busy');
            window.setTimeout(scheduleScan, 3000);
        }
        catch (e) {
            console.error('QuickApprove:', e);
            status.text('❌ ');
            btn.removeAttr('disabled data-busy').addClass('btn-danger');
        }
    }));
}
function cached(cache, key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) {
        return hit.value;
    }
    const value = fn();
    cache.set(key, { at: Date.now(), value });
    value.catch(() => cache.delete(key));
    return value;
}
const ROCKET_ICON = '<svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16" fill="currentColor"><path d="M14.064 0h.186C15.216 0 16 .784 16 1.75v.186a8.752 8.752 0 0 1-2.564 6.186l-.458.459c-.314.314-.641.616-.979.904v3.207c0 .608-.315 1.172-.833 1.49l-2.774 1.707a.749.749 0 0 1-1.11-.418l-.954-3.102a1.214 1.214 0 0 1-.145-.125L3.754 9.816a1.218 1.218 0 0 1-.124-.145L.528 8.717a.749.749 0 0 1-.418-1.11l1.71-2.774A1.748 1.748 0 0 1 3.31 4h3.204c.288-.338.59-.665.904-.979l.459-.458A8.749 8.749 0 0 1 14.064 0ZM8.938 3.623h-.002l-.458.458c-.76.76-1.437 1.598-2.02 2.5l-1.5 2.317 2.143 2.143 2.317-1.5c.902-.583 1.74-1.26 2.499-2.02l.459-.458a7.25 7.25 0 0 0 2.123-5.127V1.75a.25.25 0 0 0-.25-.25h-.186a7.249 7.249 0 0 0-5.125 2.123ZM3.56 14.56c-.732.732-2.334 1.045-3.005 1.148a.234.234 0 0 1-.201-.064.234.234 0 0 1-.064-.201c.103-.671.416-2.273 1.15-3.003a1.502 1.502 0 1 1 2.12 2.12Zm6.94-3.935c-.088.06-.177.118-.266.175l-2.35 1.521.548 1.783 1.949-1.2a.25.25 0 0 0 .119-.213ZM3.678 8.116 5.2 5.766c.058-.09.117-.178.176-.266H3.309a.25.25 0 0 0-.213.119l-1.2 1.95ZM12 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg>';
