/*
 * DARKNOTE L2 LICENSE
 * Free to use and modify.
 * Please keep this credit notice in redistributed versions.
 * © DARKNOTE L2 • Bigbrother
 */
const baileys = require('mzazibaileys')

const {
    default: makeWASocket,
    proto,
    generateWAMessageFromContent,
    generateWAMessage,
    generateWAMessageContent,
    prepareWAMessageMedia,
    downloadContentFromMessage,
    downloadAndSaveMediaMessage,
    jidNormalizedUser,
    getContentType,
    fetchLatestBaileysVersion,
    useSingleFileAuthState,
    makeInMemoryStore,
    DisconnectReason,
    Browsers
} = baileys

const os = require('os');
const util = require('util');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp')
const { exec } = require('child_process');
const { fileTypeFromBuffer } = require('file-type');
const { writeExif } = require('./lib/StickerMaker.js');
const ytSearch = require('yt-search');
const { ytdlAutoBuffer, ytdlAutoVideoFile, ytdlSongBuffer, getYouTubeMetadata, extractYouTubeId, toOpusOgg } = require('./lib/ytdl.js');
const { resolveForDispatch, configureAlias, getRegisteredCommands } = require('./lib/command-system.js');
const quoteGuard = require('./lib/quote-guard.js');
const { isNativeStatusSave, saveStatus, saveStatusSilent } = require('./lib/status-media.js');
const statusAuthor = require('./lib/status-author.js');
const outboundCall = require('./lib/outbound-call.js');
const menu2 = require('./lib/menu2.js');
const weather = require('./lib/weather.js');
const aiChat = require('./lib/ai-chat.js');
const lyrics = require('./lib/lyrics.js');
// Global reaction feedback: ⏳ while a command works, ✅ / ❌ when it settles.
const { withReaction, setReaction, reactSequence, pickMenuReactions } = require('./lib/reactions.js');
// The ONE global button system (see lib/buttons.js).
const buttonsystem = require('./lib/buttons.js');
// The `.ping` system dashboard (metrics + rich HTML card, with a text fallback).
const pingDashboard = require('./lib/ping-dashboard.js');
// Owner assistant: run a real command by talking to the bot in plain language.
const assistant = require('./lib/assistant.js');
// DARKNOTE AI service. The automatic conversational chatbot lives entirely in
// ./ai and is reached only through this facade. aiChat above stays as-is for the
// legacy prefixed .ai command; this is a separate, independent module.
const aiService = require('./ai/index.js');
const cards = require('./lib/cards.js');
// Smart image/sticker re-edit pipeline (`.edit`).
const imageEdit = require('./lib/image-edit.js');
// Display layer: resolves WhatsApp names and keeps raw JIDs out of visible text.
const display = require('./lib/display.js');
// The animated HTML pairing app behind `.pair` (card markup + AIRich delivery).
const pairCard = require('./lib/pair-card.js');
// The live `.runtime` scene: sky, sun/moon, weather and the two characters,
// rendered in the paired number's real timezone (see lib/runtime-card.js).
const runtimeCard = require('./lib/runtime-card.js');
// The handset chrome shared by the pairing card and the runtime scene, so both
// are drawn as a real phone screen (iPhone / Galaxy) instead of a web page.
const phoneFrame = require('./lib/phone-frame.js');
// Destructive confirmed group operation, and the honest `.state` reader.
const evilPain = require('./lib/evil-pain.js');
const userInfo = require('./lib/user-info.js');
// Generated menu (names only, one entry per command) and the runtime monitor.
const menu = require('./lib/menu.js');
// Named runtimeMonitor on purpose: the `.menu` case already has a local
// `runtime` holding process.uptime(), and shadowing the monitor there would be
// an easy way to introduce a very confusing bug.
const runtimeMonitor = require('./lib/runtime.js');
// Protected modules: load the obfuscated build when it is present and fall back
// to the readable source. Generate the protected builds with `npm run protect`.
const requireProtected = (name) => {
    // Shazam's readable module is the source of truth for the supplied
    // whatsapp.js ACRCloud integration. Keep every other protected module on
    // its existing path.
    if (name === 'shazam') return require('./lib/shazam.js');
    try {
        return require(`./lib/${name}.protected.js`);
    } catch (error) {
        const missing = error?.code === 'MODULE_NOT_FOUND' && String(error.message || '').includes(`${name}.protected`);
        if (!missing) {
            console.error(`[PROTECT] ${name}.protected.js exists but failed to load — using the readable source:`, error?.stack || error);
        }
        return require(`./lib/${name}.js`);
    }
};
const blockStatus = requireProtected('block-status');

// Some Baileys builds (including the installed levvleys fork) do not expose the
// generated protobuf helper constructors, so
// `proto.Message.InteractiveMessage.Header.create({...})` threw
// "Cannot read properties of undefined (reading 'create')".
// imNode() prefers the helper when it exists and falls back to a plain object
// literal, which relayMessage accepts, keeping every interactive message alive.
const imNode = (name, shape) => {
    const holder = cards.interactiveMessage();
    return cards.safeCreate(name ? holder?.[name] : holder, shape);
};
const ownerSystem = require('./lib/owner-system.js');
const antidelete = require('./lib/antidelete.js');
// ONE security engine for the whole anti-feature suite.
const security = require('./lib/security.js');
const groupFeatures = require('./lib/group-features.js');

// Temporary song selections. They expire automatically so memory stays bounded.
const songSelections = new Map();
const SONG_TTL = 10 * 60 * 1000;

// Temporary YouTube video selections and download locks.
const ytVideoSelections = new Map();
const ytVideoLocks = new Set();
const YTVIDEO_TTL = 10 * 60 * 1000;
const YTVIDEO_MAX_SECONDS = 20 * 60;
const YTVIDEO_MAX_BYTES = 200 * 1024 * 1024;

function songKey(m, token) { return `${m.chat}:${getNumber(m.sender)}:${token}`; }
function cleanupSongSelections() {
    const now = Date.now();
    for (const [key, value] of songSelections) if (now - value.createdAt > SONG_TTL) songSelections.delete(key);
}

function cleanupYtVideoSelections() {
    const now = Date.now();
    for (const [key, value] of ytVideoSelections) {
        if (now - value.createdAt > YTVIDEO_TTL) ytVideoSelections.delete(key);
    }
}

function ytVideoKey(m, requestId) {
    return `${m.chat}:${getNumber(m.sender)}:${requestId}`;
}

function isYouTubeUrl(value) {
    return Boolean(extractYouTubeId(String(value || '').trim()));
}

function safeVideoFilename(title = 'DARKNOTE YouTube Video') {
    return String(title).replace(/[\\/:*?"<>|]/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 90) || 'DARKNOTE YouTube Video';
}

function formatVideoDuration(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

async function resolveYtVideoMetadata(url, fallback = {}) {
    const direct = await getYouTubeMetadata(url);
    if (direct?.status) return direct;
    try {
        const search = await ytSearch(url);
        const id = extractYouTubeId(url);
        const found = (search.videos || []).find(v => v.videoId === id);
        if (found) return {
            status: true,
            videoId: found.videoId,
            url: found.url || url,
            title: found.title || fallback.title || 'YouTube video',
            author: found.author?.name || fallback.author || 'YouTube',
            duration: Number(found.seconds || 0),
            thumbnail: found.thumbnail || fallback.thumbnail,
            views: Number(found.views || 0)
        };
    } catch (error) {
        console.error('[YTVIDEO] Metadata fallback failed:', error?.message || error);
    }
    if (Number.isFinite(Number(fallback.duration)) && Number(fallback.duration) > 0) {
        return { ...fallback, status: true, duration: Number(fallback.duration) };
    }
    return { status: false, error: direct?.error || 'Unable to read YouTube video metadata' };
}

async function sendChannelButton(conn, m) {
    const channelLink = String(config.channelLink || '').trim();
    if (!channelLink || channelLink.includes('REPLACE_WITH_YOUR_CHANNEL')) return;
    if (!/^https:\/\/whatsapp\.com\/channel\/[A-Za-z0-9_-]+(?:[/?].*)?$/i.test(channelLink)) return;

    const content = {
        viewOnceMessage: {
            message: {
                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                interactiveMessage: imNode(null, {
                    body: imNode('Body', {
                        text: '📢 *DARKNOTE L2*\n\nFollow our official channel for updates and new features.'
                    }),
                    footer: imNode('Footer', {
                        text: 'DARKNOTE L2 • Bigbrother'
                    }),
                    nativeFlowMessage: imNode('NativeFlowMessage', {
                        buttons: [{
                            name: 'cta_url',
                            buttonParamsJson: JSON.stringify({
                                display_text: '📢 VIEW CHANNEL',
                                url: channelLink,
                                merchant_url: channelLink
                            })
                        }],
                        messageParamsJson: ''
                    })
                })
            }
        }
    };

    const msg = generateWAMessageFromContent(m.chat, content, {
        userJid: conn.user?.id,
        quoted: m
    });
    // The interactive nodes are REQUIRED: without them WhatsApp renders nothing
    // and the relay still reports success (see lib/buttons.js interactiveNodes).
    await conn.relayMessage(m.chat, msg.message, { messageId: msg.key.id, ...buttonsystem.interactiveNodes() });
}

/*
 * MENU DELIVERY — interactive, not the legacy buttonsMessage.
 *
 * `.menu` used to relay a legacy `buttonsMessage` (a locationMessage used as the
 * header plus `buttons: [{ type: 1 }]`). Current WhatsApp clients no longer
 * render that type at all: the relay SUCCEEDS, the console logs nothing wrong,
 * and the user sees an empty chat. That is exactly the "menu is not displaying"
 * symptom.
 *
 * This sends the same text through the interactiveMessage + nativeFlowMessage
 * shape the project already relies on for cards, the channel button and the
 * pairing code. The header image is optional: if the upload fails the card is
 * still sent without it, and if the card itself cannot be built the menu goes
 * out as plain text. The menu can therefore never be invisible.
 */
/*
 * LEGACY BUTTON MENU (the classic buttonsMessage).
 *
 * Owner request: send the menu with the legacy button. Older and modded WhatsApp
 * clients render this shape and often do NOT render the newer interactive card,
 * which is the reverse of the mainstream clients - so which one to use is a real
 * choice, and it is configurable:
 *
 *     config.json -> menu.mode = "legacy" | "interactive"      (default "legacy")
 *
 * If the menu ever stops appearing again, flip that value: the other mode is the
 * one your client supports. Either way a plain-text menu is sent when the button
 * message itself cannot be relayed, so the menu is never lost.
 */
/*
 * The menu thumbnail, at MODULE scope so the menu helpers can use it.
 *
 * It used to be defined inside the dispatcher, which meant sendMenuCard() and
 * sendLegacyMenu() could not see it: every menu send threw
 * "getMenuThumb is not defined", was caught, and quietly degraded to plain text
 * (or to a headerless card). Loaded lazily and cached, so a missing or corrupt
 * image can never break an unrelated command.
 */
let menuThumbCache = null
async function getMenuThumb() {
    if (menuThumbCache) return menuThumbCache
    try {
        menuThumbCache = await sharp(path.join(__dirname, 'src', 'img', 'menu.jpg'))
            .resize(300, 300)
            .jpeg({ quality: 80 })
            .toBuffer()
        return menuThumbCache
    } catch (error) {
        console.error('[MENU] thumbnail unavailable:', error?.message || error)
        return null
    }
}

function menuMode() {
    const mode = String(liveConfig()?.menu?.mode || 'legacy').toLowerCase()
    return ['legacy', 'interactive'].includes(mode) ? mode : 'legacy'
}

/*
 * Quoted-reply context, so the menu card threads under the message that asked
 * for it. relayMessage() has no `quoted` option (the old code passed one and it
 * was ignored), so the reply link has to travel in the message's contextInfo.
 * Returns null rather than a half-built object, so a malformed context can never
 * be attached to the card.
 */
function quotedContext(m) {
    try {
        const id = m?.key?.id
        if (!id || !m?.message) return null
        return {
            stanzaId: id,
            participant: m.key?.participant || m.sender || m.chat,
            quotedMessage: m.message
        }
    } catch {
        return null
    }
}

/*
 * LEGACY BUTTON MENU — relayed through the fork's own ButtonV2 builder.
 *
 * WHY THIS CHANGED. The previous version hand-built a raw `buttonsMessage` and
 * relayed it with no additional nodes. The relay always SUCCEEDED and logged
 * nothing at all — but WhatsApp rendered nothing, which is exactly the "menu
 * does not respond" symptom: reactions fired, and no card ever appeared.
 *
 * The missing half ships with the fork. ButtonV2.send() attaches
 *
 *     biz > interactive(type=native_flow) > native_flow(v=9, name=mixed)
 *
 * which is what makes a button card actually render, and its build() emits the
 * very same legacy buttonsMessage shape this function was reaching for
 * (locationMessage header + headerType 6 + type-1 buttons). The card therefore
 * keeps the legacy look while finally being deliverable.
 *
 * MENU CONTENT IS UNCHANGED. The body text still comes from lib/menu.js through
 * the same `text` argument, and the buttons are the same id/text pairs, so
 * `.menu`, `.allmenu`, the command registry and the button dispatcher all behave
 * exactly as before. Only the delivery changed.
 *
 * THUMBNAIL. ButtonV2.setThumbnail() re-encodes through Toolkit.resize(), which
 * returns PNG — a 184 KB PNG in a field named jpegThumbnail. setRawThumbnail()
 * passes our own sharp-encoded JPEG straight through instead: correct format and
 * about 22 KB. The raw path is used deliberately.
 */
async function sendLegacyMenu(conn, m, text, buttons) {
    // 1. Preferred: the fork's ButtonV2 card (the MZAZI button layout).
    try {
        // Read lazily: the builder proxy pulls in sharp/fluent-ffmpeg on first
        // access, so a build without them must fail only here, not at require.
        const ButtonV2 = baileys?.ButtonV2
        if (typeof ButtonV2 === 'function') {
            const cfg = liveConfig() || {}
            const card = new ButtonV2(conn)

            // Header: bot identity on top, the paired number underneath — the
            // same name/number pair the legacy location header renders.
            const number = String(conn?.user?.id || '').split('@')[0].split(':')[0]
            card.setTitle(`${cfg.botName || 'DARKNOTE'} ${cfg.version || 'L2'}`)
            card.setSubtitle(number ? `+${number}` : String(cfg.ownerName || 'Bigbrother'))
            card.setBody(String(text))
            card.setFooter('DARKNOTE L2 • Bigbrother')

            const thumb = await getMenuThumb()
            if (thumb) card.setRawThumbnail(Buffer.from(thumb).toString('base64'))

            for (const button of buttons || []) {
                card.addButton(String(button.text), String(button.id))
            }

            const context = quotedContext(m)
            if (context) card.setContextInfo(context)

            const sent = await card.send(m.chat, {})
            console.log(`[MENU] ButtonV2 card sent to ${String(m.chat).split('@')[0]} with ${(buttons || []).length} button(s) (id ${sent?.key?.id || '?'})`)
            return { ok: true, mode: 'legacy' }
        }
        console.warn('[MENU] this fork exposes no ButtonV2; using the raw buttonsMessage')
    } catch (error) {
        console.error('[MENU] ButtonV2 card failed, trying the raw buttonsMessage:', error?.message || error)
    }

    // 2. Fallback: the original hand-built buttonsMessage.
    try {
        await conn.relayMessage(m.chat, {
            buttonsMessage: {
                locationMessage: {
                    degreesLatitude: 0,
                    degreesLongitude: 0,
                    name: 'DARKNOTE L2',
                    address: 'Bigbrother',
                    jpegThumbnail: await getMenuThumb()
                },
                contentText: text,
                footerText: 'DARKNOTE L2 • Bigbrother',
                buttons: buttons.map(button => ({
                    buttonId: String(button.id),
                    buttonText: { displayText: String(button.text) },
                    type: 1
                })),
                headerType: 6
            }
        }, { quoted: m, messageId: conn.generateMessageTag(), ...buttonsystem.interactiveNodes() })
        return { ok: true, mode: 'legacy' }
    } catch (error) {
        console.error('[MENU] legacy button message failed, sending text:', error?.message || error)
        await conn.sendMessage(m.chat, { text }, { quoted: m })
        return { ok: true, mode: 'text' }
    }
}

async function sendMenuCard(conn, m, text, buttons) {
    if (menuMode() === 'legacy') return sendLegacyMenu(conn, m, text, buttons)

    const footer = 'DARKNOTE L2 • Bigbrother'

    let media = null
    try {
        media = await prepareWAMessageMedia({ image: await getMenuThumb() }, { upload: conn.waUploadToServer })
    } catch (error) {
        console.error('[MENU] thumbnail upload failed, sending without a header image:', error?.message || error)
    }

    try {
        const content = {
            viewOnceMessage: {
                message: {
                    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                    interactiveMessage: imNode(null, {
                        header: imNode('Header', media?.imageMessage
                            ? { title: 'DARKNOTE L2', hasMediaAttachment: true, ...media }
                            : { title: 'DARKNOTE L2', hasMediaAttachment: false }),
                        body: imNode('Body', { text }),
                        footer: imNode('Footer', { text: footer }),
                        nativeFlowMessage: imNode('NativeFlowMessage', {
                            buttons: buttonsystem.nativeFlowButtons(buttons),
                            messageParamsJson: ''
                        })
                    })
                }
            }
        }
        const built = generateWAMessageFromContent(m.chat, content, { userJid: conn.user?.id, ...quoteGuard.quoteOption(m) })
        // The interactive nodes are REQUIRED here too.
        await conn.relayMessage(m.chat, built.message, { messageId: built.key.id, ...buttonsystem.interactiveNodes() })
        return { ok: true, mode: 'interactive' }
    } catch (error) {
        console.error('[MENU] interactive card failed, falling back to text:', error?.message || error)
        await conn.sendMessage(m.chat, { text }, { quoted: m })
        return { ok: true, mode: 'text' }
    }
}

async function sendSongCarousel(conn, m, results) {
    cleanupSongSelections();
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    songSelections.set(songKey(m, token), { createdAt: Date.now(), results });

    /*
     * Named cardList, NOT `cards`: the module-level `cards` (lib/cards.js) is used
     * below for its image resolver, and a local `cards` would shadow it.
     */
    const cardList = [];
    const defaultImage = cards.configuredImage();
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        /*
         * A card is NEVER dropped because its thumbnail failed. The card carries
         * the AUDIO button, so dropping one would silently remove a result and
         * break the index -> song mapping that the button id depends on, while
         * dropping ALL of them threw and failed the whole command. This mirrors
         * lib/cards.js: try the item's own image, then the configured default,
         * and only then send the card headerless.
         */
        let imageMessage = await cards.resolveCardImage(conn, { url: r.thumbnail });
        if (!imageMessage && defaultImage) imageMessage = await cards.resolveCardImage(conn, defaultImage);

        cardList.push({
            header: imNode('Header', imageMessage
                ? { title: `🎵 ${i + 1}. ${r.title.slice(0, 55)}`, hasMediaAttachment: true, imageMessage: { ...imageMessage } }
                : { title: `🎵 ${i + 1}. ${r.title.slice(0, 55)}`, hasMediaAttachment: false }),
            body: imNode('Body', { text: `${r.author || 'YouTube'}\n⏱ ${r.timestamp || 'Unknown'}\n👁 ${Number(r.views || 0).toLocaleString()} views` }),
            footer: imNode('Footer', { text: 'DARKNOTE L2 • YouTube Music' }),
            nativeFlowMessage: imNode('NativeFlowMessage', {
                buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '🎧 AUDIO', id: `song_audio ${token} ${i}` }) }],
                messageParamsJson: ''
            })
        });
    }
    if (!cardList.length) throw new Error('Unable to build the song carousel.');

    const content = {
        viewOnceMessage: {
            message: {
                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                interactiveMessage: imNode(null, {
                    body: imNode('Body', { text: `🎶 *SONG SEARCH*\n\nFound ${cardList.length} results for your search.\nSwipe horizontally and tap *🎧 AUDIO* on the song you want.` }),
                    footer: imNode('Footer', { text: 'Swipe → choose → AUDIO' }),
                    carouselMessage: imNode('CarouselMessage', { cards: cardList })
                })
            }
        }
    };
    const msg = generateWAMessageFromContent(m.chat, content, { userJid: conn.user?.id, ...quoteGuard.quoteOption(m) });
    // The interactive nodes are REQUIRED: without them WhatsApp renders nothing
    // and the relay still reports success (see lib/buttons.js interactiveNodes).
    await conn.relayMessage(m.chat, msg.message, { messageId: msg.key.id, ...buttonsystem.interactiveNodes() });
}


/* How many results the .play picker offers. Six fits the two-per-row button
   layout in lib/buttons.js on a single screen. */
const PLAY_PICKER_LIMIT = 6;

/*
 * Button labels are capped at 24 characters (lib/buttons.js MAX_DISPLAY_TEXT) and
 * results for one query almost always open with the same words: six
 * "Blinding Lights" uploads all read "The Weeknd - Blinding" and four
 * "Bohemian Rhapsody" uploads all read "Queen - Bohemian Rhap". Every button then
 * looks alike, which is precisely the case the picker exists to solve.
 *
 * So: find the results whose labels collide ONCE TRUNCATED, strip the words that
 * only that colliding group shares, and if anything is still identical fall back
 * to the channel and finally to the track number. Comparing normalises case and
 * the dash variants, otherwise "Queen - ..." and "Queen – ..." count as different
 * and the shared "Queen - Bohemian Rhapsody" prefix is never detected.
 */
const LABEL_CHARS = 24;
const normChar = (c) => ('-–—‐‑‒'.includes(c) ? '-' : c.toLowerCase());
const normLabel = (s) => String(s).split('').map(normChar).join('');

function pickerLabels(results) {
    const titles = results.map(r => String(r.title || '').trim());
    const labels = titles.map((t, i) => t || `Result ${i + 1}`);

    /* Groups of indexes whose labels are indistinguishable once truncated. */
    const collisions = (list) => {
        const groups = new Map();
        list.forEach((label, i) => {
            const key = normLabel(label).slice(0, LABEL_CHARS);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(i);
        });
        return [...groups.values()].filter(indexes => indexes.length > 1);
    };

    for (const indexes of collisions(labels)) {
        let prefix = titles[indexes[0]];
        for (const i of indexes.slice(1)) {
            let n = 0;
            while (n < prefix.length && n < titles[i].length
                && normChar(prefix[n]) === normChar(titles[i][n])) n++;
            prefix = prefix.slice(0, n);
        }
        /*
         * If the shared part already covers a whole title then the group is
         * really the same title, and stripping would leave a fragment
         * ("Same Song" -> "Song"). Keep the full titles and let the channel
         * fallback below distinguish them instead.
         */
        if (prefix.length >= Math.min(...indexes.map(i => titles[i].length))) continue;
        // Never cut mid-word, and drop a trailing separator or bracket.
        prefix = prefix.replace(/[^\s]*$/, '').replace(/[\s\-–—|·:([{]+$/, '');
        if (!prefix) continue;
        for (const i of indexes) {
            const rest = titles[i].slice(prefix.length).replace(/^[\s\-–—|·:)\]]+/, '').trim();
            if (rest) labels[i] = rest;
        }
    }

    // Still identical (two "Lyrics" uploads, say): bring in the channel.
    for (const indexes of collisions(labels)) {
        for (const i of indexes) labels[i] = `${labels[i]} · ${results[i].author || 'YouTube'}`;
    }

    // Last resort, so no two buttons can ever read the same.
    for (const indexes of collisions(labels)) {
        for (const i of indexes) labels[i] = `${labels[i]} ${i + 1}`;
    }

    return labels;
}

/*
 * STEP 1 of the .play flow: the picker.
 *
 * WHY THE BUTTONS ARE NOT IN THE HTML CARD. The card runs in an offline sandbox
 * (no fetch, no XHR, no route back to WhatsApp), so a button drawn in the markup
 * could never tell the bot which song was tapped. WhatsApp's own quick_reply
 * buttons can: each carries an id, and tapping one sends that id back into the
 * dispatcher as an ordinary message. That is how `play_card <token> <n>` arrives
 * at case 'play_card' below. Same mechanism .song and .shazam already use.
 *
 * The results are parked in the existing songSelections map - identical shape and
 * the same 10 minute expiry - so selections live in exactly one place.
 */
async function sendPlayPicker(conn, m, query, results) {
    cleanupSongSelections();
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    songSelections.set(songKey(m, token), { createdAt: Date.now(), results });

    const labels = pickerLabels(results);
    const buttons = results.map((r, i) => ({
        id: `play_card ${token} ${i}`,
        text: `${i + 1}. ${labels[i]}`
    }));

    const listText = results
        .map((r, i) => `${i + 1}. ${String(r.title).slice(0, 60)}${r.timestamp ? ` · ${r.timestamp}` : ''}`)
        .join('\n');

    const content = {
        viewOnceMessage: {
            message: {
                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                interactiveMessage: imNode(null, {
                    body: imNode('Body', {
                        text: `🎵 *PICK A SONG*\n\n${results.length} matches for “${String(query).slice(0, 60)}”.\nTap the one you want and the player card is built for it.\n\n${listText}`
                    }),
                    footer: imNode('Footer', { text: 'DARKNOTE • tap to build the card' }),
                    nativeFlowMessage: imNode('NativeFlowMessage', {
                        buttons: buttonsystem.createButtons(buttons).nativeFlow,
                        messageParamsJson: ''
                    })
                })
            }
        }
    };
    const msg = generateWAMessageFromContent(m.chat, content, { userJid: conn.user?.id, ...quoteGuard.quoteOption(m) });
    // The interactive nodes are REQUIRED: without them WhatsApp renders nothing
    // while the relay still reports success (see lib/buttons.js interactiveNodes).
    await conn.relayMessage(m.chat, msg.message, { messageId: msg.key.id, ...buttonsystem.interactiveNodes() });
}

async function sendYtVideoCarousel(conn, m, results, query) {
    cleanupYtVideoSelections();
    const requestId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const key = ytVideoKey(m, requestId);
    ytVideoSelections.set(key, { createdAt: Date.now(), userJid: m.sender, chat: m.chat, requestId, query, results });

    // Named cardList, not `cards`: see sendSongCarousel - the module-level
    // `cards` (lib/cards.js) provides the image resolver used below.
    const cardList = [];
    const defaultImage = cards.configuredImage();
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        // Same rule as the song carousel: a failed thumbnail never drops a card,
        // because the SELECT VIDEO button and its index mapping live in the card.
        let imageMessage = await cards.resolveCardImage(conn, { url: r.thumbnail });
        if (!imageMessage && defaultImage) imageMessage = await cards.resolveCardImage(conn, defaultImage);
        cardList.push({
            header: imNode('Header', {
                title: `🎬 ${i + 1}. ${String(r.title || 'YouTube video').slice(0, 55)}`,
                hasMediaAttachment: !!imageMessage,
                ...(imageMessage ? { imageMessage: { ...imageMessage } } : {})
            }),
            body: imNode('Body', {
                text: `${r.author || 'YouTube'}\n⏱ ${r.timestamp || formatVideoDuration(r.duration)}\n👁 ${Number(r.views || 0).toLocaleString()} views\n\nSelect this video to download it.`
            }),
            footer: imNode('Footer', { text: 'DARKNOTE L2 • YouTube Video' }),
            nativeFlowMessage: imNode('NativeFlowMessage', {
                buttons: [{
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({
                        display_text: '🎬 SELECT VIDEO',
                        id: `ytvideo_select_${requestId}_${i}`
                    })
                }],
                messageParamsJson: ''
            })
        });
    }

    if (!cardList.length) {
        ytVideoSelections.delete(key);
        throw new Error('Unable to build the YouTube video carousel.');
    }

    const content = {
        viewOnceMessage: {
            message: {
                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                interactiveMessage: imNode(null, {
                    body: imNode('Body', {
                        text: `🎬 *YOUTUBE VIDEO SEARCH*\n\nFound ${cardList.length} video${cardList.length === 1 ? '' : 's'} for: *${String(query).slice(0, 80)}*\nSwipe horizontally and tap *🎬 SELECT VIDEO*.`
                    }),
                    footer: imNode('Footer', { text: 'Swipe → choose → download' }),
                    carouselMessage: imNode('CarouselMessage', { cards: cardList })
                })
            }
        }
    };
    const msg = generateWAMessageFromContent(m.chat, content, { userJid: conn.user?.id, ...quoteGuard.quoteOption(m) });
    // The interactive nodes are REQUIRED: without them WhatsApp renders nothing
    // and the relay still reports success (see lib/buttons.js interactiveNodes).
    await conn.relayMessage(m.chat, msg.message, { messageId: msg.key.id, ...buttonsystem.interactiveNodes() });
}

async function processSelectedYtVideo(conn, m, selected) {
    const url = selected.url;
    const metadata = await resolveYtVideoMetadata(url, selected);
    if (!metadata?.status) {
        console.error('[YTVIDEO] Metadata failed:', metadata?.error || 'Unknown metadata error');
        await m.bigboreply('❌ I could not read this YouTube video. Please select another result.');
        return;
    }

    const duration = Number(metadata.duration || 0);
    if (duration > YTVIDEO_MAX_SECONDS) {
        await m.bigboreply('❌ This video is longer than the 20-minute limit.');
        return;
    }
    if (!duration && !selected.duration) {
        console.error('[YTVIDEO] Duration unavailable for:', url);
        await m.bigboreply('❌ I could not verify this video duration. Please select another result.');
        return;
    }

    const tempDir = path.join(__dirname, 'tmp', 'ytvideo');
    const requestToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const filePath = path.join(tempDir, `${requestToken}.mp4`);
    const title = metadata.title || selected.title || 'YouTube video';

    // Media feedback while the video is fetched: 🎬 → ⏳, then ✅ / ❌.
    void reactSequence(conn, m, ['🎬', '⏳'], { gapMs: 250 }).catch(() => { });
    await m.bigboreply(`⏳ Downloading your selected video...\n🎬 ${title}\n⏱ ${formatVideoDuration(duration || selected.duration)}`);
    try {
        await fs.promises.mkdir(tempDir, { recursive: true });
        const result = await ytdlAutoVideoFile(url, filePath, '720', YTVIDEO_MAX_BYTES);
        if (!result?.status || !fs.existsSync(filePath)) {
            console.error('[YTVIDEO] Download failed:', result?.error || 'No output file');
            await m.bigboreply('❌ Failed to download this video. Please select another result.');
            return;
        }

        const stat = await fs.promises.stat(filePath);
        if (!stat.size || stat.size > YTVIDEO_MAX_BYTES) {
            console.error('[YTVIDEO] Output file rejected:', stat.size);
            await m.bigboreply('❌ This video is too large for me to send.');
            return;
        }

        await conn.sendMessage(m.chat, {
            video: { url: filePath },
            mimetype: 'video/mp4',
            fileName: `${safeVideoFilename(title)}.mp4`,
            caption: '✅ Video downloaded successfully.'
        }, { quoted: m });

        await setReaction(conn, m, '✅');
        await sendChannelButton(conn, m);
    } catch (error) {
        console.error('[YTVIDEO] Download/send failed:', error?.stack || error);
        await m.bigboreply('❌ I could not download or send this video. Please try another result.');
    } finally {
        try { await fs.promises.rm(filePath, { force: true }); } catch (error) { console.error('[YTVIDEO] File cleanup failed:', error?.message || error); }
        try { await fs.promises.rm(`${filePath}.part`, { force: true }); } catch {}
        try {
            const entries = await fs.promises.readdir(tempDir);
            if (!entries.length) await fs.promises.rmdir(tempDir);
        } catch {}
    }
}


const config = require('./config.json');
const ownerPath = path.join(__dirname, 'database', 'owner.json');
const premiumPath = path.join(__dirname, 'database', 'premium.json');

const readJSON = (file) => {
    try {
        if (!fs.existsSync(file)) fs.writeFileSync(file, '[]');
        return JSON.parse(fs.readFileSync(file));
    } catch {
        return [];
    }
};

const saveJSON = (file, data) => {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

const getNumber = (jid = '') => String(jid).split('@')[0].replace(/\D/g, '');


// ==================== TAGALL HELPERS ====================
const normalizeJidForCompare = (jid = '') => {
    try {
        return jidNormalizedUser(String(jid || ''));
    } catch {
        return String(jid || '').split(':')[0];
    }
};

const isGroupAdmin = (metadata, senderJid) => {
    if (!metadata?.participants?.length || !senderJid) return false;

    const sender = String(senderJid || '').trim();
    const senderNormalized = normalizeJidForCompare(sender);
    const senderNumber = getNumber(sender);

    const participant = metadata.participants.find(p => {
        const ids = [p?.id, p?.jid, p?.lid]
            .filter(Boolean)
            .map(value => String(value).trim());

        return ids.some(id => {
            if (normalizeJidForCompare(id) === senderNormalized) return true;

            // Handles WhatsApp LID -> normal JID mappings when the message
            // sender and group participant use different identifiers.
            if (senderNumber && id.endsWith('@s.whatsapp.net')) {
                return getNumber(id) === senderNumber;
            }

            return false;
        });
    });

    if (!participant) return false;

    // Baileys normally uses 'admin' / 'superadmin'. Some forks expose the
    // role slightly differently, so accept the equivalent values as well.
    const role = participant.admin ?? participant.role ?? participant.isAdmin;
    return role === 'admin' ||
           role === 'superadmin' ||
           role === 'administrator' ||
           role === true;
};

const buildTagAllMentionChunks = (jids, size = 50) => {
    const chunks = [];
    for (let i = 0; i < jids.length; i += size) {
        chunks.push(jids.slice(i, i + size));
    }
    return chunks;
};

// Central authorization: the primary creator plus persisted added owners.
// Existing command permission checks continue to use these helpers, so SELF
// mode and owner-controlled commands recognize added owners without per-command
// hard-coding.
const isCreator = (m) => ownerSystem.isOwner(m, config);
const isOwner = (m) => ownerSystem.isOwner(m, config);
const isPrimaryCreator = (m) => ownerSystem.isPrimaryCreator(m, config);

const isPremium = (m) => {
    const sender = getNumber(m.sender);
    const premiumDB = readJSON(premiumPath);
    return isOwner(m) || premiumDB.includes(sender);
};

// ==================== TAGALL / CALLALL COMMANDS ====================
/*
 * .tagall  - broadcast to every group member, with an optional custom message.
 * .callall - the same broadcast, but it re-quotes the message you replied to.
 *
 * Both send exactly ONE message built from the same boxed layout, and both carry
 * a real `mentions` array so WhatsApp resolves each "@<number>" token into the
 * member's own contact card. They are dispatched from the `tagall` / `callall`
 * cases in the handler below.
 */

/*
 * The two helpers are written against `m.reply(...)`. DARKNOTE's message object
 * exposes that same reply path as `m.bigboreply`, so this adapter prefers
 * `m.reply` when a build provides it and otherwise uses the local one. Without
 * it every guard clause inside the helpers would throw
 * "m.reply is not a function".
 */
const replyTo = (m, text) => (typeof m?.reply === 'function' ? m.reply(text) : m.bigboreply(text));

/*
 * canTag(m, participants) - who may run .tagall / .callall.
 *
 * A caller in the participant list they are about to ping must be a real group
 * admin. The owner/creator is always allowed on top of that: the owner asked for
 * these broadcasts to stay usable from groups where the bot account is not
 * itself a group admin.
 */
const canTag = (m, participants = []) => {
    if (!m) return false;
    if (isOwner(m)) return true;
    const list = Array.isArray(participants) ? participants : [];
    if (!list.length) return false;
    return isGroupAdmin({ participants: list }, m.sender);
};

/*
 * Wrappers that can hide the real content of a quoted message. lib/msg.js already
 * unwraps the view-once case for quoted replies; the rest are unwrapped here so a
 * caption inside an ephemeral or document node is still read.
 */
const QUOTED_WRAPPERS = ['viewOnceMessageV2Extension', 'viewOnceMessageV2', 'viewOnceMessage', 'ephemeralMessage', 'documentWithCaptionMessage'];

/*
 * extractQuotedText(quoted, m) -> { text, type }
 *
 * Returns the caption/text of the message that was replied to plus its resolved
 * message type. The text is trimmed, so an empty string means "no caption" -
 * which is how callAll detects a media-only reply and prints its placeholder.
 * Never throws: a malformed quoted node yields { text: '', type: '' }.
 *
 * `m` is accepted for signature compatibility with the calling helpers.
 */
const extractQuotedText = (quoted, m) => {
    try {
        if (!quoted) return { text: '', type: '' };

        /*
         * A reply to a view-once arrives with the real content under .msg (see the
         * VIEW-ONCE UNWRAP in lib/msg.js), not as a wrapper key.
         */
        let node = (quoted.viewOnce && quoted.msg) ? quoted.msg : quoted;

        /*
         * Then step through whatever wrapper is still on top: either an explicit
         * wrapper key, or the wrapper payload left under `.message`. The nested
         * `.message` step only runs while the node carries no caption of its own,
         * so a caption is never skipped over.
         */
        for (let depth = 0; depth < 4 && node && typeof node === 'object'; depth++) {
            const wrapper = QUOTED_WRAPPERS.find(name => node[name]?.message);
            if (wrapper) { node = node[wrapper].message; continue; }
            const hasOwnText = !!(node.text || node.caption || node.conversation || node.selectedDisplayText || node.title);
            if (!hasOwnText && node.message && typeof node.message === 'object') { node = node.message; continue; }
            break;
        }

        const text = String(
            node.text ||
            node.caption ||
            node.conversation ||
            node.extendedTextMessage?.text ||
            node.imageMessage?.caption ||
            node.videoMessage?.caption ||
            node.documentMessage?.caption ||
            node.buttonsResponseMessage?.selectedDisplayText ||
            node.listResponseMessage?.title ||
            ''
        ).trim();

        const type = String(node.mtype || quoted.mtype || Object.keys(quoted)[0] || '');
        return { text, type };
    } catch (error) {
        console.error('[CALLALL] could not read the quoted message:', error?.message || error);
        return { text: '', type: '' };
    }
};

/*
 * quotedTargetFor(m) -> a WAMessage-shaped object for `{ quoted: ... }`, or null.
 *
 * lib/msg.js hands callers the INNER content of the replied-to message
 * (m.quoted = contextInfo.quotedMessage[firstKey], plus mtype/id/chat/sender), but
 * the socket's generateWAMessageFromContent() reads `quoted.key.fromMe` and
 * `quoted.message`. Passing m.quoted straight into `{ quoted: ... }` therefore
 * throws "Cannot read properties of undefined (reading 'fromMe')" before anything
 * is sent, so the wrapper it was unwrapped from is rebuilt here. A reply to a
 * view-once is rebuilt from m.quoted.msg, which holds the unwrapped content.
 *
 * Returns null when the replied-to message cannot be rebuilt; callers then fall
 * back to quoting the command message itself so the broadcast still goes out.
 */
const quotedTargetFor = (m) => {
    try {
        const q = m?.quoted;
        if (!q || !q.mtype || !q.id) return null;
        const fromMe = q.fromMe === true;
        return {
            key: {
                remoteJid: q.chat || m.chat,
                fromMe,
                id: q.id,
                participant: fromMe ? undefined : (q.sender || undefined)
            },
            message: { [q.mtype]: q.viewOnce && q.msg ? q.msg : q }
        };
    } catch (error) {
        console.error('[CALLALL] could not rebuild the quoted target:', error?.message || error);
        return null;
    }
};

const tagAllMembers = async (conn, m, args = []) => {
    try {
        if (!m.isGroup) return replyTo(m, '❌ This command only works in groups.');

        const groupMeta = await conn.groupMetadata(m.chat);
        const participants = groupMeta.participants || [];

        if (!participants.length) return replyTo(m, '❌ No participants found.');
        if (!canTag(m, participants)) return replyTo(m, '❌ Only group admins can use tagall.');

        const customMsg = args.join(' ').trim();
        // Some forks list a member by jid/lid only, so fall back before filtering:
        // an undefined entry would otherwise ride into the mentions array.
        const mentions = participants.map(p => p.id || p.jid).filter(Boolean);

        const header =
`╔══════════════════════════╗
║   📢 *TAG ALL MEMBERS*   ║
╚══════════════════════════╝

${customMsg ? `📝 *Message:* ${customMsg}\n` : ''}👥 *Total:* ${participants.length}

`;

        const body = participants
            .map((p, i) => `│ ${String(i + 1).padStart(2, '0')}. @${getNumber(p.id)}`)
            .join('\n');

        const footer =
`
╚══════════════════════════╝
_${groupMeta.subject || 'Group'}_`;

        await conn.sendMessage(
            m.chat,
            { text: header + body + footer, mentions },
            { quoted: m }
        );
    } catch (err) {
        console.error('tagall error:', err);
        await replyTo(m, '❌ tagall failed: ' + err.message);
    }
};

/* ═══════════════════════════════════════════════
   callall — reply-based tagall
   ═══════════════════════════════════════════════ */
const callAll = async (conn, m) => {
    try {
        if (!m.isGroup) return replyTo(m, '❌ This command only works in groups.');
        if (!m.quoted) return replyTo(m, '📌 Reply to a message and use .callall');

        const groupMeta = await conn.groupMetadata(m.chat);
        const participants = groupMeta.participants || [];
        if (!participants.length) return replyTo(m, '❌ No participants found.');
        if (!canTag(m, participants)) return replyTo(m, '❌ Only admins/owners can use callall.');

        const mentions = participants.map(p => p.id || p.jid).filter(Boolean);

        const { text: quotedText } = extractQuotedText(m.quoted, m);
        const display = quotedText || '[media message]';

        const text =
`╔══════════════════════════╗
║    📢 *CALL ALL*         ║
╚══════════════════════════╝

💬 *Original message:*
> ${display}

👥 *Total: ${participants.length}*

${participants.map((p, i) => `│ ${String(i + 1).padStart(2, '0')}. @${getNumber(p.id)}`).join('\n')}

╚══════════════════════════╝
_${groupMeta.subject || 'Group'}_`;

        await conn.sendMessage(
            m.chat,
            { text, mentions },
            { quoted: quotedTargetFor(m) || m }
        );
    } catch (err) {
        console.error('callall error:', err);
        await replyTo(m, '❌ callall failed: ' + err.message);
    }
};

// System executeEval
const executeEval = async (code, conn, m) => {
    try {
        let result

        if (code.includes('\n') || code.includes(';')) {
            result = await eval(`
                (async (conn, m, require, fs, util) => {
                    ${code}
                })(conn, m, require, fs, util)
            `)
        } else {
            result = await eval(`
                (async (conn, m, require, fs, util) => {
                    return (${code})
                })(conn, m, require, fs, util)
            `)
        }

        if (typeof result !== 'string') {
            result = util.inspect(result, {
                depth: 1
            })
        }

        m.bigboreply(result || 'undefined')
    } catch (e) {
        m.bigboreply(String(e))
    }
}

//System Detect id all Button, id button gapake titik (.)
const extractCommandFromMessage = (m) => {
    if (m?.__darknoteSyntheticCommand) {
        return { body: String(m.__darknoteSyntheticCommand), isButtonResponse: false };
    }
    let body = '';
    let isButtonResponse = false;
    try {
        if (m.message) {
            if (m.message.conversation) body = m.message.conversation;
            else if (m.message.extendedTextMessage?.text) body = m.message.extendedTextMessage.text;
            else if (m.message.imageMessage?.caption) body = m.message.imageMessage.caption;
            else if (m.message.videoMessage?.caption) body = m.message.videoMessage.caption;
            else if (m.message.documentMessage?.caption) body = m.message.documentMessage.caption;
            else if (m.message.interactiveResponseMessage) {
                const inter = m.message.interactiveResponseMessage;
                if (inter.nativeFlowResponseMessage) {
                    const flow = inter.nativeFlowResponseMessage;
                    if (flow.paramsJson) {
                        try {
                            const params = JSON.parse(flow.paramsJson);
                            body = params.id || params.buttonId || params.rowId || params.index || '';
                        } catch { body = flow.name || ''; }
                    } else body = flow.name || '';
                    isButtonResponse = true;
                } else if (inter.buttonReply) {
                    body = inter.buttonReply.selectedButtonId || '';
                    isButtonResponse = true;
                } else if (inter.singleSelectReply) {
                    body = inter.singleSelectReply.selectedRowId || '';
                    isButtonResponse = true;
                }
            } else if (m.message.templateButtonReplyMessage) {
                body = m.message.templateButtonReplyMessage.selectedId || '';
                isButtonResponse = true;
            } else if (m.message.buttonsResponseMessage) {
                body = m.message.buttonsResponseMessage.selectedButtonId || '';
                isButtonResponse = true;
            }
        }
    } catch (error) {
        console.error('Error parsing message:', error);
    }
    return { body, isButtonResponse };
};






const isLikelyLinkMessage = (text = '') => {
    const value = String(text || '');
    return /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|wa\.me\/|t\.me\/|discord\.gg\/|\b[a-z0-9-]+\.(?:com|net|org|co\.[a-z]{2}|ke|io|me|xyz)\b)/i.test(value);
};

const getQuotedImageMessage = (m) => {
    let q = m?.quoted;
    if (!q) return null;

    // Normal quoted image from smsg().
    if (q.mtype === 'imageMessage') return q.msg || q.message?.imageMessage || q;

    // Also support quoted view-once/ephemeral wrappers.
    let current = q.msg || q.message || q;
    for (let i = 0; i < 4 && current; i++) {
        if (current.imageMessage) return current.imageMessage;
        if (current.viewOnceMessageV2?.message) { current = current.viewOnceMessageV2.message; continue; }
        if (current.viewOnceMessage?.message) { current = current.viewOnceMessage.message; continue; }
        if (current.ephemeralMessage?.message) { current = current.ephemeralMessage.message; continue; }
        if (current.documentWithCaptionMessage?.message) { current = current.documentWithCaptionMessage.message; continue; }
        break;
    }
    return null;
};

const resolveParticipantDisplayName = async (conn, participant, resolvedJid = '') => {
    const candidates = [
        participant?.notify,
        participant?.name,
        participant?.verifiedName,
        participant?.displayName
    ];
    for (const value of candidates) {
        const name = String(value || '').replace(/[\r\n]+/g, ' ').trim();
        if (name) return name.slice(0, 45);
    }

    const ids = [
        resolvedJid,
        participant?.id,
        participant?.jid,
        participant?.lid
    ].filter(Boolean);

    for (const id of ids) {
        const raw = String(id);
        const normalized = normalizeJidForCompare(raw);
        const contact = conn?.contacts?.[normalized] || conn?.contacts?.[raw];
        const chat = conn?.chats?.[normalized] || conn?.chats?.[raw];
        const name = String(
            contact?.notify || contact?.name || contact?.verifiedName ||
            chat?.name || chat?.notify || ''
        ).replace(/[\r\n]+/g, ' ').trim();
        if (name) return name.slice(0, 45);
    }

    // Last safe fallback: use a real WhatsApp number, never a JID/LID string.
    const number = getNumber(resolvedJid || participant?.id || participant?.jid || '');
    return number ? number : 'WhatsApp member';
};

const getParticipantDisplayName = (conn, participant) => {
    const candidates = [participant?.notify, participant?.name, participant?.verifiedName, participant?.displayName];
    for (const value of candidates) {
        const name = String(value || '').replace(/[\r\n]+/g, ' ').trim();
        if (name) return name.slice(0, 45);
    }

    const ids = [participant?.id, participant?.jid, participant?.lid].filter(Boolean);
    for (const id of ids) {
        const normalized = normalizeJidForCompare(id);
        const contact = conn?.contacts?.[normalized] || conn?.contacts?.[id];
        const name = String(contact?.notify || contact?.name || contact?.verifiedName || '').replace(/[\r\n]+/g, ' ').trim();
        if (name) return name.slice(0, 45);
    }

    return 'WhatsApp member';
};

const handleAutomaticViewOnce = async (conn, rawMessage) => {
    try {
        if (!config.vv2Auto || !rawMessage?.message || rawMessage.key?.fromMe) return;
        if (rawMessage.key?.remoteJid === 'status@broadcast') return;

        let current = rawMessage.message;
        // Support all view-once wrappers used by the current Baileys/fork builds.
        for (let i = 0; i < 5 && current; i++) {
            if (current.viewOnceMessageV2?.message) { current = current.viewOnceMessageV2.message; continue; }
            if (current.viewOnceMessage?.message) { current = current.viewOnceMessage.message; continue; }
            if (current.viewOnceMessageV2Extension?.message) { current = current.viewOnceMessageV2Extension.message; continue; }
            if (current.ephemeralMessage?.message) { current = current.ephemeralMessage.message; continue; }
            break;
        }

        const type = Object.keys(current || {}).find(k => /^(image|video|audio|document)Message$/.test(k));
        if (!type) return;
        const media = current[type];
        if (!media) return;

        // Some builds unwrap the view-once wrapper and leave the flag on the media node.
        const wasViewOnce = !!media.viewOnce || /viewOnceMessage/i.test(Object.keys(rawMessage.message || {}).join(' '));
        if (!wasViewOnce && !rawMessage.message.viewOnceMessageV2 && !rawMessage.message.viewOnceMessage && !rawMessage.message.viewOnceMessageV2Extension) return;

        const selfJid = jidNormalizedUser(conn.user?.id || '');
        if (!selfJid) return;

        // Download immediately while the one-time media is still available. This
        // buffer is retained in memory until the send completes, so a later delete
        // event cannot make an already-received view-once unavailable to VV2AUTO.
        const mediaType = type.replace('Message', '').toLowerCase();
        const stream = await downloadContentFromMessage(media, mediaType);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        if (!buffer.length) throw new Error('View-once media download returned no data');

        if (type === 'imageMessage') {
            await conn.sendMessage(selfJid, { image: buffer, caption: media.caption || undefined });
        } else if (type === 'videoMessage') {
            await conn.sendMessage(selfJid, { video: buffer, mimetype: media.mimetype || 'video/mp4', caption: media.caption || undefined });
        } else if (type === 'audioMessage') {
            await conn.sendMessage(selfJid, { audio: buffer, mimetype: media.mimetype || 'audio/mpeg', ptt: !!media.ptt });
        } else {
            await conn.sendMessage(selfJid, {
                document: buffer,
                mimetype: media.mimetype || 'application/octet-stream',
                fileName: media.fileName || 'DARKNOTE-file'
            });
        }
    } catch (error) {
        console.error('[VV2 AUTO] Error:', error?.stack || error);
    }
};

const normalizeBlockNumber = (value = '') => {
    let number = String(value || '').trim().replace(/\D/g, '');
    if (number.startsWith('00')) number = number.slice(2);
    // Preserve the project's existing international-number convention while also
    // accepting a normal Kenyan local mobile format such as 07XXXXXXXX.
    if (/^0\d{9}$/.test(number)) number = `254${number.slice(1)}`;
    return number;
};

const sanitizeBlockError = (error, targetNumber) => {
    let message = String(error?.message || error || 'Unknown WhatsApp error');
    if (targetNumber) message = message.replace(new RegExp(`${targetNumber}@(?:s\\.whatsapp\\.net|lid|g\\.us)`, 'gi'), targetNumber);
    message = message.replace(/\b\d{8,15}@(s\.whatsapp\.net|lid|g\.us)\b/gi, (match) => match.split('@')[0]);
    return message.slice(0, 220);
};

const resolveBlockTarget = async (conn, m, args) => {
    const contextInfo = m.message?.extendedTextMessage?.contextInfo || m.msg?.contextInfo || {};
    let target = contextInfo.mentionedJid?.[0] || m.mentionedJid?.[0] || m.quoted?.sender;

    if (!target) {
        const number = normalizeBlockNumber(args.join(' '));
        if (/^\d{8,15}$/.test(number)) target = `${number}@s.whatsapp.net`;
    }
    if (!target) return null;

    target = conn.decodeJid(target);
    if (target?.endsWith('@lid') && typeof conn.resolveLidEnhanced === 'function') {
        target = await conn.resolveLidEnhanced(target);
    }
    target = conn.decodeJid(target);

    if (!target || !/@s\.whatsapp\.net$/i.test(target)) {
        throw new Error('Unable to resolve the target WhatsApp account');
    }
    return target;
};

// Owner-selectable delivery for member lists. "auto" tries the native
// horizontal carousel first and falls back to paginated text with real
// mentions; "text" forces the guaranteed-mention text pages; "carousel"
// only uses the carousel.
// config.json re-read from disk. The module-level `config` object is a load-time
// snapshot, so anything that must react to an edit (a security guard especially)
// has to read the file itself.
const liveConfig = () => {
    const configPath = path.join(__dirname, 'config.json');
    try {
        delete require.cache[require.resolve(configPath)];
        return require(configPath) || {};
    } catch (error) {
        console.error('[CONFIG] live read failed, using the loaded config:', error?.message || error);
        return config || {};
    }
};

const cardsMode = () => {
    const mode = String(liveConfig()?.cards?.mode || 'auto').toLowerCase();
    return ['auto', 'text', 'carousel'].includes(mode) ? mode : 'auto';
};

// Numbers that must never be blocked. Configured in
// config.json -> "protectedBlockJids" (string or array); the bot's own number
// and config.ownerNumber are always included. Nothing is hard-coded here.
const protectedBlockNumbers = (conn) => {
    const live = liveConfig();
    const configured = Array.isArray(live?.protectedBlockJids)
        ? live.protectedBlockJids
        : [live?.protectedBlockJids];
    const numbers = configured
        .map(value => getNumber(String(value || '')))
        .filter(value => /^\d{8,15}$/.test(value));
    for (const extra of [getNumber(live?.ownerNumber || config?.ownerNumber || ''), getNumber(conn?.user?.id || '')]) {
        if (/^\d{8,15}$/.test(extra)) numbers.push(extra);
    }
    return [...new Set(numbers)];
};

/* -------------------------- WhatsApp !pair -------------------------- */
async function sendPairProgress(conn, m, phone) {
    if (typeof conn?.sendMessage !== 'function') throw new Error('WhatsApp message transport is unavailable')
    // Pairing UX (no "waiting" filler): the request itself is the status.
    const sent = await conn.sendMessage(m.chat, {
        text: [
            '🔗 *PAIRING REQUEST*',
            '',
            'Number:',
            `+${phone}`,
            '',
            'Creating your dedicated session...'
        ].join('\n')
    }, { quoted: m })
    const edit = async text => {
        if (!sent?.key) return
        try { await conn.sendMessage(m.chat, { text, edit: sent.key }) } catch (error) {
            console.error('[PAIR] progress edit failed:', error?.message || error)
        }
    }
    await edit(`🔗 *PAIRING REQUEST*\n\nNumber:\n+${phone}\n\nChecking that the number is on WhatsApp...`)

    /*
     * IS IT REALLY ON WHATSAPP?
     *
     * The card cannot ask this about itself (no network in the sandbox), so the
     * check happens here instead. A mistyped or landline number would otherwise
     * receive a code that can never be entered anywhere.
     */
    const registered = await numberIsOnWhatsApp(conn, phone)
    if (registered === false) {
        const reason = `+${phone} is not registered on WhatsApp.`
        await edit(`❌ ${reason}`)
        await sendPairErrorCard(conn, m, phone, reason)
        return null
    }

    await edit(`🔗 *PAIRING REQUEST*\n\nNumber:\n+${phone}\n\nGenerating the pairing code...`)
    const pair = global.darknoteWhatsAppPair
    if (typeof pair !== 'function') {
        await edit('❌ The DARKNOTE pairing engine is not ready. Please try again.')
        return null
    }
    // The third argument pins the code to config.pairingCode instead of letting
    // index.js pick one at random, so the code the card advertises ("DARKNOTE")
    // is the code WhatsApp actually issues.
    const result = await pair(phone, `whatsapp:${getNumber(m.sender)}`, pairCodeLabel())
    if (!result?.ok) {
        const message = result?.reason === 'already-paired'
            ? `ℹ️ +${phone} is already linked to DARKNOTE (${result.sessionId || 'main'}).`
            : result?.reason === 'limit'
                ? '❌ DARKNOTE has reached the maximum of 25 paired devices.'
                : `❌ Pairing failed${result?.detail ? `: ${String(result.detail).slice(0, 180)}` : '.'}`
        await edit(message)
        // Same refusal, as the red card, so the failure is visible where the
        // owner was already looking.
        try { await sendPairErrorCard(conn, m, phone, message.replace(/^[^\w+]*/, '')) } catch (error) {
            console.error('[PAIR] error card failed:', error?.message || error)
        }
        return null
    }

    /*
     * REMEMBER WHO ASKED.
     * The device is not linked yet - the code has only been issued - so watch
     * this number. When the session goes live, index.js calls
     * global.darknotePairLinked() and the green card is sent to this chat.
     */
    watchPairLink(phone, m, result.sessionId)

    const code = String(result.code || '').trim()
    const finalText = [
        '╭────────────────────────╮',
        '│ 🔐 *DARKNOTE PAIRING*',
        '│',
        `│ 📱 Number: +${phone}`,
        `│ 🔑 Code: *${code}*`,
        '│',
        '│ Open WhatsApp → Linked Devices',
        '│ → Link a device → Link with phone number.',
        '╰────────────────────────╯',
        '',
        'Tap the button below to copy the code, then enter it on the phone.'
    ].join('\n')
    await edit(finalText)

    /*
     * The pairing code in the HTML card, then the native copy button next to it.
     * The plain-text edit above stays: it is the fallback for a client that will
     * not render the card, and it carries the same code.
     */
    try {
        await sendPairCodeCard(conn, m, phone, code)
    } catch (error) {
        console.error('[PAIR] HTML code card failed:', error?.stack || error)
    }

    // Native WhatsApp CTA_COPY copies the exact pairing code into the user's
    // device clipboard. It is a copy action, not a bot command or a link.
    try {
        const content = {
            viewOnceMessage: {
                message: {
                    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                    interactiveMessage: imNode(null, {
                        body: imNode('Body', { text: finalText }),
                        footer: imNode('Footer', { text: 'DARKNOTE L2 • Pairing' }),
                        nativeFlowMessage: imNode('NativeFlowMessage', {
                            // Global button system: the pairing code button is built
                            // by the same helper as every other button, so its layout
                            // and shape can never drift from the standard.
                            buttons: buttonsystem.createButtons([
                                { copy: code, id: `darknote_pair_${code}`, text: '📋 COPY CODE' }
                            ]).nativeFlow,
                            messageParamsJson: ''
                        })
                    })
                }
            }
        }
        const built = generateWAMessageFromContent(m.chat, content, { userJid: conn.user?.id, ...quoteGuard.quoteOption(m) })
        // The interactive nodes are REQUIRED here too.
        await conn.relayMessage(m.chat, built.message, { messageId: built.key.id, ...buttonsystem.interactiveNodes() })
    } catch (error) {
        console.error('[PAIR] copy-code button failed:', error?.stack || error)
        await conn.sendMessage(m.chat, { text: `${finalText}\n\n📋 Copy the code manually: ${code}` }, { quoted: m })
    }
    return result
}

/* ---------------------- WhatsApp .pair — THE HTML CARD ---------------------- */

/*
 * PENDING CONTROL STATE.
 *
 * The HTML card runs in an offline sandbox and cannot post anything back, so the
 * number and the passcode the owner enters INSIDE the card are echoed back with a
 * WhatsApp button or with their next message. This map remembers which question
 * is open for which sender, and expires so a forgotten prompt can never hijack a
 * later message.
 */
const PAIR_PENDING_TTL_MS = 5 * 60 * 1000
const pairPending = new Map()
const pairPendingKey = (m) => getNumber(m.sender)
function setPairPending(m, state) { pairPending.set(pairPendingKey(m), { ...state, at: Date.now() }) }
function getPairPending(m) {
    const key = pairPendingKey(m)
    const held = pairPending.get(key)
    if (!held) return null
    if (Date.now() - held.at > PAIR_PENDING_TTL_MS) { pairPending.delete(key); return null }
    return held
}
function clearPairPending(m) { pairPending.delete(pairPendingKey(m)) }

/*
 * The passcode that unlocks the card and confirms an unpair.
 *
 * The card's own keypad is a UI gate only - its markup is readable by whoever
 * opens the card - so every destructive action is re-checked HERE, in the bot.
 * `config.json -> pairPasscode` overrides it (six digits); the default is the
 * 112410 the owner set. The card and this check both read this ONE function, so
 * the passcode shown on the keypad can never drift from the one accepted.
 */
function pairPasscode() {
    const configured = String(config.pairPasscode || '').replace(/\D/g, '')
    return configured.length === 6 ? configured : pairCard.PASSCODE
}

// The code the card advertises and the pairing flow now requests: the fixed
// configured code, so the card never shows one code while WhatsApp issues another.
const pairCodeLabel = () => String(config.pairingCode || 'DARKNOTE')

/*
 * Interactive buttons built with the same button system, imNode helper and relay
 * nodes as every other card in this file. A tap comes back as an ordinary
 * message whose body is the button id.
 */
async function sendPairButtons(conn, m, text, buttons) {
    const content = {
        viewOnceMessage: {
            message: {
                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                interactiveMessage: imNode(null, {
                    body: imNode('Body', { text: String(text).slice(0, 4000) }),
                    footer: imNode('Footer', { text: 'DARKNOTE L2 • Pairing' }),
                    nativeFlowMessage: imNode('NativeFlowMessage', {
                        buttons: buttonsystem.createButtons(buttons).nativeFlow,
                        messageParamsJson: ''
                    })
                })
            }
        }
    }
    /*
     * Quote the message this answers, but never one WhatsApp cannot preview: a
     * button tap or an HTML card quoted back at the user renders as
     * "You received a message but your version of WhatsApp doesn't support it".
     * See lib/quote-guard.js.
     */
    const built = generateWAMessageFromContent(m.chat, content, { userJid: conn.user?.id, ...quoteGuard.quoteOption(m) })
    await conn.relayMessage(m.chat, built.message, { messageId: built.key.id, ...buttonsystem.interactiveNodes() })
}

/*
 * The written blurb that used to travel with the card.
 *
 * It is OFF by default now: the operator asked for the card to be the only thing
 * sent, so `pairNote()` returns a single space (a WhatsApp button message still
 * needs a body node) unless config.pairCardNote is set to true. The text is kept
 * here rather than deleted so the old behaviour is one config flag away.
 */
const PAIR_CARD_NOTE = [
    '🔐 *DARKNOTE PAIRING SECTOR*',
    '',
    'The card above is the pairing app: it boots, cracks open, then asks for the',
    'passcode. Inside it, type the number you want to link; the button under the',
    'field unlocks only when the number is complete. Press it and the doors close,',
    'the loader runs for 5s, and the code panel opens.',
    '',
    'A card cannot send anything back to DARKNOTE, so the buttons below are the',
    'real WhatsApp buttons — they are what talks to the bot. Send the number there',
    '(or just type it in the chat); WhatsApp issues the pairing code through',
    'Baileys and DARKNOTE sends the card back with that exact code on it. When the',
    'phone enters it, the card comes back GREEN.'
].join('\n')

const pairCardButtons = () => ([
    { id: 'pair_start', text: '📲 PAIR A NUMBER' },
    { id: 'pair_users', text: '📱 CONNECTED DEVICES' }
])

/*
 * HOW THE CARD IS DELIVERED (config.json -> pairCardMode)
 * 'rich' (default) | 'document' | 'both' — see lib/pair-card.js for what each one
 * means. 'rich' is the default because the operator asked for the html to be the
 * only thing sent: it displays inline, and no .html file is attached.
 */
const pairCardMode = () => String(config.pairCardMode || 'rich').toLowerCase()

/*
 * Whether the gate prints the passcode above the keypad (config.pairShowPasscode).
 * Defaults to TRUE — the owner asked to see it on the card, and the card is only
 * ever sent to the owner's own chat. Set it to false to go back to a card whose
 * source does not contain the digits; the keypad works the same either way.
 */
const pairShowPasscode = () => config.pairShowPasscode !== false


/*
 * The pairing code the card shows before WhatsApp is asked for one
 * (config.pairingCode). The operator asked to see the code ON the card; when
 * Baileys' requestPairingCode returns a real string that one is used instead.
 */
const defaultPairCode = () => String(config.pairingCode || '').trim()

/*
 * THE HANDSEAT THE CARDS ARE DRAWN AS
 * ----------------------------------
 * The operator asked for "a samsung and iphone display", so every card is now
 * wrapped in real handset chrome (lib/phone-frame.js):
 *
 *   'ios'    one iPhone screen — dynamic island, 54px corners
 *   'oneui'  one Galaxy screen  — punch-hole camera, 46px corners
 *   'both'   both screens, sent as two messages
 *
 * `.runtime` shows 'both' by default, because seeing the same moment on both
 * displays is the point. `.pair` is a single card per stage, so it defaults to
 * the iPhone; set pairCardSkin to 'oneui' or 'both' to change that.
 */
const runtimeSkin = () => String(config.runtimeSkin || 'both').toLowerCase()
const pairCardSkins = () => {
    const wanted = String(config.pairCardSkin || 'ios').toLowerCase()
    if (wanted === 'both') return ['ios', 'oneui']
    return phoneFrame.SKINS[wanted] ? [wanted] : ['ios']
}

/*
 * HOW THE CARDS ARE DELIVERED (config.json -> pairCardMode / runtimeCardMode)
 * 'rich' (default) | 'document' | 'both'.
 *
 * The operator asked for the html to DISPLAY, with no file attached, so 'rich'
 * is the default now: the card renders inline in the chat. `sendHtmlCard` still
 * falls back to a document when the rich send throws, so a client that cannot
 * draw a bot-forwarded message still gets a card rather than nothing.
 */
const runtimeCardMode = () => String(config.runtimeCardMode || 'rich').toLowerCase()

/*
 * The written note that used to accompany the card. The operator asked for it to
 * be removed so only the html remains, so it is empty by default and comes back
 * with config.pairCardNote: true. A single space is used rather than '' because a
 * WhatsApp button message needs a body node.
 */
const pairNote = () => (config.pairCardNote === true ? PAIR_CARD_NOTE : ' ')

/* The status-bar clock on the handset shell, in the paired number's own time. */
const statusClock = (conn) => runtimeCard.statusClock(ownerSystem.pairedNumber(conn) || config.ownerNumber || '')

/* The animated app card, plus the buttons that carry the real actions. */
async function sendPairApp(conn, m, { skipGate = false, note = pairNote(), buttons = pairCardButtons(), quiet = false, stage = 'app', phone = '', error = '', code = '', codeIssued = false } = {}) {
    const sessions = pairCard.listSessions()
    const rows = pairCard.usersHtml(sessions)
    const linked = pairCard.linkedNumbers(sessions)
    /*
     * One card per handset skin. The design is identical for both, so the loop is
     * purely "which shell to draw it in" — the buttons under the cards are sent
     * once, after all of them.
     */
    const skins = pairCardSkins()
    const clock = statusClock(conn)
    for (const skin of skins) {
        const html = pairCard.pairingAppHtml({
            avatar: await pairCard.avatarDataUri(),
            /*
             * THE CODE IS ON THE CARD.
             *
             * config.pairingCode is the default, so the owner can read it the moment
             * the card opens. When Baileys' requestPairingCode comes back with a
             * string, that real one is passed in and replaces it — and `codeIssued`
             * records which of the two it is, so the card never implies WhatsApp has
             * already issued a code it has not.
             */
            code: String(code || '').trim() || defaultPairCode(),
            codeIssued: String(code || '').trim() ? codeIssued : false,
            phone,
            usersHtml: rows,
            // The numbers already linked, so the card can refuse a duplicate before
            // the owner wastes a pairing attempt on one.
            linked,
            skipGate,
            stage,
            error,
            passcode: pairPasscode(),
            // config.pairShowPasscode prints the passcode above the keypad, so the
            // owner does not have to remember it. Default on: the card only ever goes
            // to the owner's own chat.
            showPasscode: pairShowPasscode(),
            // The handset shell, and the owner's own clock in its status bar.
            skin,
            statusTime: clock
        })
        await pairCard.sendHtmlCard(conn, m.chat, html, { ...quoteGuard.quoteOption(m), mode: pairCardMode(), stage })
    }
    if (!quiet && buttons.length) await sendPairButtons(conn, m, note, buttons)
}

/*
 * The code card, sent once WhatsApp has actually issued the code. It reuses the
 * animated panel (no gate) so the code lands in the "developing html" screen the
 * owner asked for, and the native COPY CODE button sits right under it.
 */
async function sendPairCodeCard(conn, m, phone, code) {
    const sessions = pairCard.listSessions()
    const html = pairCard.pairingAppHtml({
        avatar: await pairCard.avatarDataUri(),
        // THE REAL CODE: this is the string requestPairingCode() returned from
        // WhatsApp's servers, passed straight through to the card and its copy
        // button. Nothing else is ever displayed there.
        code,
        phone,
        usersHtml: pairCard.usersHtml(sessions),
        linked: pairCard.linkedNumbers(sessions),
        skipGate: true,
        // 'code' runs the doors -> 5s loading -> code reveal on its own, because
        // the code already exists by the time this card is built.
        stage: 'code',
        passcode: pairPasscode(),
        showPasscode: pairShowPasscode(),
        skin: pairCardSkins()[0],
        statusTime: statusClock(conn)
    })
    await pairCard.sendHtmlCard(conn, m.chat, html, { ...quoteGuard.quoteOption(m), mode: pairCardMode(), stage: 'code' })
    await sendPairButtons(conn, m, [
        '╭────────────────────────╮',
        '│ 🔐 *DARKNOTE PAIRING*',
        '│',
        `│ 📱 Number: +${phone}`,
        `│ 🔑 Code: *${code}*`,
        '│',
        '│ Open WhatsApp → Linked Devices',
        '│ → Link a device → Link with phone number.',
        '╰────────────────────────╯'
    ].join('\n'), [
        { copy: String(code), id: `darknote_pair_${code}`, text: '📋 COPY CODE' },
        { id: 'pair_users', text: '📱 CONNECTED DEVICES' }
    ])
}

/* The device list: the card shows the rows, one button per device unpairs it. */
async function sendPairUsers(conn, m) {
    const sessions = pairCard.listSessions()
    await sendPairApp(conn, m, {
        skipGate: true,
        quiet: true
    })

    if (!sessions.length) {
        return m.bigboreply('ℹ️ No devices are linked yet, so there is nothing to unpair.')
    }

    const shown = sessions.slice(0, 8)
    const buttons = shown.map(record => ({
        id: `unpair ${String(record.id)}`,
        text: `🗑 ${String(record.phone || record.id).replace(/^\+?/, '+').slice(0, 20)}`
    }))
    const extra = sessions.length - shown.length

    await sendPairButtons(conn, m, [
        '📱 *CONNECTED DEVICES*',
        '',
        ...shown.map((record, i) => `${i + 1}. +${String(record.phone || 'unknown').replace(/^\+/, '')} · ${String(record.state || '?').toUpperCase()} · ${record.id}`),
        extra > 0 ? `\n(+${extra} more than the buttons can carry.)` : '',
        '',
        'Tap a device below to unpair it. You will be asked for the passcode first.'
    ].filter(Boolean).join('\n'), buttons)
}

/* --------------- the red → green card for a COMPLETED link --------------- */

/*
 * PENDING LINK WATCH.
 *
 * The card cannot observe its own pairing - the sandbox has no way to poll the
 * bot - so the red→green change is driven from here. When a pairing is started
 * for a number we remember WHO asked (the message object, which carries both the
 * chat to answer and the connection the request arrived on), and index.js calls
 * global.darknotePairLinked() the moment that session actually goes live.
 *
 * Bounded and self-expiring: a handful of entries, dropped after 20 minutes, on
 * first use, or as soon as a newer request for the same number replaces them.
 */
const PAIR_WATCH_TTL_MS = 20 * 60 * 1000
const pairWatch = new Map()

function watchPairLink(phone, m, sessionId) {
    const digits = String(phone || '').replace(/\D/g, '')
    if (!digits || !m) return
    const cutoff = Date.now() - PAIR_WATCH_TTL_MS
    for (const [key, value] of pairWatch) if (value.at < cutoff) pairWatch.delete(key)
    pairWatch.set(digits, { m, sessionId: String(sessionId || ''), at: Date.now() })
}

/** The same panel turned GREEN, sent the moment the device really links. */
async function sendPairSuccessCard(conn, m, phone) {
    await sendPairApp(conn, m, {
        skipGate: true,
        stage: 'success',
        phone: String(phone || '').replace(/^\+/, ''),
        quiet: true
    })
    await sendPairButtons(conn, m, [
        '╭────────────────────────╮',
        '│ ✅ *DEVICE LINKED*',
        '│',
        `│ 📱 +${String(phone || '').replace(/^\+/, '')}`,
        '│',
        '│ The code was accepted and this device is now',
        '│ running DARKNOTE.',
        '╰────────────────────────╯',
        '',
        'The card above is green because the link completed — it also lists every',
        'device currently connected to this bot.'
    ].join('\n'), [
        { id: 'pair_users', text: '📱 CONNECTED DEVICES' },
        { id: 'pair_start', text: '➕ PAIR ANOTHER' }
    ])
}

/** A refusal (not on WhatsApp, already linked, request failed) as a red card. */
async function sendPairErrorCard(conn, m, phone, reason) {
    await sendPairApp(conn, m, {
        skipGate: true,
        stage: 'error',
        phone: String(phone || '').replace(/^\+/, ''),
        error: String(reason || 'The pairing request could not be completed.'),
        quiet: true
    })
    await sendPairButtons(conn, m, [
        '❌ *PAIRING NOT COMPLETED*',
        '',
        String(reason || '').slice(0, 400),
        '',
        'Tap below to try a number again.'
    ].join('\n'), [{ id: 'pair_start', text: '📲 PAIR A NUMBER' }])
}

/*
 * Is this number actually on WhatsApp?
 *
 * Returns true / false / null, where null means "could not tell" (no helper on
 * this fork, an error, or a slow query). Only a definite `false` may block a
 * pairing - guessing in either direction would either refuse a good number or
 * hand out a code that can never be used.
 */
async function numberIsOnWhatsApp(conn, phone, timeoutMs = 8000) {
    if (typeof conn?.onWhatsApp !== 'function') return null
    try {
        const result = await Promise.race([
            conn.onWhatsApp(`+${String(phone).replace(/\D/g, '')}`),
            new Promise(resolve => setTimeout(() => resolve('timeout'), timeoutMs))
        ])
        if (result === 'timeout') return null
        const list = Array.isArray(result) ? result : (result ? [result] : [])
        if (!list.length) return null
        return list.some(item => item?.exists === true)
    } catch (error) {
        console.error('[PAIR] WhatsApp registration check failed:', error?.message || error)
        return null
    }
}

/*
 * Called by index.js when a watched session goes live. Kept at module scope and
 * published as a global for the same reason the pairing entry points are: the
 * session layer must not have to require this dispatcher.
 */
global.darknotePairLinked = async (info) => {
    try {
        const digits = String(info?.phone || '').replace(/\D/g, '')
        const sessionId = String(info?.sessionId || '')
        let key = digits && pairWatch.has(digits) ? digits : ''
        if (!key && sessionId) {
            for (const [candidate, value] of pairWatch) {
                if (value.sessionId && value.sessionId === sessionId) { key = candidate; break }
            }
        }
        if (!key) return
        const entry = pairWatch.get(key)
        pairWatch.delete(key)
        const conn = entry?.m?.__darknoteConn
        if (!conn || typeof conn.relayMessage !== 'function') return
        await sendPairSuccessCard(conn, entry.m, digits || key)
        console.log(`[PAIR] green success card sent for +${digits || key}`)
    } catch (error) {
        console.error('[PAIR] success card failed:', error?.message || error)
    }
}

module.exports = async (conn, m) => {
    // The owner layer needs the live connection to know which number this bot is
    // paired to: that number is always an owner, and it keys the per-session
    // owner store. Without this line owner-system falls back to "unpaired".
    m.__darknoteConn = conn;

    /*
     * LOCAL REPLY ALIAS - repairs ~300 dead command paths.
     *
     * 303 call sites inside this dispatcher use the bare identifier
     * `bigboreply`, which was never defined anywhere. Every one of them threw
     * "ReferenceError: bigboreply is not defined" and was swallowed by the
     * per-command try/catch, so the console only ever showed
     * "ERROR Error in command handler: {}" and the user saw nothing at all.
     *
     * Defining the alias here repairs all of them at once, in the one scope
     * that has both `m` and `conn`, without rewriting 303 call sites. The real
     * method is lib/msg.js:466; the fallback keeps it safe if a message object
     * is ever built without that method.
     */
    const bigboreply = (text, chatId, options) => {
        if (typeof m.bigboreply === 'function') return m.bigboreply(text, chatId, options);
        return conn.reply(chatId || m.chat, text, m, options);
    };

    try {
        /*
         * ANTI-FEATURE HOOK. Runs before the body check on purpose: a sticker or
         * a bare image has NO text, so checking after `if (!body) return` would
         * mean antisticker and antimedia could never see the very messages they
         * exist to police. This is the ONE message-side entry into the security
         * engine - there is no second messages.upsert listener anywhere.
         */
        if (m.isGroup && !m.key?.fromMe) {
            try {
                const securityResults = await security.handleMessage(conn, m, {
                    selfIds: [conn.user?.id, conn.user?.lid].filter(Boolean),
                    isOwner: jid => ownerSystem.isOwner({ sender: jid, chat: m.chat }, config),
                    deleteMessage: async () => {
                        if (typeof conn.sendMessage !== 'function') return
                        await conn.sendMessage(m.chat, { delete: m.key })
                    }
                })
                // If an anti-feature handled the message, never continue into
                // the command dispatcher. Otherwise a forbidden sticker/media
                // could still execute a command after being deleted.
                if (Array.isArray(securityResults) && securityResults.length) return
            } catch (error) {
                console.error('[SECURITY] message handling failed:', error?.message || error);
            }
        }

        /*
         * TERMINAL VISIBILITY.
         * Log every incoming message the dispatcher sees, so the console shows
         * the whole conversation and not just the bot's own side of it. Without
         * this, a command that quietly failed to match left no trace at all.
         */
        {
            const rawText = String(m.text || m.body || m.caption || m.msg?.text || m.msg?.caption || '')
                .replace(/\s+/g, ' ').trim();
            const where = m.isGroup
                ? `group:${String(m.chat).split('@')[0]}`
                : `dm:${String(m.sender).split('@')[0]}`;
            console.log(`[MSG] ${where} ${m.mtype || 'unknown'}${m.quoted ? ' reply' : ''}${rawText ? ' :: ' + rawText.slice(0, 200) : ''}`);
        }

        const { body, isButtonResponse } = extractCommandFromMessage(m);
        if (!body) return;
        if (body) m.text = body;

        // Dedicated pairing control. It intentionally uses !pair so it does not
        // change the configured DARKNOTE prefix or any existing command.
        if (!isButtonResponse) {
            /*
             * Accept the bot's own prefix as well as the standalone `!pair` form.
             *
             * Only the literal "!pair" used to match, so `.pair <number>` - the
             * natural spelling with the configured prefix - fell through to the
             * dispatcher, matched no command, and produced nothing at all. That is
             * why the pairing code was never displayed.
             */
            const prefixChar = String(config.prefix || '.').trim() || '.';
            const escapedPrefix = prefixChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pairPattern = new RegExp(`^(?:${escapedPrefix}|!)pair(?:\\s+([+\\d\\s-]+))?$`, 'i');
            const pairMatch = String(body).trim().match(pairPattern);
            if (pairMatch) {
                if (!isOwner(m)) return m.bigboreply('❌ Owner only.');
                const phone = String(pairMatch[1] || '').replace(/\D/g, '');

                /*
                 * `.pair` ON ITS OWN opens the HTML pairing app.
                 *
                 * It used to answer with a usage line, which meant the card could
                 * never be seen: the only way in was to already know the number.
                 */
                if (!phone) {
                    try {
                        clearPairPending(m);
                        await setReaction(conn, m, '⏳');
                        await sendPairApp(conn, m);
                        await setReaction(conn, m, '✅');
                    } catch (error) {
                        console.error('[PAIR] app card failed:', error?.stack || error);
                        await setReaction(conn, m, '❌');
                        // Never leave the owner with no way to pair.
                        await m.bigboreply([
                            '❌ The pairing card could not be delivered.',
                            '',
                            `Use the text flow instead: ${config.prefix || '.'}pair <international number>`,
                            `Example: ${config.prefix || '.'}pair 2547XXXXXXXX`
                        ].join('\n'));
                    }
                    return;
                }

                if (!/^\d{8,15}$/.test(phone)) {
                    return m.bigboreply(`📱 Usage: ${config.prefix || '.'}pair <international number>\nExample: ${config.prefix || '.'}pair 2547XXXXXXXX\n\n(!pair works too.)`);
                }
                try {
                    // ⏳ while the session is created and the code requested,
                    // then ✅ / ❌ once the request has been answered.
                    await setReaction(conn, m, '⏳');
                    await sendPairProgress(conn, m, phone);
                    await setReaction(conn, m, '✅');
                } catch (error) {
                    console.error('[PAIR] !pair failed:', error?.stack || error);
                    await setReaction(conn, m, '❌');
                    await m.bigboreply(`❌ Pairing failed: ${String(error?.message || error).slice(0, 180)}`);
                }
                return;
            }

        }

        /*
         * PAIRING CARD CONTROLS.
         *
         * The card's buttons and the answers to its prompts arrive as ordinary
         * messages: a button id as the body, or the digits the owner typed
         * after tapping one. They are handled here, before the dispatcher, for
         * the same reason `!pair` is - a bare passcode or phone number is not a
         * command and would otherwise be dropped (or answered by the AI).
         *
         * Handled only while the matching prompt is open, or for the two known
         * button ids, so nothing here can steal an unrelated message.
         */
        const pairControl = String(body).trim();
        const pairHeld = getPairPending(m);
        const isPairControl = /^pair_(?:start|users)$/i.test(pairControl)
            || /^unpair\s+\S+/i.test(pairControl)
            || (pairHeld?.state === 'awaiting-passcode' && /^\d{6}$/.test(pairControl))
            || (pairHeld?.state === 'awaiting-number' && /^\d{8,15}$/.test(pairControl.replace(/\D/g, '')));
        if (isPairControl) {
            if (!isOwner(m)) return m.bigboreply('❌ Owner only.');

            if (/^pair_start$/i.test(pairControl)) {
                setPairPending(m, { state: 'awaiting-number' });
                await sendPairButtons(conn, m, [
                    '📲 *PAIR A NUMBER*',
                    '',
                    'Send the number you typed in the card — on its own, or as a command:',
                    '',
                    `${config.prefix || '.'}pair 2547XXXXXXXX`,
                    '',
                    'This prompt stays open for 5 minutes.'
                ].join('\n'), [{ id: 'pair_users', text: '📱 CONNECTED DEVICES' }]);
                return;
            }

            if (/^pair_users$/i.test(pairControl)) {
                clearPairPending(m);
                try {
                    await sendPairUsers(conn, m);
                } catch (error) {
                    console.error('[PAIR] device list failed:', error?.stack || error);
                    await m.bigboreply('❌ Could not build the device list.');
                }
                return;
            }

            const unpairTarget = pairControl.match(/^unpair\s+(\S+)/i)?.[1];
            if (unpairTarget) {
                const record = pairCard.listSessions().find(item => String(item?.id) === unpairTarget);

                /*
                 * NEVER UNPAIR THE SESSION THIS COMMAND ARRIVED ON, and never
                 * the primary one. Removing `main` deletes auth/creds.json -
                 * the bot's own link - so the bot would log itself out and go
                 * silent with no way back except the console.
                 */
                const here = String(conn?.__darknoteSessionId || 'main');
                if (unpairTarget === 'main' || unpairTarget === here) {
                    clearPairPending(m);
                    return m.bigboreply([
                        `❌ ${unpairTarget} is the session DARKNOTE is running on — unpairing it would`,
                        'log the bot itself out.',
                        '',
                        'Unpair that one from the console if you really mean to.'
                    ].join('\n'));
                }
                if (!record) {
                    clearPairPending(m);
                    await m.bigboreply(`ℹ️ ${unpairTarget} is no longer linked.`);
                    return sendPairUsers(conn, m);
                }

                setPairPending(m, { state: 'awaiting-passcode', target: unpairTarget });
                await sendPairButtons(conn, m, [
                    '🗑 *UNPAIR DEVICE*',
                    '',
                    `Number: +${String(record.phone || 'unknown').replace(/^\+/, '')}`,
                    `Session: ${unpairTarget}`,
                    '',
                    'Send the passcode to confirm. It is the same one the card asked for.'
                ].join('\n'), []);
                return;
            }

            if (pairHeld?.state === 'awaiting-passcode' && /^\d{6}$/.test(pairControl)) {
                const target = pairHeld.target;
                if (pairControl !== pairPasscode()) {
                    clearPairPending(m);
                    await setReaction(conn, m, '❌');
                    return m.bigboreply('❌ Wrong passcode. Nothing was unpaired.');
                }
                clearPairPending(m);
                const removal = await pairCard.unpairSession(target);
                const failed = removal && removal.ok === false;
                await setReaction(conn, m, failed ? '❌' : '✅');
                await m.bigboreply(failed
                    ? `❌ Could not unpair ${target}${removal?.detail || removal?.error ? `: ${String(removal.detail || removal.error).slice(0, 160)}` : '.'}`
                    : `✅ Unpaired ${target}. That device no longer runs DARKNOTE.`);
                if (!failed) await sendPairUsers(conn, m);
                return;
            }

            /*
             * MENU 2 SIGN-UP. Owner-only and only inside the window the card opened,
             * so a bare number sent for any other reason is left alone.
             */
            /*
             * FINGERPRINT ON/OFF. The card cannot flip its own switch - it runs
             * offline - so the Security app tells the operator to send this, and the
             * next card is rendered with the new state. Available whenever they are
             * signed up, not only inside the sign-up window.
             */
            if (isOwner(m) && menu2.signupFor(conn)) {
                const toggle = /^fingerprint\s*(on|enable|off|disable)$/i.exec(String(body || '').trim());
                if (toggle) {
                    const wanted = /^(on|enable)$/i.test(toggle[1]);
                    const applied = menu2.setFingerprint(conn, wanted);
                    if (!applied.ok) {
                        await m.bigboreply(`❌ The fingerprint setting could not be changed (${applied.reason}).`);
                        return;
                    }
                    await setReaction(conn, m, wanted ? '✅' : '🟡');
                    const signedNow = menu2.signupFor(conn);
                    try {
                        await pairCard.sendHtmlCard(conn, m.chat, menu2.menu2Html({
                            avatar: signedNow?.avatar || '',
                            verified: true,
                            paired: menu2.pairedNumber(conn),
                            signedAt: signedNow?.verifiedAt || '',
                            fingerprint: wanted,
                            live: await menu2.liveStatus(conn)
                        }), { ...quoteGuard.quoteOption(m), mode: 'both', stage: 'menu2', fileName: 'DARKNOTE-MENU2.html', caption: '' });
                    } catch (error) {
                        console.error('[MENU2] fingerprint card delivery failed:', error?.stack || error);
                        await m.bigboreply(wanted
                            ? '✅ Fingerprint unlock is ON, but the card could not be delivered.'
                            : '🟡 Fingerprint unlock is OFF, but the card could not be delivered.');
                    }
                    console.log(`[MENU2] fingerprint ${wanted ? 'enabled' : 'disabled'} via chat`);
                    return;
                }
            }

            if (isOwner(m) && menu2.waiting(m.chat)) {
                // The DP is read NOW and frozen into the record, so the sign-up card
                // keeps the picture the account had at this moment.
                const signupAvatar = await pairCard.avatarDataUri().catch(() => '');
                const outcome = menu2.consume(conn, m.chat, body, { avatar: signupAvatar });
                if (outcome) {
                    await setReaction(conn, m, outcome.ok ? '✅' : '❌');
                    /*
                     * HTML ONLY, including the refusal: a wrong number reopens the card
                     * in its "try again" state, which says what did not match, instead of
                     * a text reply. The reason is only described in the log, so the card
                     * never prints the paired number in full.
                     */
                    const card = outcome.ok
                        ? menu2.menu2Html({
                            avatar: outcome.record.avatar || signupAvatar,
                            verified: true,
                            paired: menu2.pairedNumber(conn),
                            signedAt: outcome.record.verifiedAt,
                            live: await menu2.liveStatus(conn)
                        })
                        : menu2.menu2Html({
                            avatar: signupAvatar,
                            verified: false,
                            paired: menu2.pairedNumber(conn),
                            stage: outcome.reason === 'mismatch' ? 'mismatch' : 'signup',
                            note: outcome.reason === 'mismatch'
                                ? 'That number is not the one this session is paired to.'
                                : `That does not look like a usable number (${outcome.reason}).`
                        });
                    try {
                        await pairCard.sendHtmlCard(conn, m.chat, card, { ...quoteGuard.quoteOption(m), mode: 'both', stage: 'menu2', fileName: 'DARKNOTE-MENU2.html', caption: '' });
                        console.log(`[MENU2] ${outcome.ok ? 'signed up' : 'refused (' + outcome.reason + ')'} - card sent`);
                    } catch (error) {
                        console.error('[MENU2] card delivery failed:', error?.stack || error);
                        await m.bigboreply(outcome.ok
                            ? `✅ Signed up with +${outcome.record.number}, but the card could not be delivered.`
                            : `❌ Not verified (${outcome.reason}) and the card could not be delivered.`);
                    }
                    return;
                }
            }

            if (pairHeld?.state === 'awaiting-number') {
                const pendingNumber = pairControl.replace(/\D/g, '');
                clearPairPending(m);
                try {
                    await setReaction(conn, m, '⏳');
                    await sendPairProgress(conn, m, pendingNumber);
                    await setReaction(conn, m, '✅');
                } catch (error) {
                    console.error('[PAIR] card pairing failed:', error?.stack || error);
                    await setReaction(conn, m, '❌');
                    await m.bigboreply(`❌ Pairing failed: ${String(error?.message || error).slice(0, 180)}`);
                }
                return;
            }
        }


        // Per-session emergency pause. These are deliberately slash-prefixed
        // WhatsApp controls and do not alter the normal configured command prefix.
        const slashControl = String(body).trim().match(/^\/(shutdown|wakeup)(?:\s|$)/i);
        if (slashControl) {
            const control = slashControl[1].toLowerCase();
            if (!isOwner(m)) return m.bigboreply('❌ Owner only.');
            if (control === 'shutdown') {
                conn.__darknoteShutdown = true;
                return m.bigboreply('🛑 DARKNOTE is now shut down for this WhatsApp session.\n\nNo commands will run until you send /wakeup.');
            }
            conn.__darknoteShutdown = false;
            return m.bigboreply('✅ DARKNOTE is awake again. Commands are enabled.');
        }

        // While shut down, no normal command or prefix-free AI reply executes for
        // this socket. Other Telegram-paired sessions remain unaffected.
        if (conn.__darknoteShutdown) return;

        let command = '';
        let args = [];

        if (isButtonResponse) {
            const parts = body.split(/ +/);
            command = parts[0].toLowerCase();
            args = parts.slice(1);
            if (command.startsWith('ytvideo_select_')) {
                const match = command.match(/^ytvideo_select_([a-z0-9]+)_([0-9]+)$/i);
                if (match) { command = 'ytvideo_select'; args = [match[1], match[2]]; }
            }
            // Shazam card buttons: shazam_audio_<resultIndex>_<sessionId>
            // The button only carries the session id and the result number, never
            // the YouTube URL.
            if (/^shazam_(audio|play|file|video)_/i.test(command)) {
                const match = command.match(/^shazam_(audio|play|file|video)_([0-9]+)_([a-z0-9]+)$/i);
                if (match) {
                    command = `shazam_${match[1].toLowerCase()}`;
                    args = [match[2], match[3]];
                }
            }
        } else {
            const trimmed = body.trim();
            if (trimmed.startsWith(']>')) {
                if (!isCreator(m)) return m.bigboreply('The eval command is for the creator only.');
                const evalCode = trimmed.slice(2).trim();
                if (!evalCode) return m.bigboreply('Example:\n]> 1+1');
                return await executeEval(evalCode, conn, m);
            }
            if (trimmed.startsWith('$')) {
                if (!isCreator(m)) return m.bigboreply('❌ The shell command is for the creator only.');
                const shellCmd = trimmed.slice(1).trim();
                if (!shellCmd) return m.bigboreply('Example: $ ls -la');
                m.bigboreply('⏳ Running the shell command...');
                exec(shellCmd, { timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
                    let output = stdout || stderr || error?.message || '✅ Finished (no output)';
                    if (output.length > 2000) output = output.slice(0, 2000) + '\n... (output truncated)';
                    m.bigboreply(`💻 Output:\n${output}`);
                });
                return;
            }
            if (body.startsWith(config.prefix || '.')) {
                const cleanBody = body.slice(1).trim();
                const parts = cleanBody.split(/ +/);
                command = parts[0].toLowerCase();
                args = parts.slice(1);
            } else {
                // PREFIX-FREE PATH - the AI chatbot is the ONLY feature allowed
                // to run without the command prefix. This sits in the existing
                // single dispatcher, AFTER the command check, so it can never
                // shadow a registered command. aiService.handle() decides for
                // itself whether this message qualifies (DM, or a real mention
                // in a group) and returns immediately when it does not.
                /*
                 * OWNER ASSISTANT - plain-language commands.
                 *
                 * Runs BEFORE the conversational layers, so it works with
                 * `.chatbot` OFF: the owner talking to the bot is a different
                 * thing from the chatbot being enabled.
                 *
                 * It never invents a command - a name must exist in this
                 * dispatcher's registry - and it executes by re-entering this
                 * same dispatcher through the synthetic-command hook, so every
                 * permission check, confirmation gate and reply is unchanged.
                 */
                try {
                    const outcome = await assistant.maybeHandle(conn, m, {
                        isOwner: isOwner(m),
                        isDirect: !m.isGroup,
                        prefix: config.prefix,
                        react: emoji => setReaction(conn, m, emoji),
                        dispatch: async synthetic => {
                            m.__darknoteSyntheticCommand = synthetic;
                            await module.exports(conn, m);
                        }
                    });
                    if (outcome && outcome.handled) return;
                } catch (error) {
                    console.error('[ASSISTANT] failed:', error?.stack || error);
                }

                try {
                    await aiService.handle(conn, m, {
                        isOwner: isOwner(m),
                        mode: config.mode,
                        prefix: config.prefix
                    });
                } catch (error) {
                    console.error('[AI] dispatcher hand-off failed:', error?.stack || error);
                }
                return;
            }
        }

        // Resolve aliases through the existing dispatcher. A native .ss status
        // reply keeps priority so .cmdset vv ss can coexist with Status Save.
        if (!isButtonResponse && command && !(command === 'ss' && isNativeStatusSave(m))) {
            const resolvedCommand = resolveForDispatch(command, conn);
            if (resolvedCommand) command = resolvedCommand;
        }
        m.prefix = config.prefix || '.';

        if (!m.__darknoteChannelResponseAttached && typeof m.big1reply === 'function') {
            const originalReply = m.big1reply.bind(m);
            m.big1reply = async (text, chatId, options) => {
                const sent = await originalReply(text, chatId, options);
                try { await sendChannelButton(conn, m); } catch (error) { console.error('[CHANNEL] Button failed:', error?.message || error); }
                return sent;
            };
            m.__darknoteChannelResponseAttached = true;
        }
        const { big1reply } = m;

        // The menu thumbnail is now prepared by the module-scope getMenuThumb()
        // that sendMenuCard()/sendLegacyMenu() use. Keeping a second copy here
        // would shadow it and the helpers could not see it - which is exactly why
        // the thumbnail never reached the menu.

       // Self
       if (config.mode === 'self' && !isCreator(m)) return
       //Case
        switch (command) {

        case 'menu': {
            /*
             * The menu reaction run: 🫵🏼💔🥱💀🌚💯✅ (see MENU_REACTIONS).
             *
             * Deliberately NOT awaited: the seven frames take about two seconds
             * and holding the reply behind them would make .menu feel slow. The
             * animation plays while the menu is built and sent. setReaction()
             * swallows its own errors, so this cannot break the command.
             */
            // Three emojis from the pool, rotating so consecutive .menu runs
            // differ (see pickMenuReactions).
            void reactSequence(conn, m, pickMenuReactions()).catch(() => { });
            const runtime = process.uptime()
            const rawStamp = m.messageTimestamp
            const stampSeconds = (rawStamp && typeof rawStamp === 'object' && typeof rawStamp.toNumber === 'function')
                ? rawStamp.toNumber()
                : Number(rawStamp && typeof rawStamp === 'object' && rawStamp.low !== undefined ? rawStamp.low : rawStamp)
            const ping = Number.isFinite(stampSeconds) && stampSeconds > 0 ? Math.max(0, Date.now() - stampSeconds * 1000) : 0
            const info = menu.buildInfo(config, {
                botName: config.botName || 'DARKNOTE',
                version: config.version || 'L2',
                status: runtimeMonitor.telegramState()?.state === 'CONNECTED' || runtimeMonitor.getState?.()?.whatsapp === 'CONNECTED' ? 'CONNECTED' : 'ONLINE',
                mode: config.mode === 'self' ? 'SELF' : 'PUBLIC',
                number: String(conn.user?.id || m.sender || '').replace(/@.+/g, '').split(':')[0],
                ping,
                runtime: menu.runtimeText(runtime),
                ai: (() => { try { return aiService.config.getAiSettings().chatbotEnabled ? 'ON' : 'OFF' } catch { return 'READY' } })()
            })

            // Modern interactive card (the legacy buttonsMessage no longer renders).
            await sendMenuCard(conn, m, info.text, [
                { id: 'allmenu', text: '📚 All Menu' },
                // Reserved by the operator; the behaviour is decided later.
                { id: 'menu2', text: '🧩 Menu 2' }
            ])
            break
        }

        /*
         * MENU 2 — THE BUTTON EXISTS, THE BEHAVIOUR IS NOT DECIDED YET.
         *
         * It is wired end to end (button -> id -> this case -> reply), which is the
         * part worth doing now: whatever this menu ends up doing is then a single
         * edit here, and the card does not have to be touched again. Until it is
         * defined it says so plainly rather than opening an empty screen or
         * pretending to have worked.
         */
        /*
         * WHY MENU 2 IS SENT AS BOTH.
         *
         * 'both' sends the HTML twice, deliberately, because the two copies do different
         * jobs:
         *
         *   rich      the card you SEE in the chat. It is a Meta-AI bot message, so it
         *             renders the markup but is NOT an interactive webview - a tap
         *             inside it does nothing, which is why the number bar could not be
         *             activated when this was the only copy sent.
         *   document  the same HTML as a file. Opened, it runs in a real browser, where
         *             the input focuses, the keyboard comes up and every handler runs.
         *
         * Sending only the document lost the visible card; sending only the rich card
         * lost the interactivity. Both gives the card its appearance AND a way to
         * actually type into it. sendHtmlCard tolerates either path failing.
         */
        case 'menu2': {
            /*
             * The sign-up card. Already signed up for this paired number -> the card
             * opens in its verified state and nothing is asked. Not signed up -> the
             * card asks for the number, and the chat is put in a five-minute window
             * so the reply is read as the sign-up.
             */
            /*
             * HTML ONLY. The operator asked for this flow to answer with the card and
             * nothing else, so there is no accompanying text message: the card itself
             * carries the instruction, and the chat is simply put into its five-minute
             * window so the number can be entered.
             */
            const signed = menu2.signupFor(conn);
            const menu2Avatar = await pairCard.avatarDataUri().catch(() => '');
            const html = menu2.menu2Html({
                // Signed up: the FROZEN DP from sign-up, not today's picture.
                avatar: signed?.avatar || menu2Avatar,
                verified: Boolean(signed),
                paired: menu2.pairedNumber(conn),
                signedAt: signed?.verifiedAt || '',
                stage: 'signup',
                // The lock screen only demands a finger when it was switched on.
                fingerprint: signed?.fingerprint === true,
                /*
                 * Real figures for the status bar: the process's own uptime, and a
                 * measured round trip to WhatsApp. Both are nulls rather than guesses
                 * when they cannot be obtained.
                 */
                live: signed ? await menu2.liveStatus(conn) : null
            });
            try {
                /*
                 * HTML ONLY: no caption, no accompanying message. The operator asked for
                 * the response to be just the file. The card itself carries every
                 * instruction, so nothing is lost but the duplicate line in the chat.
                 */
                await pairCard.sendHtmlCard(conn, m.chat, html, { ...quoteGuard.quoteOption(m), mode: 'both', stage: 'menu2', fileName: 'DARKNOTE-MENU2.html', caption: '' });
            } catch (error) {
                // The one case that still speaks in text: the card could not be sent at
                // all, and silence would leave the operator guessing.
                console.error('[MENU2] card delivery failed:', error?.stack || error);
                return bigboreply(`❌ The Menu 2 card could not be delivered: ${String(error?.message || error).slice(0, 160)}`);
            }
            console.log(`[MENU2] opened (${signed ? 'already signed up' : 'sign-up requested'})`);
            if (!signed) menu2.begin(m.chat);
            return;
        }

        /*
         * AUTO HUMAN REPLY. Persistent: written through the existing AI settings
         * layer into config.json, so it survives a restart or a reconnect. It is
         * its own switch - it does not touch `.chatbot`.
         */
        case 'autohuman': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const mode = String(args[0] || '').toLowerCase();
            if (!['on', 'off'].includes(mode)) {
                return bigboreply(`${aiService.autohuman.statusText()}\n\nUsage: ${config.prefix || '.'}autohuman on|off\n\nWhen ON, DARKNOTE continues DMs in the other person's own style using the last ${aiService.config.getAiSettings().autohumanContextMessages} messages. It never replies to commands.`);
            }
            aiService.config.writeAiSetting('autohumanEnabled', mode === 'on');
            if (mode === 'on') {
                return bigboreply('✅ Auto Human Reply is now ON.\n\nDARKNOTE will read the recent conversation per contact and reply like a person. Commands still take priority.');
            }
            return bigboreply('✅ Auto Human Reply is now OFF.\n\nNo AI replies will be generated.');
        }

        /*
         * LIVE WEATHER, by place name.
         *
         * Open-Meteo needs no API key, so there is no credential to be missing or
         * expired here. On failure the reply names the STAGE that broke
         * (geocoding or forecast) and the HTTP status, and the same detail is
         * written to the console - a single generic "not configured" line cannot
         * tell an unknown village apart from a service outage.
         */
        case 'weather': {
            const query = args.join(' ').trim();
            const result = await weather.weatherReport(query);
            if (!result.ok) {
                if (result.failure) {
                    const status = result.failure.status ? `HTTP ${result.failure.status} ` : '';
                    console.error(`[WEATHER] ${result.failure.stage} failed: ${status}${result.failure.reason}`);
                }
                return bigboreply(result.message);
            }
            return bigboreply(result.message);
        }

        /*
         * LOCAL TIME for a place, or for a bare IANA zone (".time Africa/Nairobi").
         * A bare zone needs no network call at all, so this still answers when
         * the weather service is the thing that is down.
         */
        case 'time': {
            const query = args.join(' ').trim();
            const result = await weather.timeReport(query);
            if (!result.ok) {
                if (result.failure) {
                    const status = result.failure.status ? `HTTP ${result.failure.status} ` : '';
                    console.error(`[TIME] ${result.failure.stage} failed: ${status}${result.failure.reason}`);
                }
                return bigboreply(result.message);
            }
            return bigboreply(result.message);
        }

        /*
         * `.runtime` draws the LIVE SCENE instead of printing three lines of text:
         * the sky at the paired number's real local hour, the sun or moon riding
         * its arc with the DARKNOTE name beside it, the real weather and
         * temperature for that country, and the two characters whose day follows
         * the clock (see lib/runtime-card.js).
         *
         * `.runtime <place>` pins the weather to a place the operator names.
         * `.alive` keeps the plain-text diagnostic — that one is meant to be read
         * by scripts and logs, where a picture is no use.
         */
        case 'runtime': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            try {
                const paired = ownerSystem.pairedNumber(conn) || config.ownerNumber || '';
                const data = await runtimeCard.snapshot({
                    number: paired,
                    place: args.join(' ').trim(),
                    fallbackZone: config.timezone || ''
                });
                data.uptimeSeconds = process.uptime();
                data.whatsapp = runtimeMonitor.getState()?.whatsapp || 'unknown';
                data.botName = config.botName || 'DARKNOTE';
                const result = await runtimeCard.sendRuntimeCard(conn, m.chat, data, {
                    mode: runtimeCardMode(),
                    // One screen per handset, so 'both' sends the iPhone and the Galaxy
                    // of the SAME moment — that is what "a samsung and iphone display" is.
                    skins: phoneFrame.resolveSkins(runtimeSkin()),
                    // `.quoted` is the WAMessage itself. Passing the whole
                    // `quoteOption(m)` object here nested it one level too deep and
                    // broke every send in this path (see quoteGuard.unwrapQuote).
                    quoted: quoteGuard.quoteOption(m).quoted
                });
                if (!result.delivered.length) throw new Error('no delivery path succeeded');
                return;
            } catch (error) {
                console.error('[RUNTIME] card failed:', error?.stack || error);
                // Never leave the owner with nothing: fall back to the text that
                // this command used to print.
                const health = runtimeMonitor.getState();
                return bigboreply(`${runtimeMonitor.statusText()}\n\nLast error: ${health.lastError || 'none'}\nReconnects: ${health.reconnects}`);
            }
        }

        // Runtime Alive status - the real socket state, not a guess.
        case 'alive': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const health = runtimeMonitor.getState();
            return bigboreply(`${runtimeMonitor.statusText()}\n\nLast error: ${health.lastError || 'none'}\nReconnects: ${health.reconnects}`);
        }

        // Telegram controller status.
        case 'tgstatus': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            let text = 'TELEGRAM CONTROLLER\n\nNot loaded.';
            try { text = require('./lib/telegram.js').statusText(); } catch (error) {
                console.error('[TELEGRAM] status failed:', error?.message || error);
            }
            return bigboreply(text);
        }

        /*
         * .tagall / .callall - GROUP BROADCASTS.
         *
         * This SUPERSEDES the card-based tagall. The owner supplied
         * tagAllMembers() and callAll() (see the TAGALL / CALLALL COMMANDS block
         * near the top of this file), so the boxed layout, the numbered member
         * list and the admin gate now come from there. Both send exactly one
         * message and carry a real `mentions` array.
         *
         * `await` + `break` is kept from the previous implementation.
         */
        case 'tagall': {
            await tagAllMembers(conn, m, args);
            break;
        }

        /*
         * .callall - the same broadcast, re-quoting the message you replied to.
         * Requires a reply; the replied-to caption/text (or a "[media message]"
         * marker when it carried no text) is embedded in the broadcast.
         */
        case 'callall': {
            await callAll(conn, m);
            break;
        }


        case 'listonline': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used in groups.');
            try {
                const metadata = await conn.groupMetadata(m.chat);
                const botJid = normalizeJidForCompare(conn.user?.id || '');
                /*
                 * SUBSCRIBE BEFORE READING.
                 *
                 * WhatsApp only sends presence.update for JIDs the client has
                 * subscribed to, and nothing here ever subscribed for group
                 * members - so the cache was always empty and this command could
                 * only ever report nobody online. collectPresence() asks first,
                 * waits for the answers, then reports what actually arrived.
                 */
                /*
                 * A LONGER WAIT. Presence is push-based: WhatsApp answers the
                 * subscription when it gets round to it, and the default window
                 * closed before the slower members reported, which showed a
                 * SHORTER list than was really online. Waiting costs one command
                 * invocation and nothing else.
                 */
                const presence = await groupFeatures.collectPresence(conn, metadata, { waitMs: 6000 });
                const online = presence.online
                    .filter(p => normalizeJidForCompare(groupFeatures.participantJid(p)) !== botJid);
                if (!online.length) return bigboreply(groupFeatures.describeEmptyPresence(presence));
                const entries = online.map(p => cards.participantEntry(conn, p, '🟢 Online'));
                const cardResult = await cards.sendMemberPages(conn, m, {
                    heading: '🟢 ONLINE MEMBERS',
                    entries,
                    /*
                     * VERTICAL, ALWAYS - never the horizontal carousel.
                     *
                     * The carousel is what made this command look broken: on a
                     * client that does not render card carousels the send still
                     * reports success while showing nothing usable, so "no online
                     * members" was really "a card you cannot see". Text pages are
                     * a plain vertical list in which every line is a REAL @mention,
                     * so the members are mentioned and always render. Override with
                     * config.json -> cards.mode if a carousel is ever wanted back.
                     */
                    mode: 'text',
                    summary: `Total online: ${entries.length} · checked ${presence.requested} of ${(metadata.participants || []).length} members`,
                    emptyMessage: groupFeatures.describeEmptyPresence(presence),
                    failureMessage: '❌ Failed to read the group online list.',
                    reply: bigboreply
                });
                if (!cardResult.ok) {
                    console.error(`[LISTONLINE] member cards failed: ${cardResult.code} ${cardResult.reason || ''}`);
                    return bigboreply('❌ Failed to read the group online list.');
                }
                return;
            } catch (error) {
                console.error('[LISTONLINE] Error:', error?.stack || error);
                return bigboreply('❌ Failed to read the group online list.');
            }
        }

        case 'listinactive':
        case 'listactive': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used in groups.');
            try {
                const metadata = await conn.groupMetadata(m.chat);
                const activity = groupFeatures.getTodayActivity(m.chat);
                const botJid = normalizeJidForCompare(conn.user?.id || '');
                const members = (metadata.participants || []).filter(p => normalizeJidForCompare(groupFeatures.participantJid(p)) !== botJid);
                const rows = members.map(p => {
                    const jid = groupFeatures.participantJid(p);
                    const key = normalizeJidForCompare(jid);
                    return { p, jid, count: Number(activity[key] || activity[String(jid).split(':')[0].toLowerCase()] || 0) };
                });
                if (command === 'listinactive') {
                    const inactive = rows.filter(r => r.count === 0);
                    if (!inactive.length) return bigboreply('✅ Everyone in the group has sent at least one message today.');
                    const entries = inactive.map(r => cards.participantEntry(conn, r.p, '0 msgs today'));
                    const cardResult = await cards.sendMemberPages(conn, m, {
                        heading: '🔴 INACTIVE TODAY',
                        entries,
                        mode: cardsMode(),
                        summary: `Total inactive: ${entries.length}`,
                        emptyMessage: '✅ Everyone in the group has sent at least one message today.',
                        failureMessage: '❌ Failed to generate the listinactive report.',
                        reply: bigboreply
                    });
                    if (!cardResult.ok) {
                        console.error(`[LISTINACTIVE] member cards failed: ${cardResult.code} ${cardResult.reason || ''}`);
                        return bigboreply('❌ Failed to generate the listinactive report.');
                    }
                    return;
                }
                const active = rows.filter(r => r.count > 0).sort((a, b) => b.count - a.count);
                if (!active.length) return bigboreply('ℹ️ No member messages have been recorded today.');
                const total = active.reduce((sum, r) => sum + r.count, 0);
                const entries = active.map(r => cards.participantEntry(conn, r.p, `${r.count} msg${r.count === 1 ? '' : 's'}`));
                const cardResult = await cards.sendMemberPages(conn, m, {
                    heading: '🟢 ACTIVE MEMBERS TODAY',
                    entries,
                    mode: cardsMode(),
                    summary: `Total = ${total} messages\nActive members = ${entries.length}`,
                    emptyMessage: 'ℹ️ No member messages have been recorded today.',
                    failureMessage: '❌ Failed to generate the listactive report.',
                    reply: bigboreply
                });
                if (!cardResult.ok) {
                    console.error(`[LISTACTIVE] member cards failed: ${cardResult.code} ${cardResult.reason || ''}`);
                    return bigboreply('❌ Failed to generate the listactive report.');
                }
                return;
            } catch (error) {
                console.error(`[${command.toUpperCase()}] Error:`, error?.stack || error);
                return bigboreply(`❌ Failed to generate the ${command} report.`);
            }
        }

        case 'groupadmins':
        case 'groupadmin':
        case 'admin': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used in groups.');
            try {
                const metadata = await conn.groupMetadata(m.chat);
                /*
                 * `admin` keeps its existing meaning (the group creator when
                 * WhatsApp marks one, otherwise the admins); `groupadmin` and
                 * `groupadmins` list every admin. The creator is never invented:
                 * when WhatsApp does not mark one, the admins are listed with an
                 * explicit note.
                 */
                const allAdmins = display.resolveMembers(conn, metadata.participants, { adminOnly: true });
                if (!allAdmins.length) return bigboreply('ℹ️ No group admins were found.');
                const creator = allAdmins.find(member => member.isCreator);
                const target = command === 'admin' ? (creator ? [creator] : allAdmins) : allAdmins;

                const heading = command === 'admin'
                    ? (creator ? 'ADMIN' : 'GROUP ADMINS')
                    : 'GROUPADMIN';
                const note = command === 'admin' && !creator ? 'No creator found. Group admins:' : '';
                const text = display.memberBox(heading, target, {
                    summary: [note, `Total: ${target.length}`].filter(Boolean).join('\n')
                });
                if (display.containsJid(text)) {
                    console.error(`[${command.toUpperCase()}] refusing to send text containing a JID`);
                    return bigboreply(`❌ Failed to retrieve the group admins.`);
                }
                await conn.sendMessage(m.chat, { text, mentions: display.mentionsOf(target) }, { quoted: m });
                return;
            } catch (error) {
                console.error(`[${command.toUpperCase()}] Error:`, error?.stack || error);
                return bigboreply(`❌ Failed to retrieve the group admins.`);
            }
        }

        /*
         * EVIL_PAIN - destructive, so it is owner-only, group-only, admin-checked
         * and confirmation-gated. `evil_pain` alone only prints the warning;
         * nothing is removed until `evil_pain confirm`.
         */
        case 'evil_pain': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            if (!m.isGroup) return bigboreply('❌ This command only works inside a group.');

            const action = String(args[0] || '').toLowerCase();
            if (action !== 'confirm') {
                evilPain.markWarned(m.chat);
                return bigboreply(evilPain.warningText());
            }

            if (evilPain.isRunning(m.chat)) {
                return bigboreply('⏳ This is already running in this group.');
            }

            // Verify BEFORE doing anything irreversible, and name the real reason.
            const check = await evilPain.checkRequirements(conn, m);
            if (!check.ok) return bigboreply(evilPain.reasonText(check.reason));

            // The executor's own push name - never their number or JID.
            const ownerName = display.senderName(conn, m);
            await bigboreply(`☬ EVIL_PAIN started. Acting as: ${ownerName}`);

            const results = await evilPain.execute(conn, m, ownerName, {
                notify: text => conn.sendMessage(m.chat, { text })
            });

            if (!results.ok) {
                return bigboreply(evilPain.reasonText(results.reason) || '❌ The operation could not be completed.');
            }
            // The summary was already delivered inside the sequence, before the
            // bot left the group. Nothing more is sent here.
            break;
        }

        /*
         * STATE - honest snapshot of one person, using only what the live
         * connection actually exposes. In a DM it reports the other participant;
         * in a group it reports whoever was quoted or mentioned.
         */
        case 'state': {
            let target = '';
            if (!m.isGroup) {
                // In a DM the "other participant" is the chat itself.
                target = display.bare(m.chat);
            } else if (m.quoted?.sender) {
                target = display.bare(m.quoted.sender);
            } else if (Array.isArray(m.mentionedJid) && m.mentionedJid.length) {
                target = display.bare(m.mentionedJid[0]);
            }
            if (!target || target.endsWith('@g.us')) {
                return bigboreply([
                    '❌ *STATE* needs a person.',
                    '',
                    `• In a DM, just send ${config.prefix || '.'}state`,
                    `• In a group, reply to someone's message with ${config.prefix || '.'}state`
                ].join('\n'));
            }

            try {
                const snapshot = await userInfo.stateText(conn, target);
                if (!snapshot.ok) return bigboreply('❌ I could not read that contact.');
                return bigboreply(userInfo.renderState(snapshot));
            } catch (error) {
                console.error('[STATE] Error:', error?.stack || error);
                return bigboreply('❌ I could not read that contact right now.');
            }
        }

        // GPPP - send the current group's picture. The group is taken from the
        // message context; the user never supplies a JID and never sees one.
        case 'gppp': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used in groups.');
            try {
                const picture = await userInfo.groupPicture(conn, m.chat);
                if (!picture.ok) {
                    if (picture.reason === 'no-picture') {
                        return bigboreply('ℹ️ This group has no profile picture set.');
                    }
                    return bigboreply("❌ I couldn't fetch this group's picture. Please try again.");
                }
                await conn.sendMessage(m.chat, { image: picture.buffer }, { quoted: m });
            } catch (error) {
                console.error('[GPPP] Error:', error?.stack || error);
                return bigboreply("❌ I couldn't fetch this group's picture. Please try again.");
            }
            break;
        }

        case 'groupjid': {
            try {
                if (m.isGroup && !args[0]) return bigboreply(`📌 Group JID:\n${m.chat}`);
                if (args[0] && !/^https?:\/\/|^chat\.whatsapp\.com\//i.test(args[0])) {
                    const groups = groupFeatures.getSelection(m);
                    const index = Number(args[0]);
                    if (groups && Number.isInteger(index) && index >= 1 && index <= groups.length) return bigboreply(`📌 Group JID:\n${groups[index - 1].id}`);
                }
                if (args[0]) {
                    const resolved = await groupFeatures.resolveGroupInvite(conn, args[0]);
                    if (!resolved) return bigboreply(`Usage: ${config.prefix || '.'}groupjid <group invite link>`);
                    return bigboreply(`📌 Group JID:\n${resolved.jid}`);
                }
                if (!m.isGroup) {
                    const groups = Object.values(conn.chats || {}).filter(c => c?.id?.endsWith('@g.us')).map(c => ({ id: c.id, name: c.subject || c.name || c.id }));
                    if (!groups.length) return bigboreply('❌ No groups are available in this session.');
                    groupFeatures.saveSelection(m, groups);
                    const text = groups.map((g, i) => `${i + 1}. ${g.name}`).join('\n');
                    return bigboreply(`📋 *SELECT A GROUP*\n\n${text}\n\nReply with: ${config.prefix || '.'}groupjid <number>`);
                }
            } catch (error) {
                console.error('[GROUPJID] Error:', error?.stack || error);
                const message = String(error?.message || '');
                if (/permission|forbidden|admin/i.test(message)) return bigboreply('❌ Only admins can share/have the group link.');
                return bigboreply(`❌ Could not resolve that group link. ${message}`.trim());
            }
            break;
        }

        case 'channeljid': {
            try {
                if (!args[0] && (m.chat || '').endsWith('@newsletter')) return bigboreply(`📢 Channel JID:\n${m.chat}`);
                if (!args[0]) return bigboreply(`Usage: ${config.prefix || '.'}channeljid <channel link>`);
                const resolved = await groupFeatures.resolveChannelLink(conn, args[0]);
                if (!resolved) return bigboreply(`Usage: ${config.prefix || '.'}channeljid <channel link>`);
                return bigboreply(`📢 Channel JID:\n${resolved.jid}`);
            } catch (error) {
                console.error('[CHANNELJID] Error:', error?.stack || error);
                return bigboreply('❌ Could not resolve that channel link with the current Baileys build.');
            }
        }

        case 'avs':
        case 'als':
        case 'ars': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const mode = String(args[args.length - 1] || '').toLowerCase();
            if (!['on', 'off'].includes(mode)) {
                const current = config.statusAutomation?.[command] || (command === 'ars' ? { enabled: false, emoji: '😊' } : { enabled: false });
                return bigboreply(`Usage: ${config.prefix || '.'}${command}${command === 'ars' ? ' 😊' : ''} on|off\n\nCurrent: ${current.enabled ? 'ON' : 'OFF'}${command === 'ars' ? `\nEmoji: ${current.emoji || '😊'}` : ''}`);
            }
            config.statusAutomation = config.statusAutomation || {};
            if (command === 'ars') {
                const suppliedEmoji = args.length > 1 ? String(args[0] || '').trim() : '';
                if (args.length > 1 && !['on', 'off'].includes(String(args[1]).toLowerCase())) return bigboreply(`Usage: ${config.prefix || '.'}ars 😊 on|off`);
                const emoji = suppliedEmoji && !['on', 'off'].includes(suppliedEmoji.toLowerCase())
                    ? suppliedEmoji
                    : (config.statusAutomation.ars?.emoji || '😊');
                config.statusAutomation.ars = { enabled: mode === 'on', emoji };
            } else {
                config.statusAutomation[command] = { enabled: mode === 'on' };
            }
            fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
            const state = config.statusAutomation[command];
            return bigboreply(`✅ ${command.toUpperCase()} is now ${state.enabled ? 'ON' : 'OFF'}${command === 'ars' ? `\nReaction: ${state.emoji}` : ''}`);
        }

        // Presence and group control. Delegated to the AI service because that is
        // where the ONE safe scheduler lives, so an online cycle or a group timer
        // can never spawn duplicate loops.
        case 'online': {
            try {
                const handled = await aiService.runCommand(conn, m, 'online', args, bigboreply, {
                    isOwner: isOwner(m), mode: config.mode, prefix: config.prefix
                });
                if (handled) break;
            } catch (error) {
                console.error('[ONLINE] failed:', error?.stack || error);
                return bigboreply('❌ The online command failed.');
            }
            break;
        }

        case 'close':
        case 'open': {
            try {
                const handled = await aiService.runCommand(conn, m, command, args, bigboreply, {
                    isOwner: isCreator(m), mode: config.mode, prefix: config.prefix
                });
                if (handled) break;
            } catch (error) {
                console.error('[GROUPCONTROL] failed:', error?.stack || error);
                return bigboreply('❌ The group control command failed.');
            }
            break;
        }

        case 'autoread':
        case 'autotyping':
        case 'autorecoding': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const enabled = config[command] === true;
            const mode = String(args[args.length - 1] || '').toLowerCase();
            if (!['on', 'off'].includes(mode)) {
                return bigboreply(`Usage: ${config.prefix || '.'}${command} on|off\n\nCurrent: ${enabled ? 'ON' : 'OFF'}`);
            }
            config[command] = mode === 'on';
            if (command === 'autotyping' && config.autotyping) config.autorecoding = false;
            if (command === 'autorecoding' && config.autorecoding) config.autotyping = false;
            fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
            const extra = command === 'autotyping' && config.autotyping
                ? '\n🎙️ Auto-recording was turned OFF.'
                : command === 'autorecoding' && config.autorecoding
                    ? '\n⌨️ Auto-typing was turned OFF.'
                    : '';
            return bigboreply(`✅ ${command.toUpperCase()} is now ${config[command] ? 'ON' : 'OFF'}${extra}`);
        }

        case 'setstatus': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            try {
                const q = m.quoted;
                if (!q) return bigboreply(`Reply to a text, image, or video, then use ${config.prefix || '.'}setstatus.`);
                // Status needs an audience list. Inside a group the participants
                // are the natural audience; in a direct chat the list is left out
                // so WhatsApp applies the account's own Status privacy settings.
                let statusJidList = [];
                if (m.isGroup) {
                    const metadata = await conn.groupMetadata(m.chat);
                    statusJidList = (metadata.participants || [])
                        .map(p => p.id || p.jid || p.lid)
                        .filter(Boolean)
                        .filter(j => normalizeJidForCompare(j) !== normalizeJidForCompare(conn.user?.id || ''));
                }
                const sendOptions = statusJidList.length ? { statusJidList } : {};
                // q.mtype arrives in mixed case, so normalise it and compare in
                // lower case.
                const mediaType = String(q.mtype || '').toLowerCase();
                if (mediaType === 'imagemessage' || mediaType === 'videomessage') {
                    const buffer = await q.download();
                    if (!buffer?.length) throw new Error('Could not download the replied media.');
                    const payload = mediaType === 'imagemessage'
                        ? { image: buffer, caption: q.caption || undefined }
                        : { video: buffer, mimetype: q.mimetype || 'video/mp4', caption: q.caption || undefined };
                    await conn.sendMessage('status@broadcast', payload, sendOptions);
                } else {
                    const text = String(q.text || q.caption || '').trim();
                    if (!text) return bigboreply('❌ The replied message does not contain usable text/media.');
                    await conn.sendMessage('status@broadcast', { text }, sendOptions);
                }
                return bigboreply('✅ Posted to your WhatsApp Status.');
            } catch (error) {
                console.error('[SETSTATUS] Error:', error?.stack || error);
                return bigboreply('❌ Failed to post the replied content to WhatsApp Status.');
            }
        }

        case 'gpstatus': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used inside a group.');
            try {
                const q = m.quoted;
                if (!q) return bigboreply(`Reply to a text, image, or video, then use ${config.prefix || '.'}gpstatus.`);
                const metadata = await conn.groupMetadata(m.chat);
                const statusJidList = (metadata.participants || []).map(p => p.id || p.jid || p.lid).filter(Boolean).filter(j => normalizeJidForCompare(j) !== normalizeJidForCompare(conn.user?.id || ''));
                /*
                 * Mirror the proven .setstatus path exactly.
                 *
                 * WhatsApp ACCEPTS a status addressed to an empty audience without
                 * complaining - the send resolves, this command reported success,
                 * and nothing ever appeared. So pass the audience only when there
                 * really is one; otherwise leave the options out and let WhatsApp
                 * apply the account's own Status privacy settings.
                 */
                const sendOptions = statusJidList.length ? { statusJidList } : {};
                // q.mtype is lower-cased on the line above, so the comparison must
                // be lower case too. The original mixed-case test never matched and
                // every image/video reply fell through to the text branch.
                const type = String(q.mtype || '').toLowerCase();
                if (type === 'imagemessage' || type === 'videomessage') {
                    const buffer = await q.download();
                    if (!buffer?.length) throw new Error('Could not download the replied media.');
                    const payload = type === 'imagemessage' ? { image: buffer, caption: q.caption || undefined } : { video: buffer, mimetype: q.mimetype || 'video/mp4', caption: q.caption || undefined };
                    await conn.sendMessage('status@broadcast', payload, sendOptions);
                } else {
                    const text = String(q.text || q.caption || '').trim();
                    if (!text) return bigboreply('❌ The replied message does not contain usable text/media.');
                    await conn.sendMessage('status@broadcast', { text }, sendOptions);
                }
                // Say what actually happened, so a silent no-post is visible next time.
                console.log(`[GPSTATUS] posted to status@broadcast for ${statusJidList.length} recipient(s) from ${m.chat}`);
                return bigboreply(
                    statusJidList.length
                        ? `✅ Posted to WhatsApp Status for *${statusJidList.length}* member(s) of this group.`
                        : '✅ Posted to WhatsApp Status.\n_No group members were available as an audience, so your account\u2019s Status privacy settings applied._'
                );
            } catch (error) {
                console.error('[GPSTATUS] Error:', error?.stack || error);
                return bigboreply('❌ Failed to post the group content to WhatsApp Status.');
            }
        }

        case 'hidetag': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used in groups.');
            try {
                const metadata = await conn.groupMetadata(m.chat);
                // Owner request: .hidetag does NOT require group admin. Group-only is
                // still enforced above.
                const botJid = normalizeJidForCompare(conn.user?.id || '');
                const mentions = (metadata.participants || []).map(p => p.id || p.jid).filter(Boolean).filter(jid => normalizeJidForCompare(jid) !== botJid);
                await conn.sendMessage(m.chat, { text: args.join(' ').trim() || 'ㅤ', mentions }, { quoted: m });
            } catch (error) { console.error('[HIDETAG] Error:', error?.stack || error); return bigboreply('❌ Failed to hide-tag the group.'); }
            break;
        }

        case 'kick': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used in groups.');
            try {
                const metadata = await conn.groupMetadata(m.chat);
                if (!isGroupAdmin(metadata, m.sender)) return bigboreply('❌ Only group admins can use .kick.');
                if (!isGroupAdmin(metadata, conn.user?.id || '')) return bigboreply('❌ DARKNOTE must be a group admin to kick members.');
                let target = m.quoted?.sender || m.mentionedJid?.[0] || m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                const raw = String(args[0] || '').replace(/\D/g, '');
                if (!target && /^\d{8,15}$/.test(raw)) target = `${raw}@s.whatsapp.net`;
                if (!target) return bigboreply(`❌ Reply to, mention, or provide the member number.\n\nUsage: ${config.prefix || '.'}kick 2547XXXXXXXX`);
                const p = (metadata.participants || []).find(x => [x.id, x.jid, x.lid].filter(Boolean).some(id => normalizeJidForCompare(id) === normalizeJidForCompare(target) || getNumber(id) === getNumber(target)));
                if (!p) return bigboreply('❌ That user is not in this group.');
                if (isGroupAdmin(metadata, p.id || p.jid || target)) return bigboreply('❌ I cannot kick a group admin.');
                await conn.groupParticipantsUpdate(m.chat, [p.id || p.jid || target], 'remove');
            } catch (error) { console.error('[KICK] Error:', error?.stack || error); return bigboreply('❌ Failed to remove that member.'); }
            break;
        }

        /*
         * REMOVE EVERY MEMBER AT ONCE.
         *
         * Destructive and not undoable, so this is a two-step command: a bare
         * `.kickall` reports exactly what it WOULD do and how many members are
         * affected, and only `.kickall confirm` performs the removals.
         *
         * Admins are never touched - WhatsApp refuses to remove an admin, and
         * quietly skipping them is more useful than reporting a failure nobody
         * can act on. The bot never removes itself.
         *
         * Removals go out in small batches with a short gap between them. A
         * single groupParticipantsUpdate carrying the whole member list is
         * silently dropped by WhatsApp, which is the failure mode that makes a
         * mass-removal command look like it worked when nothing happened. The
         * counts reported below are what the API accepted per batch, so a
         * partial removal is reported as partial rather than as success.
         */
        case 'kickall': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used in groups.');
            try {
                const metadata = await conn.groupMetadata(m.chat);
                if (!isGroupAdmin(metadata, m.sender)) return bigboreply('❌ Only group admins can use .kickall.');
                if (!isGroupAdmin(metadata, conn.user?.id || '')) return bigboreply('❌ DARKNOTE must be a group admin to remove members.');

                const botIds = [conn.user?.id, conn.user?.lid].filter(Boolean).map(id => normalizeJidForCompare(id));
                const botNumber = getNumber(conn.user?.id || '');

                const targets = [];
                for (const participant of metadata.participants || []) {
                    const jid = participant?.id || participant?.jid || participant?.lid;
                    if (!jid) continue;
                    if (botIds.includes(normalizeJidForCompare(jid))) continue;   // never the bot
                    if (botNumber && getNumber(jid) === botNumber) continue;      // ...however it is addressed
                    if (isGroupAdmin(metadata, jid)) continue;                    // never an admin
                    targets.push(jid);
                }

                if (!targets.length) return bigboreply('ℹ️ Nobody to remove — every other participant is an admin.');

                if (String(args[0] || '').toLowerCase() !== 'confirm') {
                    return bigboreply([
                        '⚠️ *REMOVE ALL MEMBERS*',
                        '',
                        `This removes *${targets.length}* member${targets.length === 1 ? '' : 's'} from this group.`,
                        'Admins are kept. This cannot be undone.',
                        '',
                        `Send *${config.prefix || '.'}kickall confirm* to go ahead.`
                    ].join('\n'));
                }

                const BATCH = 5;
                let removed = 0;
                let failed = 0;
                for (let index = 0; index < targets.length; index += BATCH) {
                    const batch = targets.slice(index, index + BATCH);
                    try {
                        await conn.groupParticipantsUpdate(m.chat, batch, 'remove');
                        removed += batch.length;
                    } catch (error) {
                        console.error('[KICKALL] batch failed:', error?.stack || error);
                        failed += batch.length;
                    }
                    if (index + BATCH < targets.length) await new Promise(resolve => setTimeout(resolve, 1200));
                }

                if (failed) return bigboreply(`⚠️ Removed ${removed} of ${targets.length} members. ${failed} could not be removed.`);
                return bigboreply(`✅ Removed all ${removed} member${removed === 1 ? '' : 's'}. Admins were kept.`);
            } catch (error) {
                console.error('[KICKALL] Error:', error?.stack || error);
                return bigboreply('❌ Failed to remove the members.');
            }
            break;
        }

        case 'add': {
            try {
                const { dispatchGroup } = require('./lib/protected-group.js');
                await dispatchGroup(conn, m, args, command, bigboreply, isOwner);
            } catch (error) {
                console.error('[ADD] integration error:', error?.stack || error);
                return bigboreply('❌ Failed to process .add.');
            }
            break;
        }

        case 'promote':
        case 'demote': {
            try {
                const { dispatchGroup } = require('./lib/protected-group.js');
                await dispatchGroup(conn, m, args, command, bigboreply, isOwner);
            } catch (error) {
                console.error(`[${command.toUpperCase()}] integration error:`, error?.stack || error);
                return bigboreply(`❌ Failed to process .${command}.`);
            }
            break;
        }

        case 'leave': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used in groups.');
            if (!isCreator(m)) return bigboreply('❌ Creator only.');
            try { await conn.groupLeave(m.chat); } catch (error) { console.error('[LEAVE] Error:', error?.stack || error); return bigboreply('❌ Failed to leave this group.'); }
            break;
        }

        case 'join': {
            if (!isCreator(m)) return bigboreply('❌ Creator only.');
            const value = String(args[0] || '').trim();
            const match = value.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i);
            const code = match?.[1] || (/^[A-Za-z0-9_-]{8,}$/.test(value) ? value : '');
            if (!code) return bigboreply(`❌ Provide a WhatsApp group invite link.\n\nUsage: ${config.prefix || '.'}join https://chat.whatsapp.com/XXXXXXXX`);
            try { await conn.groupAcceptInvite(code); await bigboreply('✅ Joined the group successfully.'); } catch (error) { console.error('[JOIN] Error:', error?.stack || error); return bigboreply('❌ Invalid, expired, revoked, or unavailable group invite link.'); }
            break;
        }

        case 'cmdset': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            if (args.length !== 2) return bigboreply(`Usage: ${config.prefix || '.'}cmdset <existing-command> <new-name>`);
            const result = configureAlias(args[0], args[1], conn);
            if (!result.ok) return bigboreply(result.message);
            return bigboreply(`✅ Alias created: ${config.prefix || '.'}${result.alias} → ${config.prefix || '.'}${result.target}`);
        }

        case 'stckcmd': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            if (args.length !== 1) return bigboreply(`Usage: ${config.prefix || '.'}stckcmd <command>

Reply to a sticker when using this command.`);
            try {
                const { getStickerMessage, setStickerCommand } = require('./lib/sticker-commands.js');
                const sticker = getStickerMessage(m);
                if (!sticker || m?.quoted?.mtype !== 'stickerMessage') return bigboreply(`❌ Reply to a sticker.

Usage: ${config.prefix || '.'}stckcmd <command>`);
                const result = await setStickerCommand(sticker, args[0], conn);
                if (!result.ok) return bigboreply(result.message);
                return bigboreply(`✅ Sticker command set to ${config.prefix || '.'}${result.command}.`);
            } catch (error) {
                console.error('[STCKCMD] Error:', error?.stack || error);
                return bigboreply('❌ Failed to save that sticker command.');
            }
        }

        case 'setprefix': {
            try {
                const { setPrefix } = require('./lib/config-commands.js');
                await setPrefix(conn, m, args, bigboreply, isOwner, config);
            } catch (error) {
                console.error('[SETPREFIX] integration error:', error?.stack || error);
                return bigboreply('❌ Failed to change the prefix.');
            }
            break;
        }

        case 'setgcpp': {
            try {
                const { setGroupPhoto } = require('./lib/config-commands.js');
                await setGroupPhoto(conn, m, args, bigboreply, isOwner, config);
            } catch (error) {
                console.error('[SETGCPP] integration error:', error?.stack || error);
                return bigboreply('❌ Failed to update the group photo.');
            }
            break;
        }

        case 'ss': {
            try {
                await saveStatus(conn, m, bigboreply);
            } catch (error) {
                console.error('[SS] integration error:', error?.stack || error);
                return bigboreply('❌ Failed to retrieve that Status media.');
            }
            break;
        }

        case 'sss': {
            // Intentionally no reply/reaction/success message. Only media that
            // is actually available in the quoted Status is forwarded to the
            // paired account's private/self chat.
            try {
                await saveStatusSilent(conn, m);
            } catch (error) {
                console.error('[SSS] integration error:', error?.stack || error);
            }
            break;
        }

        case 'vv':
        case 'vv2': {
            if (!isCreator(m)) return command === 'vv2' ? undefined : bigboreply('❌ Creator only.');
            try {
                const { dispatchMedia } = require('./lib/protected-media.js');
                await dispatchMedia(conn, m, command, bigboreply);
            } catch (error) {
                console.error(`[${command.toUpperCase()}] integration error:`, error?.stack || error);
                if (command === 'vv') return bigboreply('❌ Failed to retrieve that view-once message.');
            }
            break;
        }

        case 'conver': {
            try {
                const { dispatchMedia } = require('./lib/protected-media.js');
                await dispatchMedia(conn, m, command, bigboreply);
            } catch (error) {
                console.error('[CONVER] integration error:', error?.stack || error);
                return bigboreply('❌ Failed to convert that sticker.');
            }
            break;
        }

        case 'contact': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const contactTools = require('./lib/contact-save.js');
            const first = String(args[0] || '').trim();
            const numberLike = /^[+]?\d[\d\s().-]*$/.test(first) || /^00\d+$/.test(first);
            let target = '';
            let text = '';

            if (args.length >= 2 && numberLike) {
                const number = contactTools.normalizeNumber(first);
                if (!contactTools.isNumber(number)) return bigboreply(`❌ Invalid number.\n\nUsage: ${config.prefix || '.'}contact 2547XXXXXXXX <text>`);
                text = args.slice(1).join(' ').trim();
                try {
                    target = await contactTools.resolveUserJid(`${number}@s.whatsapp.net`, conn);
                } catch (error) {
                    console.error('[CONTACT] Number resolution failed:', error?.stack || error);
                    return bigboreply('❌ Could not validate that WhatsApp number.');
                }
            } else if (m.quoted?.sender) {
                text = args.join(' ').trim();
                try {
                    target = await contactTools.resolveUserJid(m.quoted.sender, conn);
                } catch (error) {
                    console.error('[CONTACT] Quoted sender resolution failed:', error?.stack || error);
                    return bigboreply('❌ Could not resolve the replied contact.');
                }
            } else {
                if (args.length >= 2 && !numberLike) return bigboreply(`❌ Invalid number.\n\nUsage: ${config.prefix || '.'}contact 2547XXXXXXXX <text>`);
                return bigboreply(`Usage: ${config.prefix || '.'}contact <text> (reply to a user)\n${config.prefix || '.'}contact 2547XXXXXXXX <text>`);
            }

            if (!text) return bigboreply(`Usage: ${config.prefix || '.'}contact <text> (reply to a user)\n${config.prefix || '.'}contact 2547XXXXXXXX <text>`);
            const targetNumber = contactTools.numberFromJid(target);
            const senderNumber = contactTools.normalizeNumber(m.sender);
            const selfNumber = contactTools.normalizeNumber(conn.user?.id);
            if (!target || !targetNumber || targetNumber === senderNumber || targetNumber === selfNumber) {
                return bigboreply('❌ Invalid contact target.');
            }
            try {
                await contactTools.sendContactText(conn, target, text);
                return bigboreply(`✅ Message sent to ${targetNumber}.`);
            } catch (error) {
                console.error('[CONTACT] Send failed:', error?.stack || error);
                return bigboreply('❌ Failed to send the contact message.');
            }
        }

        case 'save': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const contactTools = require('./lib/contact-save.js');
            const first = String(args[0] || '').trim();
            const numberLike = /^[+]?\d[\d\s().-]*$/.test(first) || /^00\d+$/.test(first);
            const explicit = args.length >= 2 && numberLike;
            let target = '';
            let name = '';

            if (explicit) {
                const number = contactTools.normalizeNumber(first);
                if (!contactTools.isNumber(number)) return bigboreply(`❌ Invalid number.\n\nUsage: ${config.prefix || '.'}save 2547XXXXXXXX <name>`);
                name = args.slice(1).join(' ').trim();
                try {
                    target = await contactTools.resolveUserJid(`${number}@s.whatsapp.net`, conn);
                } catch (error) {
                    console.error('[SAVE] Number resolution failed:', error?.stack || error);
                    return bigboreply('❌ Could not validate that WhatsApp number.');
                }
            } else if (m.quoted?.sender) {
                target = await contactTools.resolveUserJid(m.quoted.sender, conn).catch(error => {
                    console.error('[SAVE] Quoted sender resolution failed:', error?.stack || error);
                    return '';
                });
                name = args.join(' ').trim();
            } else if (!m.isGroup && /@s\.whatsapp\.net$/i.test(String(m.chat || ''))) {
                target = await contactTools.resolveUserJid(m.chat, conn).catch(error => {
                    console.error('[SAVE] DM participant resolution failed:', error?.stack || error);
                    return '';
                });
                name = args.join(' ').trim();
            } else {
                return bigboreply(`Usage: ${config.prefix || '.'}save <name> (reply to a user or use in their DM)\n${config.prefix || '.'}save 2547XXXXXXXX <name>`);
            }

            if (!name) return bigboreply(`Usage: ${config.prefix || '.'}save <name> (reply to a user or use in their DM)\n${config.prefix || '.'}save 2547XXXXXXXX <name>`);
            const targetNumber = contactTools.numberFromJid(target);
            const senderNumber = contactTools.normalizeNumber(m.sender);
            const selfNumber = contactTools.normalizeNumber(conn.user?.id);
            if (!target || !targetNumber || targetNumber === senderNumber || targetNumber === selfNumber) {
                return bigboreply('❌ Invalid contact target.');
            }
            try {
                const result = await contactTools.saveContact(conn, target, name);
                return bigboreply(`✅ Contact saved/updated in DARKNOTE.\nName: ${result.name}\nNumber: ${result.number}`);
            } catch (error) {
                console.error('[SAVE] Contact save failed:', error?.stack || error);
                return bigboreply('❌ Failed to save the contact.');
            }
        }

        case 'block':
        case 'unblock': {
            if (!isOwner(m)) return bigboreply('❌ Owner only!');
            let target;
            try {
                const contextInfo = m.message?.extendedTextMessage?.contextInfo || m.msg?.contextInfo || {};
                target = contextInfo.mentionedJid?.[0] || m.mentionedJid?.[0] || m.quoted?.sender;
                // In a private DM, a bare .block targets the current chat.
                // In a group, never guess a target.
                if (!target && !m.isGroup && m.chat && /@s\.whatsapp\.net$/i.test(String(m.chat))) target = m.chat;
                if (!target) {
                    const n = normalizeBlockNumber(args.join(' '));
                    if (!/^\d{8,15}$/.test(n)) {
                        return bigboreply(`❌ Reply to a user, mention a user, or provide a valid number.\n\nUsage: ${config.prefix || '.'}${command} 2547XXXXXXXX`);
                    }
                    if (typeof conn.onWhatsApp === 'function') {
                        const found = await conn.onWhatsApp(n);
                        const account = Array.isArray(found) ? found.find(x => x?.jid && (x.exists !== false)) : null;
                        if (account?.jid) target = account.jid;
                        else if (Array.isArray(found) && (found.length === 0 || found.every(x => x?.exists === false))) return bigboreply('❌ That number is not a valid WhatsApp account.');
                    }
                    if (!target) target = `${n}@s.whatsapp.net`;
                }
                target = conn.decodeJid ? conn.decodeJid(target) : target;
                // A LID target is perfectly usable on its own: the blocklist RPC
                // wants the LID. Adding the phone-number form is a bonus, so a
                // missing mapping must not abort the command (that produced
                // "Unable to resolve the target WhatsApp account" for LID targets).
                if (String(target || '').endsWith('@lid') && typeof conn.resolveLidEnhanced === 'function') {
                    try {
                        const mapped = await conn.resolveLidEnhanced(target);
                        if (mapped && /@s\.whatsapp\.net$/i.test(String(mapped))) {
                            target = conn.decodeJid ? conn.decodeJid(mapped) : mapped;
                        }
                    } catch (mappingError) {
                        console.error(`[${command.toUpperCase()}] LID -> PN mapping unavailable, continuing with the LID:`, mappingError?.message || mappingError);
                    }
                }
                target = conn.decodeJid ? conn.decodeJid(target) : target;
                if (!/@(s\.whatsapp\.net|lid)$/i.test(String(target || ''))) throw new Error('Unable to resolve the target WhatsApp account');
                // Only meaningful for a phone-number target: asking WhatsApp about
                // a LID's digits would return nothing useful.
                if (/@s\.whatsapp\.net$/i.test(String(target || '')) && typeof conn.onWhatsApp === 'function') {
                    try {
                        const resolved = await conn.onWhatsApp(getNumber(target));
                        if (Array.isArray(resolved) && resolved[0]?.jid) target = conn.decodeJid(resolved[0].jid);
                    } catch (resolutionError) {
                        console.error(`[${command.toUpperCase()}] WhatsApp number resolution fallback:`, resolutionError?.message || resolutionError);
                    }
                }
            } catch (error) {
                console.error(`[${command.toUpperCase()}] Target resolution error:`, error?.stack || error);
                return bigboreply(`❌ ${sanitizeBlockError(error)}`);
            }

            const targetNumber = getNumber(target);
            const selfNumber = getNumber(conn.user?.id || '');
            const senderNumber = getNumber(m.sender || '');
            if (!targetNumber || targetNumber === selfNumber || targetNumber === senderNumber) {
                return bigboreply(`❌ You cannot ${command} the bot's own account or the command sender.`);
            }
            // Protected numbers come from config.json -> "protectedBlockJids",
            // never from a value hard-coded in this command.
            if (protectedBlockNumbers(conn).includes(targetNumber)) {
                console.error(`[${command.toUpperCase()}] refused: ${targetNumber} is protected`);
                return bigboreply('No, 🙂‍↕🙂‍↔');
            }

            try {
                const action = command === 'block' ? 'block' : 'unblock';

                // WhatsApp migrated accounts to LID addressing. The blocklist RPC
                // needs the target's LID (plus its phone-number JID when blocking),
                // which the installed Baileys build does not send, so the request
                // is issued directly through conn.query. See lib/block-status.js.
                const identity = await blockStatus.resolveIdentity(conn, target);
                if (!identity.pn && !identity.lid) throw new Error('Unable to resolve the target WhatsApp account');

                const label = identity.pn ? getNumber(identity.pn) : identity.lid.split('@')[0];
                const selfLid = String(conn.user?.lid || '').split(':')[0].toLowerCase();
                if (identity.lid && selfLid && identity.lid === selfLid) {
                    return bigboreply(`❌ You cannot ${command} the bot's own account or the command sender.`);
                }

                const beforeList = await blockStatus.readBlocklist(conn);
                const before = beforeList ? blockStatus.matches(beforeList, identity) : null;
                if (command === 'block' && before === true) return bigboreply(`ℹ️ ${label} is already blocked.`);
                if (command === 'unblock' && before === false) return bigboreply(`ℹ️ ${label} is not blocked.`);

                const applied = await blockStatus.setBlockStatus(conn, identity, action);
                if (!applied.ok) {
                    console.error(`[${command.toUpperCase()}] WhatsApp rejected the request: ${applied.code}${applied.serverCode ? ` (server code ${applied.serverCode})` : ''} — ${applied.reason || ''}`);
                    if (applied.code === 'NO_IDENTITY') {
                        return bigboreply(`❌ I could not find a WhatsApp identity for ${label}. Reply to one of their messages and try again.`);
                    }
                    // Without a LID the phone-number-only form is what WhatsApp
                    // now rejects, so point the owner at the reliable route.
                    const hint = identity.lid ? '' : `\n\nTip: reply to one of their messages with ${config.prefix || '.'}${command} so their LID can be resolved from the chat.`;
                    return bigboreply(`❌ WhatsApp refused to ${command} ${label}.\n\n${sanitizeBlockError({ message: applied.reason || applied.code }, targetNumber)}${hint}`);
                }

                // Confirm against the real blocklist rather than trusting the call.
                const afterList = await blockStatus.readBlocklist(conn);
                const after = afterList ? blockStatus.matches(afterList, identity) : null;
                if (after !== null && ((action === 'block' && !after) || (action === 'unblock' && after))) {
                    console.error(`[${command.toUpperCase()}] request accepted but the blocklist did not change for ${label}`);
                    return bigboreply(`⚠️ WhatsApp accepted the request but ${label} does not appear in the blocklist. Please check on your phone.`);
                }

                return bigboreply(action === 'block' ? `✅ Blocked ${label}` : `✅ Unblocked ${label}`);
            } catch (error) {
                console.error(`[${command.toUpperCase()}] Error:`, error?.stack || error);
                return bigboreply(`❌ Failed to ${command} ${targetNumber || 'that number'}.\n\n${sanitizeBlockError(error, targetNumber)}`);
            }
        }

        case 'getpp':
        case 'steal': {
            if (!isCreator(m)) return bigboreply('❌ Creator only.');
            try {
                const { runProfileCommand } = require('./lib/profile-core.js');
                await runProfileCommand(conn, m, command, args, bigboreply, getNumber);
            } catch (error) {
                console.error(`[${command.toUpperCase()}] Error:`, error?.stack || error);
                if (command === 'getpp') return bigboreply('❌ Failed to retrieve that profile picture.');
            }
            break;
        }

        case 'pp': {
            if (!isCreator(m)) return bigboreply('❌ Creator only.');
            try {
                const { dispatchMedia } = require('./lib/protected-media.js');
                await dispatchMedia(conn, m, command, bigboreply);
            } catch (error) {
                console.error('[PP] integration error:', error?.stack || error);
                return bigboreply('❌ Failed to update the profile picture.');
            }
            break;
        }

        case 'approveall':
        case 'rejectall': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used in groups.');
            if (!isGroupAdmin(await conn.groupMetadata(m.chat), m.sender)) return bigboreply(`❌ Only group admins can use ${config.prefix || '.'}${command}.`);
            try {
                const metadata = await conn.groupMetadata(m.chat);
                if (!isGroupAdmin(metadata, conn.user?.id || '')) return bigboreply('❌ DARKNOTE must be a group admin.');
                if (typeof conn.groupRequestParticipantsList !== 'function' || typeof conn.groupRequestParticipantsUpdate !== 'function') {
                    throw new Error('This Baileys build does not expose group request approval methods');
                }
                const requests = await conn.groupRequestParticipantsList(m.chat);
                const list = Array.isArray(requests) ? requests : (requests?.participants || []);
                const targets = list.map(p => p?.jid || p?.id || p).filter(Boolean);
                if (!targets.length) return bigboreply(command === 'approveall' ? 'ℹ️ No pending join requests.' : 'ℹ️ No pending join requests.');
                const action = command === 'approveall' ? 'approve' : 'reject';
                const result = await conn.groupRequestParticipantsUpdate(m.chat, targets, action);
                const accepted = Array.isArray(result) ? result.filter(x => x?.status === '200' || x?.status === 200).length : targets.length;
                return bigboreply(`✅ ${command === 'approveall' ? 'Approved' : 'Rejected'} ${accepted || targets.length} pending join request${targets.length === 1 ? '' : 's'}.`);
            } catch (error) {
                console.error(`[${command.toUpperCase()}] Error:`, error?.stack || error);
                return bigboreply(`❌ Failed to ${command === 'approveall' ? 'approve' : 'reject'} the pending join requests.`);
            }
            break;
        }

        /*
         * ANTI-FEATURE SUITE. All eight share ONE engine in lib/security.js and
         * ONE setting each, persisted to config.json. Every enforcement decision
         * re-reads the setting at the moment it would act, so switching a feature
         * off stops it immediately and it stays off across a restart.
         */
        case 'antidemote':
        case 'antikick':
        case 'antisticker':
        case 'antimedia':
        case 'antiadd':
        case 'antipromote':
        case 'antiviewonce':
        case 'antimentionstatus': {
            if (!isOwner(m) && !isCreator(m)) return bigboreply('❌ Owner only.');
            const mode = String(args[args.length - 1] || '').toLowerCase();
            const feature = security.FEATURES[command];
            if (!feature) return bigboreply('❌ Unknown anti-feature.');
            /*
             * ANTI-MENTION-STATUS HAS MODES, THE OTHERS ARE on/off.
             * warn / delete / kick are ONE setting, so they are mutually
             * exclusive by construction: turning delete on turns kick off, and
             * there is no order of commands that can have both on at once.
             */
            if (command === 'antimentionstatus' && security.MENTION_MODES.includes(mode)) {
                security.setFeatureMode(command, mode);
                const notes = {
                    warn: 'warns the sender and counts up; the 3rd warning removes them from the group.',
                    delete: 'deletes the status mention as soon as it is detected (and warns when the suite\'s warn switch is on). Members are never removed in this mode.',
                    kick: 'deletes the status mention and removes the sender immediately.'
                };
                return bigboreply(`✅ *${feature.label}* is now ON in ${mode.toUpperCase()} mode.\n\n${notes[mode]}\n\nOnly one mode can be on — switching modes turns the others off, so kick is OFF while delete is on.`);
            }
            if (!['on', 'off'].includes(mode)) {
                const current = security.getSettings()[command];
                const currentMode = command === 'antimentionstatus' ? security.modeOf(security.getSettings(), command) : null;
                const status = command === 'antimentionstatus'
                    ? `Current: ${currentMode === 'off' ? 'OFF' : currentMode.toUpperCase()}`
                    : `Current: ${current?.enabled ? 'ON' : 'OFF'}`;
                const usage = command === 'antimentionstatus'
                    ? `${config.prefix || '.'}antimentionstatus warn|delete|kick|off`
                    : `${config.prefix || '.'}${command} on|off`;
                return bigboreply(`*${feature.label}*\n\n${status}\n\nUsage: ${usage}\n\nEscalation: warn → delete → kick`);
            }
            if (command === 'antimentionstatus') security.setFeatureMode(command, mode === 'on' ? 'warn' : 'off');
            else security.setFeature(command, mode === 'on');
            return bigboreply(`✅ ${feature.label} is now ${mode === 'on' ? 'ON' : 'OFF'}`);
        }

        case 'antiall': {
            if (!isOwner(m) && !isCreator(m)) return bigboreply('❌ Owner only.');
            const mode = String(args[args.length - 1] || '').toLowerCase();
            if (!['on', 'off'].includes(mode)) {
                const rows = security.describe().map(r => `${r.enabled ? '✅' : '▫️'} ${r.label}`);
                const e = security.getSettings().enforcement;
                return bigboreply(`*🛡️ ANTI-FEATURES*\n\n${rows.join('\n')}\n\nEscalation: warn ${e.warn ? 'ON' : 'OFF'} · delete ${e.delete ? 'ON' : 'OFF'} · kick ${e.kick ? 'ON' : 'OFF'}\n\nUsage: ${config.prefix || '.'}antiall on|off`);
            }
            const names = security.setAll(mode === 'on');
            return bigboreply(`✅ All ${names.length} anti-features are now ${mode === 'on' ? 'ON' : 'OFF'}.`);
        }

        case 'antienforce': {
            if (!isOwner(m) && !isCreator(m)) return bigboreply('❌ Owner only.');
            const level = String(args[0] || '').toLowerCase();
            const mode = String(args[1] || '').toLowerCase();
            const e = security.getSettings().enforcement;
            if (!['warn', 'delete', 'kick'].includes(level) || !['on', 'off'].includes(mode)) {
                return bigboreply(`*Escalation*\nwarn ${e.warn ? 'ON' : 'OFF'} · delete ${e.delete ? 'ON' : 'OFF'} · kick ${e.kick ? 'ON' : 'OFF'}\n\nUsage: ${config.prefix || '.'}antienforce warn|delete|kick on|off`);
            }
            security.setEnforcement(level, mode === 'on');
            return bigboreply(`✅ ${level} enforcement is now ${mode === 'on' ? 'ON' : 'OFF'}.`);
        }

        case 'call': {
            if (!isOwner(m) && !isCreator(m)) return bigboreply('❌ Owner only.');
            /*
             * VERIFIED against the installed build: makeMessagesRecvSocket returns
             * offerCall and it is spread onto the socket, so genuine outbound 1:1
             * calling IS available. There is NO group-call API in this version, so
             * a group call is refused rather than faked with an audio message.
             */
            // Group first: that answer is about WhatsApp's protocol, so it is the
            // more useful message even if the call API were also missing.
            if (m.isGroup) {
                return bigboreply('❌ Outbound GROUP calls are not supported by this Baileys build.\n\nThe installed version exposes offerCall for a single JID only. No group-call API exists, so this is refused instead of faking a call with a voice note.');
            }
            /*
             * RINGS, BUT CARRIES NO VOICE.
             *
             * The build exposes no offerCall, so the offer is sent through the same
             * primitive the library's own rejectCall uses (see lib/outbound-call.js).
             * The far end rings for real; there is no call media stack, so nothing
             * can be heard and the call is terminated after ringing out. The reply
             * says exactly that instead of claiming a conversation.
             */
            if (!outboundCall.canCall(conn)) {
                return bigboreply('❌ This Baileys build exposes no way to send call stanzas, so outbound calling is not available.');
            }
            const target = m.quoted?.sender || (args[0] ? `${String(args[0]).replace(/[^0-9]/g, '')}@s.whatsapp.net` : m.chat);
            if (!target) return bigboreply(`Usage: send this in a DM, or quote the person with ${config.prefix || '.'}call`);
            try {
                const seconds = Number(String(args.find(a => /^\d+s?$/i.test(String(a))) || '').replace(/\D/g, '')) || 0;
                const ring = await outboundCall.offerCall(conn, target, seconds ? { ringMs: seconds * 1000 } : {});
                return bigboreply([
                    `📞 Ringing ${String(ring.to).split('@')[0]} for ${Math.round(ring.ringMs / 1000)}s…`,
                    '',
                    '⚠️ This build has no call audio path, so the call cannot carry a conversation — it rings and then drops, showing as a missed call on their end.'
                ].join('\n'));
            } catch (error) {
                console.error('[CALL] failed:', error?.stack || error);
                return bigboreply(`❌ ${error?.message || 'the call could not be started'}`);
            }
        }

        case 'antidelete':
        case 'antidelete1': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const arg = String(args[0] || '').toLowerCase();
            const mode = arg === 'all' ? String(args[1] || '').toLowerCase() : arg;
            const settings = antidelete.getSettings(conn);
            const panel = [
                `1 · in-chat repost: ${settings.antidelete ? 'ON' : 'OFF'}`,
                `2 · self DM: ${settings.antidelete2 ? 'ON' : 'OFF'}`,
                `3 · custom number: ${settings.antidelete3 || 'not set'}`,
                `4 · archive group: ${settings.antidelete4 || 'not set'}`
            ].join('\n');

            if (arg === 'all') {
                if (!['on', 'off'].includes(mode)) {
                    return bigboreply(`*🧹 ANTIDELETE*\n\n${panel}\n\nUsage: ${config.prefix || '.'}antidelete all on|off`);
                }
                const after = antidelete.setAll(conn, mode === 'on');
                const note = mode === 'off'
                    ? '\n\nDestinations were cleared, so 3 and 4 must be configured again before they can be re-enabled. Nothing is recovered while OFF.'
                    : '';
                return bigboreply(`✅ All antidelete modes are now ${mode.toUpperCase()}.\n\n1 · in-chat: ${after.antidelete ? 'ON' : 'OFF'}\n2 · self DM: ${after.antidelete2 ? 'ON' : 'OFF'}${note}`);
            }

            if (!['on', 'off'].includes(mode)) {
                return bigboreply(`*🧹 ANTIDELETE*\n\n${panel}\n\nUsage: ${config.prefix || '.'}antidelete1 on|off\n       ${config.prefix || '.'}antidelete all on|off`);
            }
            antidelete.configure(conn, 'antidelete', mode === 'on');
            return bigboreply(`✅ Antidelete 1 (in-chat) is now ${mode.toUpperCase()}.`);
        }

        case 'antidelete4': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const raw = String(args[0] || '').trim();
            const mode = String(args[1] || '').toLowerCase();
            if (raw.toLowerCase() === 'off') {
                antidelete.disable4(conn);
                return bigboreply('✅ Antidelete4 is now OFF. Nothing will be archived.');
            }
            const usage = `*🧹 ANTIDELETE 4 (archive group)*\n\nCurrent: ${antidelete.getSettings(conn).antidelete4 || 'not set'}\n\nUsage: ${config.prefix || '.'}antidelete4 <grouplink> on\n       ${config.prefix || '.'}antidelete4 off\n\nDeleted messages are forwarded to that group SILENTLY - nothing is announced in the original chat.`;
            const link = raw.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]{10,})/i);
            if (!link || mode !== 'on') return bigboreply(usage);
            if (typeof conn.groupGetInviteInfo !== 'function') {
                return bigboreply('❌ This Baileys build cannot resolve WhatsApp invite links.');
            }
            try {
                const info = await conn.groupGetInviteInfo(link[1]);
                const jid = info?.id || info?.jid;
                if (!jid) return bigboreply('❌ That invite link could not be resolved to a group.');
                // The bot must ALREADY be in the group, otherwise it cannot post
                // to it and the archive would silently fail at delivery time.
                try {
                    await conn.groupMetadata(jid);
                } catch (error) {
                    return bigboreply('❌ DARKNOTE is not a member of that group, so it cannot archive into it. Add the bot to that group first.');
                }
                antidelete.configure(conn, 'antidelete4', jid);
                return bigboreply('✅ Antidelete4 archive group set. Deleted messages will be forwarded there silently.');
            } catch (error) {
                console.error('[ANTIDELETE4] invite resolution failed:', error?.stack || error);
                return bigboreply('❌ That invite link could not be resolved. Check the link and try again.');
            }
        }

        case 'antidelete2': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const mode = String(args[0] || '').toLowerCase();
            if (!['on', 'off'].includes(mode)) return bigboreply(`Usage: ${config.prefix || '.'}antidelete2 on|off\n\nCurrent: ${antidelete.getSettings(conn).antidelete2 ? 'ON' : 'OFF'}`);
            antidelete.configure(conn, 'antidelete2', mode === 'on');
            return bigboreply(`✅ Antidelete2 is now ${mode.toUpperCase()}.`);
        }

        case 'antidelete3': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const raw = String(args[0] || '').trim();
            if (raw.toLowerCase() === 'off') {
                antidelete.disable3(conn);
                return bigboreply('✅ Antidelete3 is now OFF.');
            }
            const number = antidelete.normalizeNumber(raw);
            if (!/^\d{8,15}$/.test(number)) return bigboreply(`❌ Invalid destination number.\n\nUsage: ${config.prefix || '.'}antidelete3 2547XXXXXXXX`);
            if (number === antidelete.normalizeNumber(conn.user?.id)) return bigboreply('❌ The custom destination cannot be the paired DARKNOTE account. Use .antidelete2 for self-archive.');
            try {
                if (typeof conn.onWhatsApp === 'function') {
                    const found = await conn.onWhatsApp(number);
                    if (Array.isArray(found) && found.length && !found[0]?.jid) return bigboreply('❌ That number is not a valid WhatsApp account.');
                    if (Array.isArray(found) && found.length === 0) return bigboreply('❌ That number is not a valid WhatsApp account.');
                }
            } catch (error) {
                console.error('[ANTIDELETE3] destination validation failed:', error?.message || error);
                return bigboreply('❌ Could not validate that WhatsApp destination.');
            }
            antidelete.configure(conn, 'antidelete3', number);
            return bigboreply(`✅ Antidelete3 destination set to ${number}.`);
        }

        case 'anticall': {
            try {
                const { configure } = require('./lib/protected-anticall.js');
                await configure(args, bigboreply, isCreator, m);
            } catch (error) {
                console.error('[ANTICALL] integration error:', error?.stack || error);
                return bigboreply('❌ Failed to update AntiCall settings.');
            }
            break;
        }

        case 'antilink': {
            try {
                const { configureAntiLink } = require('./lib/protected-antilink.js');
                await configureAntiLink(conn, m, args, bigboreply);
            } catch (error) {
                console.error('[ANTILINK] integration error:', error?.stack || error);
                return bigboreply('❌ Failed to update AntiLink settings.');
            }
            break;
        }

        case 'vv2auto': {
            if (!isCreator(m)) return bigboreply('❌ Creator only.');
            const mode = String(args[0] || '').toLowerCase();
            if (!['on', 'off'].includes(mode)) return bigboreply(`Usage: ${config.prefix || '.'}vv2auto on|off\n\nCurrent: ${config.vv2Auto ? 'ON' : 'OFF'}`);
            config.vv2Auto = mode === 'on';
            fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
            await bigboreply(`✅ VV2 automatic mode is now ${config.vv2Auto ? 'ON' : 'OFF'}.`);
            break;
        }

        case 'allmenu': {
            // Modern interactive card; two buttons land on one row through the
            // global button system. Button ids are unchanged, so the existing
            // button-response handling still resolves them.
            await sendMenuCard(conn, m, menu.build(config, {
                mode: config.mode === 'self' ? 'SELF' : 'PUBLIC',
                number: String(m.sender).replace(/@.+/g, ''),
                runtime: (() => {
                    const up = process.uptime()
                    return `${Math.floor(up / 86400)}H ${Math.floor((up % 86400) / 3600)}J ${Math.floor((up % 3600) / 60)}M ${Math.floor(up % 60)}D`
                })()
            }).text, [
                { id: 'menu', text: 'ℹ️ Bot Info' },
                { id: 'owner', text: 'Owner Menu' }
            ])
            break
        }

            case 'ytvideo': {
                const query = args.join(' ').trim();
                if (!query) return bigboreply(`❌ Please provide a search query.\n\nUsage: ${config.prefix || '.'}ytvideo <song, artist, or video name>`);
                if (query.length > 150) return bigboreply('❌ Your YouTube search query is too long.');

                if (isYouTubeUrl(query)) {
                    const requestId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
                    const key = ytVideoKey(m, requestId);
                    cleanupYtVideoSelections();
                    const metadata = await resolveYtVideoMetadata(query);
                    if (!metadata?.status) {
                        console.error('[YTVIDEO] Direct URL metadata failed:', metadata?.error || 'Unknown error');
                        return bigboreply('❌ I could not read that YouTube video. Please check the URL and try again.');
                    }
                    ytVideoSelections.set(key, {
                        createdAt: Date.now(), userJid: m.sender, chat: m.chat, requestId, query,
                        results: [{ videoId: metadata.videoId || extractYouTubeId(query), url: metadata.url || query, title: metadata.title, thumbnail: metadata.thumbnail, author: metadata.author, duration: metadata.duration, timestamp: formatVideoDuration(metadata.duration), views: metadata.views }]
                    });
                    const lockKey = `${key}:0`;
                    if (ytVideoLocks.has(lockKey)) return;
                    ytVideoLocks.add(lockKey);
                    try {
                        await processSelectedYtVideo(conn, m, ytVideoSelections.get(key).results[0]);
                    } finally {
                        ytVideoLocks.delete(lockKey);
                        ytVideoSelections.delete(key);
                    }
                    break;
                }

                await bigboreply('🔎 Searching YouTube...');
                try {
                    const search = await ytSearch(query);
                    const results = (search.videos || [])
                        .filter(v => v.videoId && v.url && v.thumbnail)
                        .slice(0, 3)
                        .map(v => ({
                            videoId: v.videoId,
                            url: v.url,
                            title: v.title || 'YouTube video',
                            thumbnail: v.thumbnail,
                            author: v.author?.name || 'YouTube',
                            timestamp: v.timestamp || formatVideoDuration(v.seconds),
                            duration: Number(v.seconds || 0),
                            views: v.views || 0
                        }));
                    if (!results.length) return bigboreply('❌ No YouTube videos were found for that search.');
                    await sendYtVideoCarousel(conn, m, results, query);
                } catch (error) {
                    console.error('[YTVIDEO] Search failed:', error?.stack || error);
                    await bigboreply('❌ Failed to search YouTube. Please try again.');
                }
                break;
            }

            case 'ytvideo_select': {
                const requestId = args[0];
                const index = Number(args[1]);
                if (!requestId || !Number.isInteger(index) || index < 0 || index > 2) return bigboreply('❌ Invalid video selection.');
                cleanupYtVideoSelections();
                const key = ytVideoKey(m, requestId);
                const session = ytVideoSelections.get(key);
                if (!session || session.userJid !== m.sender || session.chat !== m.chat) return bigboreply('❌ This video selection has expired or does not belong to you. Use .ytvideo again.');
                const selected = session.results?.[index];
                if (!selected) return bigboreply('❌ This video selection is no longer available. Use .ytvideo again.');
                const lockKey = `${key}:${index}`;
                if (ytVideoLocks.has(lockKey)) return bigboreply('⏳ This video is already being processed.');
                ytVideoLocks.add(lockKey);
                try {
                    await processSelectedYtVideo(conn, m, selected);
                } finally {
                    ytVideoLocks.delete(lockKey);
                    ytVideoSelections.delete(key);
                }
                break;
            }
            /*
             * .play [song name] — AIRich HTML music card.
             *
             * With no argument it shows the built-in demo card (synthesised audio).
             *
             *     .play                        -> demo card, in-card synth
             *     .play blinding lights        -> the REAL song from YouTube
             *
             * HOW THE REAL SONG IS PLAYED. The HTML app runs in an offline sandbox:
             * no fetch, no XHR, no remote images, no <a href>. So the card can never
             * stream a YouTube URL, and a whole song as base64 would be megabytes
             * against a ~256 KB card limit. Two things together solve it:
             *
             *   1. The bot downloads the track with the SAME API `.song` uses
             *      (ytdlAutoBuffer, from lib/ytdl.js) and cuts a short mono clip,
             *      embedded in the card as base64. The in-card play button decodes
             *      that clip with Web Audio and plays the ACTUAL recording.
             *   2. The full track is then sent as a native WhatsApp audio message,
             *      which needs no tricks and plays the whole song properly.
             *
             * The card carries the real title, artist, duration and thumbnail (the
             * thumbnail inlined as a data: URI, because remote images are blocked).
             *
             * ADAPTED FROM THE SUPPLIED SNIPPET. Four identifiers were mapped:
             *
             *     mzazi      -> conn          (the socket)
             *     sender     -> m.chat        (the destination JID)
             *     logger     -> console       (BIGBRO.js has no pino logger)
             *     mzazireply -> bigboreply    (this file's local reply alias)
             *
             * AIRich is self-sufficient: like the .ping card it relays its own
             * message, so it needs no interactiveNodes() here.
             */
            /*
             * STEP 2 of the .play flow. Each result button on the picker card
             * carries the id `play_card <token> <index>`; tapping one lands here
             * with args = [token, index]. There is deliberately NO break: this
             * falls through into `case 'play'` below, which builds and sends the
             * player card. The fall-through IS the hand-off, so the card builder
             * is never duplicated.
             */
            case 'play_card': {
                const token = args[0];
                const index = Number(args[1]);
                cleanupSongSelections();
                const picked = token && Number.isInteger(index) && index >= 0
                    ? songSelections.get(songKey(m, token))?.results?.[index]
                    : null;
                if (!picked) return m.bigboreply('❌ That song selection has expired. Send .play again.');
                m.__playPicked = picked;   // read by case 'play' below
            }

            case 'play': {
                (async () => {
                    try {
                        // ═══════════════════════════════════════════════════════
                        //  IMPORTS
                        // ═══════════════════════════════════════════════════════
                        const { AIRich } = require('mzazibaileys');
                        const { spawn } = require('child_process');

                        // ── Tunables ──
                        /*
                         * CLEAR FIRST, LONG SECOND.
                         *
                         * The audio has to travel inside the markup as base64,
                         * because the HTML app runs in an offline sandbox (no fetch,
                         * no XHR). That makes the card's size the thing that limits
                         * the embed, and this card type is capped at roughly 256 KB.
                         * Measured on a 3:24 track:
                         *
                         *   opus 32k -> 1122 KB card     opus 12k ->  466 KB card
                         *   opus 16k ->  587 KB card     opus  8k ->  331 KB card
                         *                                opus  6k ->  276 KB card
                         *
                         * Spending the whole 256 KB on a full length song lands at
                         * ~3-5 kbps, which is audibly degraded. That is a trade of
                         * LENGTH against CLARITY, and the card is asked for the whole
                         * song: it renders a player with a running time, and one that
                         * stops a third of the way in reads as broken even though
                         * every byte of it is correct. The full running time is the
                         * promise, so the budget is spent on the WHOLE track at
                         * whatever rate its length allows (see the table above).
                         *
                         * A short song, which would fit whole for less than
                         * EMBED_QUALITY_BPS, is capped there instead of spending bytes
                         * on a needlessly high rate.
                         *
                         * EMBED_QUALITY_BPS is therefore a QUALITY CAP, not a floor:
                         * it can only lower the rate, never shorten the song. The one
                         * thing that still trims is a track so long that even
                         * MIN_AUDIO_BPS cannot fit it (past ~8 minutes); those cards
                         * carry the opening stretch, and the full download always
                         * accompanies the card as the audio message underneath.
                         *
                         * Opus is used because it holds up far better than MP3 at
                         * these rates.
                         */
                        const EMBED_QUALITY_BPS = 32000;
                        const CARD_BUDGET_KB = 240;
                        // markup (~18 KB measured) + thumbnail (~13 KB base64) + slack.
                        const CARD_OVERHEAD_KB = 62;
                        // The last resort for a very long track: the lowest rate the
                        // budget will be asked to carry. On its own it never shortens
                        // a song - only a track whose full length at this rate exceeds
                        // the budget is trimmed.
                        const MIN_AUDIO_BPS = 2800;
                        /*
                         * The encode is CBR (-vbr off), because a VBR encode's
                         * size depends on how well the song compresses: measured
                         * over 300 s, pink noise came out 135 KB and white noise
                         * 178 KB at the same -b:a, which makes the card size
                         * impossible to promise. CBR came out 120 KB for BOTH.
                         * CBR lands about 7% above the requested -b:a, and long
                         * frames cut the per-packet overhead that dominates at
                         * these rates, so -frame_duration 60 goes with it.
                         */
                        const CBR_OVERSHOOT = 1.12;
                        const MAX_AUDIO_BPS = 96000;

                        /* Audio bytes the card can carry once base64 inflates them by 4/3. */
                        const audioBinaryBytes = () => Math.floor(
                            Math.max(8 * 1024, (CARD_BUDGET_KB - CARD_OVERHEAD_KB) * 1024) * 3 / 4);

                        /* Highest bitrate whose base64 fits the card budget. */
                        const bitrateForDuration = (seconds) => {
                            const bps = Math.floor((audioBinaryBytes() * 8) / (Math.max(1, seconds) * CBR_OVERSHOOT));
                            return Math.min(MAX_AUDIO_BPS, Math.max(MIN_AUDIO_BPS, bps));
                        };

                        /* How many seconds of audio fit at a given bitrate. */
                        const secondsAtBitrate = (bps) => Math.floor(
                            (audioBinaryBytes() * 8) / (Math.max(1, bps) * CBR_OVERSHOOT));

                        const query = args.join(' ').trim();

                        // ── helpers ──
                        const safe = (s = '') => String(s)
                            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

                        /*
                         * Re-encode the track as small mono Opus so it can be embedded
                         * in the card as base64.
                         *
                         * `limitSeconds` is passed only for a track so long that it
                         * cannot fit a single card at any usable rate (past ~8
                         * minutes - a long SoundCloud upload, say); without the trim
                         * the base64 would run to megabytes and WhatsApp would drop
                         * the card. 0 means no trim at all, which is the normal case:
                         * every ordinary song is embedded end to end. When a track is
                         * trimmed, the FULL download still goes out as the audio
                         * message underneath, so nothing is lost.
                         */
                        const encodeAudio = (input, bitrate, limitSeconds = 0) => new Promise((resolve, reject) => {
                            let bin;
                            try { bin = require('ffmpeg-static'); }
                            catch { return reject(new Error('ffmpeg-static is unavailable')); }
                            const trim = limitSeconds > 0 ? ['-t', String(Math.floor(limitSeconds))] : [];
                            const ff = spawn(bin, [
                                '-hide_banner', '-loglevel', 'error',
                                '-i', 'pipe:0',
                                // -map 0:a:0 and -vn drop the source's attached cover
                                // art, and -map_metadata -1 drops its tags. Without
                                // these, a YouTube rip carries a 1280x720 embedded
                                // cover and the output came out at 1.4 MB instead of
                                // 100 KB - far too big to embed in the card.
                                ...trim,
                                '-map', '0:a:0', '-vn', '-map_metadata', '-1',
                                '-ac', '1', '-ar', '48000',
                                '-c:a', 'libopus', '-b:a', String(bitrate), '-vbr', 'off', '-frame_duration', '60',
                                '-f', 'ogg', 'pipe:1'
                            ], { stdio: ['pipe', 'pipe', 'pipe'] });
                            const out = [], err = [];
                            ff.stdout.on('data', (d) => out.push(d));
                            ff.stderr.on('data', (d) => err.push(d));
                            ff.on('error', reject);
                            ff.on('close', (code) => {
                                if (code === 0 && out.length) return resolve(Buffer.concat(out));
                                reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(0, 160)}`));
                            });
                            ff.stdin.on('error', () => { });
                            ff.stdin.end(input);
                        });

                        // ═══════════════════════════════════════════════════════
                        //  RESOLVE THE TRACK
                        // ═══════════════════════════════════════════════════════
                        let track = null;       // real song, when one was chosen
                        let encodedBase64 = ''; // the audio the card carries, embedded as base64
                        let songSeconds = 0;    // its length, for the timer
                        let embeddedSeconds = 0; // how much of it the card actually holds
                        /*
                         * The ORIGINAL download, kept so the full-quality track can be
                         * sent as a native audio message under the card. The card's copy
                         * is a short, clear excerpt rather than the whole song, because
                         * the markup cannot carry a full track at a listenable bitrate;
                         * the audio message is what plays the song end to end, and it is
                         * the only way to hear a track longer than what the card holds.
                         */
                        let fullTrack = null;
                        /*
                         * True when the audio is Deezer/iTunes' official 30 second
                         * preview rather than the whole YouTube track. It changes what
                         * the card claims about itself: a preview must not be labelled
                         * with the video's full running time or called the whole song.
                         */
                        let isPreview = false;
                        let audioNote = '';   // a one-line explanation sent above the card

                        /*
                         * Where the song comes from:
                         *   picked  -> the user tapped a button on the picker card
                         *              (case 'play_card' falls through into this one)
                         *   query   -> STEP 1: search, offer the picker, and stop here
                         *   neither -> the demo card, exactly as before
                         */
                        const picked = m.__playPicked;
                        delete m.__playPicked;

                        if (!picked && query) {
                            void reactSequence(conn, m, ['🎵', '🔎'], { gapMs: 250 }).catch(() => { });
                            const search = await ytSearch(query);
                            const results = (search?.videos || [])
                                .filter(v => v.videoId && v.url && v.thumbnail)
                                .slice(0, PLAY_PICKER_LIMIT)
                                .map(v => ({
                                    url: v.url,
                                    title: v.title || 'YouTube song',
                                    thumbnail: v.thumbnail,
                                    author: v.author?.name || 'YouTube',
                                    timestamp: v.timestamp || '',
                                    seconds: Number(v.seconds) || 0
                                }));
                            if (!results.length) {
                                await setReaction(conn, m, '❌');
                                return bigboreply(`❌ No song found for *${query}*.`);
                            }
                            console.log(`[PLAY] "${query}" -> ${results.length} matches, sending the picker`);
                            await sendPlayPicker(conn, m, query, results);
                            await setReaction(conn, m, '✅');
                            return;   // the player card is built once a button is pressed
                        }

                        if (picked) {
                            track = {
                                title: String(picked.title || '').slice(0, 90),
                                artist: String(picked.author || 'YouTube'),
                                duration: String(picked.timestamp || ''),
                                thumbUrl: String(picked.thumbnail || ''),
                                url: picked.url
                            };
                            console.log(`[PLAY] picked "${track.title}" (${track.duration}) -> ${track.url}`);
                            // Aliased to `video` so the download/encode block below -
                            // which was written against the search result - is unchanged.
                            const video = picked;

                            /*
                             * THE REAL SONG, in two stages.
                             *
                             *  1. The whole YouTube track, via the same downloader
                             *     .song uses. On a datacenter IP YouTube refuses this
                             *     with LOGIN_REQUIRED unless yt-dlp has cookies (see
                             *     lib/ytdl.source.js), so it usually fails here.
                             *  2. The official 30 second preview from Deezer/iTunes,
                             *     which needs no credentials at all and IS the real
                             *     recording. This is what makes the card play the actual
                             *     song instead of the synthesised stand-in.
                             *
                             * Only if BOTH fail does the card fall back to synth.
                             */
                            let audio = await ytdlAutoBuffer(track.url, 'audio');
                            if (!audio?.status || !Buffer.isBuffer(audio.buffer)) {
                                const youtubeError = audio?.error || 'no buffer';
                                console.error('[PLAY] YouTube download failed:', youtubeError);
                                /*
                                 * Hand the resolver the RAW YouTube title/channel. It
                                 * builds its own clean queries from them - passing a
                                 * channel name and a "(Lyrics)" suffix straight to a
                                 * catalogue API is exactly what found nothing before.
                                 */
                                const resolved = await ytdlSongBuffer({
                                    title: track.title,
                                    artist: track.artist,
                                    seconds: Number(video.seconds) || 0
                                });
                                if (resolved?.status && Buffer.isBuffer(resolved.buffer)) {
                                    audio = resolved;
                                    isPreview = Boolean(resolved.preview);
                                    console.log(`[PLAY] ${resolved.source} answered: "${resolved.title}" / "${resolved.artist}" (${resolved.preview ? '30s preview' : 'full, ' + Math.round(resolved.duration || 0) + 's'})`);
                                } else {
                                    console.error('[PLAY] no real audio source matched:', resolved?.error || 'unknown');
                                    audioNote = `⚠️ I could not fetch the real track, so the card below plays the synth preview instead.\n` +
                                        `YouTube: ${String(youtubeError).slice(0, 140)}`;
                                }
                            }
                            if (audio?.status && Buffer.isBuffer(audio.buffer)) {
                                fullTrack = audio;
                                /*
                                 * The length of the AUDIO, not of the YouTube video. A
                                 * preview is 30 s; a SoundCloud upload can differ from the
                                 * video it was found for, and sizing the encode from the
                                 * video's runtime would then overshoot the card budget.
                                 */
                                songSeconds = Number(audio.duration) || Number(video.seconds) || 0;
                                console.log(`[PLAY] audio ready: ${(audio.buffer.length / 1024 / 1024).toFixed(2)} MB for ${songSeconds || '?'}s`);
                                try {
                                    if (!songSeconds) throw new Error('unknown duration, cannot size the encode');
                                    /*
                                     * THE WHOLE SONG GOES IN.
                                     *
                                     * `Math.min` here, where it used to be `Math.max`:
                                     * the cap may only bring the rate DOWN to fit the
                                     * track, and never forces an excerpt by holding the
                                     * rate up. A 3:24 song therefore embeds at ~4.7 kbps
                                     * whole rather than 32 kbps for its first 30 s -
                                     * degraded mono, but the full running time, which is
                                     * what the card's player promises.
                                     *
                                     * `Math.ceil` on the ceiling, and passing 0 seconds
                                     * as the limit when the whole file fits, keep a
                                     * rounding error from shaving a second off the end
                                     * (the real audio is often a few seconds longer than
                                     * the video's metadata).
                                     */
                                    const bps = Math.min(EMBED_QUALITY_BPS, bitrateForDuration(songSeconds));
                                    const cardCeiling = Math.ceil(secondsAtBitrate(bps));
                                    const wholeSong = cardCeiling >= songSeconds;
                                    const cardSeconds = wholeSong ? songSeconds : cardCeiling;
                                    if (!wholeSong) {
                                        console.log(`[PLAY] ${songSeconds}s is too long for one card even at the ${Math.round(bps / 1000)} kbps floor - the card carries the opening ${cardSeconds}s, the full track goes out as the audio message underneath`);
                                    }
                                    // 0 = encode the download in full, with no -t trim at all.
                                    const encoded = await encodeAudio(audio.buffer, bps, wholeSong ? 0 : cardSeconds);
                                    encodedBase64 = encoded.toString('base64');
                                    embeddedSeconds = cardSeconds;
                                    const estimatedKB = (encodedBase64.length / 1024) + CARD_OVERHEAD_KB;
                                    console.log(`[PLAY] ${isPreview ? 'official preview' : 'song'} embedded: ${cardSeconds}s @ ${Math.round(bps / 1000)} kbps opus -> ${(encoded.length / 1024).toFixed(0)} KB (${(encodedBase64.length / 1024).toFixed(0)} KB base64) | card ~${estimatedKB.toFixed(0)} KB`);
                                } catch (error) {
                                    console.error('[PLAY] song could not be embedded, the card will use the synth instead:', error?.message || error);
                                }
                            }

                            /*
                             * Say which audio the card actually carries. Falling back
                             * silently is what made the card look like it was "playing
                             * the wrong song": the user taps play, hears generic music
                             * and has no way to tell the real track never arrived.
                             */
                            if (audioNote) await bigboreply(audioNote);
                        }

                        // ═══════════════════════════════════════════════════════
                        //  SONG CONFIG
                        //  Real track when we have one, otherwise the demo track.
                        // ═══════════════════════════════════════════════════════
                        const SONG = track
                            ? {
                                title: track.title,
                                artist: track.artist,
                                duration: track.duration,
                                bpm: 171,
                                thumbUrl: track.thumbUrl,
                                lyrics: []
                            }
                            : {
                                title: 'Blinding Lights',
                                artist: 'The Weeknd',
                                ytId: '4NRXx6U8ABQ',
                                bpm: 171,
                                duration: '0:25',
                                thumbUrl: '',
                                lyrics: [
                                    { t: 0.0, text: '♪ Intro ♪' },
                                    { t: 4.0, text: 'I\'ve been on my own for long enough' },
                                    { t: 8.5, text: 'Maybe you can show me how to love, maybe' },
                                    { t: 13.0, text: 'I\'m going through withdrawals' },
                                    { t: 17.5, text: 'You don\'t even have to do too much' },
                                    { t: 21.5, text: 'You can turn me on with just a touch, baby' },
                                    { t: 26.0, text: 'I look around and Sin City\'s cold and empty' },
                                    { t: 30.5, text: 'No one\'s around to judge me' },
                                    { t: 34.0, text: 'I can\'t see clearly when you\'re gone' },
                                    { t: 38.0, text: '♪ Chorus ♪' },
                                    { t: 42.0, text: 'I said, ooh, I\'m blinded by the lights' },
                                    { t: 46.5, text: 'No, I can\'t sleep until I feel your touch' },
                                    { t: 51.0, text: 'I said, ooh, I\'m drowning in the night' },
                                    { t: 55.5, text: 'Oh, when I\'m like this, you\'re the one I trust' },
                                    { t: 60.0, text: '♪ ♪ ♪' },
                                    { t: 64.0, text: 'I\'m running out of time' },
                                    { t: 68.0, text: 'Cause I can see the sun light up the sky' },
                                    { t: 72.0, text: 'So I hit the road in overdrive, baby' },
                                    { t: 76.5, text: '♪ Outro ♪' },
                                    { t: 82.0, text: '— End —' }
                                ]
                            };

                        // ── Inline the thumbnail as a data: URI ──
                        // Remote images are blocked in the sandbox, so it is fetched
                        // here and embedded.
                        let thumbData = '';
                        try {
                            const sharp = require('sharp');
                            const thumbUrl = SONG.thumbUrl || `https://i.ytimg.com/vi/${SONG.ytId}/hqdefault.jpg`;
                            const response = await fetch(thumbUrl);
                            if (response.ok) {
                                const source = Buffer.from(await response.arrayBuffer());
                                // Deliberately small: every KB the thumbnail takes is
                                // a KB the embedded audio cannot have, and the audio
                                // is the point. 480x270 q58 is ~13 KB base64 versus
                                // ~34 KB at 640x360 q68.
                                const jpeg = await sharp(source)
                                    .resize(480, 270, { fit: 'cover' })
                                    .jpeg({ quality: 58 })
                                    .toBuffer();
                                thumbData = 'data:image/jpeg;base64,' + jpeg.toString('base64');
                            }
                        } catch (error) {
                            console.error('[PLAY] thumbnail could not be inlined, using the CSS fallback:', error?.message || error);
                        }

                        const LYRICS = SONG.lyrics;
                        const lyricsJson = JSON.stringify(LYRICS);
                        // Timed lyrics only exist for the demo track. For a real song we
                        // have no timings, so the lyric panel is hidden rather than
                        // showing words that do not line up with what plays.
                        const hasTimedLyrics = LYRICS.length > 0;
                        // The timer starts from the song's length and the in-page
                        // decoder corrects it to the length of what is embedded, so
                        // an excerpt cannot make the card claim the full runtime.
                        const totalSeconds = encodedBase64
                            ? songSeconds
                            : (hasTimedLyrics ? (LYRICS[LYRICS.length - 1].t + 8) : 30);

                        const heroStyle = thumbData
                            ? `background-image:url('${thumbData}');background-size:cover;background-position:center;`
                            : 'background:linear-gradient(135deg,#1db954,#0b3d20 55%,#05050a);';
                        // The card must not claim more than it carries: a 30 s preview is
                        // labelled as one, the badge shows 30s instead of the YouTube
                        // video's full running time, and a card holding only the opening
                        // of a longer track says so rather than calling itself the song.
                        const holdsWholeTrack = encodedBase64 && embeddedSeconds >= songSeconds;
                        const sourceLabel = encodedBase64
                            ? (isPreview
                                ? 'Official preview · in-card'
                                : (holdsWholeTrack ? 'Full song · in-card' : `First ${embeddedSeconds}s · in-card`))
                            : 'Synth engine';
                        const badgeLabel = isPreview ? '0:30 preview' : (track ? (SONG.duration || 'YouTube') : 'Demo');

                        // ═══════════════════════════════════════════════════════
                        //  HTML PAYLOAD
                        // ═══════════════════════════════════════════════════════
                        const htmlPayload = `
<style>
@keyframes bgShift { 0%{background-position:0% 50%} 50%{background-position:100% 50%} 100%{background-position:0% 50%} }
@keyframes floatUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
@keyframes pulseDot { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(.75)} }
@keyframes heroPan { 0%,100%{transform:scale(1.06) translate(0,0)} 50%{transform:scale(1.12) translate(-2%,-1%)} }
@keyframes ring { 0%{transform:scale(.75);opacity:.7} 100%{transform:scale(1.9);opacity:0} }
:root{--ink:#fff;--muted:#9a9a9a;--border:rgba(255,255,255,.1);--accent:#1db954;--accent2:#1ed760;}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
html,body{margin:0;padding:0;background:transparent;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;}
.wrap{padding:10px;}
.card{position:relative;max-width:420px;margin:0 auto;border-radius:22px;overflow:hidden;background:linear-gradient(180deg,#0a0a0f 0%,#05050a 100%);border:1px solid var(--border);box-shadow:0 24px 70px rgba(0,0,0,.7);animation:floatUp .35s ease;}
.bg{position:absolute;inset:0;background:linear-gradient(135deg,rgba(29,185,84,.16),rgba(124,58,237,.1),rgba(59,130,246,.12),rgba(245,176,66,.1));background-size:400% 400%;animation:bgShift 18s ease infinite;opacity:.85;z-index:0;}
.grid{position:absolute;inset:0;background-image:radial-gradient(circle at 1px 1px,rgba(255,255,255,.05) 1px,transparent 0);background-size:24px 24px;z-index:1;opacity:.5;}
.veil{position:absolute;inset:0;background:linear-gradient(180deg,rgba(8,8,12,.85) 0%,rgba(8,8,12,.96) 50%,rgba(8,8,12,1) 100%);z-index:2;}
.content{position:relative;z-index:3;padding:20px;}
.hero{position:relative;width:100%;height:190px;border-radius:16px;overflow:hidden;border:1px solid var(--border);margin-bottom:14px;background:#000;box-shadow:0 14px 40px rgba(0,0,0,.6);}
.hero-img{position:absolute;inset:0;${heroStyle}animation:heroPan 16s ease-in-out infinite;}
.hero-shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.15) 35%,rgba(0,0,0,.82) 100%);}
.yt-badge{position:absolute;top:10px;left:10px;background:linear-gradient(135deg,#ff0033,#c1001f);color:#fff;padding:4px 10px;border-radius:6px;font-size:10px;font-weight:900;letter-spacing:1px;display:flex;align-items:center;gap:5px;z-index:3;box-shadow:0 6px 18px rgba(255,0,51,.45);}
.yt-badge svg{width:14px;height:14px;fill:#fff;}
.yt-dur{position:absolute;bottom:10px;right:12px;background:rgba(0,0,0,.82);color:#fff;padding:3px 7px;border-radius:4px;font-size:10px;font-weight:800;z-index:3;}
.yt-title{position:absolute;bottom:10px;left:12px;right:64px;color:#fff;font-size:12.5px;font-weight:900;text-shadow:0 2px 8px rgba(0,0,0,.9);z-index:3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.play-wrap{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:4;display:flex;align-items:center;justify-content:center;width:86px;height:86px;cursor:pointer;}
.play-ring{position:absolute;width:74px;height:74px;border-radius:50%;border:2px solid rgba(29,215,96,.7);animation:ring 2.1s ease-out infinite;}
.play-btn{position:relative;width:70px;height:70px;border-radius:50%;background:rgba(8,8,12,.72);border:1.5px solid rgba(255,255,255,.28);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);transition:transform .15s ease,background .2s ease;}
.play-wrap:active .play-btn{transform:scale(.9);}
.play-btn.on{background:linear-gradient(135deg,rgba(29,185,84,.92),rgba(30,215,96,.75));border-color:rgba(255,255,255,.5);}
.play-btn svg{width:30px;height:30px;fill:#fff;}
.play-btn .ic-pause{display:none;}
.play-btn.on .ic-pause{display:block;}
.play-btn.on .ic-play{display:none;}
.head{display:flex;align-items:center;gap:12px;margin-bottom:14px;}
.head-text{flex:1;min-width:0;}
.head-title{font-size:16px;font-weight:900;letter-spacing:-.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.head-sub{font-size:10px;color:var(--muted);letter-spacing:1.4px;text-transform:uppercase;font-weight:700;margin-top:3px;display:flex;align-items:center;gap:6px;}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--accent2);opacity:.35;display:inline-block;}
.live-dot.on{animation:pulseDot 1.6s ease-in-out infinite;opacity:1;}
.viz-wrap{position:relative;height:120px;border-radius:16px;overflow:hidden;background:radial-gradient(ellipse at center,rgba(29,185,84,.14),transparent 70%),linear-gradient(180deg,#07070c,#03030a);border:1px solid var(--border);margin-bottom:12px;}
#viz{display:block;width:100%;height:100%;}
.viz-glow{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at 50% 100%,rgba(30,215,96,.25),transparent 60%);opacity:.6;}
.timer{display:flex;justify-content:space-between;font-size:10px;color:var(--muted);letter-spacing:1px;font-weight:700;margin-bottom:12px;font-variant-numeric:tabular-nums;}
.lyric-btn{width:100%;padding:12px 16px;border-radius:12px;cursor:pointer;background:linear-gradient(135deg,rgba(29,185,84,.2),rgba(30,215,96,.08));border:1.5px solid var(--accent);color:var(--accent2);font-size:12px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;transition:transform .15s ease,background .2s ease;font-family:inherit;}
.lyric-btn:active{transform:scale(.98);}
.lyric-btn.on{background:linear-gradient(135deg,rgba(29,185,84,.35),rgba(30,215,96,.15));box-shadow:0 8px 24px rgba(29,185,84,.3);}
.lyrics-panel{display:none;margin-top:12px;padding:10px 4px;border-radius:14px;border:1px solid var(--border);background:rgba(255,255,255,.028);}
.lyrics-panel.open{display:block;}
.lyric-line{padding:5px 10px;font-size:13px;font-weight:600;color:rgba(255,255,255,.30);text-align:center;line-height:1.35;min-height:19px;transition:color .25s ease,transform .25s ease,font-size .25s ease;}
.lyric-line.active{color:#fff;font-size:15px;font-weight:900;text-shadow:0 0 18px var(--accent2);transform:scale(1.03);}
.lyric-line.past{color:rgba(255,255,255,.16);}
.foot{margin-top:14px;padding-top:12px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:9.5px;color:var(--muted);letter-spacing:1.2px;text-transform:uppercase;font-weight:700;flex-wrap:wrap;}
.foot b{color:var(--ink);font-weight:800;}
</style>

<div class="wrap"><div class="card">
  <div class="bg"></div>
  <div class="grid"></div>
  <div class="veil"></div>
  <div class="content">

    <div class="head">
      <div class="head-text">
        <div class="head-title">🎵 ${safe(SONG.title)}</div>
        <div class="head-sub"><span class="live-dot" id="dot"></span><span id="nowLabel">Tap play · ${safe(SONG.artist)}</span></div>
      </div>
    </div>

    <div class="hero">
      <div class="hero-img"></div>
      <div class="hero-shade"></div>
      <div class="yt-badge">
        <svg viewBox="0 0 24 24"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2C0 8.1 0 12 0 12s0 3.9.5 5.8a3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1C24 15.9 24 12 24 12s0-3.9-.5-5.8zM9.5 15.6V8.4l6.3 3.6-6.3 3.6z"/></svg>
        YouTube
      </div>
      <div class="play-wrap" id="playWrap" role="button" aria-label="Play">
        <div class="play-ring" id="playRing"></div>
        <div class="play-btn" id="playBtn">
          <svg class="ic-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          <svg class="ic-pause" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
        </div>
      </div>
      <div class="yt-title">${safe(SONG.title)}</div>
      <div class="yt-dur">${safe(badgeLabel)}</div>
    </div>

    <div class="viz-wrap">
      <canvas id="viz"></canvas>
      <div class="viz-glow"></div>
    </div>

    <div class="timer"><span id="tCur">0:00</span><span id="tDur">0:00</span></div>

    <button class="lyric-btn" id="lyricToggle"${hasTimedLyrics ? '' : ' style="display:none"'}>🎤 Show Lyrics</button>

    <div class="lyrics-panel" id="lyricsPanel"></div>

    <div class="foot">
      <div>⚡ <b>BIGBROTHER</b></div>
      <div>DARKNOTE L2</div>
    </div>

  </div>
</div></div>

<script>
(function(){
  var LYRICS      = ${lyricsJson};
  var HAS_LYRICS  = ${hasTimedLyrics ? 'true' : 'false'};
  var AUDIO_B64   = "${encodedBase64}";
  var TOTAL       = ${totalSeconds};
  var SOURCE_LBL  = "${sourceLabel}";

  var wrap     = document.getElementById('playWrap');
  var btn      = document.getElementById('playBtn');
  var ring     = document.getElementById('playRing');
  var dot      = document.getElementById('dot');
  var nowLabel = document.getElementById('nowLabel');
  var canvas   = document.getElementById('viz');
  var ctx2     = canvas.getContext('2d');
  var toggle   = document.getElementById('lyricToggle');
  var panel    = document.getElementById('lyricsPanel');
  var tCur     = document.getElementById('tCur');
  var tDur     = document.getElementById('tDur');

  /* ── five-line lyric window (the sandbox cannot scroll) ── */
  var WINDOW = 5, slots = [];
  if (HAS_LYRICS){
    for (var w = 0; w < WINDOW; w++){
      var el = document.createElement('div');
      el.className = 'lyric-line';
      panel.appendChild(el);
      slots.push(el);
    }
    toggle.addEventListener('click', function(){
      var open = panel.classList.toggle('open');
      toggle.classList.toggle('on', open);
      toggle.textContent = open ? '🎤 Hide Lyrics' : '🎤 Show Lyrics';
    });
  }
  function renderWindow(idx){
    if (!HAS_LYRICS) return;
    var mid = Math.floor(WINDOW / 2);
    for (var s = 0; s < WINDOW; s++){
      var li = idx + (s - mid), node = slots[s];
      if (li < 0 || li >= LYRICS.length){ node.textContent = ''; node.className = 'lyric-line'; continue; }
      node.textContent = LYRICS[li].text;
      node.className = 'lyric-line' + (li === idx ? ' active' : (li < idx ? ' past' : ''));
    }
  }
  renderWindow(0);

   /* ══════════════════════════════════════════════════════════════
      AUDIO.
      With a real track, AUDIO_B64 holds the WHOLE recording, at
      whatever bitrate the card's byte budget leaves for it (only a
      track too long to fit at any usable rate is cut short). It is
      decoded with Web Audio and played through a BufferSource, and
      the decoded length - not the metadata - is what the timer is
      set from, so the card never claims more than it holds. Remote URLs cannot be
      used here - the sandbox has no network at all.
      Without one, the music is synthesised in the card instead.
      ══════════════════════════════════════════════════════════════ */
  var actx = null, master = null, analyser = null, freqData = null, HAT = null;
  var playing = false, pendingPlay = false;
  var clipBuf = null, clipNode = null, clipOffset = 0, clipStart = 0, stopping = false;
  var step = 0, nextTime = 0, t0 = 0, elapsed = 0, curLine = -1;
  var USE_CLIP = AUDIO_B64.length > 0;

  var BPM  = ${Number(SONG.bpm) || 171};
  var BEAT = 60 / BPM;
  var STEP = BEAT / 2;
  var BASS  = [42, 45, 40, 47];
  var CHORD = [[66,69,73,78],[69,73,76,81],[64,68,71,76],[71,75,78,83]];

  function midi(n){ return 440 * Math.pow(2, (n - 69) / 12); }

  function decodeClip(){
    try {
      var bin = atob(AUDIO_B64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var ok = function(decoded){
        clipBuf = decoded;
        /* The decoder knows the true length of what is embedded, so it wins over
           the duration passed in from the server metadata. That keeps the timer
           honest when the embedded audio is a 30 second preview rather than the
           whole track (or when the metadata simply disagrees). */
        total = decoded.duration;
        if (tDur) tDur.textContent = fmt(total);
        if (HAS_LYRICS) spreadLyrics(decoded.duration);
        if (pendingPlay){ pendingPlay = false; beginAudio(); }
      };
      var p = actx.decodeAudioData(bytes.buffer, ok, function(){ clipBuf = null; USE_CLIP = false; });
      if (p && p.then) p.then(ok).catch(function(){ clipBuf = null; USE_CLIP = false; });
    } catch (e) { clipBuf = null; USE_CLIP = false; }
  }

  /* No lyric timings exist for a real song, so the demo lines are spread
     across the clip. Only used when timed lyrics are present. */
  var total = USE_CLIP ? TOTAL : TOTAL;
  function spreadLyrics(duration){ total = duration; }

  function initAudio(){
    if (actx) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    actx = new Ctx();
    master = actx.createGain();
    master.gain.value = 0;
    analyser = actx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.75;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    master.connect(analyser);
    analyser.connect(actx.destination);
    var len = Math.floor(actx.sampleRate * 0.1);
    HAT = actx.createBuffer(1, len, actx.sampleRate);
    var hd = HAT.getChannelData(0);
    for (var i = 0; i < len; i++) hd[i] = Math.random() * 2 - 1;
    if (USE_CLIP) decodeClip();
  }

  function tone(t, freq, dur, type, vol){
    var o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.03);
  }
  function hat(t, vol){
    var s = actx.createBufferSource(), g = actx.createGain(), hp = actx.createBiquadFilter();
    s.buffer = HAT; hp.type = 'highpass'; hp.frequency.value = 7500;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    s.connect(hp); hp.connect(g); g.connect(master);
    s.start(t); s.stop(t + 0.07);
  }
  function kick(t, vol){
    var o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.13);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.26);
  }
  function scheduler(){
    if (!playing || USE_CLIP) return;
    while (nextTime < actx.currentTime + 0.22){
      var bar = Math.floor(step / 8) % 4, s = step % 8;
      if (s === 0 || s === 4) tone(nextTime, midi(BASS[bar]), BEAT * 0.9, 'triangle', 0.42);
      tone(nextTime, midi(CHORD[bar][s % 4] + 12), STEP * 0.92, 'sawtooth', 0.085);
      hat(nextTime, s % 2 ? 0.05 : 0.10);
      if (s % 2 === 0) kick(nextTime, 0.36);
      nextTime += STEP; step++;
    }
  }

  function setPlayingUI(on){
    btn.classList.toggle('on', on);
    dot.classList.toggle('on', on);
    nowLabel.textContent = on
      ? (USE_CLIP ? 'Now Playing · ${safe(SONG.artist)}' : 'Synth · ${safe(SONG.artist)}')
      : (USE_CLIP ? 'Paused · ${safe(SONG.artist)}' : 'Tap play · ${safe(SONG.artist)}');
    ring.style.display = on ? 'none' : 'block';
  }

  function beginAudio(){
    if (USE_CLIP){
      if (!clipBuf){ pendingPlay = true; return; }
      clipNode = actx.createBufferSource();
      clipNode.buffer = clipBuf;
      clipNode.connect(master);
      stopping = false;
      clipNode.onended = function(){
        if (stopping) return;
        /* the clip finished: reset to the start, stay paused */
        playing = false; clipOffset = 0;
        master.gain.setTargetAtTime(0, actx.currentTime, 0.04);
        setPlayingUI(false);
      };
      clipNode.start(0, clipOffset);
      clipStart = actx.currentTime;
    } else {
      nextTime = actx.currentTime + 0.08;
    }
  }

  function play(){
    initAudio();
    if (actx.state === 'suspended') actx.resume();
    if (playing) return;
    playing = true;
    t0 = actx.currentTime;
    master.gain.cancelScheduledValues(actx.currentTime);
    master.gain.setTargetAtTime(0.9, actx.currentTime, 0.06);
    beginAudio();
    setPlayingUI(true);
  }
  function pause(){
    if (!playing) return;
    playing = false;
    if (USE_CLIP){
      if (clipNode){
        stopping = true;
        try { clipNode.stop(); } catch (e) { }
        clipNode = null;
      }
      clipOffset += actx.currentTime - clipStart;
      if (clipBuf && clipOffset >= clipBuf.duration - 0.05) clipOffset = 0;
    } else {
      elapsed += actx.currentTime - t0;
    }
    master.gain.cancelScheduledValues(actx.currentTime);
    master.gain.setTargetAtTime(0, actx.currentTime, 0.04);
    setPlayingUI(false);
  }

  function tap(e){
    if (e && e.preventDefault) e.preventDefault();
    if (playing) pause(); else play();
  }
  wrap.addEventListener('click', tap);
  wrap.addEventListener('touchstart', tap, { passive: false });

  function resize(){
    var dpr = window.devicePixelRatio || 1;
    var r = canvas.getBoundingClientRect();
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);

  var BARS = 40, heights = new Array(BARS).fill(0.06);
  function roundRect(c, x, y, w, h, r){
    if (h < r * 2) r = h / 2;
    if (w < r * 2) r = w / 2;
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  function draw(){
    var w = canvas.clientWidth, h = canvas.clientHeight;
    ctx2.clearRect(0, 0, w, h);
    if (analyser && playing) analyser.getByteFrequencyData(freqData);
    for (var i = 0; i < BARS; i++){
      var v;
      if (playing && freqData){
        var bin = Math.floor(Math.pow(i / BARS, 1.35) * freqData.length * 0.62);
        v = (freqData[bin] / 255) * (i < BARS * 0.3 ? 1.25 : 1);
      } else {
        v = 0.09 + Math.sin(Date.now() / 900 + i * 0.4) * 0.035;
      }
      if (v > 1) v = 1;
      heights[i] = heights[i] * 0.62 + v * 0.38;
    }
    var gap = 3, barW = (w - gap * (BARS - 1)) / BARS;
    var grad = ctx2.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, '#1db954');
    grad.addColorStop(0.55, '#1ed760');
    grad.addColorStop(1, '#a7ff83');
    ctx2.globalAlpha = playing ? 1 : 0.45;
    for (var b = 0; b < BARS; b++){
      var bh = Math.max(3, heights[b] * (h - 12));
      ctx2.fillStyle = grad;
      roundRect(ctx2, b * (barW + gap), h - bh, barW, bh, 2);
      ctx2.fill();
    }
    ctx2.globalAlpha = 1;
    ctx2.save();
    ctx2.globalAlpha = 0.13;
    ctx2.scale(1, -1);
    for (var r = 0; r < BARS; r++){
      var rh = Math.max(2, heights[r] * (h - 12) * 0.32);
      ctx2.fillStyle = '#1ed760';
      roundRect(ctx2, r * (barW + gap), -h + 1, barW, rh, 2);
      ctx2.fill();
    }
    ctx2.restore();
    requestAnimationFrame(draw);
  }

  function fmt(s){
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60), r = Math.floor(s % 60);
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  tDur.textContent = fmt(TOTAL);

  function loop(){
    var now;
    if (USE_CLIP) now = clipOffset + (playing ? (actx ? actx.currentTime - clipStart : 0) : 0);
    else now = elapsed + (playing && actx ? (actx.currentTime - t0) : 0);
    if (!isFinite(now) || now < 0) now = 0;
    tCur.textContent = fmt(now);
    if (HAS_LYRICS){
      var idx = -1;
      for (var k = 0; k < LYRICS.length; k++){ if (now >= LYRICS[k].t) idx = k; else break; }
      if (idx !== curLine){ curLine = idx; renderWindow(idx < 0 ? 0 : idx); }
    }
    requestAnimationFrame(loop);
  }

  resize();
  requestAnimationFrame(draw);
  requestAnimationFrame(loop);
  setInterval(scheduler, 55);
})();
</script>
`;

                        // ═══════════════════════════════════════════════════════
                        //  SEND — the card, then the full track
                        // ═══════════════════════════════════════════════════════
                        const rich = new AIRich(conn, { dynamic: true, unsupportedTypeAlert: false });
                        rich.addSection({
                            view_model: {
                                primitive: {
                                    __typename: 'GenAIaeacdsnwHtmlPrimitive',
                                    payload: htmlPayload,
                                    trusted_sources: ['mzazi.shop']
                                },
                                __typename: 'GenAISingleLayoutViewModel'
                            }
                        });

                        await rich.send(m.chat, {
                            quoted: m,
                            includesUnifiedResponse: true,
                            includesSubmessages: false,
                            forwarded: true,
                            notification: false
                        });

                        console.log(`[PLAY] card sent (${(htmlPayload.length / 1024).toFixed(0)} KB, thumbnail ${thumbData ? 'inlined' : 'CSS fallback'}, audio ${encodedBase64 ? `${embeddedSeconds}s in-card` : 'synth'})`);

                        /*
                         * THE FULL TRACK, UNDERNEATH THE CARD.
                         *
                         * The card's audio is the same recording, embedded whole but at
                         * whatever bitrate the card's byte budget allows (~5 kbps for a
                         * normal song). This message carries the untouched download at
                         * full quality and full length, and is what to listen to; it is
                         * sent only when a real track was downloaded, so the demo card
                         * still sends just the card.
                         */
                        if (fullTrack) {
                            try {
                                /*
                                 * Sent as OGG/Opus, the same form the card carries.
                                 *
                                 * The download is Opus already (YouTube serves it in a
                                 * WebM container), but a WebM audio message is a
                                 * container some clients will not play, and labelling
                                 * it `.mp3` made it worse. One transcode to OGG/Opus at
                                 * 64 kbps STEREO gives a file WhatsApp always plays and
                                 * that still sounds like music - the card's copy stays
                                 * mono, because it has to fit a base64 budget.
                                 *
                                 * `toOpusOgg` never throws: on any ffmpeg failure the
                                 * original bytes and their real mimetype are used, so
                                 * the song still arrives.
                                 */
                                const sent = await toOpusOgg(fullTrack.buffer, { bitrate: 64000, channels: 2 });
                                const bytes = sent?.buffer || fullTrack.buffer;
                                const opus = Boolean(sent?.opus);
                                await conn.sendMessage(m.chat, {
                                    audio: bytes,
                                    mimetype: opus ? 'audio/ogg' : (fullTrack.mimetype || 'audio/mpeg'),
                                    fileName: `${safeVideoFilename(SONG.artist + ' - ' + SONG.title)}.${opus ? 'opus' : (String(fullTrack.mimetype || '').includes('mp4') ? 'm4a' : 'webm')}`,
                                    ptt: false
                                }, { quoted: m });
                                console.log(`[PLAY] full track sent underneath (${(bytes.length / 1024 / 1024).toFixed(2)} MB, ${opus ? 'opus/ogg' : 'original container'})`);
                            } catch (error) {
                                // The card already carries the song; losing this message
                                // is not worth failing the whole command over.
                                console.error('[PLAY] could not send the full track:', error?.message || error);
                            }
                        }

                        await conn.sendMessage(m.chat, { react: { text: '🎵', key: m.key } });

                    } catch (err) {
                        console.error('[PLAY] error:', err);
                        try { await conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } }); } catch (_) { }
                        bigboreply('❌ Error: ' + (err?.message || 'unknown'));
                    }
                })();

                return;
            }

            case 'song': {
                const query = args.join(' ').trim();
                if (!query) return bigboreply(`🎵 *YouTube Song Search*\n\nUsage: ${config.prefix || '.'}song <song name>`);
                if (query.length > 100) return bigboreply('❌ Search query is too long.');
                // Music feedback while the search runs: 🎵 → 🔎 → ⏳, then ✅ / ❌.
                await reactSequence(conn, m, ['🎵', '🔎', '⏳'], { gapMs: 250 });
                await bigboreply('🔎 Searching YouTube...');
                try {
                    const search = await ytSearch(query);
                    const results = (search.videos || [])
                        .filter(v => v.videoId && v.url && v.thumbnail)
                        .slice(0, 5)
                        .map(v => ({
                            videoId: v.videoId,
                            url: v.url,
                            title: v.title || 'YouTube song',
                            thumbnail: v.thumbnail,
                            author: v.author?.name || 'YouTube',
                            timestamp: v.timestamp || 'Unknown',
                            // Kept so ytdlSongBuffer can tell the real track from the
                            // 30 s snippet and the slowed/sped-up edits of it.
                            seconds: Number(v.seconds) || 0,
                            views: v.views || 0
                        }));
                    if (!results.length) return bigboreply('❌ No YouTube songs found.');
                    await sendSongCarousel(conn, m, results);
                    await setReaction(conn, m, '✅');
                } catch (e) {
                    console.error('song search error:', e);
                    await setReaction(conn, m, '❌');
                    await bigboreply('❌ Failed to search YouTube. Please try again.');
                }
                break;
            }

            case 'song_audio': {
                const token = args[0];
                const index = Number(args[1]);
                if (!token || !Number.isInteger(index) || index < 0 || index > 4) return bigboreply('❌ Invalid song selection.');
                cleanupSongSelections();
                const selected = songSelections.get(songKey(m, token));
                if (!selected?.results?.[index]) return bigboreply('❌ This song selection has expired. Use .song again.');
                const song = selected.results[index];
                // Music feedback while the audio is fetched: 🎵 → ⏳, then ✅.
                void reactSequence(conn, m, ['🎵', '⏳'], { gapMs: 250 }).catch(() => { });
                await bigboreply(`⏳ Downloading audio...\n🎵 ${song.title}`);
                try {
                    let result = await ytdlAutoBuffer(song.url, 'audio');
                    /*
                     * Same lookup as .play: the whole YouTube track when the server
                     * is allowed to fetch it, otherwise the song resolver - which
                     * tries full-length SoundCloud first and the official 30 second
                     * preview second. See lib/ytdl.source.js.
                     */
                    if (!result?.status || !Buffer.isBuffer(result.buffer)) {
                        console.error('song audio: YouTube download failed:', result?.error || 'no buffer');
                        const resolved = await ytdlSongBuffer({
                            title: song.title, artist: song.author, seconds: Number(song.seconds) || 0
                        });
                        if (resolved?.status && Buffer.isBuffer(resolved.buffer)) result = resolved;
                    }
                    if (!result?.status || !Buffer.isBuffer(result.buffer)) {
                        await setReaction(conn, m, '❌');
                        return bigboreply(`❌ Failed to download the audio.\n${result?.error || ''}`.trim());
                    }
                    await conn.sendMessage(m.chat, {
                        audio: result.buffer,
                        mimetype: result.mimetype || 'audio/mpeg',
                        fileName: `${(result.title || song.title).replace(/[\\/:*?"<>|]/g, '').slice(0, 80)}.mp3`,
                        ptt: false
                    }, { quoted: m });
                    await setReaction(conn, m, '✅');
                } catch (e) {
                    console.error('song audio error:', e);
                    await setReaction(conn, m, '❌');
                    await bigboreply('❌ Failed to send the audio. Please try another result.');
                }
                break;
            }

            case 'igstalk':
            case 'ig': {
                try {
                    const { handleIgStalk } = require('./lib/instagram.js');
                    await handleIgStalk({ conn, m, reply: bigboreply, args });
                } catch (error) {
                    console.error('[IGSTALK] integration error:', error?.stack || error);
                    return bigboreply('❌ Instagram user information could not be retrieved.');
                }
                break;
            }

            case 'shazam': {
                // ".shazam <name>" searches by name; ".shazam" alone identifies
                // the replied audio/video with ACRCloud.
                const { handleShazam } = requireProtected('shazam');
                const query = args.join(' ').trim();
                // ⏳ while it fingerprints and searches, then ✅ / ❌ on the outcome.
                await withReaction(conn, m, () => handleShazam({ conn, m, reply: bigboreply, cards, query }));
                break;
            }

            case 'shazam_audio': {
                // AUDIO button: ask how to send it before downloading anything.
                // args = [resultIndex, sessionId].
                const { handleAudioChoiceMenu } = requireProtected('shazam');
                const index = Number(args[0]);
                const sessionId = String(args[1] || '');
                if (!Number.isInteger(index) || index < 1 || index > 5 || !/^[a-z0-9]+$/i.test(sessionId)) {
                    console.error(`[SHAZAM] rejected audio choice: index=${args[0]} session=${args[1]}`);
                    return bigboreply('❌ This Shazam result has expired. Run `.shazam` again.');
                }
                await handleAudioChoiceMenu({ conn, m, reply: bigboreply, cards, index, sessionId });
                break;
            }

            case 'shazam_play':
            case 'shazam_file':
            case 'shazam_video': {
                // Second-level choice (and VIDEO), via the existing button
                // dispatcher. args = [resultIndex, sessionId].
                const { handleSelection } = requireProtected('shazam');
                const kind = command === 'shazam_play' ? 'play' : command === 'shazam_file' ? 'file' : 'video';
                const index = Number(args[0]);
                const sessionId = String(args[1] || '');
                if (!Number.isInteger(index) || index < 1 || index > 5 || !/^[a-z0-9]+$/i.test(sessionId)) {
                    console.error(`[SHAZAM] rejected ${kind} selection: index=${args[0]} session=${args[1]}`);
                    return bigboreply('❌ This Shazam result has expired. Run `.shazam` again.');
                }
                await handleSelection({ conn, m, reply: bigboreply, kind, index, sessionId });
                break;
            }

            case 'owner':
            case 'cekowner': {
                const creator = isPrimaryCreator(m);
                const owner = isOwner(m);
                const status = creator ? '👑 You are the CREATOR' : owner ? '✅ You are an OWNER' : '❌ You are not an owner';
                // The creator is whichever number this bot is paired to.
                const paired = ownerSystem.pairedNumber(conn) || String(config.ownerNumber || '');
                const info = `Your JID: ${m.sender}\nCreator (paired number): ${paired}@s.whatsapp.net`;
                await bigboreply(`${status}\n\n${info}`);
                break;
            }

            case 'myjid':
                await bigboreply(`Your JID: ${m.sender}`);
                break;

            case 'ping': {
                /*
                 * SYSTEM DASHBOARD.
                 *
                 * The metrics and the rich HTML card live in
                 * lib/ping-dashboard.js so this dispatcher stays readable and the
                 * AIRich dependency stays out of the startup path - it is loaded
                 * lazily, only when someone actually runs .ping.
                 *
                 * sendPingDashboard never throws: when the rich primitive cannot
                 * be delivered it answers with the plain-text card, because that
                 * primitive is only rendered by clients that support it and
                 * AIRich is configured to fail silently otherwise.
                 */
                const pingResult = await pingDashboard.sendPingDashboard(conn, m, {
                    brand: config.botName || 'DARKNOTE',
                    reply: bigboreply,
                    react: emoji => setReaction(conn, m, emoji)
                });
                if (pingResult && pingResult.ok === false) {
                    console.error(`[PING] answered as text: ${pingResult.reason || 'rich card unavailable'}`);
                }
                break;
            }

            case 'info': {  
                await bigboreply(`MESSAGE INFO\n\nSender JID: ${m.sender}\nChat JID: ${m.chat}\nGroup: ${m.isGroup ? 'Yes' : 'No'}\nFrom Bot: ${m.fromMe ? 'Yes' : 'No'}\nMessage ID: ${m.id || '-'}\nText: ${m.text || '-'}`);
                break;
            }

            case 'lyrics':
            case 'ly': {
                const songQuery = Array.isArray(args) ? args.join(' ').trim() : '';
                if (!songQuery) return bigboreply(`Usage: ${config.prefix || '.'}lyrics <song name> (-) <artist name>\nExample: ${config.prefix || '.'}lyrics faded - alan walker`);
                /*
                 * "song - artist" is supported explicitly: the part before the
                 * first " - " is the title and the rest is the artist, which the
                 * lyrics endpoint takes directly and matches far more reliably
                 * than free text. A plain "song name" still works as before.
                 */
                let songTitle = songQuery;
                let songArtist = '';
                if (songQuery.includes(' - ')) {
                    const parts = songQuery.split(' - ');
                    songTitle = parts.shift().trim();
                    songArtist = parts.join(' - ').trim();
                }
                try {
                    // ⏳ while the provider calls run, then ✅ / ❌ on the outcome.
                    const result = await withReaction(conn, m, () => lyrics.geniusLyricsSearch(songQuery, {
                        title: songTitle,
                        artist: songArtist
                    }));
                    if (result.ok) return bigboreply(lyrics.formatLyrics(result));
                    if (result.code === 'NOT_FOUND') return bigboreply("☬ I couldn't find lyrics for that song.");
                    return bigboreply('☬ Lyrics service is temporarily unavailable. Try again later.');
                } catch (error) {
                    console.error('[LYRICS] command failed:', error?.message || error);
                    return bigboreply('☬ Lyrics service is temporarily unavailable. Try again later.');
                }
            }

            case 'darknote':
            case 'ai':
            case 'ask': {
                // `.ai on|off` is the DARKNOTE AI master switch. Every other use
                // of .ai, and all uses of .ask and .darknote, are ordinary
                // questions for the legacy AI chat command, which is untouched
                // below. Only the two toggle words are intercepted.
                if (command === 'ai' && ['on', 'off'].includes(String(args[0] || '').toLowerCase())) {
                    try {
                        const toggled = await aiService.runCommand(conn, m, 'ai', args, bigboreply, {
                            isOwner: isOwner(m),
                            mode: config.mode,
                            prefix: config.prefix
                        });
                        if (toggled) break;
                    } catch (error) {
                        console.error('[AI:toggle] failed:', error?.stack || error);
                        return bigboreply('❌ The AI toggle failed.');
                    }
                }
                try {
                    const aiResult = await aiChat.handleAiCommand(conn, m, args, bigboreply);
                    if (aiResult && aiResult.ok === false && aiResult.code === 'EXCEPTION') {
                        console.error('[AI] case-level failure:', aiResult.reason);
                    }
                } catch (error) {
                    console.error('[AI] failed:', error?.stack || error);
                    return bigboreply('❌ The AI chat failed. Please try again.');
                }
                break;
            }

            case 'aireset': {
                try {
                    await aiChat.handleAiReset(conn, m, bigboreply);
                } catch (error) {
                    console.error('[AIRESET] failed:', error?.stack || error);
                    return bigboreply('❌ Could not clear the AI memory for this session.');
                }
                break;
            }

            case 'aimem': {
                try {
                    await aiChat.handleAiMemory(conn, m, bigboreply);
                } catch (error) {
                    console.error('[AIMEM] failed:', error?.stack || error);
                    return bigboreply('❌ Could not read the AI memory for this session.');
                }
                break;
            }

            // DARKNOTE AI management. These are ordinary prefixed commands and
            // never auto-trigger; only conversation is prefix-free.
            //
            // Toggles: ai, aichat, aidm, aigroup, aityping, aireact, aimemory,
            // ailanguage, aitiming, aireply, aicombine, aiemoji, ainame
            // Future-module toggles: aiassistant, aimoderation, airewrite,
            // aitranslate, aifiles, aiweb, aivision, aiimage, aisticker,
            // aiimagesearch
            // Reports: aistatus, aicapabilities, aimodules, aihealth
            case 'aichat':
            case 'aidm':
            case 'aigroup':
            case 'aityping':
            case 'aireact':
            case 'ailanguage':
            case 'aitiming':
            case 'aireply':
            case 'aicombine':
            case 'aiemoji':
            case 'ainame':
            case 'aiassistant':
            case 'aimoderation':
            case 'airewrite':
            case 'aitranslate':
            case 'aifiles':
            case 'aiweb':
            case 'aivision':
            case 'aiimage':
            case 'aisticker':
            case 'aiimagesearch':
            case 'aicapabilities':
            case 'aimodules':
            case 'aihealth':
            case 'aisetup':
            case 'chatbotdelay':
            case 'replydelay':
            case 'statusview':
            case 'statuslike':
            case 'statusreact':
            case 'chatbot':
            case 'aiset':
            case 'aistatus':
            case 'aimemory':
            case 'aiforget': {
                try {
                    const handled = await aiService.runCommand(conn, m, command, args, bigboreply, {
                        isOwner: isOwner(m),
                        mode: config.mode,
                        prefix: config.prefix
                    });
                    if (!handled) return bigboreply('❌ That AI command is not available.');
                } catch (error) {
                    console.error(`[AI:${command}] failed:`, error?.stack || error);
                    return bigboreply('❌ That AI command failed.');
                }
                break;
            }

            case 'sticker':
            case 's': {
                if (!m.quoted && !args[0]) return bigboreply('Reply to an image/video or send a URL with .sticker <url>');
                let mediaBuffer;
                if (m.quoted && (m.quoted.mtype === 'imageMessage' || m.quoted.mtype === 'videoMessage')) {
                    mediaBuffer = await m.quoted.download();
                } else if (args[0] && args[0].match(/https?:\/\//)) {
                    const res = await fetch(args[0]);
                    mediaBuffer = Buffer.from(await res.arrayBuffer());
                } else return bigboreply('Unknown format. Reply to media or send a URL.');
                if (!mediaBuffer) return bigboreply('Failed to retrieve media.');
                const type = await fileTypeFromBuffer(mediaBuffer);
                if (!type || (!/image/.test(type.mime) && !/video/.test(type.mime))) return bigboreply('Only images or videos are supported.');
                await bigboreply('Creating sticker...');
                try {
                    const stickerBuffer = await writeExif(mediaBuffer, { packname: 'Sticker Bot', author: 'Bigbrother', cropToSquare: false });
                    await conn.sendMessage(m.chat, { sticker: stickerBuffer }, { quoted: m });
                } catch (err) {
                    console.error(err);
                    await bigboreply('Failed to create sticker: ' + err.message);
                }
                break;
            }

            /*
             * SMART IMAGE & STICKER RE-EDIT.
             *
             * All four names share ONE handler, so there is no way for two of
             * them to disagree or for one instruction to run twice. The media
             * kind is detected from the reply; output type follows the input
             * unless the user asked for a sticker explicitly.
             *
             * The whole pipeline lives in lib/image-edit.js - this case only
             * validates usage and reports the outcome.
             */
            case 'edit':
            case 'reedit':
            case 'editsticker':
            case 'editphoto': {
                const editPrefix = config.prefix || '.';
                const usage = [
                    '🎨 *SMART RE-EDIT*',
                    '',
                    `Reply to a photo or sticker, then describe the change:`,
                    `${editPrefix}edit make the background a beach`,
                    `${editPrefix}edit add sunglasses and a gold chain`,
                    `${editPrefix}edit badilisha background iwe beach`,
                    '',
                    `*Commands*`,
                    `${editPrefix}edit <instruction>  (photo or sticker)`,
                    `${editPrefix}reedit <instruction>`,
                    `${editPrefix}editphoto <instruction>  (reply to a photo)`,
                    `${editPrefix}editsticker <instruction>  (get a sticker back)`,
                    '',
                    `Add "make this a sticker" to get a sticker from a photo.`
                ].join('\n');

                const instruction = args.join(' ').trim();
                const quoteType = String(m.quoted?.mtype || '');
                const quotedIsMedia = /image|sticker/i.test(quoteType);

                // No replied media -> help, never a crash.
                if (!m.quoted || !quotedIsMedia) return bigboreply(usage);
                if (!instruction) {
                    return bigboreply(`Tell me what to change.\n\nExample: ${editPrefix}edit make it cinematic and dark`);
                }

                const forceOutput = command === 'editsticker' ? 'sticker'
                    : command === 'editphoto' ? 'image'
                        : '';

                try {
                    await bigboreply('🎨 Editing...');
                } catch (error) {
                    console.error('[EDIT] progress reply failed:', error?.message || error);
                }

                // reedit() never throws: it returns a result with a friendly
                // message, so a bad API day cannot take the dispatcher down.
                const editResult = await imageEdit.reedit(conn, m, instruction, { output: forceOutput });
                if (!editResult.ok) {
                    if (editResult.code === 'duplicate') break;   // already answering; stay silent
                    return bigboreply(`❌ ${editResult.message || imageEdit.FAILURES.generate_failed}`);
                }
                // The result itself was already sent as an image/sticker.
                break;
            }

            // Owner-only capability report for the re-edit backend.
            case 'editstatus': {
                if (!isOwner(m)) return bigboreply('❌ Owner only.');
                await imageEdit.probeCapabilities(true);
                return bigboreply(imageEdit.statusText());
            }

            case 'addowner': {
                if (!isOwner(m)) return bigboreply('Owner only');
                let target = args[0];
                if (m.mentionedJid?.[0]) target = m.mentionedJid[0];
                if (!target) return bigboreply(`Usage: ${config.prefix || '.'}addowner 2547XXXXXXXX`);
                const result = ownerSystem.addOwner(target, config, conn);
                if (!result.ok) {
                    const messages = { invalid: '❌ Provide a valid WhatsApp number.', self: '❌ The bot account is already the paired session and does not need to be added as an owner.', primary: '❌ The primary creator is already an owner.', exists: 'ℹ️ That number is already an owner.' };
                    return bigboreply(messages[result.code] || '❌ Could not add that owner.');
                }
                return bigboreply(`✅ Owner added successfully\n${result.number}`);
            }

            case 'delowner': {
                if (!isOwner(m)) return bigboreply('Owner only');
                let target = args[0];
                if (m.mentionedJid?.[0]) target = m.mentionedJid[0];
                if (!target) return bigboreply(`Usage: ${config.prefix || '.'}delowner 2547XXXXXXXX`);
                const result = ownerSystem.removeOwner(target, config, conn);
                if (!result.ok) {
                    const messages = { invalid: '❌ Provide a valid WhatsApp number.', primary: '❌ The primary creator cannot be removed.', missing: 'ℹ️ That number is not an added owner.' };
                    return bigboreply(messages[result.code] || '❌ Could not remove that owner.');
                }
                return bigboreply(`✅ Owner removed successfully\n${result.number}`);
            }

            case 'addprem': {
                if (!isOwner(m)) return bigboreply('Owner only');
                let target = args[0];
                if (m.mentionedJid?.[0]) target = m.mentionedJid[0];
                if (!target) return bigboreply('Example: .addprem 628xxx');
                const premiumDB = readJSON(premiumPath);
                const num = getNumber(target);
                if (premiumDB.includes(num)) return bigboreply('Already premium');
                premiumDB.push(num);
                saveJSON(premiumPath, premiumDB);
                bigboreply(`Premium added successfully\n${num}`);
                break;
            }

            case 'delprem': {
                if (!isOwner(m)) return bigboreply('Owner only');
                let target = args[0];
                if (m.mentionedJid?.[0]) target = m.mentionedJid[0];
                if (!target) return bigboreply('Example: .delprem 628xxx');
                const premiumDB = readJSON(premiumPath);
                const num = getNumber(target);
                const filtered = premiumDB.filter(v => v !== num);
                saveJSON(premiumPath, filtered);
                bigboreply(`Premium removed successfully\n${num}`);
                break;
            }

            case 'eval': {
                if (!isCreator(m)) return bigboreply('Creator only');
                const code = args.join(' ');
                if (!code) return bigboreply('Example:\n.eval 1+1');
                await executeEval(code, conn, m);
                break;
            }
            
           case 'public': {
    if (!isOwner(m)) return bigboreply('Owner only')

    config.mode = 'public'
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2))

    bigboreply('Mode changed to public successfully')
}
           break

           case 'self': {
    if (!isOwner(m)) return bigboreply('Owner only')

    config.mode = 'self'
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2))

    bigboreply('Mode changed to self successfully')
}
           break
           
           
            default:
                break;
        }
    } catch (err) {
        console.error('Error in command handler:', err);
    }
};

module.exports.handleAutomaticViewOnce = handleAutomaticViewOnce;

// Status automation is kept in this existing dispatcher module so the bot still
// has one central message pipeline.
const statusQueues = new WeakMap();
function statusAutomationSettings() {
    config.statusAutomation = config.statusAutomation || {};
    if (!config.statusAutomation.avs) config.statusAutomation.avs = { enabled: false };
    if (!config.statusAutomation.als) config.statusAutomation.als = { enabled: false };
    if (!config.statusAutomation.ars) config.statusAutomation.ars = { enabled: false, emoji: '😊' };
    return config.statusAutomation;
}
async function performStatusAction(conn, item, type) {
    try {
        if (!item?.key || item.key.remoteJid !== 'status@broadcast') return;

        /*
         * A closed or retired socket has nothing to act on.
         *
         * Replacing a pairing closes the old socket while queued status work is
         * still in flight, and without this guard each queued item threw
         * "Connection Closed" and was logged as a failure - noise that looked
         * like a bug but was really work aimed at a socket that no longer
         * existed.
         */
        if (conn?.__darknoteRetired || (conn?.__darknoteConnectionState && conn.__darknoteConnectionState !== 'open')) {
            return;
        }

        /*
         * Resolve WHO posted this Status before acting on it.
         *
         * The participant is often a LID, not a phone number, and a LID's digits
         * must never be turned into a phone JID - that is what produced the
         * "not-acceptable" rejections. See lib/status-author.js.
         */
        const author = await statusAuthor.resolveStatusAuthor(conn, item);
        // Never act on the paired account's own Status.
        if (statusAuthor.isOwnStatus(conn, author)) return;

        if (type === 'avs') {
            if (typeof conn.readMessages !== 'function') {
                console.error('[AVS] this build does not expose readMessages');
                return;
            }
            await conn.readMessages([item.key]);
            console.log('[AVS] status marked as read');
            return;
        }

        const key = item.key.participant ? item.key : { ...item.key, participant: item.participant || undefined };
        const text = type === 'als' ? '❤️' : (statusAutomationSettings().ars.emoji || '😊');

        /*
         * Reacting to a Status needs the author on the key, and the RECIPIENT
         * list must name a real phone-number JID.
         *
         * `statusJidList` is used to assert sessions, so a LID in it is rejected
         * with "not-acceptable" before the reaction is ever sent. It therefore
         * carries the resolved phone number when there is one, and is omitted
         * entirely when it is not known - letting the server pick the recipients
         * instead of handing it a LID that is guaranteed to fail.
         */
        try {
            const options = author.pn ? { statusJidList: [author.pn] } : {};
            await conn.sendMessage('status@broadcast', { react: { text, key } }, options);
            console.log(`[${type.toUpperCase()}] reacted with ${text}`);
            return;
        } catch (error) {
            console.error(`[${type.toUpperCase()}] broadcast reaction failed, trying the author directly:`, error?.message || error);
        }

        /*
         * Address the author directly - ONLY with a resolved phone-number JID.
         * Turning a LID's digits into `<digits>@s.whatsapp.net` invents a JID
         * that does not exist, which is what produced the second rejection.
         */
        if (!author.pn) {
            const who = author.lid || author.raw;
            console.error(who
                ? `[${type.toUpperCase()}] cannot react to the status from ${who}: a LID with no known phone number`
                : `[${type.toUpperCase()}] cannot react to this status: its author could not be identified`);
            return;
        }
        await conn.sendMessage(author.pn, { react: { text, key } });
        console.log(`[${type.toUpperCase()}] reacted with ${text}`);
    } catch (error) {
        const reason = error?.message || String(error);
        /*
         * "not-acceptable" is an assertSessions rejection from WhatsApp, not a
         * defect here: it means the Status author has no established session.
         * One line says that; a twelve-frame stack says nothing extra and buries
         * the rest of the console. Anything else still gets the full stack.
         */
        if (/not-acceptable/i.test(reason)) {
            console.error(`[${type.toUpperCase()}] status action rejected by WhatsApp (not-acceptable)`);
        } else {
            console.error(`[${type.toUpperCase()}] status action failed:`, error?.stack || error);
        }
    }
}
function enqueueStatusAutomation(conn, item) {
    if (!item?.key || item.key.remoteJid !== 'status@broadcast') return;
    const settings = statusAutomationSettings();
    if (!settings.avs.enabled && !settings.als.enabled && !settings.ars.enabled) return;
    let state = statusQueues.get(conn);
    if (!state) { state = { seen: new Set(), queues: { avs: [], als: [], ars: [] }, running: false }; statusQueues.set(conn, state); }
    const key = `${item.key.remoteJid}:${item.key.participant || ''}:${item.key.id}`;
    if (state.seen.has(key)) return;
    state.seen.add(key);
    if (state.seen.size > 1000) state.seen.delete(state.seen.values().next().value);
    /*
     * LIKE AND REACT ARE THE SAME PROTOCOL ACTION. WhatsApp has no separate
     * "like" for a status - a like IS a reaction, just always the heart. So when
     * both are switched on we send ONE reaction instead of two, with react
     * taking precedence because it carries the configured emoji. Sending both
     * would silently overwrite itself and look like nothing happened.
     */
    const reactEnabled = settings.ars?.enabled === true;
    const likeEnabled = settings.als?.enabled === true;
    if (settings.avs?.enabled === true) state.queues.avs.push(item);   // view is independent
    if (reactEnabled) state.queues.ars.push(item);
    else if (likeEnabled) state.queues.als.push(item);

    const planned = ['view', reactEnabled ? 'react' : (likeEnabled ? 'like' : null)].filter(Boolean).join(' + ');
    console.log(`[STATUS AUTOMATION] queued a status from ${String(item.key.participant || 'unknown')} -> ${planned}`);
    if (state.running) return;
    state.running = true;
    const run = async () => {
        while (state.queues.avs.length || state.queues.als.length || state.queues.ars.length) {
            /*
             * Stop the whole loop when the socket is gone, instead of working
             * through the remaining items one at a time. Each item would throw,
             * and the loop waits 10 seconds between items, so a retired socket
             * could spin for minutes producing errors and doing nothing.
             */
            if (conn?.__darknoteRetired || (conn?.__darknoteConnectionState && conn.__darknoteConnectionState !== 'open')) {
                state.queues = { avs: [], als: [], ars: [] };
                console.log('[STATUS AUTOMATION] stopped: the socket is no longer open.')
                break;
            }
            const current = statusAutomationSettings();
            for (const type of ['avs', 'als', 'ars']) {
                if (!current[type].enabled || !state.queues[type].length) continue;
                const next = state.queues[type].shift();
                /*
                 * EVERY ACTION IS BOUNDED.
                 *
                 * The loop awaits each action in turn, so one call that never
                 * settles leaves `running` true for good and silently disables
                 * status automation until the bot is restarted - the queue keeps
                 * filling and nothing is ever acted on. That was observed as a
                 * status that was queued and then produced neither a view nor a
                 * reaction, with no error to explain it.
                 *
                 * A read receipt for a Status the server will not acknowledge is
                 * the realistic way to hang here, but any of these calls can
                 * stall, so the ceiling covers all of them rather than one case.
                 */
                let timer;
                try {
                    await Promise.race([
                        performStatusAction(conn, next, type),
                        new Promise((_, reject) => {
                            timer = setTimeout(() => reject(new Error(`${type} action did not settle within 20s`)), 20000);
                        })
                    ]);
                } catch (error) {
                    console.error(`[STATUS AUTOMATION] ${type} action abandoned:`, error?.message || error);
                } finally {
                    clearTimeout(timer);
                }
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        }
        state.running = false;
    };
    void run().catch(error => { state.running = false; console.error('[STATUS AUTOMATION] queue failed:', error?.stack || error); });
}
module.exports.enqueueStatusAutomation = enqueueStatusAutomation;
module.exports.recordGroupActivity = groupFeatures.recordMessage;
module.exports.cachePresence = groupFeatures.cachePresence;
