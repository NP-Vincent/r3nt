export function actionsFor({ role, entity, perms }) {
  // entity: 'listing' | 'booking' | 'token'
  // perms: capabilities computed from chain state
  if (entity === 'listing') {
    return [
      { label:'Preview totals', onClick: perms.onPreview, visible: role==='tenant' },
      { label:'Book', onClick: perms.onBook, visible: role==='tenant' && perms.bookable },
      { label:'Check availability', onClick: perms.onCheck, visible: role==='landlord' },
      { label: perms.active ? 'Deactivate' : 'Activate', onClick: perms.onToggleActive, visible: role==='landlord' },
      { label:'Propose tokenisation', onClick: perms.onPropose, visible: perms.canPropose },
    ];
  }
  if (entity === 'booking') {
    return [
      { label:'Pay rent', onClick: perms.onPay, visible: role==='tenant' && perms.canPay },
      { label:'Propose deposit split', onClick: perms.onSplit, visible: role==='landlord' && perms.canSplit },
      { label:'Claim rent', onClick: perms.onClaim, visible: role==='investor' && perms.canClaim },
    ];
  }
  return [];
}
