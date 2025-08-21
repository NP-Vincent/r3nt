// /js/index.js
import { ready, maybeShowReadOnlyBanner } from "./shared.js";

window.addEventListener("DOMContentLoaded", async () => {
  await maybeShowReadOnlyBanner();
  await ready();
});
