// /toast.js (class-based, no inline styles)
(function () {
  const CID = "toast-container";

  function container() {
    let c = document.getElementById(CID);
    if (!c) {
      c = document.createElement("div");
      c.id = CID;
      document.body.appendChild(c);
    }
    return c;
  }

  /**
   * Show a toast
   * @param {string} message - text/html allowed
   * @param {"success"|"error"|"info"|"warning"} [type="success"]
   * @param {number} [ms=4000]
   */
  function showToast(message, type = "success", ms = 4000) {
    const c = container();
    const t = document.createElement("div");
    t.className = `toast ${type}`;
    t.innerHTML = message;

    // remove on click
    t.addEventListener("click", () => dismiss(t));
    c.appendChild(t);

    // animate in
    requestAnimationFrame(() => t.classList.add("show"));

    // auto-dismiss
    const timeout = setTimeout(() => dismiss(t), ms);
    t.dataset.timeout = timeout;
    return t;
  }

  function dismiss(t) {
    if (!t) return;
    const timeout = t.dataset.timeout;
    if (timeout) clearTimeout(timeout);
    t.classList.remove("show");
    // allow transition to play
    setTimeout(() => t.remove(), 220);
  }

  // expose
  window.showToast = showToast;
  window.dismissToast = dismiss;
})();
