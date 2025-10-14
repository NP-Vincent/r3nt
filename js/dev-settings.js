(function () {
  if (typeof window === 'undefined') {
    return;
  }

  window.__R3NT_DEV_SETTINGS__ = {
    /**
     * Set to `true` to force the developer console on for every page.
     * Set to `false` to force the console off everywhere.
     * Set to `null` (or remove this property) to use the per-browser toggle
     * managed from the Platform admin view.
     */
    devConsoleOverride: null,
    /**
     * When `devConsoleOverride` is `null`, this value controls the default state
     * if there is no preference stored in localStorage.
     */
    devConsoleDefault: false,
  };
})();
