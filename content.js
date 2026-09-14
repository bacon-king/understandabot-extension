//the input image size is 96p, no preprocessing aside from resizing the image, and the image is just simply classified into one of 5 categories: gaming, podcasts, science and education, sports, or vlogs.
(() => {
  "use strict";

  console.log("[Understandabot] CONTENT SCRIPT IS RUNNING");

  let enabled = false;
  let popup = null;
  let hoveredVideo = null;
  let hoverTimer = null;
  let resultTimer = null;

  const HOVER_DELAY = 300;
  const RESULT_DELAY = 1400;

  // ============================================================
  // DEBUG INDICATOR
  // ============================================================

  function createDebugIndicator() {
    if (document.getElementById("ub-debug-indicator")) return;

    const indicator = document.createElement("div");

    indicator.id = "ub-debug-indicator";

    indicator.textContent = "UB ACTIVE";

    indicator.style.cssText = `
      position: fixed;
      bottom: 10px;
      right: 10px;
      z-index: 2147483647;
      background: #2e7d32;
      color: white;
      padding: 5px 9px;
      border-radius: 5px;
      font-family: Arial, sans-serif;
      font-size: 11px;
      font-weight: bold;
      pointer-events: none;
    `;

    document.documentElement.appendChild(indicator);
  }

  // ============================================================
  // POPUP
  // ============================================================

  // Color/dot values sampled directly from the design mockups.
  const DOT_COLORS = [
    "#d6ad9a",
    "#ce9a89",
    "#c68879",
    "#c0776a",
    "#b8655a",
    "#b1534a",
    "#aa413a",
    "#a32f29"
  ];

  function injectStyles() {
    if (document.getElementById("ub-styles")) return;

    const style = document.createElement("style");

    style.id = "ub-styles";

    style.textContent = `
      #understandabot-popup {
        position: fixed;
        display: none;
        flex-direction: column;
        width: 280px;
        min-height: 130px;
        background: #545454;
        color: #fff;
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 10px 34px rgba(0,0,0,.4);
        z-index: 2147483647;
        font-family: Arial, Helvetica, sans-serif;
        pointer-events: none;
      }

      .ub-header {
        padding: 12px 14px;
        background: #38363a;
        font-size: 15px;
        font-weight: 800;
      }

      .ub-header .ub-brand { color: #ff3131; }
      .ub-header .ub-suffix { color: #fff; }

      .ub-body { padding: 18px 16px; }

      /* Loading state */
      .ub-loading-text {
        margin: 0 0 20px;
        font-size: 14px;
        font-weight: 600;
        text-align: center;
      }

      .ub-spinner-ring {
        position: relative;
        width: 64px;
        height: 64px;
        margin: 0 auto;
        animation: ub-rotate 1.1s linear infinite;
      }

      .ub-dot {
        position: absolute;
        top: 50%;
        left: 50%;
        width: 10px;
        height: 10px;
        margin: -5px;
        border-radius: 50%;
        transform: rotate(var(--angle)) translate(0, -27px);
      }

      @keyframes ub-rotate {
        to { transform: rotate(360deg); }
      }

      /* Result state */
      .ub-result-title {
        margin: 0 0 10px;
        font-size: 14px;
        font-weight: 700;
      }

      .ub-rows {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .ub-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
        background: #38363a;
        border-radius: 8px;
      }

      .ub-row-name { font-size: 13px; font-weight: 700; }

      .ub-row-confidence {
        font-size: 12px;
        font-style: italic;
        color: #b1b1b1;
        white-space: nowrap;
      }

      /* Error state */
      .ub-error-title {
        margin: 4px 0 10px;
        font-size: 18px;
        font-weight: 800;
        text-align: center;
      }

      .ub-error-message {
        margin: 0;
        font-size: 13px;
        color: #b1b1b1;
        text-align: center;
      }
    `;

    document.head.appendChild(style);
  }

  function createPopup() {
    if (popup) return popup;

    injectStyles();

    popup = document.createElement("div");

    popup.id = "understandabot-popup";

    popup.innerHTML = `
      <div class="ub-header">
        <span class="ub-brand">Understandabot</span><span class="ub-suffix">.ai</span>
      </div>

      <div id="ub-popup-body" class="ub-body"></div>
    `;

    document.documentElement.appendChild(popup);

    return popup;
  }

  function renderLoading(body) {
    const dots = DOT_COLORS.map((color, i) => {
      const angle = i * 45;

      return `<span class="ub-dot" style="--angle:${angle}deg; background:${color};"></span>`;
    }).join("");

    body.innerHTML = `
      <div class="ub-loading-text">Predicting category...</div>
      <div class="ub-spinner-ring">${dots}</div>
    `;
  }

  function renderResult(body, categories) {
    const rows = categories
      .map(
        c => `
          <div class="ub-row">
            <span class="ub-row-name">${c.name}</span>
            <span class="ub-row-confidence">${c.confidence}% confidence</span>
          </div>
        `
      )
      .join("");

    body.innerHTML = `
      <div class="ub-result-title">Most likely category</div>
      <div class="ub-rows">${rows}</div>
    `;
  }

  // Ready for when a real prediction call fails â€” not currently
  // triggered anywhere since results are still simulated.
  function renderError(body, message) {
    body.innerHTML = `
      <div class="ub-error-title">ERROR!</div>
      <p class="ub-error-message">${message || "Something went wrong."}</p>
    `;
  }

  // ============================================================
  // FIND VIDEO
  // ============================================================

  function findVideoElement(element) {
    if (!element) return null;

    // Walk up the DOM from whatever the mouse is over.
    let current = element;

    for (let i = 0; i < 10 && current; i++) {

      // Direct YouTube thumbnail link
      if (
        current.tagName === "A" &&
        current.id === "thumbnail"
      ) {
        return current;
      }

      // Any link pointing to a YouTube watch page
      if (
        current.tagName === "A" &&
        current.href &&
        current.href.includes("youtube.com/watch")
      ) {
        return current;
      }

      current = current.parentElement;
    }

    // Sometimes the mouse is over an element inside
    // a thumbnail but the parent traversal doesn't find it.
    const thumbnail = element.closest?.(
      'a#thumbnail'
    );

    if (thumbnail) {
      return thumbnail;
    }

    return null;
  }

  // ============================================================
  // POSITION POPUP
  // ============================================================

  function positionPopup(video) {
    if (!popup || !video) return;

    const rect = video.getBoundingClientRect();

    const popupWidth = 280;
    const popupHeight =
      popup.getBoundingClientRect().height || 150;

    let left = rect.right + 12;
    let top = rect.top;

    // If popup doesn't fit on right,
    // put it on the left.
    if (
      left + popupWidth >
      window.innerWidth - 10
    ) {
      left =
        rect.left -
        popupWidth -
        12;
    }

    // Keep inside viewport horizontally.
    if (left < 10) {
      left = 10;
    }

    // Keep inside viewport vertically.
    if (
      top + popupHeight >
      window.innerHeight - 10
    ) {
      top =
        window.innerHeight -
        popupHeight -
        10;
    }

    if (top < 10) {
      top = 10;
    }

    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  // ============================================================
  // SHOW POPUP
  // ============================================================

  function showPopup(video) {

    if (!enabled) return;

    if (!video) return;

    console.log(
      "[Understandabot] SHOWING POPUP",
      video
    );

    const popupElement = createPopup();

    const body =
      popupElement.querySelector(
        "#ub-popup-body"
      );

    popupElement.style.display = "flex";

    renderLoading(body);

    positionPopup(video);

    clearTimeout(resultTimer);

    resultTimer = setTimeout(() => {

      // Make sure the user is still hovering
      // over the same video.
      if (
        !enabled ||
        hoveredVideo !== video
      ) {
        return;
      }

      // Simulated result for now â€” swap for the real
      // prediction response (and call renderError(body, msg)
      // on failure) once the backend call is wired up.
      renderResult(body, [
        { name: "Category Name", confidence: 67 },
        { name: "Category Name", confidence: 67 },
        { name: "Category Name", confidence: 67 }
      ]);

      positionPopup(video);

    }, RESULT_DELAY);
  }

  // ============================================================
  // HIDE POPUP
  // ============================================================

  function hidePopup() {

    clearTimeout(hoverTimer);
    clearTimeout(resultTimer);

    hoveredVideo = null;

    if (popup) {
      popup.style.display = "none";
    }
  }

  // ============================================================
  // MOUSE MOVEMENT
  // ============================================================

  document.addEventListener(
    "mousemove",
    event => {

      if (!enabled) {
        return;
      }

      const video =
        findVideoElement(
          event.target
        );

      // Mouse isn't over a video.
      if (!video) {

        if (hoveredVideo) {
          hidePopup();
        }

        return;
      }

      // Still hovering same video.
      if (video === hoveredVideo) {
        return;
      }

      console.log(
        "[Understandabot] VIDEO HOVERED:",
        video.href
      );

      clearTimeout(hoverTimer);
      clearTimeout(resultTimer);

      hoveredVideo = video;

      hoverTimer = setTimeout(() => {

        if (
          enabled &&
          hoveredVideo === video
        ) {
          showPopup(video);
        }

      }, HOVER_DELAY);

    },
    true
  );

  // ============================================================
  // STORAGE
  // ============================================================

  chrome.storage.local.get(
    {
      enabled: false
    },
    result => {

      enabled =
        Boolean(result.enabled);

      console.log(
        "[Understandabot] Initial state:",
        enabled
      );

    }
  );

  chrome.storage.onChanged.addListener(
    (changes, area) => {

      if (
        area === "local" &&
        changes.enabled
      ) {

        enabled =
          Boolean(
            changes.enabled.newValue
          );

        console.log(
          "[Understandabot] State changed:",
          enabled
        );

        if (!enabled) {
          hidePopup();
        }
      }
    }
  );

  // ============================================================
  // WINDOW EVENTS
  // ============================================================

  window.addEventListener(
    "scroll",
    () => {

      if (
        popup &&
        popup.style.display === "flex" &&
        hoveredVideo
      ) {
        positionPopup(
          hoveredVideo
        );
      }

    },
    true
  );

  window.addEventListener(
    "resize",
    () => {

      if (
        popup &&
        popup.style.display === "flex" &&
        hoveredVideo
      ) {
        positionPopup(
          hoveredVideo
        );
      }

    }
  );

  // Create diagnostic indicator.
  createDebugIndicator();

})();