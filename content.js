/**
 * CardScope — content.js
 * Injected on voggt.com pages.
 * Finds the <video> element, captures frames every 3s,
 * sends them to the background service worker for card detection + price lookup,
 * and renders the overlay badge on top of the video.
 */

const CAPTURE_INTERVAL_MS = 2000;   // how often we CHECK for visual change
const MIN_API_INTERVAL_MS = 12000;  // min time between actual API calls
const JPEG_QUALITY = 0.6;
const MAX_FRAME_WIDTH = 640; // resize before sending to reduce payload
const DIFF_SAMPLE_SIZE = 32;        // sample grid for frame diff (32×32 = 1024 points)
const DIFF_THRESHOLD = 0.08;        // 8% of pixels must change to trigger API call

let overlayEl = null;
let videoEl = null;
let captureInterval = null;
let lastCardName = null;
let isEnabled = true;
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let lastFramePixels = null;         // sampled pixel data of last API-triggering frame
let lastApiCallAt = 0;              // timestamp of last API call

// ─── Settings ────────────────────────────────────────────────────────────────

async function getSettings() {
    return new Promise((resolve) => {
        chrome.storage.sync.get(
            {
                serverUrl: 'http://localhost:3000',
                secret: '',
                condition: 'NM',
                nidThresholdPct: 90,
                enabled: true,
            },
            resolve
        );
    });
}

// ─── Overlay ─────────────────────────────────────────────────────────────────

function createOverlay() {
    const el = document.createElement('div');
    el.id = 'cardscope-overlay';
    el.innerHTML = `
        <div class="cardscope-header">
            <span class="cardscope-logo">CardScope</span>
            <span class="cardscope-condition" id="cs-condition">NM</span>
        </div>
        <div id="cs-body">
            <div class="cardscope-idle">🃏 En attente d'une carte…</div>
        </div>
    `;
    makeDraggable(el);
    return el;
}

function attachOverlayToVideo(video) {
    const container = video.parentElement;
    if (!container) return;
    const style = window.getComputedStyle(container);
    if (style.position === 'static') {
        container.style.position = 'relative';
    }
    if (overlayEl && overlayEl.parentElement) {
        overlayEl.parentElement.removeChild(overlayEl);
    }
    container.appendChild(overlayEl);
}

function renderLoading(condition) {
    document.getElementById('cs-condition').textContent = condition;
    document.getElementById('cs-body').innerHTML = `
        <div class="cardscope-loading">
            <div class="cardscope-spinner"></div>
            Analyse en cours…
        </div>
    `;
}

function renderIdle(condition) {
    document.getElementById('cs-condition').textContent = condition;
    document.getElementById('cs-body').innerHTML = `
        <div class="cardscope-idle">🃏 En attente d'une carte…</div>
    `;
}

function renderResult(data, condition, nidThresholdPct) {
    document.getElementById('cs-condition').textContent = condition;

    if (!data || !data.detected) {
        renderIdle(condition);
        return;
    }

    const { cardName, set, cardNumber, trendPrice, lowPrice, currency, justtcgUrl } = data;
    const symbol = currency === 'EUR' ? '€' : currency;
    const metaParts = [set, cardNumber ? `#${cardNumber}` : null].filter(Boolean);

    let verdictHtml = '';
    if (trendPrice != null) {
        verdictHtml = `
            <div class="cardscope-verdict unknown" id="cs-verdict">
                Renseigne le prix live pour le verdict
            </div>
        `;
    }

    document.getElementById('cs-body').innerHTML = `
        <div class="cardscope-card-name">${escapeHtml(cardName)}</div>
        ${metaParts.length ? `<div class="cardscope-card-meta">${escapeHtml(metaParts.join(' • '))}</div>` : ''}
        ${trendPrice != null ? `
        <div class="cardscope-prices">
            <div class="cardscope-price-block">
                <div class="cardscope-price-label">Tendance</div>
                <div class="cardscope-price-value">${trendPrice.toFixed(2)} ${symbol}</div>
            </div>
            <div class="cardscope-price-block">
                <div class="cardscope-price-label">Prix bas</div>
                <div class="cardscope-price-value">${lowPrice != null ? lowPrice.toFixed(2) + ' ' + symbol : '—'}</div>
            </div>
        </div>
        ${verdictHtml}
        ${justtcgUrl ? `<a class="cardscope-link" href="${justtcgUrl}" target="_blank">Voir sur JustTCG ↗</a>` : ''}
        ` : `<div class="cardscope-idle">Prix non disponible</div>`}
    `;
}

function renderError(msg) {
    if (!document.getElementById('cs-body')) return;
    document.getElementById('cs-body').innerHTML = `
        <div class="cardscope-idle">⚠️ ${escapeHtml(msg)}</div>
    `;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ─── Drag & Drop ─────────────────────────────────────────────────────────────

function makeDraggable(el) {
    el.addEventListener('mousedown', (e) => {
        isDragging = true;
        const rect = el.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const parent = el.parentElement;
        if (!parent) return;
        const parentRect = parent.getBoundingClientRect();
        const x = e.clientX - parentRect.left - dragOffsetX;
        const y = e.clientY - parentRect.top - dragOffsetY;
        el.style.right = 'auto';
        el.style.left = `${Math.max(0, x)}px`;
        el.style.top = `${Math.max(0, y)}px`;
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
    });
}

// ─── Video frame capture ──────────────────────────────────────────────────────

function captureFrame(video) {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return { canvas, ctx, base64: canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1] };
}

// Sample a grid of pixels from the canvas for cheap visual diff
function samplePixels(ctx, w, h) {
    const pixels = [];
    for (let i = 0; i < DIFF_SAMPLE_SIZE; i++) {
        for (let j = 0; j < DIFF_SAMPLE_SIZE; j++) {
            const x = Math.floor((i / DIFF_SAMPLE_SIZE) * w);
            const y = Math.floor((j / DIFF_SAMPLE_SIZE) * h);
            const d = ctx.getImageData(x, y, 1, 1).data;
            pixels.push(d[0], d[1], d[2]); // R, G, B
        }
    }
    return pixels;
}

// Returns fraction of sampled pixels that changed significantly
function frameDiff(prev, curr) {
    if (!prev || prev.length !== curr.length) return 1;
    let changed = 0;
    const total = curr.length / 3;
    for (let i = 0; i < curr.length; i += 3) {
        const dr = Math.abs(curr[i] - prev[i]);
        const dg = Math.abs(curr[i + 1] - prev[i + 1]);
        const db = Math.abs(curr[i + 2] - prev[i + 2]);
        if (dr + dg + db > 30) changed++; // ~10/255 per channel
    }
    return changed / total;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function runCaptureLoop() {
    const settings = await getSettings();
    if (!settings.enabled) return;

    if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) return;

    // Rate limit: don't call API more often than MIN_API_INTERVAL_MS
    const now = Date.now();
    if (now - lastApiCallAt < MIN_API_INTERVAL_MS) return;

    let frame;
    try {
        frame = captureFrame(videoEl);
    } catch (e) {
        return; // cross-origin or video not ready
    }

    // Visual diff: skip API call if frame hasn't changed enough
    const currentPixels = samplePixels(frame.ctx, frame.canvas.width, frame.canvas.height);
    const diff = frameDiff(lastFramePixels, currentPixels);
    if (diff < DIFF_THRESHOLD) return; // scene unchanged, skip

    lastFramePixels = currentPixels;
    lastApiCallAt = now;

    renderLoading(settings.condition);

    chrome.runtime.sendMessage(
        {
            type: 'CARDSCOPE_IDENTIFY',
            image: frame.base64,
            condition: settings.condition,
            serverUrl: settings.serverUrl,
            secret: settings.secret,
        },
        (response) => {
            if (chrome.runtime.lastError) {
                renderError('Erreur de connexion au serveur');
                return;
            }
            if (!response || response.error) {
                renderError(response?.error || 'Erreur inconnue');
                return;
            }
            if (response.cardName && response.cardName === lastCardName && response.cached) {
                return;
            }
            lastCardName = response.cardName || null;
            renderResult(response, settings.condition, settings.nidThresholdPct);
        }
    );
}

// ─── Voggt DOM trigger — detect new listing events ────────────────────────────

function watchVoggtListings() {
    // Reset the API cooldown when Voggt signals a new lot/listing
    // Voggt uses React so we watch for DOM changes in the listing area
    const listingObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1) continue;
                // Detect Voggt listing signals: price elements, lot numbers, countdown timers
                const text = node.textContent || '';
                const isListingChange =
                    node.querySelector?.('[class*="lot"]') ||
                    node.querySelector?.('[class*="price"]') ||
                    node.querySelector?.('[class*="timer"]') ||
                    node.querySelector?.('[class*="countdown"]') ||
                    node.querySelector?.('[class*="current"]') ||
                    /^\d+[,.]?\d*\s*€/.test(text.trim()); // price pattern like "12,50 €"

                if (isListingChange) {
                    // New listing detected — force next capture to bypass cooldown
                    lastApiCallAt = 0;
                    lastFramePixels = null;
                    break;
                }
            }
        }
    });

    listingObserver.observe(document.body, { childList: true, subtree: true });
}

// ─── Video element discovery ──────────────────────────────────────────────────

function findVideoElement() {
    // Direct video element on the page
    const videos = Array.from(document.querySelectorAll('video'));
    // Prefer the one that is playing and visible
    const playing = videos.find(
        (v) => !v.paused && v.videoWidth > 0 && v.offsetParent !== null
    );
    return playing || videos[0] || null;
}

function startCapture() {
    videoEl = findVideoElement();
    if (!videoEl) return false;

    if (!overlayEl) {
        overlayEl = createOverlay();
    }
    attachOverlayToVideo(videoEl);

    if (captureInterval) clearInterval(captureInterval);
    captureInterval = setInterval(runCaptureLoop, CAPTURE_INTERVAL_MS);
    return true;
}

// ─── Observe DOM for video appearing (SPA navigation) ─────────────────────────

const observer = new MutationObserver(() => {
    if (!videoEl || !document.contains(videoEl)) {
        videoEl = null;
        if (captureInterval) {
            clearInterval(captureInterval);
            captureInterval = null;
        }
        startCapture();
    }
});

observer.observe(document.body, { childList: true, subtree: true });

// Initial attempt
startCapture();

// Watch Voggt DOM for new listing events
watchVoggtListings();

// Retry a few times in case the video loads after the script
let retries = 0;
const retryInterval = setInterval(() => {
    if (videoEl || retries >= 10) {
        clearInterval(retryInterval);
        return;
    }
    startCapture();
    retries++;
}, 2000);

// Listen to settings changes (e.g. toggle enabled from popup)
chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled && !changes.enabled.newValue) {
        if (captureInterval) clearInterval(captureInterval);
        captureInterval = null;
        if (overlayEl) overlayEl.classList.add('cardscope-hidden');
    } else if (changes.enabled && changes.enabled.newValue) {
        if (overlayEl) overlayEl.classList.remove('cardscope-hidden');
        startCapture();
    }
    if (changes.condition) {
        renderIdle(changes.condition.newValue);
    }
});
