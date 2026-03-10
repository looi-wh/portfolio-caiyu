const TOTAL_FRAMES = 329;
const FRAME_DIR = "frames_webp";
const FRAME_PAD = 6;
const SECTION_COUNT = 4;
const SNAP_IDLE_MS = 120;
const SNAP_DURATION_MS = 380;
const NAV_SNAP_DURATION_MS = 780;
const SNAP_ADVANCE_RATIO = 0.32;

const scrollContainer = document.getElementById("scroll-container");
const stickyScene = document.getElementById("sticky-scene");
const track = document.getElementById("track");
const scrubBg = document.getElementById("scrub-bg");
const bgOverlay = document.querySelector(".bg-overlay");
const rippleLayer = document.getElementById("ripple-layer");
const historyLists = Array.from(document.querySelectorAll(".history-list"));
const mobileCardsQuery = window.matchMedia("(max-width: 1100px), (hover: none) and (pointer: coarse)");

let maxHorizontal = 0;
let containerStartY = 0;
let progress = 0;
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

const frameCache = new Map();

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

  const scrolled = window.scrollY - containerStartY;
  const nextProgress = clamp(scrolled / maxHorizontal, 0, 1);
  const delta = nextProgress - progress;

  if (!snapping && Math.abs(delta) > 0.0005) {
    lastIntentDirection = delta > 0 ? 1 : -1;
  }

  progress = nextProgress;
  needsRender = true;
  requestRender();

  if (!snapping) {
    scheduleSnap();
  }
}

function setProgress(nextProgress, syncScroll) {
  progress = clamp(nextProgress, 0, 1);
  needsRender = true;

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
  track.style.transform = `translate3d(${translateX}px, 0, 0)`;
  updateOverlayStrength(progress);

  const nextFrame = progressToFrame(progress);
  if (nextFrame !== currentFrame) {
    currentFrame = nextFrame;
    swapFrame(nextFrame);
    preloadNearby(nextFrame, 8);
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
}

function animateSnap(now) {
  if (!snapping) {
    return;
  }

  const elapsed = now - snapStartTime;
  const linear = clamp(elapsed / snapDurationMs, 0, 1);
  const eased = 1 - Math.pow(1 - linear, 4);
  const next = snapFromProgress + (snapToProgress - snapFromProgress) * eased;

  setProgress(next, true);

  if (linear >= 1) {
    snapping = false;
    snapRafId = 0;
    setProgress(snapToProgress, true);
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

  cancelSnap();
  snapping = true;
  snapDurationMs = durationMs;
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
    if (scrubBg.src !== cached.src) {
      scrubBg.src = cached.src;
    }
    return;
  }

  const img = new Image();
  img.src = framePath(frameNumber);
  frameCache.set(frameNumber, img);

  img.onload = () => {
    if (frameNumber === currentFrame) {
      scrubBg.src = img.src;
    }
  };
}

function preloadFrame(frameNumber) {
  if (frameNumber < 1 || frameNumber > TOTAL_FRAMES || frameCache.has(frameNumber)) {
    return;
  }

  const img = new Image();
  img.src = framePath(frameNumber);
  frameCache.set(frameNumber, img);
}

function preloadInitial() {
  for (let i = 1; i <= 24; i += 1) {
    preloadFrame(i);
  }
}

function preloadNearby(centerFrame, radius) {
  for (let offset = 1; offset <= radius; offset += 1) {
    preloadFrame(centerFrame - offset);
    preloadFrame(centerFrame + offset);
  }
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
  dragging = true;
  dragStartX = getClientX(event);
  dragStartProgress = progress;
  stickyScene.classList.add("is-dragging");
}

function onDragMove(event) {
  if (!dragging) {
    return;
  }

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

  if (now - lastRippleTime < 55 || moved < 22) {
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

window.addEventListener("resize", () => {
  setContainerMetrics();
  updateFromScroll();
});

window.addEventListener("scroll", updateFromScroll, { passive: true });
window.addEventListener("wheel", cancelSnap, { passive: true });

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
  mobileCardsQuery.addEventListener("change", applyHistoryCardMode);
} else {
  mobileCardsQuery.addListener(applyHistoryCardMode);
}

initializeFirstSection();
setContainerMetrics();
preloadInitial();
setProgress(0, false);
applyHistoryCardMode();
