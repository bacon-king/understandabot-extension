(() => {
  "use strict";

  const toggle = document.getElementById("toggle");
  const statusValue = document.getElementById("statusValue");
  const apiUrlInput = document.getElementById("apiUrl");
  const serverStatus = document.getElementById("serverStatus");

  const DEFAULT_API_URL = "https://understandabot-backend.onrender.com";

  function updateToggleUI(enabled) {
    const isEnabled = Boolean(enabled);
    toggle.setAttribute("aria-checked", String(isEnabled));
    toggle.classList.toggle("on", isEnabled);
    statusValue.textContent = isEnabled ? "ON" : "OFF";
  }

  async function checkServer(url) {
    serverStatus.className = "server-status";
    serverStatus.textContent = "Connecting to server...";

    try {
      const resp = await fetch(`${url.replace(/\/+$/, "")}/api/v1/health`, {
        method: "GET",
        signal: AbortSignal.timeout(4000)
      });
      if (resp.ok) {
        const data = await resp.json();
        serverStatus.className = "server-status online";
        serverStatus.textContent = `● Online (${data.device.toUpperCase()})`;
      } else {
        throw new Error(`HTTP ${resp.status}`);
      }
    } catch (err) {
      serverStatus.className = "server-status offline";
      serverStatus.textContent = "● Offline / Sleeping (Free Tier)";
    }
  }

  // Load saved state from chrome.storage.local
  chrome.storage.local.get(
    { enabled: false, backendApiUrl: DEFAULT_API_URL },
    result => {
      updateToggleUI(result.enabled);
      if (apiUrlInput) {
        apiUrlInput.value = result.backendApiUrl || DEFAULT_API_URL;
        checkServer(apiUrlInput.value);
      }
    }
  );

  // Toggle extension ON / OFF
  toggle.addEventListener("click", async () => {
    const currentlyEnabled = toggle.getAttribute("aria-checked") === "true";
    const newState = !currentlyEnabled;
    await chrome.storage.local.set({ enabled: newState });
    updateToggleUI(newState);
  });

  // Save updated API URL
  if (apiUrlInput) {
    let debounceTimer;
    apiUrlInput.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const newUrl = apiUrlInput.value.trim() || DEFAULT_API_URL;
        await chrome.storage.local.set({ backendApiUrl: newUrl });
        checkServer(newUrl);
      }, 600);
    });
  }

  // Synchronize state across open popups/tabs
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.enabled) {
      updateToggleUI(changes.enabled.newValue);
    }
  });
})();