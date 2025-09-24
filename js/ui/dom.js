export const el = (tag, props={}, children=[]) => {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k,v]) => {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach(c => node.append(c?.nodeType ? c : document.createTextNode(String(c ?? ''))));
  return node;
};

const USDC_DECIMALS = 6;

const PERIOD_LABELS = new Map([
  ['day', 'Daily'],
  ['week', 'Weekly'],
  ['month', 'Monthly'],
  ['0', 'Unspecified'],
  ['1', 'Daily'],
  ['2', 'Weekly'],
  ['3', 'Monthly'],
]);

const toBigIntSafe = (value) => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isNaN(value)) return null;
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }
  return null;
};

const formatBigIntWithDecimals = (value, decimals = USDC_DECIMALS) => {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const units = abs / (10n ** BigInt(decimals));
  const remainder = (abs % (10n ** BigInt(decimals))).toString().padStart(decimals, '0').replace(/0+$/, '');
  const base = `${units.toString()}${remainder ? `.${remainder}` : ''}`;
  return negative ? `-${base}` : base;
};

const formatInteger = (value) => {
  if (typeof value === 'bigint') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && Math.abs(numeric) <= Number.MAX_SAFE_INTEGER) {
      return numeric.toLocaleString('en-US');
    }
    return value.toString();
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isNaN(value)) return '0';
    return Math.trunc(value).toLocaleString('en-US');
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed).toLocaleString('en-US');
    return value;
  }
  return '0';
};

const formatDurationSeconds = (seconds) => {
  const value = toBigIntSafe(seconds) ?? 0n;
  if (value <= 0n) return 'None';
  const totalSeconds = Number(value);
  if (!Number.isFinite(totalSeconds)) return `${value.toString()} sec`;
  const days = Math.floor(totalSeconds / 86400);
  const remainder = totalSeconds % 86400;
  if (days > 0 && remainder === 0) {
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (days > 0) {
    const hours = Math.round(remainder / 3600);
    if (hours === 0) {
      return `${days} day${days === 1 ? '' : 's'}`;
    }
    return `${days} day${days === 1 ? '' : 's'} ${hours} h`;
  }
  const hoursOnly = Math.max(1, Math.round(totalSeconds / 3600));
  return `${hoursOnly} hour${hoursOnly === 1 ? '' : 's'}`;
};

const formatTimestampSeconds = (seconds, { isoDate = false } = {}) => {
  const value = toBigIntSafe(seconds);
  if (!value || value <= 0n) return '';
  let numeric;
  try {
    numeric = Number(value);
  } catch {
    return `Unix ${value.toString()}`;
  }
  if (!Number.isFinite(numeric) || Number.isNaN(numeric)) {
    return `Unix ${value.toString()}`;
  }
  const date = new Date(numeric * 1000);
  if (Number.isNaN(date.getTime())) {
    return `Unix ${value.toString()}`;
  }
  if (isoDate) {
    return date.toISOString().slice(0, 10);
  }
  return `${date.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
};

const formatBasisPoints = (value) => {
  const raw = toBigIntSafe(value);
  if (raw === null) return '0 bps';
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    return `${raw.toString()} bps`;
  }
  const percent = (numeric / 100).toFixed(2).replace(/\.0+$/, '').replace(/\.([1-9])0$/, '.$1');
  return `${percent}% (${raw.toString()} bps)`;
};

const resolvePeriodLabel = (value) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (PERIOD_LABELS.has(normalized)) {
      return PERIOD_LABELS.get(normalized);
    }
    if (/^\d+$/.test(normalized) && PERIOD_LABELS.has(normalized)) {
      return PERIOD_LABELS.get(normalized);
    }
  }
  const asBigInt = toBigIntSafe(value);
  if (asBigInt !== null) {
    const label = PERIOD_LABELS.get(asBigInt.toString());
    if (label) return label;
  }
  return '';
};

const formatUsdc = (value) => {
  if (value === undefined || value === null) return '0';
  if (typeof value === 'bigint') {
    return formatBigIntWithDecimals(value, USDC_DECIMALS);
  }
  const asBigInt = toBigIntSafe(value);
  if (asBigInt !== null) {
    return formatBigIntWithDecimals(asBigInt, USDC_DECIMALS);
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || Number.isNaN(numeric)) {
    return '0';
  }
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: USDC_DECIMALS,
  }).format(numeric);
};

export const fmt = {
  money: (value) => formatUsdc(value),
  usdc: (value) => formatUsdc(value),
  sqm:   (n) => `${formatInteger(n)} m²`,
  sqmu:  (value) => formatInteger(value),
  duration: (seconds) => formatDurationSeconds(seconds),
  timestamp: (seconds) => formatTimestampSeconds(seconds),
  date: (seconds) => formatTimestampSeconds(seconds, { isoDate: true }) || '—',
  bps: (value) => formatBasisPoints(value),
  period: (value) => resolvePeriodLabel(value) || '—',
};
