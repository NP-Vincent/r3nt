import { el, fmt } from './dom.js';

let activeConfirmation = null;

const closeActiveConfirmation = (decision = false) => {
  if (activeConfirmation && typeof activeConfirmation.close === 'function') {
    activeConfirmation.close(decision);
  }
};

const createDetailRow = (label, value) => {
  if (!label || value === undefined || value === null || value === '') {
    return null;
  }
  return el('div', { class: 'confirmation-detail-row' }, [
    el('dt', {}, label),
    el('dd', {}, value),
  ]);
};

export function confirmBookingAction({
  title = 'Confirm action',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Go back',
  booking = null,
  footnote = '',
} = {}) {
  closeActiveConfirmation(false);

  const detailRows = [];
  const bookingId = booking?.bookingIdText || booking?.bookingId;
  const listingTitle = booking?.listingTitle || '';
  const startLabel = booking?.startLabel || booking?.start;
  const endLabel = booking?.endLabel || booking?.end;
  const deposit = booking?.deposit;
  const rent = booking?.rent;
  const period = booking?.periodLabel || booking?.period;

  if (listingTitle) {
    detailRows.push(createDetailRow('Listing', listingTitle));
  }
  if (bookingId) {
    detailRows.push(createDetailRow('Booking', `#${bookingId}`));
  }
  if (startLabel || endLabel) {
    const stayValue = [startLabel || '—', endLabel || '—'].join(' → ');
    detailRows.push(createDetailRow('Stay', stayValue));
  }
  if (deposit !== undefined && deposit !== null) {
    detailRows.push(createDetailRow('Deposit', `${fmt.usdc(deposit)} USDC`));
  }
  if (rent !== undefined && rent !== null) {
    detailRows.push(createDetailRow('Rent', `${fmt.usdc(rent)} USDC`));
  }
  if (period) {
    detailRows.push(createDetailRow('Payments', period));
  }

  return new Promise((resolve) => {
    const previousActiveElement = document.activeElement;
    const previousOverflow = document.body.style.overflow;

    const dialogChildren = [
      el('h3', { class: 'confirmation-title' }, title),
    ];

    if (message) {
      dialogChildren.push(el('p', { class: 'confirmation-message' }, message));
    }

    if (detailRows.length > 0) {
      dialogChildren.push(
        el(
          'dl',
          { class: 'confirmation-details' },
          detailRows.filter(Boolean),
        ),
      );
    }

    if (footnote) {
      dialogChildren.push(el('p', { class: 'confirmation-footnote' }, footnote));
    }

    const cancelButton = el(
      'button',
      { type: 'button', class: 'inline-button confirmation-dismiss' },
      cancelLabel,
    );
    const confirmButton = el(
      'button',
      { type: 'button', class: 'confirmation-confirm' },
      confirmLabel,
    );

    const actions = el('div', { class: 'confirmation-actions' }, [cancelButton, confirmButton]);
    dialogChildren.push(actions);

    const dialog = el('div', { class: 'confirmation-dialog', role: 'document' }, dialogChildren);
    const overlay = el('div', { class: 'confirmation-overlay', role: 'dialog', 'aria-modal': 'true' }, dialog);
    overlay.tabIndex = -1;

    let settled = false;
    const cleanup = (decision) => {
      if (settled) return;
      settled = true;
      overlay.removeEventListener('click', overlayClick);
      overlay.removeEventListener('keydown', overlayKeydown);
      cancelButton.removeEventListener('click', cancelHandler);
      confirmButton.removeEventListener('click', confirmHandler);
      overlay.remove();
      document.body.style.overflow = previousOverflow;
      activeConfirmation = null;
      if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
        try {
          previousActiveElement.focus();
        } catch {}
      }
      resolve(decision);
    };

    const cancelHandler = () => cleanup(false);
    const confirmHandler = () => cleanup(true);
    const overlayClick = (event) => {
      if (event.target === overlay) {
        cleanup(false);
      }
    };
    const overlayKeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cleanup(false);
      }
    };

    cancelButton.addEventListener('click', cancelHandler);
    confirmButton.addEventListener('click', confirmHandler);
    overlay.addEventListener('click', overlayClick);
    overlay.addEventListener('keydown', overlayKeydown);

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    activeConfirmation = { close: cleanup };

    requestAnimationFrame(() => {
      try {
        confirmButton.focus();
      } catch {}
    });
  });
}
