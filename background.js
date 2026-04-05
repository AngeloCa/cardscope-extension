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
        return true; // keep message channel open for async response
    }
});

async function handleIdentify({ image, condition, serverUrl, secret }) {
    if (!secret) {
        return { error: 'Secret manquant — configure CardScope dans le popup' };
    }
    if (!serverUrl) {
        return { error: 'URL serveur manquante — configure CardScope dans le popup' };
    }

    // Step 1: Identify card via Claude Vision
    let identified;
    try {
        identified = await callServer(`${serverUrl}/v1/voggt/identify`, 'POST', secret, {
            image,
        });
    } catch (e) {
        return { error: `Identification échouée: ${e.message}` };
    }

    if (!identified.detected) {
        return { detected: false };
    }

    const { cardName, game, set, cardNumber } = identified;

    // Step 2: Check memory cache
    const cacheKey = `${game}:${cardName}:${condition}`.toLowerCase();
    const cached = cardCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return { ...cached.result, cached: true };
    }

    // Step 3: Fetch price from Cardmarket via server
    let priceData;
    try {
        const params = new URLSearchParams({ name: cardName, game, condition });
        if (set) params.set('set', set);
        priceData = await callServer(`${serverUrl}/v1/voggt/price?${params}`, 'GET', secret);
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
        trendPrice: priceData.trendPrice,
        lowPrice: priceData.lowPrice,
        condition: priceData.condition,
        currency: priceData.currency,
        cardmarketUrl: priceData.cardmarketUrl,
    };

    // Store in memory cache
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
