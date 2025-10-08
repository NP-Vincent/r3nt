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

export function ListingCard({
  id,
  title,
  summary,
  location,
  pricePerDayUSDC,
  areaSqm,
  depositUSDC,
  status,
  actions = [],
  imageUrl,
  detailLink,
}) {
  const visibleActions = actions.filter((a) => a?.visible !== false);
  const actionButtons = visibleActions.map((a) => el('button', { class: 'inline-button', onClick: a.onClick }, a.label));
  const summaryText = typeof summary === 'string' ? summary.trim() : '';

  const headerChildren = [el('strong', {}, title || `Listing #${id}`)];
  if (summaryText) {
    headerChildren.push(el('div', { class: 'listing-summary' }, summaryText));
  }

  if (detailLink?.href) {
    const detailLinkProps = {
      href: detailLink.href,
      target: '_blank',
      rel: 'noopener',
      class: detailLink.className || 'listing-link listing-link-subtle',
    };
    if (typeof detailLink.onClick === 'function') {
      detailLinkProps.onClick = detailLink.onClick;
    }
    headerChildren.push(
      el('div', { class: 'listing-farcaster-link' }, [
        el('a', detailLinkProps, detailLink.label || 'View full details on Farcaster'),
      ]),
    );
  }

  const metaPills = [
    Pill(location || '—'),
    pricePerDayUSDC != null ? Pill(`Daily ${fmt.usdc(pricePerDayUSDC)} USDC`) : null,
    areaSqm != null ? Pill(fmt.sqm(areaSqm)) : null,
    depositUSDC != null ? Pill(`Deposit ${fmt.usdc(depositUSDC)} USDC`) : null,
    status ? Pill(status) : null,
  ].filter(Boolean);
  if (metaPills.length > 0) {
    headerChildren.push(el('div', { class: 'card-meta' }, metaPills));
  }

  const children = [];

  const normalizedImageUrl = typeof imageUrl === 'string' ? imageUrl.trim() : '';
  if (normalizedImageUrl) {
    const altText = title ? `${title} preview image` : 'Listing preview image';
    children.push(
      el('div', { class: 'listing-card-preview-wrapper' }, [
        el('img', {
          class: 'listing-card-preview',
          src: normalizedImageUrl,
          alt: altText,
          loading: 'lazy',
          decoding: 'async',
        }),
      ]),
    );
  }

  children.push(el('div', { class: 'card-header' }, headerChildren));

  if (actionButtons.length > 0) {
    children.push(el('div', { class: 'card-actions' }, actionButtons));
  }

  return el('div', { class: 'card listing-card', dataset: { id } }, children);
}

export function BookingCard({
  bookingId,
  listingId,
  dates,
  period,
  depositUSDC,
  rentUSDC,
  tenantFeeBps,
  status,
  statusClass,
  actions = [],
}) {
  const periodText = (periodLabel(period) || '').trim();
  const showPeriod = Boolean(periodText) && periodText !== '—';
  const tenantFeeAvailable = tenantFeeBps !== undefined && tenantFeeBps !== null;
  const tenantFeePill = tenantFeeAvailable ? Pill(`Tenant fee ${fmt.bps(tenantFeeBps)}`) : null;
  if (tenantFeePill) {
    tenantFeePill.dataset.role = 'tenant-fee-bps';
  }
  return el('div', { class: 'card data-card booking-entry', dataset: { bookingId, listingId } }, [
    el('div', { class: 'card-header' }, [
      el('strong', {}, `Booking #${bookingId}`),
      el('div', { class: 'card-meta' }, [
        Pill(dates || '—'),
        showPeriod ? Pill(periodText) : null,
        depositUSDC != null ? Pill(`Deposit ${fmt.usdc(depositUSDC)} USDC`) : null,
        rentUSDC != null ? Pill(`Rent ${fmt.usdc(rentUSDC)} USDC`) : null,
        tenantFeePill,
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
  const amountInput = el('input', { name: 'amount', type: 'number', step: '1', min: '1', required: true });
  const amountLabelChildren = [
    el('span', {}, mode === 'propose' ? 'Total SQMU' : 'Amount (SQMU)'),
    amountInput,
  ];
  if (mode === 'invest') {
    amountLabelChildren.push(
      el('div', { class: 'muted total-usdc', dataset: { role: 'total-usdc' } }, '0 USDC'),
    );
  }

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
    el('label', {}, amountLabelChildren),
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
