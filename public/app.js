/*
 * Copyright Mor3 Inc., 2026 All Rights Reserved.
 */

'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
    user: null,
    page: 'dashboard',
    options: null,
    customers: [],
    charts: { deals: null, leads: null },
    modal: null, // { type, id, dirty }
};

const PAGES = ['dashboard', 'customers', 'leads', 'deals', 'activities', 'team'];
const TYPE_LABELS = { customers: 'Customer', leads: 'Lead', deals: 'Deal', activities: 'Activity', users: 'Team Member' };
const CHART_COLORS = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Escape any value before placing it in HTML.
function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

function titleCase(value) {
    return String(value ?? '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const moneyFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
function formatMoney(value) {
    if (value === null || value === undefined || value === '') return '–';
    const n = Number(value);
    return Number.isFinite(n) ? moneyFormat.format(n) : '–';
}

// "2026-03-15" → local date (avoids the off-by-one-day timezone bug).
function formatDate(value) {
    if (!value) return '–';
    const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return '–';
    return new Date(y, m - 1, d).toLocaleDateString();
}

// Server stores UTC "YYYY-MM-DD HH:MM:SS".
function parseUtc(value) {
    if (!value) return null;
    const text = String(value);
    const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : text.replace(' ', 'T') + 'Z';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value) {
    const date = parseUtc(value);
    return date ? date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '–';
}

// UTC string → value for <input type="datetime-local"> in the user's timezone.
function toLocalInput(value) {
    const date = parseUtc(value);
    if (!date) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function debounce(fn, wait) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
}

function isAdmin() {
    return state.user?.role === 'admin';
}

const STATUS_BADGES = {
    active: 'success', inactive: 'muted',
    new: 'primary', contacted: 'warning', qualified: 'success', converted: 'success', lost: 'danger',
    low: 'muted', medium: 'warning', high: 'danger',
    prospecting: 'primary', qualification: 'primary', proposal: 'warning', negotiation: 'warning',
    'closed-won': 'success', 'closed-lost': 'danger',
};
function badge(value) {
    if (!value) return '–';
    return `<span class="badge badge-${STATUS_BADGES[value] || 'primary'}">${esc(titleCase(value))}</span>`;
}

function actionButtons(type, id, { canDelete = isAdmin() } = {}) {
    return `
        <div class="row-actions">
            <button type="button" class="btn btn-secondary btn-icon" data-action="edit" data-type="${type}" data-id="${id}" title="View / edit" aria-label="View or edit">
                <i class="fas fa-pen" aria-hidden="true"></i>
            </button>
            ${canDelete ? `
            <button type="button" class="btn btn-secondary btn-icon btn-icon-danger" data-action="delete" data-type="${type}" data-id="${id}" title="Delete" aria-label="Delete">
                <i class="fas fa-trash" aria-hidden="true"></i>
            </button>` : ''}
        </div>`;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
function toast(message, type = 'success') {
    const host = $('#toastHost');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => {
        el.classList.add('toast-hide');
        setTimeout(() => el.remove(), 300);
    }, type === 'error' ? 6000 : 3000);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

async function api(path, { method = 'GET', body } = {}) {
    // The session lives in a secure httpOnly cookie; this header blocks cross-site requests.
    const headers = { 'X-Requested-With': 'CRaM' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response;
    try {
        response = await fetch(path, { method, headers, credentials: 'same-origin', body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch {
        throw new ApiError('Cannot reach the server. Check your connection and try again.', 0);
    }

    let data = null;
    try {
        data = await response.json();
    } catch {
        // Non-JSON response (e.g. a proxy error page).
    }

    const authPaths = ['/api/auth/login', '/api/auth/mfa', '/api/auth/me', '/api/auth/logout', '/api/auth/recover', '/api/setup'];
    if (response.status === 401 && !authPaths.includes(path)) {
        signOut(data?.error || 'Your session has expired. Please sign in again.');
        throw new ApiError(data?.error || 'Please sign in.', 401);
    }
    if (!response.ok) {
        throw new ApiError(data?.error || `The server returned an error (${response.status}). Please try again.`, response.status);
    }
    return data;
}

// Ignore out-of-order responses when filters change quickly.
const requestIds = {};
async function latest(key, promise) {
    const id = (requestIds[key] = (requestIds[key] || 0) + 1);
    const result = await promise;
    if (requestIds[key] !== id) throw new ApiError('stale', -1);
    return result;
}

function reportError(err, fallbackTarget) {
    if (err.status === -1 || err.status === 401) return; // stale or already handled
    console.error(err);
    if (fallbackTarget) {
        const html = `<div class="load-error"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i> ${esc(err.message)} <button type="button" class="btn btn-secondary btn-sm" data-action="retry">Retry</button></div>`;
        if (fallbackTarget.tagName === 'TBODY') {
            const cols = fallbackTarget.closest('table')?.querySelectorAll('thead th').length || 1;
            fallbackTarget.innerHTML = `<tr><td colspan="${cols}">${html}</td></tr>`;
        } else {
            fallbackTarget.innerHTML = html;
        }
    } else {
        toast(err.message, 'error');
    }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
// Password rules (the server enforces the same rules).
function passwordChecks(pw, { email = '', name = '' } = {}) {
    const lower = pw.toLowerCase();
    const local = String(email).toLowerCase().split('@')[0];
    const nameParts = String(name).toLowerCase().split(/\s+/).filter((p) => p.length >= 3);
    return [
        ['At least 8 characters', pw.length >= 8],
        ['Uppercase letter', /[A-Z]/.test(pw)],
        ['Lowercase letter', /[a-z]/.test(pw)],
        ['Number', /[0-9]/.test(pw)],
        ['Symbol (! @ # $ % …)', /[^A-Za-z0-9]/.test(pw)],
        ['No 3+ repeated characters or sequences like 1234', !/(.)\1\1/.test(pw) && !/1234|abcd|qwer/.test(lower)],
        ['Does not contain your name or email', !(local.length >= 3 && lower.includes(local)) && !nameParts.some((p) => lower.includes(p))],
    ];
}

function passwordContext(input) {
    const form = input.form;
    if (form?.dataset.panel === 'setup') return { email: form.email.value, name: form.name.value };
    if (form?.id === 'usersForm') return { email: form.email.value, name: form.name.value };
    return { email: state.user?.email || $('#fEmail')?.value || '', name: state.user?.name || '' };
}

function renderPasswordRules(input) {
    const list = input.parentElement.querySelector('.pw-rules');
    if (!list) return true;
    if (!input.value) { list.innerHTML = ''; return false; }
    const checks = passwordChecks(input.value, passwordContext(input));
    list.innerHTML = checks.map(([label, okay]) =>
        `<li class="${okay ? 'ok' : 'bad'}"><i class="fas ${okay ? 'fa-check' : 'fa-xmark'}" aria-hidden="true"></i> ${esc(label)}</li>`).join('');
    return checks.every(([, okay]) => okay);
}

document.addEventListener('input', (e) => {
    if (e.target.classList?.contains('pw-check')) renderPasswordRules(e.target);
});

function authMessage(error, success) {
    const err = $('#authError');
    const ok = $('#authSuccess');
    err.textContent = error || '';
    err.hidden = !error;
    ok.textContent = success || '';
    ok.hidden = !success;
}

function showAuth(panel, { error, success } = {}) {
    state.user = null;
    closeAllModals(true);
    $('#appShell').hidden = true;
    $('#authScreen').hidden = false;
    $$('#authScreen [data-panel]').forEach((el) => {
        el.hidden = el.dataset.panel !== panel;
        if (el.tagName === 'FORM' && el.dataset.panel !== panel) {
            el.reset();
            $$('.pw-rules', el).forEach((l) => { l.innerHTML = ''; });
        }
    });
    authMessage(error, success);
    if (panel === 'enroll') startEnrollment();
    const first = $(`#authScreen [data-panel="${panel}"] input:not([type=checkbox])`);
    setTimeout(() => first?.focus(), 0);
}

function signOut(message) {
    api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    showAuth('login', { error: message });
}

async function startEnrollment() {
    $('#enrollQr').removeAttribute('src');
    $('#enrollSecret').textContent = 'Loading…';
    try {
        const data = await api('/api/auth/2fa/setup', { method: 'POST' });
        $('#enrollQr').src = data.qr;
        $('#enrollSecret').textContent = data.secret;
    } catch (err) {
        if (err.status !== 401) authMessage(err.message);
    }
}

function showRecoveryCodes(listId, codes) {
    $(`#${listId}`).innerHTML = codes.map((c) => `<li>${esc(c)}</li>`).join('');
}

function codesText(listId) {
    return `CRaM recovery codes for ${state.user?.email || ''}\nEach code can be used once.\n\n` +
        $$(`#${listId} li`).map((li) => li.textContent).join('\n') + '\n';
}

async function startApp() {
    $('#authScreen').hidden = true;
    $('#appShell').hidden = false;
    $('#userName').textContent = state.user.name;
    $$('.admin-only').forEach((el) => { el.hidden = !isAdmin(); });

    try {
        await Promise.all([loadOptions(), refreshCustomerCache()]);
    } catch (err) {
        reportError(err);
    }
    routeFromHash();
}

async function loadMe() {
    const { user, stage } = await api('/api/auth/me');
    state.user = user;
    if (stage === 'enroll') {
        showAuth('enroll');
        state.user = user;
    } else {
        startApp();
    }
}

async function boot() {
    try {
        const setup = await api('/api/setup/status');
        if (setup.needsSetup) return showAuth('setup');
        await loadMe();
    } catch (err) {
        if (err.status === 401) showAuth('login');
        else showAuth('login', { error: err.message });
    }
}

// Generic submit helper for the auth panels.
function authForm(panel, handler) {
    const form = $(`#authScreen [data-panel="${panel}"]`);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        authMessage('');
        const button = $('button[type="submit"]', form);
        const data = collectForm(form);
        button.disabled = true;
        try {
            await handler(data, form);
        } catch (err) {
            authMessage(err.message);
        } finally {
            button.disabled = false;
        }
    });
}

function requireFilled(data, fields) {
    if (fields.some((f) => !data[f])) throw new Error('Please fill in every field.');
}

function requireNewPassword(form, pw, confirm) {
    const input = $('.pw-check', form);
    if (!renderPasswordRules(input)) throw new Error('Your password does not meet all the requirements.');
    if (pw !== confirm) throw new Error('The passwords do not match.');
}

authForm('login', async (data) => {
    requireFilled(data, ['email', 'password']);
    const result = await api('/api/auth/login', { method: 'POST', body: { email: data.email, password: data.password } });
    if (result.stage === 'mfa') showAuth('mfa');
    else await loadMe();
});

authForm('mfa', async (data) => {
    requireFilled(data, ['code']);
    const result = await api('/api/auth/mfa', { method: 'POST', body: { code: data.code } });
    await loadMe();
    if (result.usedRecovery) {
        toast(`Recovery code used. ${result.recoveryCodesLeft} left. Generate new codes from the shield icon.`, result.recoveryCodesLeft < 3 ? 'error' : 'success');
    }
});

authForm('enroll', async (data) => {
    requireFilled(data, ['code']);
    const result = await api('/api/auth/2fa/enable', { method: 'POST', body: { code: data.code } });
    const { user } = await api('/api/auth/me');
    showAuth('codes');
    state.user = user;
    showRecoveryCodes('authCodes', result.recoveryCodes);
    $('#codesSaved').checked = false;
    $('#codesContinue').disabled = true;
});

authForm('forgot', async (data, form) => {
    requireFilled(data, ['email', 'recovery_code', 'totp_code', 'new_password', 'confirm_password']);
    requireNewPassword(form, data.new_password, data.confirm_password);
    const result = await api('/api/auth/recover', { method: 'POST', body: data });
    showAuth('login', { success: result.message });
});

authForm('setup', async (data, form) => {
    requireFilled(data, ['setup_code', 'name', 'email', 'password', 'confirm_password']);
    requireNewPassword(form, data.password, data.confirm_password);
    await api('/api/setup', { method: 'POST', body: data });
    await loadMe();
});

$('#codesSaved').addEventListener('change', (e) => { $('#codesContinue').disabled = !e.target.checked; });
$('#codesContinue').addEventListener('click', () => startApp());

// ---------------------------------------------------------------------------
// Navigation (URL hash: #customers, #leads/new, …)
// ---------------------------------------------------------------------------
function routeFromHash() {
    if (!state.user) return;
    const [rawPage, sub] = location.hash.replace(/^#/, '').split('/');
    let page = PAGES.includes(rawPage) ? rawPage : 'dashboard';
    if (page === 'team' && !isAdmin()) page = 'dashboard';
    showPage(page);
    if (sub === 'new') {
        const type = page === 'team' ? 'users' : page;
        if (TYPE_LABELS[type]) openRecordModal(type, null);
        history.replaceState(null, '', `#${page}`);
    }
}

function showPage(page) {
    state.page = page;
    $$('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.pageLink === page));
    $$('.page').forEach((section) => section.classList.toggle('active', section.id === page));
    loadCurrentPage();
}

function loadCurrentPage() {
    const loaders = {
        dashboard: loadDashboard,
        customers: loadCustomers,
        leads: loadLeads,
        deals: loadDeals,
        activities: loadActivities,
        team: loadUsers,
    };
    loaders[state.page]?.();
}

window.addEventListener('hashchange', routeFromHash);

// ---------------------------------------------------------------------------
// Options & shared lookups
// ---------------------------------------------------------------------------
async function loadOptions() {
    state.options = await api('/api/options');
    const o = state.options;

    $$('select[data-options]').forEach((select) => {
        const values = o[select.dataset.options] || [];
        const placeholder = select.dataset.placeholder;
        select.innerHTML = (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') +
            values.map((v) => `<option value="${esc(v)}">${esc(titleCase(v))}</option>`).join('');
    });

    const fillFilter = (id, values, allLabel) => {
        const select = $(id);
        const current = select.value;
        select.innerHTML = `<option value="">${esc(allLabel)}</option>` +
            values.map((v) => `<option value="${esc(v)}">${esc(titleCase(v))}</option>`).join('');
        select.value = values.includes(current) ? current : '';
    };
    fillFilter('#leadStatus', o.leadStatuses, 'All statuses');
    fillFilter('#leadPriority', o.priorities, 'All priorities');
    fillFilter('#dealStage', o.dealStages, 'All stages');
    fillFilter('#activityTypeFilter', o.activityTypes, 'All types');

    const industries = o.industries || [];
    const industrySelect = $('#customerIndustry');
    const currentIndustry = industrySelect.value;
    industrySelect.innerHTML = '<option value="">All industries</option>' +
        industries.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    industrySelect.value = industries.includes(currentIndustry) ? currentIndustry : '';

    const defaults = ['Technology', 'Software', 'Consulting', 'Manufacturing', 'Healthcare', 'Finance', 'Retail', 'Real Estate', 'Education'];
    const all = Array.from(new Set([...defaults, ...industries])).sort();
    $('#industryList').innerHTML = all.map((v) => `<option value="${esc(v)}"></option>`).join('');
}

async function refreshCustomerCache() {
    state.customers = await api('/api/customers');
    $$('select.customer-select').forEach((select) => {
        const current = select.value;
        select.innerHTML = '<option value="">No customer</option>' +
            state.customers.map((c) => `<option value="${c.id}">${esc(c.company_name)}</option>`).join('');
        select.value = current;
    });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
async function loadDashboard() {
    try {
        const data = await latest('dashboard', api('/api/dashboard'));
        const s = data.stats;
        $('#statCustomers').textContent = s.totalCustomers.toLocaleString();
        $('#statLeads').textContent = s.activeLeads.toLocaleString();
        $('#statDeals').textContent = s.openDeals.toLocaleString();
        $('#statPipeline').textContent = formatMoney(s.pipelineValue);
        $('#statWon').textContent = formatMoney(s.wonValue);
        renderCharts(data);
        renderActivityList($('#recentActivities'), data.recentActivities, { compact: true });
    } catch (err) {
        reportError(err, $('#recentActivities'));
    }
}

function renderCharts(data) {
    if (typeof window.Chart === 'undefined') {
        $$('.chart-box').forEach((box) => { box.innerHTML = '<p class="empty-state">Charts could not be loaded.</p>'; });
        return;
    }

    const dealsCanvas = $('#dealsChart');
    const leadsCanvas = $('#leadsChart');
    if (!dealsCanvas || !leadsCanvas) return;

    state.charts.deals?.destroy();
    state.charts.deals = new Chart(dealsCanvas, {
        type: 'bar',
        data: {
            labels: data.dealsByStage.map((d) => titleCase(d.stage)),
            datasets: [{ label: 'Deals', data: data.dealsByStage.map((d) => d.count), backgroundColor: '#4f46e5', borderRadius: 4 }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
        },
    });

    const leads = data.leadsByStatus.filter((l) => l.count > 0);
    state.charts.leads?.destroy();
    state.charts.leads = new Chart(leadsCanvas, {
        type: 'doughnut',
        data: {
            labels: leads.length ? leads.map((l) => titleCase(l.status)) : ['No leads yet'],
            datasets: [{
                data: leads.length ? leads.map((l) => l.count) : [1],
                backgroundColor: leads.length ? CHART_COLORS : ['#e5e7eb'],
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom' }, tooltip: { enabled: leads.length > 0 } },
        },
    });
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
async function loadCustomers() {
    const tbody = $('#customersTable');
    try {
        const params = new URLSearchParams({
            search: $('#customerSearch').value.trim(),
            status: $('#customerStatus').value,
            industry: $('#customerIndustry').value,
        });
        const customers = await latest('customers', api(`/api/customers?${params}`));
        if (!customers.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No customers found.</td></tr>';
            return;
        }
        tbody.innerHTML = customers.map((c) => `
            <tr>
                <td><strong>${esc(c.company_name)}</strong></td>
                <td>${esc(c.industry || '–')}</td>
                <td>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '–'}</td>
                <td>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '–'}</td>
                <td>${esc(c.annual_revenue || '–')}</td>
                <td>${badge(c.status)}</td>
                <td>${actionButtons('customers', c.id)}</td>
            </tr>`).join('');
    } catch (err) {
        reportError(err, tbody);
    }
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------
async function loadLeads() {
    const tbody = $('#leadsTable');
    try {
        const params = new URLSearchParams({
            search: $('#leadSearch').value.trim(),
            status: $('#leadStatus').value,
            priority: $('#leadPriority').value,
        });
        const leads = await latest('leads', api(`/api/leads?${params}`));
        if (!leads.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No leads found.</td></tr>';
            return;
        }
        tbody.innerHTML = leads.map((l) => `
            <tr>
                <td><strong>${esc(l.contact_name)}</strong></td>
                <td>${esc(l.company_name || '–')}</td>
                <td>${l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : '–'}</td>
                <td>${esc(l.position || '–')}</td>
                <td>${badge(l.status)}</td>
                <td>${badge(l.priority)}</td>
                <td>${actionButtons('leads', l.id)}</td>
            </tr>`).join('');
    } catch (err) {
        reportError(err, tbody);
    }
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------
async function loadDeals() {
    const tbody = $('#dealsTable');
    try {
        const params = new URLSearchParams({
            search: $('#dealSearch').value.trim(),
            stage: $('#dealStage').value,
        });
        const deals = await latest('deals', api(`/api/deals?${params}`));
        if (!deals.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No deals found.</td></tr>';
            return;
        }
        tbody.innerHTML = deals.map((d) => `
            <tr>
                <td><strong>${esc(d.deal_name)}</strong></td>
                <td>${esc(d.company_name || '–')}</td>
                <td>${formatMoney(d.value)}</td>
                <td>${badge(d.stage)}</td>
                <td>${Number(d.probability) || 0}%</td>
                <td>${formatDate(d.expected_close_date)}</td>
                <td>${actionButtons('deals', d.id)}</td>
            </tr>`).join('');
    } catch (err) {
        reportError(err, tbody);
    }
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------
async function loadActivities() {
    const container = $('#activitiesList');
    try {
        const params = new URLSearchParams({ type: $('#activityTypeFilter').value });
        const activities = await latest('activities', api(`/api/activities?${params}`));
        renderActivityList(container, activities);
    } catch (err) {
        reportError(err, container);
    }
}

function renderActivityList(container, activities, { compact = false } = {}) {
    if (!activities || !activities.length) {
        container.innerHTML = `<p class="empty-state">${compact ? 'No recent activities.' : 'No activities found.'}</p>`;
        return;
    }
    container.innerHTML = activities.map((a) => {
        const canDelete = isAdmin() || a.user_id === state.user.id;
        const meta = [a.company_name, a.user_name].filter(Boolean).map(esc).join(' · ');
        return `
        <div class="activity-item">
            <div class="activity-main">
                <div class="activity-title">
                    <span class="badge badge-primary">${esc(a.type)}</span>
                    <strong>${esc(a.subject)}</strong>
                </div>
                ${meta ? `<div class="activity-meta">${meta}</div>` : ''}
                ${a.description && !compact ? `<div class="activity-desc">${esc(a.description)}</div>` : ''}
            </div>
            <div class="activity-side">
                <div class="activity-date">${formatDateTime(a.date_time)}</div>
                ${compact ? '' : actionButtons('activities', a.id, { canDelete })}
            </div>
        </div>`;
    }).join('');
}

// ---------------------------------------------------------------------------
// Team members (admins)
// ---------------------------------------------------------------------------
async function loadUsers() {
    const tbody = $('#usersTable');
    if (!isAdmin()) return;
    try {
        const users = await latest('users', api('/api/users'));
        state.users = users;
        tbody.innerHTML = users.map((u) => `
            <tr class="${u.active ? '' : 'row-muted'}">
                <td><strong>${esc(u.name)}</strong>${u.id === state.user.id ? ' <span class="you-tag">(you)</span>' : ''}</td>
                <td>${esc(u.email)}</td>
                <td>${esc(titleCase(u.role))}</td>
                <td>${u.totp_enabled ? '<span class="badge badge-success">On</span>' : '<span class="badge badge-warning">Not set up</span>'}</td>
                <td>${u.active ? badge('active') : '<span class="badge badge-muted">Deactivated</span>'}</td>
                <td>${actionButtons('users', u.id, { canDelete: false })}</td>
            </tr>`).join('');
    } catch (err) {
        reportError(err, tbody);
    }
}

// ---------------------------------------------------------------------------
// Modals & forms
// ---------------------------------------------------------------------------
function openModal(modal) {
    modal.classList.add('active');
    document.body.classList.add('modal-open');
    const first = $('input:not([type="hidden"]), select, textarea', modal);
    setTimeout(() => first?.focus(), 50);
}

function closeModal(modal, force = false) {
    if (!modal || !modal.classList.contains('active')) return;
    if (!force && state.modal?.dirty && !confirm('Discard your unsaved changes?')) return;
    modal.classList.remove('active');
    if (!$('.modal.active')) document.body.classList.remove('modal-open');
    state.modal = null;
}

function closeAllModals(force) {
    $$('.modal.active').forEach((m) => closeModal(m, force));
}

function setFormError(form, message) {
    const box = $('.form-error', form);
    if (!box) return;
    box.textContent = message || '';
    box.hidden = !message;
}

async function openRecordModal(type, id) {
    const modal = $(`#${type}Modal`);
    const form = $(`#${type}Form`);
    if (!modal || !form) return;

    let record = null;
    if (id) {
        try {
            record = type === 'users'
                ? (state.users || []).find((u) => u.id === id)
                : await api(`/api/${type}/${id}`);
            if (!record) throw new ApiError('That record could not be found. It may have been deleted.', 404);
        } catch (err) {
            reportError(err);
            loadCurrentPage();
            return;
        }
    }

    form.reset();
    setFormError(form, '');
    modal.classList.toggle('is-edit', !!record);
    $(`#${type}ModalTitle`).textContent = record
        ? (type === 'activities' ? 'Edit Activity' : `Edit ${TYPE_LABELS[type]}`)
        : (type === 'activities' ? 'Log Activity' : `Add ${TYPE_LABELS[type]}`);

    if (record) {
        $$('[name]', form).forEach((field) => {
            let value = record[field.name];
            if (field.name === 'date_time') value = toLocalInput(value);
            if (field.name === 'active') value = record.active ? '1' : '0';
            if (field.name === 'password') value = '';
            if (field.tagName === 'SELECT' && value !== null && value !== undefined && value !== '' &&
                !$$('option', field).some((o) => o.value === String(value))) {
                // Keep legacy values visible instead of silently dropping them.
                field.insertAdjacentHTML('beforeend', `<option value="${esc(value)}">${esc(value)}</option>`);
            }
            field.value = value ?? '';
        });
    }

    if (type === 'users') {
        $('#u_email').readOnly = !!record;
        $('#u_password').required = !record;
    }

    const deleteBtn = $('.btn-delete', form);
    if (deleteBtn) {
        const canDelete = record && (isAdmin() || (type === 'activities' && record.user_id === state.user.id));
        deleteBtn.hidden = !canDelete;
    }

    state.modal = { type, id: record ? record.id : null, dirty: false };
    openModal(modal);
}

function collectForm(form) {
    const data = {};
    new FormData(form).forEach((value, key) => { data[key] = typeof value === 'string' ? value.trim() : value; });
    return data;
}

async function submitRecordForm(type, form) {
    const button = $('button[type="submit"]', form);
    setFormError(form, '');

    // Browser-side checks for required fields and formats.
    if (!form.checkValidity()) {
        const invalid = $(':invalid', form);
        const label = invalid && $(`label[for="${invalid.id}"]`, form);
        setFormError(form, `Please check "${(label?.textContent || 'this field').replace(/\*/g, '').trim()}".`);
        invalid?.focus();
        return;
    }

    const data = collectForm(form);
    if (type === 'activities' && data.date_time) {
        const local = new Date(data.date_time);
        data.date_time = Number.isNaN(local.getTime()) ? '' : local.toISOString();
    }
    if (type === 'users') {
        data.active = data.active !== '0';
        data.reset_2fa = !!data.reset_2fa;
        if (!data.password) delete data.password;
        else if (!renderPasswordRules($('#u_password'))) {
            setFormError(form, 'The password does not meet all the requirements.');
            return;
        }
    }

    const id = state.modal?.id;
    button.disabled = true;
    try {
        const result = await api(id ? `/api/${type}/${id}` : `/api/${type}`, { method: id ? 'PUT' : 'POST', body: data });
        closeModal($(`#${type}Modal`), true);
        toast(result?.message || 'Saved.');
        await afterChange(type);
    } catch (err) {
        if (err.status !== 401) setFormError(form, err.message);
    } finally {
        button.disabled = false;
    }
}

async function deleteRecord(type, id) {
    const label = TYPE_LABELS[type].toLowerCase();
    const extra = type === 'customers' ? ' Its leads, deals and activities will be kept but unlinked.' : '';
    if (!confirm(`Delete this ${label}? This cannot be undone.${extra}`)) return;
    try {
        const result = await api(`/api/${type}/${id}`, { method: 'DELETE' });
        closeModal($(`#${type}Modal`), true);
        toast(result?.message || 'Deleted.');
        await afterChange(type);
    } catch (err) {
        reportError(err);
    }
}

async function afterChange(type) {
    try {
        if (type === 'customers') await Promise.all([refreshCustomerCache(), loadOptions()]);
    } catch (err) {
        reportError(err);
    }
    loadCurrentPage();
}

['customers', 'leads', 'deals', 'activities', 'users'].forEach((type) => {
    const form = $(`#${type}Form`);
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        submitRecordForm(type, form);
    });
    form.addEventListener('input', () => { if (state.modal) state.modal.dirty = true; });
});

$('#passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = collectForm(form);
    setFormError(form, '');
    if (!data.current_password || !data.new_password) return setFormError(form, 'Fill in all fields.');
    if (!renderPasswordRules($('#p_new'))) return setFormError(form, 'Your new password does not meet all the requirements.');
    if (data.new_password !== data.confirm_password) return setFormError(form, 'The new passwords do not match.');

    const button = $('button[type="submit"]', form);
    button.disabled = true;
    try {
        const result = await api('/api/auth/change-password', {
            method: 'POST',
            body: { current_password: data.current_password, new_password: data.new_password },
        });
        closeModal($('#passwordModal'), true);
        toast('Password changed. Other devices have been signed out.');
    } catch (err) {
        if (err.status !== 401) setFormError(form, err.message);
    } finally {
        button.disabled = false;
    }
});

$('#recoveryForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    setFormError(form, '');
    const password = $('#r_password').value;
    if (!password) return setFormError(form, 'Enter your password.');
    try {
        const result = await api('/api/auth/recovery-codes', { method: 'POST', body: { password } });
        showRecoveryCodes('modalCodes', result.recoveryCodes);
        $$('.recovery-step-1', form).forEach((x) => { x.hidden = true; });
        $$('.recovery-step-2', form).forEach((x) => { x.hidden = false; });
        state.user.recovery_codes_left = result.recoveryCodes.length;
    } catch (err) {
        if (err.status !== 401) setFormError(form, err.message);
    }
});

// ---------------------------------------------------------------------------
// Global click handling (no inline onclick — required by the security policy)
// ---------------------------------------------------------------------------
document.addEventListener('click', (e) => {
    const panelLink = e.target.closest('[data-show-panel]');
    if (panelLink) {
        e.preventDefault();
        showAuth(panelLink.dataset.showPanel);
        return;
    }

    const pageLink = e.target.closest('[data-page-link]');
    if (pageLink) {
        e.preventDefault();
        const page = pageLink.dataset.pageLink;
        if (location.hash === `#${page}`) showPage(page);
        else location.hash = page;
        return;
    }

    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, type } = el.dataset;
    const id = el.dataset.id ? Number(el.dataset.id) : null;

    switch (action) {
        case 'new': openRecordModal(type, null); break;
        case 'edit': openRecordModal(type, id); break;
        case 'delete': deleteRecord(type, id); break;
        case 'delete-current':
            if (state.modal?.id) deleteRecord(state.modal.type, state.modal.id);
            break;
        case 'close-modal': closeModal(el.closest('.modal')); break;
        case 'retry': loadCurrentPage(); break;
        case 'logout': signOut(); break;
        case 'recovery-codes': {
            const form = $('#recoveryForm');
            form.reset();
            setFormError(form, '');
            $('#r_username').value = state.user?.email || '';
            $('#codesLeft').textContent = state.user?.recovery_codes_left ?? 0;
            $$('.recovery-step-1', form).forEach((x) => { x.hidden = false; });
            $$('.recovery-step-2', form).forEach((x) => { x.hidden = true; });
            state.modal = { type: 'recovery', id: null, dirty: false };
            openModal($('#recoveryModal'));
            break;
        }
        case 'copy-codes':
            navigator.clipboard?.writeText(codesText(el.dataset.target))
                .then(() => toast('Recovery codes copied.'))
                .catch(() => toast('Copy failed. Select the codes and copy them manually.', 'error'));
            break;
        case 'download-codes': {
            const blob = new Blob([codesText(el.dataset.target)], { type: 'text/plain' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = 'CRaM-recovery-codes.txt';
            link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
            break;
        }
        case 'change-password': {
            const form = $('#passwordForm');
            form.reset();
            $('#p_username').value = state.user?.email || '';
            setFormError(form, '');
            state.modal = { type: 'password', id: null, dirty: false };
            openModal($('#passwordModal'));
            break;
        }
        default: break;
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const open = $$('.modal.active').pop();
        if (open) closeModal(open);
    }
});

// Filters
$('#customerSearch').addEventListener('input', debounce(loadCustomers, 300));
$('#customerStatus').addEventListener('change', loadCustomers);
$('#customerIndustry').addEventListener('change', loadCustomers);
$('#leadSearch').addEventListener('input', debounce(loadLeads, 300));
$('#leadStatus').addEventListener('change', loadLeads);
$('#leadPriority').addEventListener('change', loadLeads);
$('#dealSearch').addEventListener('input', debounce(loadDeals, 300));
$('#dealStage').addEventListener('change', loadDeals);
$('#activityTypeFilter').addEventListener('change', loadActivities);

// Keep data fresh when someone returns to the tab.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.user && !$('.modal.active')) loadCurrentPage();
});

boot();

/*
 * Copyright Mor3 Inc., 2026 All Rights Reserved.
 */
