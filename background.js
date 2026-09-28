/**
 * Understandabot Background Service Worker (Manifest V3)
 * Full Hybrid Architecture: Local Client-Side ONNX Inference + Render Cloud Fallback & Supabase Sync
 * Implements SRS Section 3.2, 3.3, 3.5, REQ-5, REQ-6, REQ-10, REQ-11, REQ-19, and Table 4.1 (State S3).
 */

// Import ONNX Runtime Web
try {
  importScripts("ort.min.js");
  if (typeof ort !== "undefined") {
    ort.env.wasm.wasmPaths = chrome.runtime.getURL("");
    ort.env.wasm.numThreads = 1; // Single-threaded for Service Worker stability
    console.log("[Understandabot SW] ONNX Runtime Web initialized successfully.");
  }
} catch (e) {
  console.warn("[Understandabot SW] Failed to importScripts ort.min.js:", e);
}

// Config
const DEFAULT_API_BASE = "https://understandabot-backend.onrender.com";
const INFERENCE_TIMEOUT_MS = 2500; // 2.5s budget per NREQ-PERF-5
const CONFIDENCE_THRESHOLD = 0.60;

const CATEGORIES = [
  { index: 0, name: "Gaming", code: "GAMING" },
  { index: 1, name: "Podcasts", code: "PODCASTS" },
  { index: 2, name: "Science & Education", code: "SCIENCE_AND_EDUCATION" },
  { index: 3, name: "Sports", code: "SPORTS" },
  { index: 4, name: "Vlogs", code: "VLOGS" }
];

// Singleton ONNX Session
let onnxSession = null;
let isSessionLoading = false;

async function getOnnxSession() {
  if (onnxSession) return onnxSession;
  if (typeof ort === "undefined") return null;
  if (isSessionLoading) {
    while (isSessionLoading) {
      await new Promise(r => setTimeout(r, 50));
    }
    return onnxSession;
  }

  isSessionLoading = true;
  try {
    const modelUrl = chrome.runtime.getURL("model.onnx");
    console.log(`[Understandabot SW] Loading ONNX session from ${modelUrl}...`);
    onnxSession = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    });
    console.log("[Understandabot SW] Local ONNX model loaded successfully!");
  } catch (err) {
    console.error("[Understandabot SW] Failed to load local ONNX model:", err);
    onnxSession = null;
  } finally {
    isSessionLoading = false;
  }
  return onnxSession;
}

// Helper: Convert image URL to base64 data URL using ArrayBuffer
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
    if (b64) frames.push(b64);
  }

  while (frames.length > 0 && frames.length < 3) {
    frames.push(frames[0]);
  }

  return frames;
}

// Preprocess a single image into normalized ImageNet channels (R, G, B Float32Arrays of 224x224)
async function preprocessFrame(b64DataUrl) {
  const resp = await fetch(b64DataUrl);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);

  const canvas = new OffscreenCanvas(224, 224);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, 224, 224);
  const imgData = ctx.getImageData(0, 0, 224, 224);
  const data = imgData.data;

  const red = new Float32Array(224 * 224);
  const green = new Float32Array(224 * 224);
  const blue = new Float32Array(224 * 224);

  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];

  for (let i = 0; i < 224 * 224; i++) {
    const r = data[i * 4] / 255.0;
    const g = data[i * 4 + 1] / 255.0;
    const b = data[i * 4 + 2] / 255.0;

    red[i] = (r - mean[0]) / std[0];
    green[i] = (g - mean[1]) / std[1];
    blue[i] = (b - mean[2]) / std[2];
  }

  return { red, green, blue };
}

// Client-Side ONNX inference
async function runClientOnnxInference(frames) {
  const session = await getOnnxSession();
  if (!session) throw new Error("Local ONNX runtime unavailable.");

  const processed = await Promise.all(frames.slice(0, 3).map(f => preprocessFrame(f)));
  while (processed.length < 3) processed.push(processed[0]);

  // Pack into shape [1, 3, 3, 224, 224] (batch=1, num_frames=3, channels=3, h=224, w=224)
  const totalElements = 1 * 3 * 3 * 224 * 224;
  const tensorData = new Float32Array(totalElements);

  let offset = 0;
  for (let frameIdx = 0; frameIdx < 3; frameIdx++) {
    const { red, green, blue } = processed[frameIdx];
    tensorData.set(red, offset);
    offset += 224 * 224;
    tensorData.set(green, offset);
    offset += 224 * 224;
    tensorData.set(blue, offset);
    offset += 224 * 224;
  }

  const inputTensor = new ort.Tensor("float32", tensorData, [1, 3, 3, 224, 224]);
  const results = await session.run({ frames_input: inputTensor });
  const logits = Array.from(results.logits.data);

  // Softmax
  const maxLogit = Math.max(...logits);
  const expScores = logits.map(l => Math.exp(l - maxLogit));
  const sumExp = expScores.reduce((a, b) => a + b, 0);
  const probs = expScores.map(s => s / sumExp);

  // Build ranked predictions
  const scoredTags = CATEGORIES.map((cat, idx) => ({
    name: cat.name,
    code: cat.code,
    confidence: Math.round(probs[idx] * 10000) / 100,
    prob: probs[idx]
  }));

  scoredTags.sort((a, b) => b.prob - a.prob);

  const top = scoredTags[0];
  const isConfident = top.prob >= CONFIDENCE_THRESHOLD;

  return {
    status: "SUCCESS",
    source: "client-side-onnx",
    primary_category: isConfident ? top.name : "Uncertain",
    primary_code: isConfident ? top.code : "UNCERTAIN",
    confidence: Math.round(top.prob * 10000) / 10000,
    is_confident: isConfident,
    predicted_tags: scoredTags.map(t => ({
      name: t.name,
      code: t.code,
      confidence: t.confidence
    })),
    model_version: "v1.0-onnx-local"
  };
}

// Remote Cloud Inference (Render Backend)
async function runCloudInference(videoId, metadata, frames) {
  const stored = await chrome.storage.local.get(["backendApiUrl"]);
  const apiBase = (stored.backendApiUrl || DEFAULT_API_BASE).replace(/\/+$/, "");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT_MS);

  try {
    const response = await fetch(`${apiBase}/api/v1/infer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ youtube_id: videoId, metadata: metadata, frames: frames }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const data = await response.json();
    data.source = "cloud-render";
    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// Main Request Handler (Hybrid Logic)
async function handleInferenceRequest(videoId, metadata = {}) {
  const startTime = Date.now();
  const cacheKey = `ub_cache_${videoId}`;

  // 1. Check local cache (REQ-19)
  const stored = await chrome.storage.local.get([cacheKey]);
  if (stored[cacheKey]) {
    console.log(`[Understandabot SW] Serving from local cache for ${videoId}`);
    return { status: "SUCCESS", cached: true, ...stored[cacheKey] };
  }

  // 2. Fetch 3 CDN frames
  const frames = await getYouTubeFrames(videoId);
  if (!frames || frames.length === 0) {
    return { status: "FAILED", error: "Unable to retrieve preview frames from CDN." };
  }

  let result = null;

  // 3. Try Local Client-Side ONNX First (Fastest, 0ms network latency)
  try {
    result = await runClientOnnxInference(frames);
    result.latency_ms = Date.now() - startTime;
    console.log(`[Understandabot SW] Client-side ONNX succeeded in ${result.latency_ms}ms!`);

    // Async background cloud sync: send sample & metadata to Render/Supabase without blocking user
    runCloudInference(videoId, metadata, frames).catch(e => {
      console.log("[Understandabot SW] Background cloud telemetry sync skipped:", e.message);
    });
  } catch (onnxErr) {
    console.warn("[Understandabot SW] Local ONNX failed, falling back to Render Cloud API:", onnxErr);

    // 4. Fallback to Cloud Inference (Render)
    try {
      result = await runCloudInference(videoId, metadata, frames);
      result.latency_ms = Date.now() - startTime;
    } catch (cloudErr) {
      console.error("[Understandabot SW] Both Local ONNX and Cloud Inference failed:", cloudErr);
      return { status: "FAILED", error: "Prediction unavailable." };
    }
  }

  // 5. Cache result locally
  if (result && result.status === "SUCCESS") {
    result.youtube_id = videoId;
    const cacheData = {
      primary_category: result.primary_category,
      primary_code: result.primary_code,
      confidence: result.confidence,
      predicted_tags: result.predicted_tags,
      model_version: result.model_version
    };
    await chrome.storage.local.set({ [cacheKey]: cacheData });
  }

  return result;
}

// Runtime Message Listener (REQ-5)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "FETCH_FRAMES_AND_INFER") {
    const videoId = request.videoId;
    if (!videoId) {
      sendResponse({ status: "FAILED", error: "Missing videoId" });
      return false;
    }

    handleInferenceRequest(videoId, request.metadata)
      .then(result => sendResponse(result))
      .catch(error => {
        console.error("[Understandabot SW] Unexpected error:", error);
        sendResponse({ status: "FAILED", error: "Prediction unavailable." });
      });

    return true; // Keep message channel open for async response
  }

  if (request.type === "CHECK_API_HEALTH") {
    chrome.storage.local.get(["backendApiUrl"]).then(stored => {
      const apiBase = (stored.backendApiUrl || DEFAULT_API_BASE).replace(/\/+$/, "");
      fetch(`${apiBase}/api/v1/health`)
        .then(r => r.json())
        .then(data => sendResponse({ ok: true, data }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
    });
    return true;
  }
});
