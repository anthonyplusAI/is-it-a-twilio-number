const refreshButton = document.querySelector('#refresh-button');
const refreshLabel = document.querySelector('#refresh-label');
const loadStatus = document.querySelector('#load-status');
const summary = document.querySelector('.admin-summary');
const chartViewport = document.querySelector('#chart-viewport');
const chartBars = document.querySelector('#chart-bars');
const chartEmpty = document.querySelector('#chart-empty');
const dailyTableBody = document.querySelector('#daily-table-body');
const numberFormat = new Intl.NumberFormat();
const shortUtcDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const longUtcDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
const localDateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
const outcomeKeys = ['twilio_signal', 'no_signal', 'unavailable', 'failed', 'untracked'];
let hasLoadedMetrics = false;

document.querySelector('#year').textContent = String(new Date().getFullYear());

function nonnegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_metrics');
  return value;
}

function utcDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('invalid_metrics');
  }
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('invalid_metrics');
  }
  return date;
}

function parseMetrics(raw) {
  if (!raw || typeof raw !== 'object' || !raw.totals || !raw.outcomes || !Array.isArray(raw.days)) {
    throw new Error('invalid_metrics');
  }
  const generatedAt = new Date(raw.generatedAt);
  if (raw.timezone !== 'UTC' || !Number.isFinite(generatedAt.getTime())) {
    throw new Error('invalid_metrics');
  }
  const dailyLimit = nonnegativeInteger(raw.dailyLimit);
  if (dailyLimit < 1) throw new Error('invalid_metrics');

  const totals = {
    today: nonnegativeInteger(raw.totals.today),
    last7Days: nonnegativeInteger(raw.totals.last7Days),
    last30Days: nonnegativeInteger(raw.totals.last30Days),
  };
  const outcomes = Object.fromEntries(outcomeKeys.map((key) => [key, nonnegativeInteger(raw.outcomes[key])]));
  const days = raw.days.map((day) => ({
    date: day.date,
    dateObject: utcDate(day.date),
    attempts: nonnegativeInteger(day.attempts),
  }));
  return { generatedAt, dailyLimit, totals, outcomes, days };
}

function setStatus(message, isError = false) {
  loadStatus.textContent = message;
  loadStatus.dataset.state = isError ? 'error' : 'ready';
  loadStatus.setAttribute('role', isError ? 'alert' : 'status');
}

function renderSummary(metrics) {
  document.querySelector('#total-today').textContent = numberFormat.format(metrics.totals.today);
  document.querySelector('#total-seven').textContent = numberFormat.format(metrics.totals.last7Days);
  document.querySelector('#total-thirty').textContent = numberFormat.format(metrics.totals.last30Days);
  document.querySelector('#limit-count').textContent = `${numberFormat.format(metrics.totals.today)} / ${numberFormat.format(metrics.dailyLimit)}`;

  const progress = document.querySelector('#daily-progress');
  progress.max = metrics.dailyLimit;
  progress.value = Math.min(metrics.totals.today, metrics.dailyLimit);
  progress.hidden = false;
}

function renderDailyTable(days) {
  const fragment = document.createDocumentFragment();
  for (const day of days) {
    const row = document.createElement('tr');
    const dateCell = document.createElement('th');
    const time = document.createElement('time');
    const countCell = document.createElement('td');
    dateCell.scope = 'row';
    time.dateTime = day.date;
    time.textContent = longUtcDate.format(day.dateObject);
    countCell.textContent = numberFormat.format(day.attempts);
    dateCell.append(time);
    row.append(dateCell, countCell);
    fragment.append(row);
  }
  dailyTableBody.replaceChildren(fragment);
}

function renderChart(days) {
  const peak = Math.max(0, ...days.map((day) => day.attempts));
  document.querySelector('#chart-scale').textContent = peak
    ? `Busiest day: ${numberFormat.format(peak)}`
    : 'No activity yet';
  chartEmpty.hidden = peak !== 0;
  chartBars.hidden = peak === 0;

  const fragment = document.createDocumentFragment();
  days.forEach((day, index) => {
    const column = document.createElement('li');
    const barWrap = document.createElement('div');
    const bar = document.createElement('span');
    const tick = document.createElement('span');

    column.className = 'admin-chart-day';
    column.title = `${longUtcDate.format(day.dateObject)}: ${numberFormat.format(day.attempts)} admitted checks`;
    barWrap.className = 'admin-chart-bar-wrap';
    bar.className = 'admin-chart-bar';
    bar.style.height = peak && day.attempts ? `${day.attempts / peak * 100}%` : '0%';
    tick.className = 'admin-chart-tick';
    if (index === 0 || index === days.length - 1 || index % 6 === 0) {
      tick.textContent = shortUtcDate.format(day.dateObject);
    }

    barWrap.append(bar);
    column.append(barWrap, tick);
    fragment.append(column);
  });
  chartBars.replaceChildren(fragment);
  chartViewport.scrollLeft = chartViewport.scrollWidth - chartViewport.clientWidth;
  renderDailyTable(days);
}

function renderOutcomes(metrics) {
  for (const key of outcomeKeys) {
    const count = metrics.outcomes[key];
    document.getElementById(`outcome-${key}`).textContent = numberFormat.format(count);
    const percent = metrics.totals.last30Days ? Math.min(100, count / metrics.totals.last30Days * 100) : 0;
    document.getElementById(`outcome-bar-${key}`).style.width = `${percent}%`;
  }
}

async function refreshMetrics() {
  refreshButton.disabled = true;
  refreshLabel.textContent = hasLoadedMetrics ? 'Refreshing…' : 'Loading…';
  summary.setAttribute('aria-busy', 'true');
  setStatus(hasLoadedMetrics ? 'Refreshing activity…' : 'Loading activity…');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/admin/metrics', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) throw new Error('access_denied');
    if (!response.ok) throw new Error('request_failed');

    const metrics = parseMetrics(await response.json());
    renderSummary(metrics);
    renderChart(metrics.days);
    renderOutcomes(metrics);
    hasLoadedMetrics = true;
    setStatus(`Updated ${localDateTime.format(metrics.generatedAt)}. Dates use UTC.`);
  } catch (error) {
    if (error.message === 'access_denied') {
      setStatus('Access denied. Reload this page and enter the owner credentials.', true);
    } else if (hasLoadedMetrics) {
      setStatus('Could not refresh. Showing the last loaded counts. Select Refresh data to try again.', true);
    } else if (error.name === 'AbortError') {
      setStatus('Loading took too long. Select Refresh data to try again.', true);
    } else {
      setStatus('Could not load activity. Select Refresh data to try again.', true);
    }
  } finally {
    clearTimeout(timeout);
    refreshButton.disabled = false;
    refreshLabel.textContent = 'Refresh data';
    summary.removeAttribute('aria-busy');
  }
}

refreshButton.addEventListener('click', refreshMetrics);
refreshMetrics();
