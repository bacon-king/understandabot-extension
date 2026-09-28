/**
 * Understandabot Background Service Worker (Manifest V3)
 * Implements SRS Section 3.2, 3.5, REQ-5, REQ-6, REQ-10, REQ-19, and NREQ-PERF-5.
 */

// Default backend API URL on Render (can be overridden via popup settings)
const DEFAULT_API_BASE = "https://understandabot-backend.onrender.com";
const LOCAL_API_BASE = "http://localhost:8000";
const INFERENCE_TIMEOUT_MS = 2500; // 2.5s budget per NREQ-PERF-5

// Helper: Convert image URL to base64 data URL using ArrayBuffer (safe for Service Workers)
async function fetchImageAsBase64(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const len = bytes.byteLength;
    const chunkSize = 8192;
    for (let i = 0; i < len; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, len)));
    }
    const b64 = btoa(binary);
    const contentType = response.headers.get("content-type") || "image/jpeg";
    return `data:${contentType};base64,${b64}`;
  } catch (err) {
    console.warn(`[Understandabot SW] Failed to fetch frame from ${url}:`, err);
    return null;
  }
}

// Fetch 3 keyframes from YouTube's static CDN (REQ-6, REQ-7, REQ-8)
async function getYouTubeFrames(videoId) {
  const candidates = [
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/default.jpg`
  ];

  const frames = [];
  for (const url of candidates) {
    const b64 = await fetchImageAsBase64(url);
    if (b64) {
      frames.push(b64);
    }
  }

  // Fallback: If only 1 or 2 frames fetched, duplicate to ensure exactly 3 frames
  while (frames.length > 0 && frames.length < 3) {
    frames.push(frames[0]);
  }

  return frames;
}

// Get active API base URL (checks storage, then default Render, then localhost fallback)
async function getApiBase() {
  const stored = await chrome.storage.local.get(["backendApiUrl"]);
  return (stored.backendApiUrl || DEFAULT_API_BASE).replace(/\/+$/, "");
}

// Listen for messages from content script (REQ-5)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "FETCH_FRAMES_AND_INFER") {
    const videoId = request.videoId;
    if (!videoId) {
      sendResponse({ status: "FAILED", error: "Missing videoId" });
      return false;
    }

    handleInferenceRequest(videoId, request.metadata)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error("[Understandabot SW] Inference failed:", error);
        sendResponse({ status: "FAILED", error: "Prediction unavailable." });
      });

    return true; // Keep channel open for async response
  }

  if (request.type === "CHECK_API_HEALTH") {
    checkHealth()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ status: "error", message: err.message }));
    return true;
  }
});

async function checkHealth() {
  const apiBase = await getApiBase();
  try {
    const resp = await fetch(`${apiBase}/api/v1/health`, { method: "GET" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleInferenceRequest(videoId, metadata = {}) {
  // 1. Check local cache (REQ-19, Section 4.1.2)
  const cacheKey = `ub_cache_${videoId}`;
  const stored = await chrome.storage.local.get([cacheKey]);
  if (stored[cacheKey]) {
    console.log(`[Understandabot SW] Serving from local cache for ${videoId}`);
    return {
      status: "SUCCESS",
      cached: true,
      ...stored[cacheKey]
    };
  }

  const apiBase = await getApiBase();

  // 2. Fetch 3 preview frames from YouTube CDN (REQ-6, REQ-7)
  const frames = await getYouTubeFrames(videoId);
  if (!frames || frames.length === 0) {
    return {
      status: "FAILED",
      error: "Unable to retrieve preview frames from CDN."
    };
  }

  // 3. Dispatch POST request to backend API (REQ-10) with timeout constraint (NREQ-PERF-5)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT_MS);

  try {
    const response = await fetch(`${apiBase}/api/v1/infer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        youtube_id: videoId,
        metadata: metadata,
        frames: frames
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}`);
    }

    const data = await response.json();

    if (data.status === "SUCCESS") {
      // 4. Save to local cache (REQ-19)
      const cacheData = {
        primary_category: data.primary_category,
        primary_code: data.primary_code,
        confidence: data.confidence,
        predicted_tags: data.predicted_tags,
        model_version: data.model_version
      };
      await chrome.storage.local.set({ [cacheKey]: cacheData });
      return data;
    } else {
      return {
        status: "FAILED",
        error: data.error || "Prediction unavailable."
      };
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      console.warn(`[Understandabot SW] Request timed out (> ${INFERENCE_TIMEOUT_MS}ms) for ${videoId}`);
      return { status: "FAILED", error: "Prediction unavailable (timeout)." };
    }
    console.warn(`[Understandabot SW] Network/Backend error:`, err);
    return { status: "FAILED", error: "Prediction unavailable." };
  }
}
