/**
 * CardScope — background.js (MV3 service worker)
 * Relays card identification and price lookup requests to the happy-server backend.
 * Keeps an in-memory cache to avoid redundant API calls for the same card.
 */

// In-memory cache: cardName → { result, expiresAt }
const cardCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'CARDSCOPE_IDENTIFY') {
        handleIdentify(message).then(sendResponse).catch((err) => {
            sendResponse({ error: err.message || 'Erreur serveur' });
        });
        return true;
    }
    if (message.type === 'CARDSCOPE_PRICE_ONLY') {
        handlePriceOnly(message).then(sendResponse).catch((err) => {
            sendResponse({ error: err.message || 'Erreur serveur' });
        });
        return true;
    }
});

async function handleIdentify({ image, condition, serverUrl, secret, force }) {
    if (!secret) {
        return { error: 'Secret manquant — configure CardScope dans le popup' };
    }
    if (!serverUrl) {
        return { error: 'URL serveur manquante — configure CardScope dans le popup' };
    }

    // Step 1: Identify card via Claude Vision
    let identified;
    try {
        identified = await callServer(`${serverUrl}/identify`, 'POST', secret, { image });
    } catch (e) {
        return { error: `Identification échouée: ${e.message}` };
    }

    if (!identified.detected) {
        return { detected: false };
    }

    const { cardName, game, set, cardNumber, language } = identified;

    // Step 2: Check memory cache (skip if forced)
    const cacheKey = `${game}:${cardName}:${condition}:${language ?? 'EN'}`.toLowerCase();
    if (!force) {
        const cached = cardCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return { ...cached.result, cached: true };
        }
    }

    // Step 3: Fetch price from JustTCG via server
    let priceData;
    try {
        const params = new URLSearchParams({ name: cardName, game, condition, language: language ?? 'EN' });
        if (set) params.set('set', set);
        priceData = await callServer(`${serverUrl}/price?${params}`, 'GET', secret);
    } catch (e) {
        // Return card info even if price fetch fails
        return { detected: true, cardName, game, set, cardNumber, priceError: e.message };
    }

    const result = {
        detected: true,
        cardName,
        game,
        set,
        cardNumber,
        language: language ?? 'EN',
        trendPrice: priceData.trendPrice,
        lowPrice: priceData.lowPrice,
        condition: priceData.condition,
        currency: priceData.currency,
        justtcgUrl: priceData.justtcgUrl,
    };

    // Store in memory cache
    cardCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });

    return result;
}

// Direct price lookup — skips OCR when card name comes from Voggt's DOM
async function handlePriceOnly({ cardName, condition, serverUrl, secret }) {
    if (!secret || !serverUrl) return { error: 'Config manquante' };

    const cacheKey = `dom:${cardName}:${condition}`.toLowerCase();
    const cached = cardCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return { ...cached.result, cached: true };

    const params = new URLSearchParams({ name: cardName, condition });
    const priceData = await callServer(`${serverUrl}/price?${params}`, 'GET', secret);

    const result = {
        trendPrice: priceData.trendPrice,
        lowPrice: priceData.lowPrice,
        condition: priceData.condition,
        currency: priceData.currency,
        justtcgUrl: priceData.justtcgUrl,
        set: priceData.setName,
        cardNumber: priceData.cardNumber,
    };
    cardCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
}

async function callServer(url, method, secret, body) {
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'x-cardscope-secret': secret,
        },
    };
    if (body && method !== 'GET') {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 100)}`);
    }
    return response.json();
}
