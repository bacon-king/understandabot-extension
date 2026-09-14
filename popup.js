(() => {
  "use strict";

  const toggle =
    document.getElementById("toggle");

  const statusValue =
    document.getElementById("statusValue");

  function updateUI(enabled) {
    const isEnabled =
      Boolean(enabled);

    toggle.setAttribute(
      "aria-checked",
      String(isEnabled)
    );

    toggle.classList.toggle(
      "on",
      isEnabled
    );

    statusValue.textContent =
      isEnabled ? "ON" : "OFF";
  }

  // Load saved state.
  chrome.storage.local.get(
    { enabled: false },
    result => {
      updateUI(result.enabled);
    }
  );

  // Toggle extension.
  toggle.addEventListener(
    "click",
    async () => {
      const currentlyEnabled =
        toggle.getAttribute(
          "aria-checked"
        ) === "true";

      const newState =
        !currentlyEnabled;

      await chrome.storage.local.set({
        enabled: newState
      });

      updateUI(newState);
    }
  );

  // Keep UI synchronized.
  chrome.storage.onChanged.addListener(
    (changes, area) => {
      if (
        area === "local" &&
        changes.enabled
      ) {
        updateUI(
          changes.enabled.newValue
        );
      }
    }
  );
})();