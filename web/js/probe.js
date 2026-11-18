// probe.js
// Step 1 "device check" page. Loads the MediaPipe Image Embedder, embeds photos,
// tests the live camera and speech, and lists what this device supports.
// Everything happens on the device; nothing is uploaded.

import { APP_NAME, MEDIAPIPE_VERSION } from "./config.js";
import {
  createEmbedder,
  fileToImage,
  releaseImage,
  toSquareCanvas,
  embedCanvas,
  norm,
  cosine,
  median,
} from "./embedder.js";

const WARM_RUNS = 5; // extra timed runs per photo, for a stable speed number

const $ = (id) => document.getElementById(id);
const ui = {
  modelSelect: $("model-select"),
  delegateSelect: $("delegate-select"),
  engineStatus: $("engine-status"),
  engineStats: $("engine-stats"),
  cameraInput: $("camera-input"),
  uploadInput: $("upload-input"),
  clearPhotos: $("clear-photos"),
  photoStatus: $("photo-status"),
  photoList: $("photo-list"),
  liveStart: $("live-start"),
  liveCapture: $("live-capture"),
  liveStop: $("live-stop"),
  liveVideo: $("live-video"),
  liveStatus: $("live-status"),
  speakBtn: $("speak-btn"),
  speechStatus: $("speech-status"),
  capsBody: $("caps-body"),
  copyReport: $("copy-report"),
  reportStatus: $("report-status"),
  reportText: $("report-text"),
  log: $("log"),
};

const state = {
  engine: null,
  engineStats: null,
  engineLoadToken: 0,
  firstEmbedDone: false,
  photos: [],
  liveStream: null,
  liveInfo: null,
  speech: null,
  capabilities: {},
};

// ---------- Small helpers ----------

function setStatus(el, text, kind = "") {
  el.textContent = text;
  el.className = `status ${kind}`.trim();
}

function log(message) {
  const time = new Date().toLocaleTimeString();
  ui.log.textContent += `[${time}] ${message}\n`;
}

function logError(err) {
  const msg = err?.message || String(err);
  log(`ERROR: ${msg}`);
  console.error(err);
}

/** Lets the browser paint a status message before a blocking task. */
function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function formatBytes(bytes) {
  if (bytes == null) return "n/a";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Phones have no visible console, so surface every error on the page.
window.addEventListener("error", (e) => logError(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => logError(e.reason));

// ---------- 1. Engine ----------

async function loadEngine() {
  const token = ++state.engineLoadToken;
  const modelKey = ui.modelSelect.value;
  const delegate = ui.delegateSelect.value;

  if (state.engine) {
    try {
      state.engine.close();
    } catch {
      /* already closed */
    }
    state.engine = null;
  }
  state.firstEmbedDone = false;
  ui.engineStats.replaceChildren();
  setStatus(ui.engineStatus, `Loading ${modelKey} model on ${delegate}…`);
  log(`Loading engine: MediaPipe ${MEDIAPIPE_VERSION}, model=${modelKey}, delegate=${delegate}`);

  try {
    const { embedder, stats } = await createEmbedder({ modelKey, delegate });
    if (token !== state.engineLoadToken) {
      embedder.close(); // the user switched settings while this was loading
      return;
    }
    state.engine = embedder;
    state.engineStats = stats;
    setStatus(ui.engineStatus, `Ready in ${(stats.totalMs / 1000).toFixed(1)} s`, "ok");
    renderEngineStats(stats);
    log(`Engine ready in ${stats.totalMs} ms`);
  } catch (err) {
    if (token !== state.engineLoadToken) return;
    logError(err);
    // Chrome says "Failed to fetch", Safari says "Load failed" or "Importing a module script failed".
    const networkProblem = /failed to fetch|load failed|importing a module|networkerror/i.test(err.message);
    const hint = networkProblem
      ? " Check the connection: the engine downloads from cdn.jsdelivr.net on the first visit."
      : "";
    const message = err.message.replace(/\.\s*$/, "");
    setStatus(ui.engineStatus, `Could not start the engine: ${message}.${hint}`, "error");
  }
}

function renderEngineStats(stats) {
  const rows = [
    ["Engine", `MediaPipe Tasks Vision ${MEDIAPIPE_VERSION}`],
    ["Model", stats.model],
    ["Runs on", stats.delegate],
    ["Model file", formatBytes(stats.modelBytes)],
    ["Library import", `${stats.libraryImportMs} ms`],
    ["Model download", `${stats.modelDownloadMs} ms`],
    ["Engine start", `${stats.engineInitMs} ms (includes engine download on first visit)`],
  ];
  if (stats.wasm) {
    const { transferBytes, decodedBytes, durationMs } = stats.wasm;
    let text;
    if (transferBytes > 0) {
      text = `${formatBytes(transferBytes)} over the network (${formatBytes(decodedBytes)} unpacked), ${durationMs} ms`;
    } else if (decodedBytes > 0) {
      text = `from browser cache, ${durationMs} ms`;
    } else {
      text = `${durationMs} ms (size not reported by the CDN)`;
    }
    rows.push(["Engine download", text]);
  }
  ui.engineStats.replaceChildren(...rows.flatMap(([k, v]) => [el("dt", k), el("dd", v)]));
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

ui.modelSelect.addEventListener("change", loadEngine);
ui.delegateSelect.addEventListener("change", loadEngine);

// ---------- 2. Photos ----------

async function handleFile(file, source) {
  if (!file) return;
  if (!state.engine) {
    setStatus(ui.photoStatus, "The engine is still loading. Try again in a moment.", "warn");
    return;
  }
  setStatus(ui.photoStatus, "Reading photo…");
  let img = null;
  try {
    img = await fileToImage(file);
    const canvas = toSquareCanvas(img);
    await processCanvas(canvas, {
      source,
      originalSize: `${img.naturalWidth}×${img.naturalHeight}`,
      fileBytes: file.size,
      fileType: file.type || "unknown",
    });
  } catch (err) {
    logError(err);
    setStatus(ui.photoStatus, err.message, "error");
  } finally {
    releaseImage(img);
  }
}

async function processCanvas(canvas, meta) {
  setStatus(ui.photoStatus, "Embedding…");
  await nextPaint();

  const coldStart = !state.firstEmbedDone;
  const first = embedCanvas(state.engine, canvas);
  const warmTimes = [];
  for (let i = 0; i < WARM_RUNS; i++) warmTimes.push(embedCanvas(state.engine, canvas).ms);
  state.firstEmbedDone = true;

  const vector = first.vector;
  const modelKey = state.engineStats.modelKey;
  const comparable = state.photos.filter((p) => p.modelKey === modelKey);
  const similarities = comparable
    .map((p) => ({ id: p.id, score: cosine(vector, p.vector) }))
    .sort((a, b) => b.score - a.score);

  const photo = {
    id: state.photos.length + 1,
    ...meta,
    modelKey,
    delegate: state.engineStats.delegate,
    dimensions: vector.length,
    vectorLength: Number(norm(vector).toFixed(4)),
    firstRunMs: Math.round(first.ms),
    coldStart,
    warmMedianMs: Number(median(warmTimes).toFixed(1)),
    similarities: similarities.map((s) => ({ id: s.id, score: Number(s.score.toFixed(4)) })),
    vector,
    canvas,
  };
  state.photos.push(photo);
  renderPhoto(photo);
  setStatus(ui.photoStatus, `Photo ${photo.id} embedded in ${photo.warmMedianMs} ms (warm).`, "ok");
  log(
    `Photo ${photo.id} (${meta.source}): ${photo.dimensions} numbers, first ${photo.firstRunMs} ms` +
      `${coldStart ? " (cold start)" : ""}, warm median ${photo.warmMedianMs} ms`
  );
}

function renderPhoto(photo) {
  const item = el("li", null, "photo");

  const thumb = photo.canvas;
  thumb.className = "thumb";
  thumb.setAttribute("aria-label", `Photo ${photo.id}, as the model sees it`);
  item.append(thumb);

  const body = el("div", null, "photo-body");
  body.append(el("p", `Photo ${photo.id} · ${photo.source} · ${photo.originalSize}`, "photo-title"));
  const details = [
    `${photo.dimensions} numbers · length ${photo.vectorLength}`,
    `first run ${photo.firstRunMs} ms${photo.coldStart ? " (cold start)" : ""} · warm ${photo.warmMedianMs} ms`,
  ];
  if (photo.fileBytes) details.push(`${formatBytes(photo.fileBytes)} · ${photo.fileType}`);
  for (const line of details) body.append(el("p", line, "photo-meta"));

  if (photo.similarities.length) {
    const list = el("ul", null, "sims");
    for (const s of photo.similarities) {
      const row = el("li", null, "sim");
      row.append(el("span", `vs #${s.id}`, "sim-label"));
      const bar = el("span", null, "sim-bar");
      const fill = el("span", null, "sim-fill");
      fill.style.width = `${Math.max(0, Math.min(1, s.score)) * 100}%`;
      bar.append(fill);
      row.append(bar, el("span", s.score.toFixed(3), "sim-score"));
      list.append(row);
    }
    body.append(list);
  } else {
    body.append(el("p", "Add another photo to see similarity scores.", "photo-meta"));
  }

  item.append(body);
  ui.photoList.prepend(item);
}

ui.cameraInput.addEventListener("change", (e) => {
  handleFile(e.target.files?.[0], "camera");
  e.target.value = ""; // allow picking the same file again
});
ui.uploadInput.addEventListener("change", (e) => {
  handleFile(e.target.files?.[0], "upload");
  e.target.value = "";
});
ui.clearPhotos.addEventListener("click", () => {
  state.photos = [];
  ui.photoList.replaceChildren();
  setStatus(ui.photoStatus, "Cleared.");
});

// ---------- 3. Live camera ----------

async function startLive() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus(ui.liveStatus, "This browser has no camera API here. It needs HTTPS (the live site, not a local IP).", "error");
    return;
  }
  setStatus(ui.liveStatus, "Asking for camera permission…");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    state.liveStream = stream;
    ui.liveVideo.srcObject = stream;
    ui.liveVideo.hidden = false;
    await ui.liveVideo.play();

    const settings = stream.getVideoTracks()[0]?.getSettings?.() || {};
    state.liveInfo = {
      width: settings.width ?? ui.liveVideo.videoWidth,
      height: settings.height ?? ui.liveVideo.videoHeight,
      facingMode: settings.facingMode ?? "unknown",
    };
    setStatus(
      ui.liveStatus,
      `Camera on: ${state.liveInfo.width}×${state.liveInfo.height}, facing ${state.liveInfo.facingMode}.`,
      "ok"
    );
    log(`Live camera started: ${JSON.stringify(state.liveInfo)}`);
    ui.liveStart.disabled = true;
    ui.liveCapture.disabled = false;
    ui.liveStop.disabled = false;
  } catch (err) {
    logError(err);
    const messages = {
      NotAllowedError: "Camera permission was denied. On iPhone: Settings > Apps > Safari > Camera > Allow, then reload.",
      NotFoundError: "No camera found on this device.",
      NotReadableError: "The camera is busy in another app or tab.",
      OverconstrainedError: "The camera does not support the requested settings.",
    };
    setStatus(ui.liveStatus, messages[err.name] || `Camera failed: ${err.message}`, "error");
    stopLive();
  }
}

async function captureLive() {
  if (!state.engine) {
    setStatus(ui.liveStatus, "The engine is still loading.", "warn");
    return;
  }
  const video = ui.liveVideo;
  if (video.readyState < 2 || !video.videoWidth) {
    setStatus(ui.liveStatus, "The camera is still warming up. Try again in a second.", "warn");
    return;
  }
  try {
    const canvas = toSquareCanvas(video);
    await processCanvas(canvas, { source: "live", originalSize: `${video.videoWidth}×${video.videoHeight}` });
    setStatus(ui.liveStatus, "Frame embedded. See it in section 2.", "ok");
  } catch (err) {
    logError(err);
    setStatus(ui.liveStatus, err.message, "error");
  }
}

function stopLive() {
  state.liveStream?.getTracks().forEach((t) => t.stop());
  state.liveStream = null;
  ui.liveVideo.srcObject = null;
  ui.liveVideo.hidden = true;
  ui.liveStart.disabled = false;
  ui.liveCapture.disabled = true;
  ui.liveStop.disabled = true;
}

ui.liveStart.addEventListener("click", startLive);
ui.liveCapture.addEventListener("click", captureLive);
ui.liveStop.addEventListener("click", () => {
  stopLive();
  setStatus(ui.liveStatus, "Camera off.");
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.liveStream) stopLive();
});

// ---------- 4. Speech ----------

function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  const english = voices.filter((v) => v.lang?.toLowerCase().startsWith("en"));
  return (
    english.find((v) => v.lang === "en-US" && v.localService) ||
    english.find((v) => v.lang === "en-US") ||
    english[0] ||
    null
  );
}

function speakTest() {
  if (!("speechSynthesis" in window)) {
    setStatus(ui.speechStatus, "Speech synthesis is not available in this browser.", "error");
    return;
  }
  const synth = window.speechSynthesis;
  const sentence = "Looks like a coffee mug. I found five similar products.";
  const utterance = new SpeechSynthesisUtterance(sentence);
  utterance.lang = "en-US";
  const voice = pickVoice();
  if (voice) utterance.voice = voice;

  const t0 = performance.now();
  let started = false;
  let failed = false;
  utterance.onstart = () => {
    started = true;
    state.speech = {
      ok: true,
      startDelayMs: Math.round(performance.now() - t0),
      voice: voice ? `${voice.name} (${voice.lang}${voice.localService ? ", on-device" : ", network"})` : "browser default",
      voiceCount: synth.getVoices().length,
    };
    setStatus(ui.speechStatus, `Speaking with ${state.speech.voice}. Started in ${state.speech.startDelayMs} ms.`, "ok");
  };
  utterance.onerror = (e) => {
    failed = true;
    state.speech = { ok: false, error: e.error };
    setStatus(ui.speechStatus, `Speech error: ${e.error}`, "error");
    log(`Speech error: ${e.error}`);
  };

  synth.cancel(); // clears a stuck queue, a known Safari issue
  synth.speak(utterance);
  setTimeout(() => {
    if (!started && !failed) {
      setStatus(
        ui.speechStatus,
        "No sound started after 3 seconds. On iPhone, check the volume and the silent switch, then tap again.",
        "warn"
      );
    }
  }, 3000);
}

ui.speakBtn.addEventListener("click", speakTest);
if ("speechSynthesis" in window) {
  // Voice lists load late in some browsers; refresh the capability row when they arrive.
  window.speechSynthesis.addEventListener?.("voiceschanged", () => {
    if (!("Speech voices" in state.capabilities)) return; // the full list is not built yet
    state.capabilities["Speech voices"] = window.speechSynthesis.getVoices().length;
    renderCapabilities();
  });
}

// ---------- 5. Capabilities ----------

function wasmSimdSupported() {
  try {
    // A tiny WebAssembly module that uses one SIMD instruction.
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
    return WebAssembly.validate(bytes);
  } catch {
    return false;
  }
}

async function webGpuStatus() {
  if (!("gpu" in navigator)) return "no";
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter ? "yes" : "API present, no adapter";
  } catch {
    return "API present, request failed";
  }
}

async function promptApiStatus() {
  // Chrome's built-in Gemini Nano. We only ask about availability; we never start a download here.
  if (!("LanguageModel" in self)) return { text: "not in this browser", image: "not in this browser" };
  const ask = async (inputs) => {
    try {
      return await self.LanguageModel.availability({
        expectedInputs: inputs,
        expectedOutputs: [{ type: "text", languages: ["en"] }],
      });
    } catch (err) {
      return `error: ${err.message}`;
    }
  };
  return {
    text: await ask([{ type: "text", languages: ["en"] }]),
    image: await ask([{ type: "image" }]),
  };
}

async function storageEstimate() {
  if (!navigator.storage?.estimate) return "n/a";
  try {
    const { quota, usage } = await navigator.storage.estimate();
    return `${formatBytes(usage)} used of ${formatBytes(quota)}`;
  } catch {
    return "n/a";
  }
}

async function collectCapabilities() {
  const caps = {};
  caps["Secure context (HTTPS)"] = window.isSecureContext;
  caps["WebAssembly"] = typeof WebAssembly === "object";
  caps["WebAssembly SIMD (MediaPipe needs it)"] = wasmSimdSupported();
  caps["WebGL2 (MediaPipe GPU path)"] = !!document.createElement("canvas").getContext("webgl2");
  caps["WebGPU (for bigger models later)"] = await webGpuStatus();
  caps["Camera API (getUserMedia)"] = !!navigator.mediaDevices?.getUserMedia;
  caps["Speech synthesis"] = "speechSynthesis" in window;
  caps["Speech voices"] = "speechSynthesis" in window ? window.speechSynthesis.getVoices().length : 0;
  const prompt = await promptApiStatus();
  caps["Gemini Nano, text (Prompt API)"] = prompt.text;
  caps["Gemini Nano, image input"] = prompt.image;
  caps["Offline cache (Cache Storage)"] = "caches" in window;
  caps["Service worker"] = "serviceWorker" in navigator;
  caps["Storage"] = await storageEstimate();
  caps["CPU cores"] = navigator.hardwareConcurrency ?? "n/a";
  caps["Device memory (Chrome only)"] = navigator.deviceMemory ? `${navigator.deviceMemory} GB` : "n/a";
  caps["Screen"] = `${screen.width}×${screen.height} @ ${window.devicePixelRatio}x`;
  caps["User agent"] = navigator.userAgent;
  state.capabilities = caps;
  renderCapabilities();
}

function capabilityClass(value) {
  if (value === true || value === "yes" || value === "available") return "ok";
  if (value === false || value === "no" || value === "unavailable" || value === "not in this browser") return "warn";
  return "";
}

function renderCapabilities() {
  const rows = Object.entries(state.capabilities).map(([name, value]) => {
    const tr = document.createElement("tr");
    const display = value === true ? "yes" : value === false ? "no" : String(value);
    tr.append(el("th", name), el("td", display, capabilityClass(value)));
    return tr;
  });
  ui.capsBody.replaceChildren(...rows);
}

// ---------- Report ----------

function buildReport() {
  return {
    app: APP_NAME,
    page: "device-check",
    createdAt: new Date().toISOString(),
    mediapipeVersion: MEDIAPIPE_VERSION,
    engine: state.engineStats,
    photos: state.photos.map(({ vector, canvas, ...rest }) => ({
      ...rest,
      firstValues: Array.from(vector.slice(0, 6), (v) => Number(v.toFixed(5))),
    })),
    liveCamera: state.liveInfo,
    speech: state.speech,
    capabilities: state.capabilities,
  };
}

ui.copyReport.addEventListener("click", async () => {
  const text = JSON.stringify(buildReport(), null, 2);
  ui.reportText.value = text;
  try {
    await navigator.clipboard.writeText(text);
    setStatus(ui.reportStatus, "Copied to clipboard.", "ok");
    ui.reportText.hidden = true;
  } catch {
    ui.reportText.hidden = false;
    ui.reportText.focus();
    ui.reportText.select();
    setStatus(ui.reportStatus, "Could not copy automatically. Select the text below and copy it.", "warn");
  }
});

// ---------- Start ----------

document.title = `${APP_NAME} · Device check`;
$("app-name").textContent = APP_NAME;
log(`Page loaded. ${navigator.userAgent}`);
collectCapabilities().catch(logError);
loadEngine();
