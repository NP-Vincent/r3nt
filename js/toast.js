// toast.js
(function () {
  const containerId = "toast-container";

  function ensureContainer() {
    let c = document.getElementById(containerId);
    if (!c) {
      c = document.createElement("div");
      c.id = containerId;
      c.style.position = "fixed";
      c.style.top = "1rem";
      c.style.right = "1rem";
      c.style.zIndex = "9999";
      c.style.display = "flex";
      c.style.flexDirection = "column";
      c.style.gap = "0.5rem";
      document.body.appendChild(c);
    }
    return c;
  }

  function showToast(message, type = "ok", duration = 4000) {
    const c = ensureContainer();
    const t = document.createElement("div");
    t.innerText = message;
    t.style.padding = "0.75rem 1rem";
    t.style.borderRadius = "6px";
    t.style.fontFamily = "sans-serif";
    t.style.fontSize = "0.9rem";
    t.style.color = "#fff";
    t.style.boxShadow = "0 2px 6px rgba(0,0,0,0.2)";
    t.style.cursor = "pointer";
    t.style.transition = "opacity 0.3s ease";

    if (type === "error") {
      t.style.backgroundColor = "#d9534f"; // red
    } else {
      t.style.backgroundColor = "#5cb85c"; // green
    }

    t.onclick = () => {
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 300);
    };

    c.appendChild(t);

    setTimeout(() => {
      if (t.parentNode) {
        t.style.opacity = "0";
        setTimeout(() => t.remove(), 300);
      }
    }, duration);
  }

  // expose globally
  window.showToast = showToast;
})();
