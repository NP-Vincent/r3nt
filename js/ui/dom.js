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
export const fmt = {
  money: (n) => new Intl.NumberFormat(undefined, {minimumFractionDigits:2, maximumFractionDigits:6}).format(Number(n || 0)),
  sqm:   (n) => `${n} m²`,
};
