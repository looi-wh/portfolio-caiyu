const TOTAL_FRAMES = 329;
const FRAME_DIR = "frames_webp";
const FRAME_PAD = 6;
const SECTION_COUNT = 4;
const SNAP_IDLE_MS = 120;
const SNAP_DURATION_MS = 380;
const NAV_SNAP_DURATION_MS = 780;
const MIN_SECTION_TRANSITION_MS = 900;
const SNAP_ADVANCE_RATIO = 0.32;
const INITIAL_PRELOAD_FRAMES = 8;
const NEARBY_PRELOAD_RADIUS = 6;
const BACKGROUND_PRELOAD_DELAY_MS = 0;
const BACKGROUND_PRELOAD_START_DELAY_MS = 0;
const INTERACTION_IDLE_MS = 260;
const MAX_FRAME_CACHE_DESKTOP = 96;
const MAX_FRAME_CACHE_MOBILE = 48;
const MAX_FRAME_CACHE_SLOW_CONNECTION = 36;
const MAX_FRAME_CACHE_SAVE_DATA = 20;
const DESKTOP_FIRST_SECTION_PRELOAD_BATCH = 14;
const MOBILE_FIRST_SECTION_PRELOAD_BATCH = 8;
const DESKTOP_REMAINING_PRELOAD_BATCH = 12;
const MOBILE_REMAINING_PRELOAD_BATCH = 6;
const SECTION_IMAGE_PATHS = ["me.webp", "logos/pwc.webp", "logos/kpmg.webp"];
const AIRPLANE_WIDTH = 19;
const AIRPLANE_HEIGHT = 19;
const AIRPLANE_MIN_SPEED = 35;
const AIRPLANE_MAX_SPEED = 60;
const AIRPLANE_MARGIN = 24;
const AIRPLANE_ORIENTATION_OFFSET = Math.PI / 2;
const AIRPLANE_TRAIL_INTERVAL_MS = 130;
const AIRPLANE_TRAIL_OFFSET = 14;
const AIRPLANE_TRAIL_MAX = 42;
const AIRPLANE_EDGE_JITTER = Math.PI / 5;
const AIRPLANE_SPAWN_MIN_MS = 10000;
const AIRPLANE_SPAWN_MAX_MS = 60000;

const scrollContainer = document.getElementById("scroll-container");
const stickyScene = document.getElementById("sticky-scene");
const track = document.getElementById("track");
const scrubBg = document.getElementById("scrub-bg");
const bgOverlay = document.querySelector(".bg-overlay");
const rippleLayer = document.getElementById("ripple-layer");
const airplaneLayer = document.getElementById("airplane-layer");
const historyLists = Array.from(document.querySelectorAll(".history-list"));
const panelOneBodyText = document.querySelector(".panel-1 p");
const panelOneNavRight = document.querySelector(".panel-1 .panel-nav.nav-right");
const mobileCardsQuery = window.matchMedia("(max-width: 1100px), (hover: none) and (pointer: coarse)");
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const SECTION_ONE_HINT_TEXT = "Swipe Left to Continue";

let maxHorizontal = 0;
let containerStartY = 0;
let progress = 0;
let activeSectionIndex = 0;
let currentFrame = 0;
let rafId = 0;
let needsRender = true;

let dragging = false;
let dragStartX = 0;
let dragStartProgress = 0;
let snapping = false;
let snapFromProgress = 0;
let snapToProgress = 0;
let snapStartTime = 0;
let snapRafId = 0;
let snapTimeoutId = 0;
let lastIntentDirection = 0;
let snapDurationMs = SNAP_DURATION_MS;
let historyRotationTimerId = 0;
let activeHistoryCardIndex = 0;
let lastRippleTime = 0;
let lastRippleX = -1000;
let lastRippleY = -1000;
let backgroundPreloadQueue = [];
let backgroundPreloadTimerId = 0;
let backgroundPreloadIdleId = 0;
let interactionIdleTimerId = 0;
let isUserInteracting = false;
let firstSectionFramesPrimed = false;
let sectionAssetsPrimed = false;
let airplaneRafId = 0;
let airplaneLastTime = 0;
let airplaneState = null;
let airplaneSpawnTimerId = 0;
let sectionOneHintTimerId = 0;
let sectionOneOriginalText = "";

const frameCache = new Map();

function setTransitionUiActive(active) {
  stickyScene.classList.toggle("is-scrolling-transition", active);
}

function connectionInfo() {
  return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
}

function getFrameCacheLimit() {
  const connection = connectionInfo();
  if (connection && connection.saveData) {
    return MAX_FRAME_CACHE_SAVE_DATA;
  }

  if (isSlowConnection()) {
    return MAX_FRAME_CACHE_SLOW_CONNECTION;
  }

  if (mobileCardsQuery.matches) {
    return MAX_FRAME_CACHE_MOBILE;
  }

  return MAX_FRAME_CACHE_DESKTOP;
}

function isSlowConnection() {
  const connection = connectionInfo();
  if (!connection || !connection.effectiveType) {
    return false;
  }

  return connection.effectiveType === "slow-2g" || connection.effectiveType === "2g";
}

function touchFrameInCache(frameNumber) {
  const cached = frameCache.get(frameNumber);
  if (!cached) {
    return;
  }

  frameCache.delete(frameNumber);
  frameCache.set(frameNumber, cached);
}

function isProtectedFrame(frameNumber) {
  if (frameNumber === currentFrame) {
    return true;
  }

  return Math.abs(frameNumber - currentFrame) <= NEARBY_PRELOAD_RADIUS;
}

function trimFrameCache() {
  const limit = getFrameCacheLimit();
  while (frameCache.size > limit) {
    let removed = false;

    for (const oldestFrameNumber of frameCache.keys()) {
      if (isProtectedFrame(oldestFrameNumber)) {
        continue;
      }

      frameCache.delete(oldestFrameNumber);
      removed = true;
      break;
    }

    if (!removed) {
      break;
    }
  }
}

function markUserInteraction() {
  isUserInteracting = true;
  setTransitionUiActive(true);
  if (interactionIdleTimerId) {
    window.clearTimeout(interactionIdleTimerId);
  }

  interactionIdleTimerId = window.setTimeout(() => {
    interactionIdleTimerId = 0;
    isUserInteracting = false;
    if (!snapping && !dragging) {
      setTransitionUiActive(false);
    }
    if (backgroundPreloadQueue.length > 0) {
      scheduleBackgroundPreload();
    }
  }, INTERACTION_IDLE_MS);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function initializeFirstSection() {
  if ("scrollRestoration" in window.history) {
    window.history.scrollRestoration = "manual";
  }

  window.scrollTo(0, 0);
}

function framePath(frameNumber) {
  return `${FRAME_DIR}/frame_${String(frameNumber).padStart(FRAME_PAD, "0")}.webp`;
}

function progressToFrame(value) {
  const frame = Math.round(1 + value * (TOTAL_FRAMES - 1));
  return clamp(frame, 1, TOTAL_FRAMES);
}

function progressToSectionIndex(value) {
  return clamp(Math.round(value * (SECTION_COUNT - 1)), 0, SECTION_COUNT - 1);
}

function syncAirplaneWithProgressDelta(deltaProgress) {
  if (!airplaneState || Math.abs(deltaProgress) < 0.000001) {
    return;
  }

  airplaneState.x -= deltaProgress * maxHorizontal;
  placeAirplane();
}

function refreshAirplaneOnSectionChange() {
  const nextSectionIndex = progressToSectionIndex(progress);
  if (nextSectionIndex === activeSectionIndex) {
    return;
  }

  activeSectionIndex = nextSectionIndex;
  setupAirplane();
  resetSectionOneHintCycle();
}

function updateOverlayStrength(value) {
  if (!bgOverlay) {
    return;
  }

  const sectionOneEnd = 1 / (SECTION_COUNT - 1);
  const t = clamp(value / sectionOneEnd, 0, 1);
  const strength = 0.1 + t * 0.1;
  bgOverlay.style.setProperty("--overlay-strength", strength.toFixed(3));
}

function getNearestSnapPoint(value) {
  let nearest = 0;
  let smallestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < SECTION_COUNT; i += 1) {
    const point = i / (SECTION_COUNT - 1);
    const distance = Math.abs(value - point);
    if (distance < smallestDistance) {
      smallestDistance = distance;
      nearest = point;
    }
  }

  return nearest;
}

function getBiasedSnapPoint(value, direction) {
  const nearest = getNearestSnapPoint(value);
  if (direction === 0) {
    return nearest;
  }

  const segmentSize = 1 / (SECTION_COUNT - 1);
  const maxIndex = SECTION_COUNT - 1;

  if (direction > 0) {
    const currentIndex = clamp(Math.floor(value / segmentSize), 0, maxIndex);
    const nextIndex = Math.min(currentIndex + 1, maxIndex);
    const currentPoint = currentIndex * segmentSize;
    const forwardThreshold = currentPoint + segmentSize * SNAP_ADVANCE_RATIO;

    if (nextIndex !== currentIndex && value >= forwardThreshold) {
      return nextIndex * segmentSize;
    }
  } else {
    const currentIndex = clamp(Math.ceil(value / segmentSize), 0, maxIndex);
    const prevIndex = Math.max(currentIndex - 1, 0);
    const currentPoint = currentIndex * segmentSize;
    const backwardThreshold = currentPoint - segmentSize * SNAP_ADVANCE_RATIO;

    if (prevIndex !== currentIndex && value <= backwardThreshold) {
      return prevIndex * segmentSize;
    }
  }

  return nearest;
}

function setContainerMetrics() {
  maxHorizontal = Math.max(track.scrollWidth - window.innerWidth, 1);
  scrollContainer.style.height = `${window.innerHeight + maxHorizontal}px`;
  containerStartY = scrollContainer.offsetTop;
}

function updateFromScroll() {
  if (dragging) {
    return;
  }

  if (snapping) {
    return;
  }

  markUserInteraction();

  const scrolled = window.scrollY - containerStartY;
  const nextProgress = clamp(scrolled / maxHorizontal, 0, 1);
  const delta = nextProgress - progress;

  if (!snapping && Math.abs(delta) > 0.0005) {
    lastIntentDirection = delta > 0 ? 1 : -1;
  }

  setProgress(nextProgress, false);

  if (!snapping) {
    scheduleSnap();
  }
}

function setProgress(nextProgress, syncScroll) {
  const clampedProgress = clamp(nextProgress, 0, 1);
  const deltaProgress = clampedProgress - progress;

  progress = clampedProgress;
  syncAirplaneWithProgressDelta(deltaProgress);
  needsRender = true;
  refreshAirplaneOnSectionChange();

  if (syncScroll) {
    window.scrollTo({ top: containerStartY + progress * maxHorizontal });
  }

  requestRender();
}

function requestRender() {
  if (rafId) {
    return;
  }

  rafId = window.requestAnimationFrame(render);
}

function render() {
  rafId = 0;

  if (!needsRender) {
    return;
  }

  needsRender = false;

  const translateX = -progress * maxHorizontal;
  const pixelRatio = window.devicePixelRatio || 1;
  const snappedTranslateX = Math.round(translateX * pixelRatio) / pixelRatio;
  track.style.transform = `translate3d(${snappedTranslateX}px, 0, 0)`;
  updateOverlayStrength(progress);

  const nextFrame = progressToFrame(progress);
  if (nextFrame !== currentFrame) {
    currentFrame = nextFrame;
    swapFrame(nextFrame);
    preloadNearby(nextFrame, snapping ? NEARBY_PRELOAD_RADIUS + 2 : NEARBY_PRELOAD_RADIUS);
  }
}

function cancelSnap() {
  if (snapTimeoutId) {
    window.clearTimeout(snapTimeoutId);
    snapTimeoutId = 0;
  }

  if (snapRafId) {
    window.cancelAnimationFrame(snapRafId);
    snapRafId = 0;
  }

  snapping = false;
  if (!dragging && !isUserInteracting) {
    setTransitionUiActive(false);
  }
}

function animateSnap(now) {
  if (!snapping) {
    return;
  }

  const elapsed = now - snapStartTime;
  const linear = clamp(elapsed / snapDurationMs, 0, 1);
  const eased = linear < 0.5
    ? 4 * linear * linear * linear
    : 1 - Math.pow(-2 * linear + 2, 3) / 2;
  const next = snapFromProgress + (snapToProgress - snapFromProgress) * eased;

  setProgress(next, false);

  if (linear >= 1) {
    snapping = false;
    snapRafId = 0;
    setProgress(snapToProgress, false);
    window.scrollTo({ top: containerStartY + snapToProgress * maxHorizontal });
    if (!dragging && !isUserInteracting) {
      setTransitionUiActive(false);
    }
    return;
  }

  snapRafId = window.requestAnimationFrame(animateSnap);
}

function startSnapTo(targetProgress, durationMs = SNAP_DURATION_MS) {
  const clampedTarget = clamp(targetProgress, 0, 1);
  const distance = Math.abs(clampedTarget - progress);

  if (distance < 0.0005) {
    setProgress(clampedTarget, true);
    return;
  }

  if (snapping && Math.abs(clampedTarget - snapToProgress) < 0.0005) {
    return;
  }

  const sectionsCrossed = Math.max(distance * (SECTION_COUNT - 1), 1);
  const scaledMinimum = MIN_SECTION_TRANSITION_MS * sectionsCrossed;

  cancelSnap();
  markUserInteraction();
  snapping = true;
  setTransitionUiActive(true);
  snapDurationMs = Math.max(durationMs, scaledMinimum);
  snapFromProgress = progress;
  snapToProgress = clampedTarget;
  snapStartTime = performance.now();
  snapRafId = window.requestAnimationFrame(animateSnap);
}

function snapToSection(sectionIndex) {
  const maxIndex = SECTION_COUNT - 1;
  const clampedIndex = clamp(sectionIndex, 0, maxIndex);
  const targetProgress = clampedIndex / maxIndex;
  lastIntentDirection = targetProgress > progress ? 1 : -1;
  markUserInteraction();
  startSnapTo(targetProgress, NAV_SNAP_DURATION_MS);
}

function snapToNearest() {
  if (dragging) {
    return;
  }

  const nearest = getBiasedSnapPoint(progress, lastIntentDirection);
  startSnapTo(nearest, SNAP_DURATION_MS);
}

function scheduleSnap() {
  if (snapTimeoutId) {
    window.clearTimeout(snapTimeoutId);
  }

  snapTimeoutId = window.setTimeout(() => {
    snapTimeoutId = 0;
    snapToNearest();
  }, SNAP_IDLE_MS);
}

function swapFrame(frameNumber) {
  const cached = frameCache.get(frameNumber);
  if (cached && cached.complete) {
    touchFrameInCache(frameNumber);
    if (scrubBg.src !== cached.src) {
      scrubBg.src = cached.src;
    }
    return;
  }

  const img = new Image();
  img.decoding = "async";
  img.src = framePath(frameNumber);
  frameCache.set(frameNumber, img);
  trimFrameCache();

  img.onload = () => {
    if (frameNumber === currentFrame) {
      scrubBg.src = img.src;
    }
  };
}

function preloadFrame(frameNumber) {
  if (frameNumber < 1 || frameNumber > TOTAL_FRAMES || frameCache.has(frameNumber)) {
    if (frameCache.has(frameNumber)) {
      touchFrameInCache(frameNumber);
    }
    return;
  }

  const img = new Image();
  img.decoding = "async";
  img.src = framePath(frameNumber);
  frameCache.set(frameNumber, img);
  trimFrameCache();
}

function preloadInitial() {
  for (let i = 1; i <= INITIAL_PRELOAD_FRAMES; i += 1) {
    preloadFrame(i);
  }
}

function preloadNearby(centerFrame, radius) {
  for (let offset = 1; offset <= radius; offset += 1) {
    preloadFrame(centerFrame - offset);
    preloadFrame(centerFrame + offset);
  }
}

function getFirstSectionEndFrame() {
  return progressToFrame(1 / (SECTION_COUNT - 1));
}

function getBackgroundBatchSize() {
  const firstSectionEndFrame = getFirstSectionEndFrame();
  const nextFrame = backgroundPreloadQueue[0] || TOTAL_FRAMES;
  const isFirstSectionPhase = nextFrame <= firstSectionEndFrame;
  const connection = connectionInfo();

  if (connection && connection.saveData) {
    return 1;
  }

  if (isSlowConnection()) {
    return 2;
  }

  if (isFirstSectionPhase) {
    if (mobileCardsQuery.matches) {
      return MOBILE_FIRST_SECTION_PRELOAD_BATCH;
    }

    return DESKTOP_FIRST_SECTION_PRELOAD_BATCH;
  }

  if (mobileCardsQuery.matches) {
    return MOBILE_REMAINING_PRELOAD_BATCH;
  }

  return DESKTOP_REMAINING_PRELOAD_BATCH;
}

function buildBackgroundPreloadQueue() {
  const queue = [];
  const firstSectionEndFrame = getFirstSectionEndFrame();

  for (let frameNumber = INITIAL_PRELOAD_FRAMES + 1; frameNumber <= firstSectionEndFrame; frameNumber += 1) {
    if (!frameCache.has(frameNumber)) {
      queue.push(frameNumber);
    }
  }

  for (let frameNumber = firstSectionEndFrame + 1; frameNumber <= TOTAL_FRAMES; frameNumber += 1) {
    if (!frameCache.has(frameNumber)) {
      queue.push(frameNumber);
    }
  }

  return queue;
}

function preloadSectionAssets() {
  if (sectionAssetsPrimed) {
    return;
  }

  sectionAssetsPrimed = true;
  SECTION_IMAGE_PATHS.forEach((src) => {
    const img = new Image();
    img.decoding = "async";
    img.src = src;
  });
}

function scheduleBackgroundPreload(delayMs = 0) {
  if (backgroundPreloadIdleId || backgroundPreloadTimerId) {
    return;
  }

  const requestIdle = () => {
    if ("requestIdleCallback" in window) {
      backgroundPreloadIdleId = window.requestIdleCallback(runBackgroundPreload, { timeout: 300 });
      return;
    }

    backgroundPreloadTimerId = window.setTimeout(() => runBackgroundPreload(), 0);
  };

  if (delayMs > 0) {
    backgroundPreloadTimerId = window.setTimeout(() => {
      backgroundPreloadTimerId = 0;
      requestIdle();
    }, delayMs);
    return;
  }

  requestIdle();
}

function runBackgroundPreload(deadline) {
  backgroundPreloadIdleId = 0;
  backgroundPreloadTimerId = 0;

  if (backgroundPreloadQueue.length < 1) {
    return;
  }

  if (isUserInteracting || dragging || snapping) {
    scheduleBackgroundPreload(160);
    return;
  }

  const batchSize = getBackgroundBatchSize();
  const firstSectionEndFrame = getFirstSectionEndFrame();
  let loaded = 0;

  while (backgroundPreloadQueue.length > 0 && loaded < batchSize) {
    if (deadline && typeof deadline.timeRemaining === "function" && deadline.timeRemaining() < 4) {
      break;
    }

    const frameNumber = backgroundPreloadQueue.shift();
    preloadFrame(frameNumber);
    loaded += 1;

    if (!firstSectionFramesPrimed && frameNumber >= firstSectionEndFrame) {
      firstSectionFramesPrimed = true;
      preloadSectionAssets();
    }
  }

  if (!firstSectionFramesPrimed && backgroundPreloadQueue.length > 0 && backgroundPreloadQueue[0] > firstSectionEndFrame) {
    firstSectionFramesPrimed = true;
    preloadSectionAssets();
  }

  if (backgroundPreloadQueue.length > 0) {
    scheduleBackgroundPreload(BACKGROUND_PRELOAD_DELAY_MS);
  }
}

function startBackgroundPreload() {
  if (backgroundPreloadQueue.length > 0) {
    return;
  }

  if (isSlowConnection()) {
    return;
  }

  backgroundPreloadQueue = buildBackgroundPreloadQueue();
  if (backgroundPreloadQueue.length < 1) {
    firstSectionFramesPrimed = true;
    preloadSectionAssets();
    return;
  }

  scheduleBackgroundPreload(BACKGROUND_PRELOAD_START_DELAY_MS);
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function randomAirplaneSpawn() {
  const side = Math.floor(randomBetween(0, 4));
  const minX = AIRPLANE_MARGIN;
  const maxX = Math.max(minX + 1, window.innerWidth - AIRPLANE_MARGIN - AIRPLANE_WIDTH);
  const minY = AIRPLANE_MARGIN;
  const maxY = Math.max(minY + 1, window.innerHeight - AIRPLANE_MARGIN - AIRPLANE_HEIGHT);
  const xRand = randomBetween(minX, maxX);
  const yRand = randomBetween(minY, maxY);

  if (side === 0) {
    return {
      x: -AIRPLANE_WIDTH - AIRPLANE_MARGIN,
      y: yRand,
      heading: randomBetween(-AIRPLANE_EDGE_JITTER, AIRPLANE_EDGE_JITTER),
    };
  }

  if (side === 1) {
    return {
      x: window.innerWidth + AIRPLANE_MARGIN,
      y: yRand,
      heading: Math.PI + randomBetween(-AIRPLANE_EDGE_JITTER, AIRPLANE_EDGE_JITTER),
    };
  }

  if (side === 2) {
    return {
      x: xRand,
      y: -AIRPLANE_HEIGHT - AIRPLANE_MARGIN,
      heading: Math.PI / 2 + randomBetween(-AIRPLANE_EDGE_JITTER, AIRPLANE_EDGE_JITTER),
    };
  }

  return {
    x: xRand,
    y: window.innerHeight + AIRPLANE_MARGIN,
    heading: -Math.PI / 2 + randomBetween(-AIRPLANE_EDGE_JITTER, AIRPLANE_EDGE_JITTER),
  };
}

function createAirplaneState() {
  if (!airplaneLayer || reducedMotionQuery.matches) {
    return null;
  }

  const element = document.createElement("span");
  element.className = "mini-airplane";
  airplaneLayer.appendChild(element);

  const spawn = randomAirplaneSpawn();
  const state = {
    element,
    x: spawn.x,
    y: spawn.y,
    speed: randomBetween(AIRPLANE_MIN_SPEED, AIRPLANE_MAX_SPEED),
    heading: spawn.heading,
    nextTrailAt: performance.now(),
  };

  return state;
}

function clearAirplaneSpawnTimer() {
  if (airplaneSpawnTimerId) {
    window.clearTimeout(airplaneSpawnTimerId);
    airplaneSpawnTimerId = 0;
  }
}

function scheduleAirplaneSpawn(delayMs) {
  if (!airplaneLayer || reducedMotionQuery.matches || airplaneState || airplaneSpawnTimerId) {
    return;
  }

  const delay = typeof delayMs === "number"
    ? delayMs
    : Math.round(randomBetween(AIRPLANE_SPAWN_MIN_MS, AIRPLANE_SPAWN_MAX_MS));

  airplaneSpawnTimerId = window.setTimeout(() => {
    airplaneSpawnTimerId = 0;
    airplaneState = createAirplaneState();
    if (!airplaneState) {
      scheduleAirplaneSpawn();
      return;
    }

    placeAirplane();
    airplaneLastTime = 0;
    airplaneRafId = window.requestAnimationFrame(updateAirplane);
  }, delay);
}

function placeAirplane() {
  if (!airplaneState) {
    return;
  }

  const rotate = airplaneState.heading + AIRPLANE_ORIENTATION_OFFSET;
  airplaneState.element.style.transform = `translate3d(${airplaneState.x.toFixed(2)}px, ${airplaneState.y.toFixed(2)}px, 0) rotate(${rotate.toFixed(4)}rad)`;
}

function emitAirplaneTrail(now) {
  if (!airplaneState || !airplaneLayer || now < airplaneState.nextTrailAt) {
    return;
  }

  airplaneState.nextTrailAt = now + AIRPLANE_TRAIL_INTERVAL_MS;

  const dot = document.createElement("span");
  dot.className = "airplane-trail-dot";

  const centerX = airplaneState.x + AIRPLANE_WIDTH * 0.5;
  const centerY = airplaneState.y + AIRPLANE_HEIGHT * 0.5;
  const x = centerX - Math.cos(airplaneState.heading) * AIRPLANE_TRAIL_OFFSET;
  const y = centerY - Math.sin(airplaneState.heading) * AIRPLANE_TRAIL_OFFSET;

  dot.style.setProperty("--trail-x", `${x.toFixed(2)}px`);
  dot.style.setProperty("--trail-y", `${y.toFixed(2)}px`);
  dot.style.setProperty("--trail-size", `${randomBetween(1.4, 2.8).toFixed(2)}px`);
  dot.style.setProperty("--trail-duration", `${Math.round(randomBetween(900, 1500))}ms`);

  while (airplaneLayer.querySelectorAll(".airplane-trail-dot").length >= AIRPLANE_TRAIL_MAX) {
    const oldest = airplaneLayer.querySelector(".airplane-trail-dot");
    if (!oldest) {
      break;
    }
    oldest.remove();
  }

  airplaneLayer.appendChild(dot);
  dot.addEventListener("animationend", () => dot.remove(), { once: true });
}

function updateAirplane(now) {
  if (!airplaneState) {
    airplaneRafId = 0;
    return;
  }

  if (!airplaneLastTime) {
    airplaneLastTime = now;
  }

  const dt = Math.min((now - airplaneLastTime) / 1000, 0.05);
  airplaneLastTime = now;

  airplaneState.x += Math.cos(airplaneState.heading) * airplaneState.speed * dt;
  airplaneState.y += Math.sin(airplaneState.heading) * airplaneState.speed * dt;

  const outLeft = airplaneState.x < -AIRPLANE_WIDTH - AIRPLANE_MARGIN * 2;
  const outRight = airplaneState.x > window.innerWidth + AIRPLANE_WIDTH + AIRPLANE_MARGIN * 2;
  const outTop = airplaneState.y < -AIRPLANE_HEIGHT - AIRPLANE_MARGIN * 2;
  const outBottom = airplaneState.y > window.innerHeight + AIRPLANE_HEIGHT + AIRPLANE_MARGIN * 2;

  if (outLeft || outRight || outTop || outBottom) {
    clearAirplane();
    scheduleAirplaneSpawn();
    return;
  }

  emitAirplaneTrail(now);
  placeAirplane();
  airplaneRafId = window.requestAnimationFrame(updateAirplane);
}

function stopAirplaneAnimation() {
  if (airplaneRafId) {
    window.cancelAnimationFrame(airplaneRafId);
    airplaneRafId = 0;
  }
  airplaneLastTime = 0;
}

function clearAirplane() {
  stopAirplaneAnimation();

  if (airplaneState && airplaneState.element) {
    airplaneState.element.remove();
  }

  if (airplaneLayer) {
    airplaneLayer.querySelectorAll(".airplane-trail-dot").forEach((dot) => dot.remove());
  }

  airplaneState = null;
}

function setupAirplane() {
  clearAirplaneSpawnTimer();
  clearAirplane();
  scheduleAirplaneSpawn();
}

function getClientX(event) {
  if (event.touches && event.touches[0]) {
    return event.touches[0].clientX;
  }
  return event.clientX;
}

function onDragStart(event) {
  if (event.target.closest(".nav-btn")) {
    return;
  }

  cancelSnap();
  markUserInteraction();
  dragging = true;
  dragStartX = getClientX(event);
  dragStartProgress = progress;
  stickyScene.classList.add("is-dragging");
}

function onDragMove(event) {
  if (!dragging) {
    return;
  }

  markUserInteraction();

  const deltaX = getClientX(event) - dragStartX;
  const nextProgress = dragStartProgress - deltaX / maxHorizontal;
  const delta = nextProgress - progress;

  if (Math.abs(delta) > 0.0005) {
    lastIntentDirection = delta > 0 ? 1 : -1;
  }

  setProgress(nextProgress, true);
}

function onDragEnd() {
  if (!dragging) {
    return;
  }

  dragging = false;
  stickyScene.classList.remove("is-dragging");
  snapToNearest();
}

function createRipple(clientX, clientY) {
  if (!rippleLayer) {
    return;
  }

  if (mobileCardsQuery.matches || reducedMotionQuery.matches) {
    return;
  }

  const rect = stickyScene.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;

  if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
    return;
  }

  const now = performance.now();
  const deltaX = x - lastRippleX;
  const deltaY = y - lastRippleY;
  const moved = Math.hypot(deltaX, deltaY);

  if (now - lastRippleTime < 95 || moved < 32) {
    return;
  }

  lastRippleTime = now;
  lastRippleX = x;
  lastRippleY = y;

  const ripple = document.createElement("span");
  const size = 26 + Math.random() * 18;
  const duration = 460 + Math.random() * 280;

  ripple.className = "ripple-dot";
  ripple.style.setProperty("--ripple-x", `${x}px`);
  ripple.style.setProperty("--ripple-y", `${y}px`);
  ripple.style.setProperty("--ripple-size", `${size}px`);
  ripple.style.setProperty("--ripple-duration", `${duration}ms`);

  while (rippleLayer.childElementCount > 12) {
    rippleLayer.firstElementChild.remove();
  }

  rippleLayer.appendChild(ripple);
  ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
}

function onSceneMouseMove(event) {
  createRipple(event.clientX, event.clientY);
}

function onSceneClick(event) {
  createRipple(event.clientX, event.clientY);
}

function setActiveHistoryCard(index) {
  historyLists.forEach((list) => {
    const cards = Array.from(list.querySelectorAll(".history-card"));
    if (cards.length < 1) {
      return;
    }

    const safeIndex = ((index % cards.length) + cards.length) % cards.length;
    cards.forEach((card, cardIndex) => {
      const isActive = cardIndex === safeIndex;
      card.classList.toggle("is-active", isActive);
      card.setAttribute("aria-hidden", isActive ? "false" : "true");
    });
  });
}

function stopHistoryCardRotation() {
  if (historyRotationTimerId) {
    window.clearInterval(historyRotationTimerId);
    historyRotationTimerId = 0;
  }
}

function applyHistoryCardMode() {
  stopHistoryCardRotation();

  if (historyLists.length < 1) {
    return;
  }

  if (!mobileCardsQuery.matches) {
    historyLists.forEach((list) => {
      list.classList.remove("is-mobile-cards");
      list.querySelectorAll(".history-card").forEach((card) => {
        card.classList.remove("is-active");
        card.removeAttribute("aria-hidden");
      });
    });
    return;
  }

  historyLists.forEach((list) => {
    list.classList.add("is-mobile-cards");
  });

  const maxCards = historyLists.reduce((max, list) => {
    const count = list.querySelectorAll(".history-card").length;
    return Math.max(max, count);
  }, 0);

  if (maxCards < 1) {
    return;
  }

  activeHistoryCardIndex = 0;
  setActiveHistoryCard(activeHistoryCardIndex);

  if (maxCards < 2) {
    return;
  }

  historyRotationTimerId = window.setInterval(() => {
    activeHistoryCardIndex = (activeHistoryCardIndex + 1) % maxCards;
    setActiveHistoryCard(activeHistoryCardIndex);
  }, 10000);
}

function startSectionOneHintToggle() {
  if (!panelOneBodyText) {
    return;
  }

  sectionOneOriginalText = panelOneBodyText.textContent ? panelOneBodyText.textContent.trim() : "";
  if (!sectionOneOriginalText) {
    sectionOneOriginalText = SECTION_ONE_HINT_TEXT;
  }

  resetSectionOneHintCycle();
}

function applySectionOneHintState(showHint) {
  if (!panelOneBodyText) {
    return;
  }

  panelOneBodyText.textContent = showHint ? SECTION_ONE_HINT_TEXT : sectionOneOriginalText;

  if (panelOneNavRight) {
    panelOneNavRight.classList.toggle("hint-nav-visible", showHint);
  }
}

function clearSectionOneHintTimer() {
  if (sectionOneHintTimerId) {
    window.clearTimeout(sectionOneHintTimerId);
    sectionOneHintTimerId = 0;
  }
}

function scheduleSectionOneHintOn() {
  if (activeSectionIndex !== 0) {
    return;
  }

  sectionOneHintTimerId = window.setTimeout(() => {
    sectionOneHintTimerId = 0;

    if (activeSectionIndex !== 0) {
      return;
    }

    applySectionOneHintState(true);
    sectionOneHintTimerId = window.setTimeout(() => {
      sectionOneHintTimerId = 0;

      if (activeSectionIndex !== 0) {
        return;
      }

      applySectionOneHintState(false);
      scheduleSectionOneHintOn();
    }, 15000);
  }, 15000);
}

function resetSectionOneHintCycle() {
  clearSectionOneHintTimer();
  applySectionOneHintState(false);

  if (activeSectionIndex === 0) {
    scheduleSectionOneHintOn();
  }
}

window.addEventListener("resize", () => {
  setContainerMetrics();
  trimFrameCache();
  updateFromScroll();
  setupAirplane();
});

window.addEventListener("scroll", updateFromScroll, { passive: true });
window.addEventListener("wheel", () => {
  markUserInteraction();
  cancelSnap();
}, { passive: true });

track.addEventListener("click", (event) => {
  const button = event.target.closest(".nav-btn");
  if (!button) {
    return;
  }

  const targetIndex = Number.parseInt(button.dataset.target, 10);
  if (Number.isNaN(targetIndex)) {
    return;
  }

  snapToSection(targetIndex);
});

stickyScene.addEventListener("mousedown", onDragStart);
window.addEventListener("mousemove", onDragMove);
window.addEventListener("mouseup", onDragEnd);
stickyScene.addEventListener("mouseleave", onDragEnd);

stickyScene.addEventListener("touchstart", onDragStart, { passive: true });
window.addEventListener("touchmove", onDragMove, { passive: true });
window.addEventListener("touchend", onDragEnd);
window.addEventListener("touchcancel", onDragEnd);
stickyScene.addEventListener("mousemove", onSceneMouseMove, { passive: true });
stickyScene.addEventListener("click", onSceneClick);
window.addEventListener("pageshow", initializeFirstSection);

if (mobileCardsQuery.addEventListener) {
  mobileCardsQuery.addEventListener("change", () => {
    trimFrameCache();
    applyHistoryCardMode();
    setupAirplane();
  });
} else {
  mobileCardsQuery.addListener(() => {
    trimFrameCache();
    applyHistoryCardMode();
    setupAirplane();
  });
}

if (reducedMotionQuery.addEventListener) {
  reducedMotionQuery.addEventListener("change", setupAirplane);
} else {
  reducedMotionQuery.addListener(setupAirplane);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopAirplaneAnimation();
    return;
  }

  if (airplaneState && !airplaneRafId) {
    airplaneLastTime = 0;
    airplaneRafId = window.requestAnimationFrame(updateAirplane);
  }
});

initializeFirstSection();
setContainerMetrics();
preloadInitial();
setProgress(0, false);
applyHistoryCardMode();
startSectionOneHintToggle();
setupAirplane();

window.addEventListener("load", startBackgroundPreload, { once: true });
