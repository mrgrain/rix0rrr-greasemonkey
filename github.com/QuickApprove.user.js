"use strict";
// ==UserScript==
// @name         QuickApprove
// @namespace    http://rix0r.nl/
// @version      0.1.0
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
const OWN_CLASS = 'quick-approve';
const RUN_URL_RE = /\/[^/\s]+\/[^/\s]+\/actions\/runs\/(\d+)/;
const DEPLOYMENTS_TTL_MS = 10000;
const APPROVAL_FORM_TTL_MS = 30000;
const deploymentsCache = new Map();
const approvalFormCache = new Map();
const approvedRuns = new Set();
let scanTimer;
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
function isOwnMutation(m) {
    return m.target instanceof Element && m.target.closest(`.${OWN_CLASS}`) !== null;
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
        if (!pr || (findDeploymentBoxes().length === 0 && findChecksSections().length === 0)) {
            $(`.${OWN_CLASS}`).remove();
            return;
        }
        const pending = [];
        for (const deployment of yield waitingDeployments(pr.url)) {
            if (!approvedRuns.has(deployment.runId) && (yield approvalForm(deployment.runUrl))) {
                pending.push(deployment);
            }
        }
        // The DOM may have changed while we were fetching. Prefer GitHub's own
        // deployments box; the merge status panel doesn't have one, so add a
        // section to its checks there.
        const boxes = findDeploymentBoxes();
        if (boxes.length > 0) {
            $(`section.${OWN_CLASS}`).remove();
            boxes.forEach((box) => renderButtonsInBox(box, pending));
        }
        else {
            findChecksSections().forEach((checks) => renderSection(checks, pending));
        }
    });
}
function currentPullRequest() {
    const m = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return m ? { url: `/${m[1]}/${m[2]}/pull/${m[3]}` } : undefined;
}
/**
 * GitHub's "This branch is waiting for a deployment approval" boxes
 */
function findDeploymentBoxes() {
    return $('[data-url$="/partials/deployments_box"]').closest('.branch-action-item').get();
}
/**
 * The checks sections of the merge box, inline and in the "Merge status" panel
 */
function findChecksSections() {
    return $('section[aria-label="Checks"]').get();
}
/**
 * Read the waiting deployments from the same partial that renders the deployments box.
 *
 * Fetching it means we don't depend on the box being on the page.
 */
function waitingDeployments(prUrl) {
    return cached(deploymentsCache, prUrl, DEPLOYMENTS_TTL_MS, () => __awaiter(this, void 0, void 0, function* () {
        const response = yield fetch(`${prUrl}/partials/deployments_box`, {
            headers: { 'Accept': 'text/html', 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (!response.ok) {
            return [];
        }
        const page = new DOMParser().parseFromString(yield response.text(), 'text/html');
        const byRun = new Map();
        $(page).find('.merge-status-list > div').each((_, row) => {
            if (!/\bWaiting\b/.test($(row).text())) {
                return;
            }
            const environment = $(row).find('.text-emphasized').first().text().trim();
            $(row).find('a[href*="/actions/runs/"]').each((_, a) => {
                var _a, _b;
                const runUrl = normalizeRunUrl((_a = $(a).attr('href')) !== null && _a !== void 0 ? _a : '');
                if (!runUrl) {
                    return;
                }
                const existing = (_b = byRun.get(runUrl.runId)) !== null && _b !== void 0 ? _b : Object.assign(Object.assign({}, runUrl), { environments: [] });
                if (environment && !existing.environments.includes(environment)) {
                    existing.environments.push(environment);
                }
                byRun.set(runUrl.runId, existing);
            });
        });
        return Array.from(byRun.values());
    }));
}
function normalizeRunUrl(href) {
    const url = new URL(href, window.location.origin);
    const m = url.pathname.match(RUN_URL_RE);
    return m ? { runId: m[1], runUrl: `${url.origin}${m[0]}` } : undefined;
}
/**
 * Load the run page and find the "Review deployments" form on it.
 *
 * Returns `undefined` if there is nothing to approve, or the user can't approve it.
 */
function approvalForm(runUrl) {
    return cached(approvalFormCache, runUrl, APPROVAL_FORM_TTL_MS, () => __awaiter(this, void 0, void 0, function* () {
        const response = yield fetch(runUrl);
        if (!response.ok) {
            return undefined;
        }
        const page = new DOMParser().parseFromString(yield response.text(), 'text/html');
        return Array.from(page.querySelectorAll('form'))
            .find((f) => { var _a; return (_a = f.getAttribute('action')) === null || _a === void 0 ? void 0 : _a.endsWith('approve_or_reject'); });
    }));
}
function approve(deployment) {
    return __awaiter(this, void 0, void 0, function* () {
        // Always use a fresh form, the token in a cached one may have expired
        approvalFormCache.delete(deployment.runUrl);
        const form = yield approvalForm(deployment.runUrl);
        const action = form === null || form === void 0 ? void 0 : form.getAttribute('action');
        if (!form || !action) {
            throw new Error(`Nothing to approve for ${deployment.runUrl}`);
        }
        const response = yield fetch(action, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: collectFormData(form),
        });
        if (!response.ok) {
            throw new Error(`Approval failed: ${response.status} ${response.statusText}`);
        }
        approvedRuns.add(deployment.runId);
        approvalFormCache.delete(deployment.runUrl);
        deploymentsCache.clear();
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
/**
 * Put a row of approve buttons, right aligned, below the text of GitHub's deployments box
 */
function renderButtonsInBox(box, pending) {
    const existing = $(box).find(`.${OWN_CLASS}`);
    if (!needsRender(existing, pending)) {
        return;
    }
    if (pending.length === 0) {
        existing.remove();
        return;
    }
    const row = buttonRow(pending);
    if (existing.length > 0) {
        existing.replaceWith(row);
    }
    else {
        const meta = $(box).find('.status-meta').first();
        (meta.length > 0 ? meta : $(box).find('.status-heading').first()).after(row);
    }
}
/**
 * Add a section like GitHub's own merge box sections, in front of the checks
 */
function renderSection(checks, pending) {
    const existing = $(checks).prevAll(`section.${OWN_CLASS}`).first();
    if (!needsRender(existing, pending)) {
        return;
    }
    if (pending.length === 0) {
        existing.remove();
        return;
    }
    const environments = Array.from(new Set([].concat(...pending.map((p) => p.environments))));
    const subtitle = $('<div>').addClass('fgColor-muted color-fg-muted');
    environments.forEach((env, i) => subtitle.append(i > 0 ? ', ' : '', $('<span>').addClass('text-bold').text(env)));
    subtitle.append(environments.length > 0 ? ' needs your review' : 'A deployment needs your review');
    const section = $('<section>')
        .addClass(`${OWN_CLASS} d-flex flex-items-start gap-2 p-3 border-bottom color-border-subtle`)
        .attr('aria-label', 'Deployments')
        .attr('data-signature', signature(pending))
        .append($('<div>')
        .addClass('d-flex flex-items-center flex-justify-center flex-shrink-0 circle')
        .css({
        width: '32px',
        height: '32px',
        color: 'var(--fgColor-onEmphasis, #fff)',
        backgroundColor: 'var(--bgColor-attention-emphasis, #9a6700)',
    })
        .html(ROCKET_ICON), $('<div>').addClass('flex-auto').append($('<h3>').addClass('h4').text('Some deployments are waiting for approval'), subtitle, buttonRow(pending).removeClass(OWN_CLASS)));
    if (existing.length > 0) {
        existing.replaceWith(section);
    }
    else {
        $(checks).before(section);
    }
}
/**
 * Whether the rendered buttons are out of date and may be replaced
 */
function needsRender(existing, pending) {
    // Don't replace buttons while an approval is running, and keep showing the
    // result until GitHub updates the page
    if (existing.find('button[data-busy], button[data-done]').length > 0) {
        return false;
    }
    if (existing.length === 0) {
        return pending.length > 0;
    }
    return existing.attr('data-signature') !== signature(pending);
}
function signature(pending) {
    return pending.map((p) => `${p.runId}:${p.environments.join(',')}`).join(';');
}
function buttonRow(pending) {
    const row = $('<div>')
        .addClass(`${OWN_CLASS} d-flex flex-wrap flex-justify-end gap-2 mt-2`)
        .attr('data-signature', signature(pending));
    for (const p of pending) {
        row.append(approveButton(p));
    }
    return row;
}
function approveButton(p) {
    const label = $('<span>').append('Approve ');
    if (p.environments.length > 0) {
        p.environments.forEach((env, i) => label.append(i > 0 ? ', ' : '', $('<code>').text(env)));
        label.append(p.environments.length > 1 ? ' deployments' : ' deployment');
    }
    else {
        label.append('deployment');
    }
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
            btn.removeAttr('data-busy').attr('data-done', 'true');
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
