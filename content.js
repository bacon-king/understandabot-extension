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
  // ONNX MODEL PREDICTION
  // ============================================================
  let extractorSession = null;
  let classifierSession = null;
  const CATEGORIES = ["Gaming", "Podcasts", "Science & Education", "Sports", "Vlogs"];

  ort.env.wasm.wasmPaths = chrome.runtime.getURL('wasm/');
  ort.env.wasm.numThreads = 1;

  async function loadModels() {

    if (!chrome.runtime?.id) {
      throw new Error("Extension was reloaded â€” refresh this YouTube tab and try again.");
    }

    if (!extractorSession) {
      const extUrl = chrome.runtime.getURL("extractor.onnx");
      extractorSession = await ort.InferenceSession.create(extUrl, { 
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });
    }
    
    if (!classifierSession) {
      const clsUrl = chrome.runtime.getURL("classifier.onnx");
      
      classifierSession = await ort.InferenceSession.create(clsUrl, { 
        executionProviders: ['wasm'] 
      });
    }
  }

  const IMAGENET_MEAN = [0.485, 0.456, 0.406];
  const IMAGENET_STD = [0.229, 0.224, 0.225];

  function preprocessCanvas(canvas) {
    const size = 224;
    const ctx = canvas.getContext("2d");
    const { data } = ctx.getImageData(0, 0, size, size); // RGBA, Uint8ClampedArray

    const plane = size * size;
    const chw = new Float32Array(3 * plane);

    for (let i = 0; i < plane; i++) {
      const offset = i * 4;

      chw[i] = (data[offset] / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];               // R
      chw[plane + i] = (data[offset + 1] / 255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1];    // G
      chw[plane * 2 + i] = (data[offset + 2] / 255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2]; // B
      // data[offset + 3] is alpha â€” intentionally unused
    }

    return chw;
  }

  async function predictCategories(canvases) {
    try {
      await loadModels();
    } catch (e) {
      console.error("[Understandabot] Raw model load failure:", e);

      throw new Error("Model Load Error: " + (e?.message || String(e)));
    }

    const allFeatures = [];

    // Step 1: Run Extractor 5 times (Batch Size 1 to save memory)
    for (let f = 0; f < 5; f++) {
      const frameData = preprocessCanvas(canvases[f]);
      const inputTensor = new ort.Tensor('float32', frameData, [1, 3, 224, 224]);
      const results = await extractorSession.run({ input: inputTensor });
      allFeatures.push(results.features.data); // Should be length 1280
    }

    // Step 2: Mean and Max Pooling in JavaScript
    const featureLength = 1280;
    const pooledData = new Float32Array(featureLength * 2); // 2560

    for (let i = 0; i < featureLength; i++) {
      let sum = 0;
      let max = -Infinity;
      for (let f = 0; f < 5; f++) {
        const val = allFeatures[f][i];
        sum += val;
        if (val > max) max = val;
      }
      pooledData[i] = sum / 5;               // Mean pool first half
      pooledData[featureLength + i] = max;   // Max pool second half
    }

    // Step 3: Run Classifier
    const pooledTensor = new ort.Tensor('float32', pooledData, [1, 2560]);
    const finalResults = await classifierSession.run({ pooled_features: pooledTensor });
    const logits = finalResults.logits.data;

    // Softmax
    const maxLogit = Math.max(...logits);
    const exps = logits.map(l => Math.exp(l - maxLogit));
    const sumExps = exps.reduce((a, b) => a + b, 0);
    const probs = exps.map(e => e / sumExps);

    const predictions = CATEGORIES.map((name, index) => ({
      name,
      confidence: (probs[index] * 100).toFixed(1)
    })).sort((a, b) => b.confidence - a.confidence);

    return predictions.slice(0, 3);
  }

  function captureFrameAt(video, percent) {
    return new Promise((resolve, reject) => {
      const targetTime = video.duration * percent;
      
      // Fail if seeking takes longer than 3 seconds
      const timeout = setTimeout(() => {
        video.removeEventListener("seeked", onSeeked);
        reject(new Error(`Seeking to ${percent * 100}% timed out.`));
      }, 3000);

      const onSeeked = () => {
        clearTimeout(timeout);
        video.removeEventListener("seeked", onSeeked);
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 224;
          canvas.height = 224;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(video, 0, 0, 224, 224);
          resolve(canvas);
        } catch (e) {
          reject(new Error("Canvas draw failed: " + e.message));
        }
      };

      video.addEventListener("seeked", onSeeked);
      video.currentTime = targetTime;
    });
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

    // Stop previous timers
    clearTimeout(resultTimer);

    // Small delay to ensure the video element has loaded its metadata/duration
    resultTimer = setTimeout(async () => {
      if (!enabled || hoveredVideo !== video) return;

      // Ensure we are targeting the actual HTML5 video tag
      const videoTag = video.querySelector('video') || video;
      
      if (!videoTag.duration || isNaN(videoTag.duration)) {
        renderError(body, "Video preview not loaded.");
        return;
      }

      try {
        const originalTime = videoTag.currentTime;
        const wasPaused = videoTag.paused;

        const percentages = [0.10, 0.25, 0.50, 0.75, 0.90];
        const canvases = [];

        for (const pct of percentages) {
          const canvas = await captureFrameAt(videoTag, pct);
          canvases.push(canvas);
        }

        // Restore video state
        videoTag.currentTime = originalTime;
        if (!wasPaused) videoTag.play();

        const topCategories = await predictCategories(canvases);

        if (enabled && hoveredVideo === video) {
          renderResult(body, topCategories);
          positionPopup(video);
        }

      } catch (error) {
        // This will now print the exact trace in the background console
        console.error("[Understandabot] Detailed Error:", error);
        
        // This will render the specific text in the popup UI
        renderError(body, error.message);
      }
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