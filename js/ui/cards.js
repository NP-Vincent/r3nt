import { el, fmt } from './dom.js';

const Pill = (text, extraClass = '') => {
  const className = extraClass ? `pill ${extraClass}` : 'pill';
  return el('span', { class: className }, text);
};

const periodLabel = (value) => {
  if (value === undefined || value === null || value === '') return '—';
  const label = fmt.period(value);
  if (label) return label;
  return typeof value === 'string' ? value : String(value);
};

export function ListingCard({ id, title, location, pricePerDayUSDC, areaSqm, depositUSDC, status, actions = [] }) {
  return el('div', { class: 'card listing-card', dataset: { id } }, [
    el('div', { class: 'card-header' }, [
      el('strong', {}, title || `Listing #${id}`),
      el('div', { class: 'card-meta' }, [
        Pill(location || '—'),
        pricePerDayUSDC != null ? Pill(`Daily ${fmt.usdc(pricePerDayUSDC)} USDC`) : null,
        areaSqm != null ? Pill(fmt.sqm(areaSqm)) : null,
        depositUSDC != null ? Pill(`Deposit ${fmt.usdc(depositUSDC)} USDC`) : null,
        status ? Pill(status) : null,
      ].filter(Boolean)),
    ]),
    el(
      'div',
      { class: 'card-actions' },
      actions
        .filter((a) => a?.visible !== false)
        .map((a) => el('button', { class: 'inline-button', onClick: a.onClick }, a.label)),
    ),
  ]);
}

export function BookingCard({
  bookingId,
  listingId,
  dates,
  period,
  depositUSDC,
  rentUSDC,
  status,
  statusClass,
  actions = [],
}) {
  const periodText = (periodLabel(period) || '').trim();
  const showPeriod = Boolean(periodText) && periodText !== '—';
  return el('div', { class: 'card data-card booking-entry', dataset: { bookingId, listingId } }, [
    el('div', { class: 'card-header' }, [
      el('strong', {}, `Booking #${bookingId}`),
      el('div', { class: 'card-meta' }, [
        Pill(dates || '—'),
        showPeriod ? Pill(periodText) : null,
        depositUSDC != null ? Pill(`Deposit ${fmt.usdc(depositUSDC)} USDC`) : null,
        rentUSDC != null ? Pill(`Rent ${fmt.usdc(rentUSDC)} USDC`) : null,
        status
          ? Pill(
              status,
              ['booking-status-badge', statusClass ? `booking-status-${statusClass}` : '']
                .filter(Boolean)
                .join(' '),
            )
          : null,
      ].filter(Boolean)),
    ]),
    el(
      'div',
      { class: 'card-actions' },
      actions
        .filter((a) => a?.visible !== false)
        .map((a) => el('button', { class: 'inline-button', onClick: a.onClick }, a.label)),
    ),
  ]);
}

export function TokenisationCard({ bookingId, totalSqmu, soldSqmu, pricePerSqmu, feeBps, period, mode = 'invest', onSubmit }) {
  const form = el('form', { class: 'token-proposal-card card' }, [
    el('h3', {}, mode === 'propose' ? 'Propose tokenisation' : 'Invest in SQMU-R'),
    el('div', { class: 'card-meta' }, [
      Pill(`Booking #${bookingId}`),
      totalSqmu != null ? Pill(`Total ${fmt.sqmu(totalSqmu)} SQMU`) : null,
      soldSqmu != null ? Pill(`Sold ${fmt.sqmu(soldSqmu)}`) : null,
      pricePerSqmu != null ? Pill(`Price ${fmt.usdc(pricePerSqmu)} USDC`) : null,
      feeBps != null ? Pill(fmt.bps(feeBps)) : null,
      period ? Pill(periodLabel(period)) : null,
    ].filter(Boolean)),
    el('label', {}, [
      el('span', {}, mode === 'propose' ? 'Total SQMU' : 'Amount (SQMU)'),
      el('input', { name: 'amount', type: 'number', step: '1', min: '1', required: true }),
    ]),
    mode === 'propose'
      ? el('label', {}, [
          el('span', {}, 'Price per SQMU (USDC)'),
          el('input', { name: 'price', type: 'number', step: '0.000001', min: '0', required: true }),
        ])
      : null,
    mode === 'propose'
      ? el('label', {}, [
          el('span', {}, 'Platform fee (bps)'),
          el('input', { name: 'fee', type: 'number', step: '1', min: '0', max: '10000', required: true }),
        ])
      : null,
    mode === 'propose'
      ? el('label', {}, [
          el('span', {}, 'Distribution period'),
          el('select', { name: 'period', required: true }, [
            el('option', { value: 'day' }, 'Daily'),
            el('option', { value: 'week' }, 'Weekly'),
            el('option', { value: 'month' }, 'Monthly'),
          ]),
        ])
      : null,
    el('div', { class: 'card-actions' }, [
      el('button', { type: 'submit', class: 'inline-button' }, mode === 'propose' ? 'Submit proposal' : 'Invest'),
    ]),
  ].filter(Boolean));

  if (onSubmit)
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      onSubmit(Object.fromEntries(fd));
    });
  return form;
}
