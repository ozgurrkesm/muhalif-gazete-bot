import TelegramBot from 'node-telegram-bot-api';
import RssParser from 'rss-parser';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';
import { spawn, spawnSync } from 'child_process';
import os from 'os';
import OpenAI from 'openai';

  // ── Telegram Userbot (@vide entegrasyonu) ─────────────────────────────────────
  let _userbotClient = null;
  let _userbotConnecting = false;

  async function getUserbotClient() {
    if (_userbotClient) return _userbotClient;
    if (_userbotConnecting) return null;
    const apiId = parseInt(process.env.TG_API_ID || '');
    const apiHash = process.env.TG_API_HASH || '';
    const sessionStr = process.env.TG_SESSION || '';
    if (!apiId || !apiHash || !sessionStr) return null;

    try {
      _userbotConnecting = true;
      const { TelegramClient } = await import('telegram');
      const { StringSession } = await import('telegram/sessions/index.js');
      const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
        connectionRetries: 3,
        retryDelay: 1000,
      });
      await client.connect();
      _userbotClient = client;
      console.log('✅ Userbot bağlandı (@vide hazır)');
      return client;
    } catch (e) {
      console.error('❌ Userbot bağlantı hatası:', e.message);
      return null;
    } finally {
      _userbotConnecting = false;
    }
  }

  async function downloadVideoViaVide(videoUrl) {
    const client = await getUserbotClient().catch(() => null);
    if (!client) return null;

    try {
      console.log(`📩 @vide'ye gönderiliyor: ${videoUrl.slice(0, 60)}`);
      await client.sendMessage('@vide', { message: videoUrl });

      // Yanıt için 120 sn bekle (3 sn aralıklarla kontrol)
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const messages = await client.getMessages('@vide', { limit: 3 });
        const videoMsg = messages.find(m =>
          m.media && (m.media.className === 'MessageMediaDocument' || m.media.className === 'MessageMediaVideo')
        );
        if (videoMsg) {
          console.log('📥 @vide video yanıtı alındı, indiriliyor...');
          const tmpDir = path.join(os.tmpdir(), `vide_${Date.now()}`);
          fs.mkdirSync(tmpDir, { recursive: true });
          const tmpFile = path.join(tmpDir, 'video.mp4');
          await client.downloadMedia(videoMsg.media, { outputFile: tmpFile });
          console.log('✅ @vide video indirildi:', tmpFile);
          return tmpFile;
        }
      }
      console.log('⏰ @vide 120sn içinde yanıt vermedi');
      return null;
    } catch (e) {
      console.error('❌ @vide hatası:', e.message);
      return null;
    }
  }
  

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERS_FILE = path.join(__dirname, 'users.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const PUBLISHED_FILE = path.join(__dirname, 'published.json');

const aiClient = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || 'dummy',
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID || '@muhalif_gazete';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin2024';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN eksik!');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, {
  polling: { interval: 100, autoStart: true, params: { timeout: 10, limit: 100, allowed_updates: ['message','callback_query','channel_post','inline_query'] } },
});

// ─── Ayarlar Yönetimi ─────────────────────────────────────────────────────────

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch {}
  return {
    intervalMinutes: 1.5,
    activeCategory: 'hepsi',
    adminChatIds: [],
    paused: false,
    maxAgeHours: 24,
    publishStartHour: 9,
    publishEndHour: 2,
  };
}

function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

let settings = loadSettings();
if (settings.maxAgeHours === undefined) settings.maxAgeHours = 24;
if (settings.publishStartHour === undefined) settings.publishStartHour = 9;
if (settings.publishEndHour === undefined) settings.publishEndHour = 2;

// ─── Kullanıcı Yönetimi ───────────────────────────────────────────────────────

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

let users = loadUsers();

function getUser(chatId) {
  if (!users[chatId]) users[chatId] = { name: '', filters: [] };
  return users[chatId];
}

function addFilter(chatId, keyword) {
  const user = getUser(chatId);
  const kw = keyword.toLowerCase().trim();
  if (!kw || user.filters.includes(kw)) return false;
  user.filters.push(kw);
  saveUsers(users);
  return true;
}

function removeFilter(chatId, keyword) {
  const user = getUser(chatId);
  const kw = keyword.toLowerCase().trim();
  const idx = user.filters.indexOf(kw);
  if (idx === -1) return false;
  user.filters.splice(idx, 1);
  saveUsers(users);
  return true;
}

function clearFilters(chatId) {
  getUser(chatId).filters = [];
  saveUsers(users);
}

function isAdmin(chatId) {
  const id = String(chatId);
  // Ortam değişkeninden kalıcı admin (Railway restart'larında kaybolmaz)
  if (ADMIN_CHAT_ID && id === String(ADMIN_CHAT_ID)) return true;
  return settings.adminChatIds.includes(id);
}

// Admin'e Telegram üzerinden log gönder (video/hata takibi için)
async function tgLog(text) {
  const adminId = ADMIN_CHAT_ID || settings.adminChatIds[0];
  if (!adminId) return;
  try {
    await bot.sendMessage(adminId, `🔧 ${text.slice(0, 3000)}`);
  } catch {}
}

// ─── RSS + YouTube Kaynakları ─────────────────────────────────────────────────

const RSS_FEEDS = [
  // ── Muhalif / Bağımsız Haber Kaynakları ──────────────────────────────────
  {
    url: 'https://news.google.com/rss/search?q=site:ankaajans.com&hl=tr&gl=TR&ceid=TR:tr',
    label: '📡 ANKA Ajans',
    source: 'ANKA',
    type: 'google',
    category: 'politika',
  },
  {
    url: 'https://www.cumhuriyet.com.tr/rss/son_dakika.xml',
    label: '🗞 Cumhuriyet',
    source: 'Cumhuriyet',
    type: 'direct',
    category: 'genel',
  },
  {
    url: 'https://www.cumhuriyet.com.tr/rss/4',
    label: '🌍 Cumhuriyet | Dünya',
    source: 'Cumhuriyet',
    type: 'direct',
    category: 'dunya',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:sozcu.com.tr&hl=tr&gl=TR&ceid=TR:tr',
    label: '🗞 Sözcü',
    source: 'Sözcü',
    type: 'google',
    category: 'genel',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:halktv.com.tr&hl=tr&gl=TR&ceid=TR:tr',
    label: '📺 Halk TV',
    source: 'Halk TV',
    type: 'google',
    category: 'politika',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:krttv.com.tr&hl=tr&gl=TR&ceid=TR:tr',
    label: '📺 KRT TV',
    source: 'KRT TV',
    type: 'google',
    category: 'politika',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:t24.com.tr&hl=tr&gl=TR&ceid=TR:tr',
    label: '🗞 T24',
    source: 'T24',
    type: 'google',
    category: 'genel',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:gazeteduvar.com.tr&hl=tr&gl=TR&ceid=TR:tr',
    label: '🗞 Gazete Duvar',
    source: 'Gazete Duvar',
    type: 'google',
    category: 'politika',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:birgun.net&hl=tr&gl=TR&ceid=TR:tr',
    label: '🗞 BirGün',
    source: 'BirGün',
    type: 'google',
    category: 'politika',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:odatv.com&hl=tr&gl=TR&ceid=TR:tr',
    label: '🗞 OdaTV',
    source: 'OdaTV',
    type: 'google',
    category: 'politika',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:tele1.com.tr&hl=tr&gl=TR&ceid=TR:tr',
    label: '📺 Tele1',
    source: 'Tele1',
    type: 'google',
    category: 'politika',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:artigercek.com&hl=tr&gl=TR&ceid=TR:tr',
    label: '🗞 Artı Gerçek',
    source: 'Artı Gerçek',
    type: 'google',
    category: 'politika',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:bianet.org&hl=tr&gl=TR&ceid=TR:tr',
    label: '🗞 Bianet',
    source: 'Bianet',
    type: 'google',
    category: 'genel',
  },
  // ── Genel / Ekonomi ────────────────────────────────────────────────────────
  {
    url: 'https://news.google.com/rss/search?q=site:dha.com.tr&hl=tr&gl=TR&ceid=TR:tr',
    label: '📡 DHA',
    source: 'DHA',
    type: 'google',
    category: 'genel',
  },
  {
    url: 'https://www.ntv.com.tr/son-dakika.rss',
    label: '📺 NTV',
    source: 'NTV',
    type: 'direct',
    category: 'genel',
  },
  // ── Spor Kaynakları ────────────────────────────────────────────────────────
  {
    url: 'https://www.sporx.com/rss/',
    label: '⚽ Sporx',
    source: 'Sporx',
    type: 'direct',
    category: 'spor',
  },
  {
    url: 'https://www.ntvspor.net/rss',
    label: '📺 NTV Spor',
    source: 'NTV Spor',
    type: 'direct',
    category: 'spor',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:fanatik.com.tr&hl=tr&gl=TR&ceid=TR:tr',
    label: '⚽ Fanatik',
    source: 'Fanatik',
    type: 'google',
    category: 'spor',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:milliyet.com.tr+spor&hl=tr&gl=TR&ceid=TR:tr',
    label: '⚽ Milliyet Spor',
    source: 'Milliyet',
    type: 'google',
    category: 'spor',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:goal.com+tr&hl=tr&gl=TR&ceid=TR:tr',
    label: '⚽ Goal Türkiye',
    source: 'Goal',
    type: 'google',
    category: 'spor',
  },
  {
    url: 'https://news.google.com/rss/search?q=galatasaray+OR+fenerbahce+OR+besiktas+OR+trabzonspor&hl=tr&gl=TR&ceid=TR:tr',
    label: '⚽ Süper Lig Haberleri',
    source: 'Google Spor',
    type: 'google',
    category: 'spor',
  },
  // ── Muhalif YouTube Kanalları ──────────────────────────────────────────────
  {
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCf_ResXZzE-o18zACUEmyvQ',
    label: '▶️ Halk TV YouTube',
    source: 'Halk TV',
    type: 'youtube',
    category: 'video',
  },
  {
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCbq0bGdShXK5dMzEDU7nThA',
    label: '▶️ NOW Haber YouTube',
    source: 'NOW Haber',
    type: 'youtube',
    category: 'video',
  },
  {
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCo_RGmsTwCBt6VIgU0IQEHA',
    label: '▶️ Tele1 YouTube',
    source: 'Tele1',
    type: 'youtube',
    category: 'video',
  },
  {
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCpHBnE7RdmHCopCJEDYkiEA',
    label: '▶️ CHP TV YouTube',
    source: 'CHP TV',
    type: 'youtube',
    category: 'video',
  },
  {
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCYXe_Lq4D_MAlNUH_VJEGWg',
    label: '▶️ KRT TV YouTube',
    source: 'KRT TV',
    type: 'youtube',
    category: 'video',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:sozcu.com.tr+video&hl=tr&gl=TR&ceid=TR:tr',
    label: '▶️ Sözcü Video',
    source: 'Sözcü',
    type: 'google',
    category: 'video',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:krttv.com.tr+video&hl=tr&gl=TR&ceid=TR:tr',
    label: '▶️ KRT Video',
    source: 'KRT TV',
    type: 'google',
    category: 'video',
  },
];

const CATEGORY_LABELS = {
  hepsi: '🌐 Hepsi',
  genel: '📰 Genel',
  spor: '⚽ Spor',
  ekonomi: '💰 Ekonomi',
  dunya: '🌍 Dünya',
  teknoloji: '💻 Teknoloji',
  politika: '🏛 Politika',
  video: '▶️ Video',
};

const INTERVAL_OPTIONS = [1, 1.5, 3, 5, 10, 15, 30];

  // ─── Son Dakika Hızlı Tarama ─────────────────────────────────────────────────

  const BREAKING_NEWS_KEYWORDS = [
    'son dakika', 'acil', 'flaş', 'flash', 'breaking',
    'deprem', 'patlama', 'bomba', 'saldırı', 'terör',
    'yangın', 'sel', 'fırtına', 'tsunami',
    'vefat etti', 'hayatını kaybetti', 'öldürüldü',
    'istifa etti', 'istifa', 'gözaltı', 'tutuklandı', 'tutuklama',
    'acil toplantı', 'olağanüstü', 'alarm',
  ];

  const BREAKING_NEWS_FEEDS = [
    {
      url: 'https://news.google.com/rss/search?q=%22son+dakika%22+&hl=tr&gl=TR&ceid=TR:tr',
      label: '🚨 Google Son Dakika',
      source: 'Son Dakika',
      type: 'google',
      category: 'genel',
    },
    {
      url: 'https://www.cumhuriyet.com.tr/rss/son_dakika.xml',
      label: '🚨 Cumhuriyet Son Dakika',
      source: 'Cumhuriyet',
      type: 'direct',
      category: 'genel',
    },
    {
      url: 'https://news.google.com/rss/search?q=%22son+dakika%22+site:t24.com.tr&hl=tr&gl=TR&ceid=TR:tr',
      label: '🚨 T24 Son Dakika',
      source: 'T24',
      type: 'google',
      category: 'genel',
    },
    {
      url: 'https://news.google.com/rss/search?q=%22son+dakika%22+site:sozcu.com.tr&hl=tr&gl=TR&ceid=TR:tr',
      label: '🚨 Sözcü Son Dakika',
      source: 'Sözcü',
      type: 'google',
      category: 'genel',
    },
    {
      url: 'https://news.google.com/rss/search?q=%22son+dakika%22+site:cumhuriyet.com.tr&hl=tr&gl=TR&ceid=TR:tr',
      label: '🚨 Cumhuriyet SD Google',
      source: 'Cumhuriyet',
      type: 'google',
      category: 'genel',
    },
    {
      url: 'https://news.google.com/rss/search?q=%22son+dakika%22+site:haberler.com&hl=tr&gl=TR&ceid=TR:tr',
      label: '🚨 Haberler.com Son Dakika',
      source: 'Haberler.com',
      type: 'google',
      category: 'genel',
    },
  ];

  function isBreakingNews(title) {
    if (!title) return false;
    const lower = title.toLowerCase();
    return BREAKING_NEWS_KEYWORDS.some(kw => lower.includes(kw));
  }

  

// ─── RSS Parser ───────────────────────────────────────────────────────────────

const parser = new RssParser({
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: false }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
      ['enclosure', 'enclosure', { keepArray: false }],
      ['yt:videoId', 'videoId'],
      ['media:group', 'mediaGroup', { keepArray: false }],
    ],
  },
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
    'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml',
  },
});

// ─── Konu Takip Sistemi ───────────────────────────────────────────────────────

const recentTopicMessages = new Map();
const TOPIC_EXPIRE_MS = 3 * 60 * 60 * 1000;

const TR_STOP_WORDS = new Set([
  've','ile','de','da','ki','bu','bir','için','olan','olan','o','bu','şu','ne','çok',
  'daha','ya','veya','ama','fakat','ancak','sadece','bile','gibi','kadar','sonra',
  'önce','haber','haberi','haberler','açıkladı','dedi','söyledi','yaptı','oldu',
  'olan','olarak','üzerine','bakanlığı','başkanlığı','genel','müdürlüğü',
]);

function extractTopicWords(title) {
  return title.toLowerCase()
    .replace(/[^a-züöşçğıéàâêîô\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !TR_STOP_WORDS.has(w));
}

function topicKey(words) {
  return [...new Set(words)].sort().join('|');
}

function registerSentMessage(messageId, title) {
  const words = extractTopicWords(title);
  if (words.length === 0) return;
  const key = topicKey(words.slice(0, 6));
  recentTopicMessages.set(key, { messageId, title, publishedAt: Date.now() });
}

function findRelatedMessageId(title) {
  const now = Date.now();
  const words = new Set(extractTopicWords(title));
  if (words.size === 0) return null;

  let bestId = null;
  let bestOverlap = 0;
  let bestTime = 0;

  for (const [, entry] of recentTopicMessages) {
    if (now - entry.publishedAt > TOPIC_EXPIRE_MS) continue;
    const entryWords = extractTopicWords(entry.title);
    const overlap = entryWords.filter((w) => words.has(w)).length;
    if (overlap >= 2 && (overlap > bestOverlap || (overlap === bestOverlap && entry.publishedAt > bestTime))) {
      bestOverlap = overlap;
      bestId = entry.messageId;
      bestTime = entry.publishedAt;
    }
  }

  for (const [key, entry] of recentTopicMessages) {
    if (now - entry.publishedAt > TOPIC_EXPIRE_MS) recentTopicMessages.delete(key);
  }

  return bestId;
}

// ─── Yayınlanan URL takibi ────────────────────────────────────────────────────

const PUBLISHED_TITLES_FILE = path.join(__dirname, 'published_titles.json');

function loadPublishedUrls() {
  try {
    if (fs.existsSync(PUBLISHED_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(PUBLISHED_FILE, 'utf8')));
    }
  } catch {}
  return new Set();
}

function persistPublishedUrls() {
  try {
    let arr = [...publishedUrls];
    if (arr.length > 5000) arr = arr.slice(arr.length - 3000);
    fs.writeFileSync(PUBLISHED_FILE, JSON.stringify(arr));
  } catch {}
}

const publishedUrls = loadPublishedUrls();
setInterval(persistPublishedUrls, 30 * 1000);

// ─── Başlık bazlı tekrar engeli — dosyaya da kaydediliyor (Railway restart'ta sıfırlanmaz) ──
function loadPublishedTitles() {
  try {
    if (fs.existsSync(PUBLISHED_TITLES_FILE)) {
      const arr = JSON.parse(fs.readFileSync(PUBLISHED_TITLES_FILE, 'utf8'));
      return new Set(arr);
    }
  } catch {}
  return new Set();
}

const publishedTitlesSession = loadPublishedTitles();

function persistPublishedTitles() {
  try {
    let arr = [...publishedTitlesSession];
    if (arr.length > 3000) arr = arr.slice(arr.length - 2000);
    fs.writeFileSync(PUBLISHED_TITLES_FILE, JSON.stringify(arr));
  } catch {}
}
setInterval(persistPublishedTitles, 30 * 1000);

function normalizeTitle(title) {
  return (title || '').toLowerCase()
    .replace(/[^a-züöşçğı0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

// Kelime örtüşme benzerlik kontrolü (%60+ aynı kelime = duplicate)
function isSimilarTitle(a, b) {
  const wordsA = new Set(a.split(' ').filter(w => w.length > 3));
  const wordsB = new Set(b.split(' ').filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  let overlap = 0;
  for (const w of wordsA) { if (wordsB.has(w)) overlap++; }
  return overlap / Math.min(wordsA.size, wordsB.size) >= 0.45;
}

function isTitleDuplicate(title) {
  const norm = normalizeTitle(title);
  if (publishedTitlesSession.has(norm)) return true;
  // Benzerlik kontrolü (son 200 başlık)
  const recent = [...publishedTitlesSession].slice(-200);
  if (recent.some(t => isSimilarTitle(norm, t))) return true;
  publishedTitlesSession.add(norm);
  return false;
}

let currentFeedIndex = 0;

const mediaStats = { image: 0, video: 0, text: 0 };
const botStartTime = Date.now();
const recentErrors = [];

function trackError(context, message) {
  const entry = `[${new Date().toLocaleTimeString('tr-TR')}] ${context}: ${message}`;
  recentErrors.unshift(entry);
  if (recentErrors.length > 5) recentErrors.pop();
  console.error(`❌ ${entry}`);
}

function getNeededMediaType() {
  const total = mediaStats.image + mediaStats.video + mediaStats.text;
  if (total === 0) return 'image';
  const imageRatio = mediaStats.image / total;
  const videoRatio = mediaStats.video / total;
  // Videonun oranı düşükse YouTube/web video ara
  if (videoRatio < 0.15) return 'video';
  // Görsel oranı her zaman yüksek tutulsun
  if (imageRatio < 0.80) return 'image';
  return 'image'; // Varsayılan: görsel
}

// ─── Medya Çıkarma ────────────────────────────────────────────────────────────

const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/avi', 'video/quicktime'];

function isVideoType(mimeType) {
  return VIDEO_TYPES.some((t) => String(mimeType || '').toLowerCase().startsWith(t.split('/')[0] + '/'));
}

function extractMedia(item) {
  if (item.enclosure?.url) {
    const mime = item.enclosure.type || '';
    if (isVideoType(mime)) return { type: 'video', url: item.enclosure.url };
    if (mime.startsWith('image/')) return { type: 'image', url: item.enclosure.url };
  }
  const mc = item.mediaContent || item['media:content'];
  if (mc?.$?.url) {
    const mime = mc.$.type || mc.$.medium || '';
    if (isVideoType(mime) || mime === 'video') return { type: 'video', url: mc.$.url };
    return { type: 'image', url: mc.$.url };
  }
  const mg = item.mediaGroup || item['media:group'];
  if (mg?.['media:thumbnail']?.[0]?.$?.url) {
    return { type: 'image', url: mg['media:thumbnail'][0].$.url };
  }
  const mt = item.mediaThumbnail || item['media:thumbnail'];
  if (mt?.$?.url) return { type: 'image', url: mt.$.url };
  const content = item.content || item['content:encoded'] || item.summary || '';
  const videoMatch = content.match(/<(?:video|source)[^>]+src=["']([^"']+\.(?:mp4|webm|ogg))["']/i);
  if (videoMatch) return { type: 'video', url: videoMatch[1] };
  const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch) return { type: 'image', url: imgMatch[1] };
  return { type: null, url: null };
}

// ─── og:image Çekici ──────────────────────────────────────────────────────────

function fetchOgMeta(url, redirectCount = 0) {
  if (redirectCount > 3) return Promise.resolve({ image: null, description: null });
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    const timer = setTimeout(() => done({ image: null, description: null }), 7000);
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        clearTimeout(timer);
        fetchOgMeta(res.headers.location, redirectCount + 1).then(done);
        return;
      }
      let html = '';
      res.on('data', (chunk) => { html += chunk; if (html.length > 80000) res.destroy(); });
      res.on('end', () => {
        clearTimeout(timer);
        const imgMatch =
          html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
          html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
          html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
        const image = imgMatch ? imgMatch[1] : null;

        const descMatch =
          html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{20,}?)["']/i) ||
          html.match(/<meta[^>]+content=["']([^"']{20,}?)["'][^>]+property=["']og:description["']/i) ||
          html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{20,}?)["']/i) ||
          html.match(/<meta[^>]+content=["']([^"']{20,}?)["'][^>]+name=["']description["']/i) ||
          html.match(/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']{20,}?)["']/i);
        const rawDesc = descMatch ? descMatch[1].replace(/&#?[a-z0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim() : null;
        const description = rawDesc && !isGarbageText(rawDesc) ? rawDesc : null;

        const pMatches = html.match(/<p[^>]*>([^<]{40,})<\/p>/gi) || [];
        const bodyText = pMatches
          .map(p => p.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
          .filter(t => t.length > 40 && !isGarbageText(t))
          .slice(0, 6)
          .join(' ');
        const articleBody = bodyText.length > 80 ? bodyText.slice(0, 1200) : null;

        // İkinci görsel: haber sayfasındaki büyük içerik görselleri
        // Alakasız küçük görseller (logo, ikon, reklam, tracking pixel) hariç
        const imgTags = html.matchAll(/<img[^>]+src=["']([^"']{30,})["']/gi);
        let image2 = null;
        const SKIP_PATTERNS = ['logo','icon','avatar','ads','pixel','banner','sponsor','reklam','widget','share','social','button','arrow','loading','spinner','blank','spacer','1x1','tracking'];
        for (const m of imgTags) {
          const u = m[1];
          if (!u || !u.startsWith('http') || !/\.(jpg|jpeg|png|webp)/i.test(u) || u === image) continue;
          if (SKIP_PATTERNS.some(p => u.toLowerCase().includes(p))) continue;
          // Boyut filtresi: URL'de küçük boyut varsa atla
          if (/[_-](\d{1,3})x(\d{1,3})[_.-]/.test(u) && !/(\d{3,4})x(\d{3,4})/.test(u)) continue;
          image2 = u; break;
        }
        // Tüm og:image variantları
        const ogImg2m = html.match(/<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image:secure_url["']/i);
        if (ogImg2m && ogImg2m[1] !== image) image2 = ogImg2m[1];

        done({ image, image2: image2 || null, description, articleBody });
      });
      res.on('error', () => { clearTimeout(timer); done({ image: null, description: null }); });
    });
    req.on('error', () => { clearTimeout(timer); done({ image: null, description: null }); });
    req.setTimeout(6000, () => { req.destroy(); clearTimeout(timer); done({ image: null, description: null }); });
  });
}

async function fetchOgImage(url) {
  const meta = await fetchOgMeta(url);
  return meta.image;
}

// ─── AI Özetleme ──────────────────────────────────────────────────────────────

function isGarbageText(text) {
  if (!text || text.length < 15) return true;
  const questionCount = (text.match(/\?/g) || []).length;
  const sentenceCount = (text.match(/[.!?]/g) || []).length || 1;
  if (questionCount / sentenceCount > 0.55) return true;
  const words = text.split(/\s+/);
  if (words.length < 8) return false;
  const half = words.slice(0, Math.floor(words.length / 2)).join(' ');
  const second = words.slice(Math.floor(words.length / 2)).join(' ');
  if (half.length > 30 && second.includes(half.slice(0, 30))) return true;
  return false;
}

// Metindeki ok ve gereksiz işaretleri temizle
function cleanArrows(text) {
  if (!text) return text;
  return text
    .replace(/[→←↑↓↗↘↙↖➜➡➢➣➤▶►◄◀▷◁▸◂]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Caption'dan tüm URL/link'leri temizle (video/metin gönderiminde kullan)
function stripLinks(text) {
  if (!text) return text;
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function detectCategory(title, description) {
  const text = `${title} ${description || ''}`.toLowerCase();
  const cats = [
    { emoji: '⚽', words: ['futbol','maç','gol','transfer','fenerbahçe','galatasaray','beşiktaş','trabzonspor','milli takım','süper lig','basketbol','tenis','formula','olimpiyat','şampiyon','teknik direktör','taraftar','lig','kulüp','atlet','maraton','yüzme','voleybol'] },
    { emoji: '🏛', words: ['cumhurbaşkanı','erdoğan','meclis','hükümet','bakan','chp','akp','mhp','hdp','dip','parti','muhalefet','seçim','milletvekili','tbmm','anayasa','siyasi','muhalif','oy','sandık','koalisy'] },
    { emoji: '💰', words: ['dolar','euro','faiz','enflasyon','tcmb','borsa','bist','merkez bankası','ihracat','ithalat','büyüme','gdp','bütçe','vergi','işsizlik','ticaret','piyasa','hisse','altın','döviz','kredi','hazine'] },
    { emoji: '🌍', words: ['ukrayna','rusya','abd','ab','nato','bm','suriye','gazze','israil','filistin','irak','iran','çin','almanya','fransa','ingiltere','putin','biden','trump','savaş','uluslararası','yabancı','küresel'] },
    { emoji: '💻', words: ['yapay zeka','ai','teknoloji','yazılım','donanım','uygulama','sosyal medya','twitter','instagram','google','apple','meta','microsoft','iphone','android','siber','uzay','roket','satellite','5g','kripto','bitcoin'] },
    { emoji: '🎬', words: ['magazin','dizi','film','oyuncu','şarkıcı','sanatçı','konser','albüm','moda','manken','ödül','oscar','grammy','ünlü','çift','ayrılık','evlilik','nişan','sevgili','skandal'] },
    { emoji: '🚨', words: ['cinayet','hırsızlık','dolandırıcılık','terör','bomba','saldırı','gözaltı','tutuklama','mahkeme','yargı','savcı','polis','jandarma','uyuşturucu','kaçakçılık','kaza','deprem','yangın','sel','afet'] },
    { emoji: '🏥', words: ['sağlık','hastane','doktor','ilaç','aşı','hastalık','covid','kanser','pandemi','salgın','tedavi','ameliyat','eczane','klinik','bakan sağlık'] },
    { emoji: '🎓', words: ['okul','üniversite','öğrenci','öğretmen','meb','yks','lgs','sınav','burs','mezun','eğitim','müfredat','akademik','rektör'] },
    { emoji: '🌿', words: ['iklim','çevre','orman','yangın','küresel ısınma','karbon','yenilenebilir','solar','rüzgar','doğa','çevre kirliliği','deniz','hayvan'] },
  ];
  for (const { emoji, words } of cats) {
    if (words.some(w => text.includes(w))) return emoji;
  }
  return null;
}

async function summarizeNews(title, description, articleBody = null) {
  const rawText = (description || '').trim();
  const inputText = isGarbageText(rawText) ? '' : rawText;
  const bodyText = articleBody && !isGarbageText(articleBody) ? articleBody : '';
  const fullContent = [inputText, bodyText].filter(Boolean).join('\n\n').slice(0, 2000);

  // AI yoksa: makale gövdesi varsa onu kullan, yoksa RSS açıklamasını
  if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
    // Önce makale gövdesini tercih et (daha zengin içerik)
    const best = bodyText.length > 80 ? bodyText.slice(0, 400) : (inputText.length > 20 ? inputText.slice(0, 400) : null);
    return best;
  }
  try {
    const prompt = fullContent
      ? `Sen Türkçe bir haber kanalının editörüsün. Aşağıdaki haberi okuyuculara 2-3 cümleyle anlat. Önemli olan: başlıkta yazanı TEKRARLAMA, okuyucunun merak ettiği ayrıntıları yaz — kim ne dedi, ne karar verildi, neden önemli. "X şunu söyledi" gibi belirsiz ifade kullanma; varsa gerçek sözleri/rakamları/kararları yaz. Kaynak adı, tarih, link ekleme. Sadece özeti yaz.\n\nBaşlık: ${title}\nİçerik: ${fullContent}`
      : `Sen Türkçe bir haber kanalının editörüsün. Aşağıdaki haber başlığını oku. Başlıkta geçen konuyu 1-2 cümleyle arka plan bağlamıyla açıkla — okuyucunun bilmediği bir şey söyle. Başlığı kelime kelime tekrarlama. Kaynak adı, tarih ekleme.\n\nBaşlık: ${title}`;

    const response = await Promise.race([
      aiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 220,
        messages: [{ role: 'user', content: prompt }],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('AI timeout')), 8000)),
    ]);
    const result = (response.choices[0]?.message?.content || '').trim();
    if (!result || result.length < 10) return fullContent.slice(0, 400) || inputText.slice(0, 400) || null;
    return result;
  } catch {
    const best = bodyText.length > 80 ? bodyText.slice(0, 400) : (inputText.length > 20 ? inputText.slice(0, 400) : null);
    return best;
  }
}

// ─── DuckDuckGo Görsel Arama ──────────────────────────────────────────────────

function fetchDuckDuckGoImage(query) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done(null), 8000);

    const searchReq = https.get(
      `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } },
      (res) => {
        let html = '';
        res.on('data', (c) => { html += c; if (html.length > 80000) res.destroy(); });
        res.on('end', () => {
          clearTimeout(timer);
          const vqdMatch = html.match(/vqd=['"]([^'"]+)['"]/);
          if (!vqdMatch) return done(null);
          const vqd = vqdMatch[1];

          const imgUrl = `https://duckduckgo.com/i.js?q=${encodeURIComponent(query)}&vqd=${vqd}&p=1&o=json&l=tr-tr&f=,,,`;
          https.get(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://duckduckgo.com/' } }, (res2) => {
            let data = '';
            res2.on('data', (c) => { data += c; });
            res2.on('end', () => {
              try {
                const json = JSON.parse(data);
                const results = json?.results || [];
                const best = results.find((r) => r.image && (r.width || 0) >= 800) || results[0];
                done(best?.image || null);
              } catch { done(null); }
            });
            res2.on('error', () => done(null));
          }).on('error', () => done(null));
        });
        res.on('error', () => { clearTimeout(timer); done(null); });
      }
    );
    searchReq.on('error', () => { clearTimeout(timer); done(null); });
  });
}

// ─── Web'den Video Çıkarma ────────────────────────────────────────────────────

function extractWebVideo(html) {
  if (!html) return null;

  // og:video meta tag — mp4, m3u8, webm
  const ogVideo =
    html.match(/<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::url)?["']/i)?.[1];
  if (ogVideo && /\.(mp4|webm|ogg|m3u8)/i.test(ogVideo)) return ogVideo;

  // <video src> veya <source src>
  const videoSrc =
    html.match(/<video[^>]+src=["']([^"']+\.(?:mp4|webm|ogg|m3u8))["']/i)?.[1] ||
    html.match(/<source[^>]+src=["']([^"']+\.(?:mp4|webm|ogg|m3u8))["']/i)?.[1];
  if (videoSrc) return videoSrc;

  // data-src attribute
  const dataSrc = html.match(/data-src=["']([^"']+\.(?:mp4|webm|m3u8))["']/i)?.[1];
  if (dataSrc) return dataSrc;

  // JSON player config içindeki video URL'leri (haber sitesi player'ları)
  const jsonVid =
    html.match(/"(?:videoUrl|video_url|hlsUrl|hls_url|streamUrl|stream_url|file|src)"\s*:\s*"([^"]+\.(?:mp4|m3u8|webm))"/i)?.[1] ||
    html.match(/'(?:videoUrl|video_url|hlsUrl|hls_url|file|src)'\s*:\s*'([^']+\.(?:mp4|m3u8|webm))'/i)?.[1];
  if (jsonVid) return jsonVid;

  // JW Player config (CNN Türk, NTV, Haberturk vb.)
  const jwFile = html.match(/file\s*:\s*["']([^"']+\.(?:mp4|m3u8))["']/i)?.[1];
  if (jwFile) return jwFile;

  // data-video-url, data-mp4, data-hls attribute
  const dataVid =
    html.match(/data-(?:video-url|mp4|hls|stream|videofile|video_url|video-src)=["']([^"']+\.(?:mp4|m3u8|webm))["']/i)?.[1];
  if (dataVid) return dataVid;

  // ── Türk haber siteleri özel pattern'ları ────────────────────────────────

  // Halk TV / Tele1 / KRT gibi siteler — flashvar / playerConfig içindeki URL
  const flashVar = html.match(/flashvars[\s\S]{0,200}?["'](https?:[^"']+\.(?:mp4|m3u8))["']/i)?.[1];
  if (flashVar) return flashVar;

  // NTV / CNN Türk — playerData JSON
  const playerData = html.match(/playerData\s*=\s*[{[]["'][^}]*?"(?:hls|mp4|video)"\s*:\s*"([^"]+\.(?:mp4|m3u8))"/i)?.[1];
  if (playerData) return playerData;

  // Sözcü / T24 — window.videoData veya window.pageData içindeki video
  const windowData = html.match(/window\.(?:videoData|pageData|videoInfo|videoConfig|player_data)\s*=\s*\{[\s\S]{0,500}?"(?:url|src|file|hls)"\s*:\s*"([^"]+\.(?:mp4|m3u8))"/i)?.[1];
  if (windowData) return windowData;

  // __NEXT_DATA__ veya __NUXT__ içindeki video URL (Next.js / Nuxt tabanlı siteler)
  const nextDataMatch = html.match(/"(?:videoUrl|hlsUrl|mp4Url|streamUrl|videoSrc)"\s*:\s*"([^"]+\.(?:mp4|m3u8))"/i);
  if (nextDataMatch) return nextDataMatch[1];

  // Brightcove player (medya şirketleri tarafından yaygın kullanılır)
  const brightcove = html.match(/data-video-id=["']([^"']+)["'][\s\S]{0,300}?["'](https?:[^"']+\.(?:mp4|m3u8))["']/i)?.[2];
  if (brightcove) return brightcove;

  // video.twimg.com (Twitter/X gömülü videolar)
  const twitterVid = html.match(/(https?:\/\/video\.twimg\.com\/[^"'\s]+\.mp4[^"'\s]*)/i)?.[1];
  if (twitterVid) return twitterVid;

  // dailymotion embed
  const dailymotion = html.match(/dailymotion\.com\/embed\/video\/([a-zA-Z0-9]+)/i)?.[1];
  if (dailymotion) return `https://www.dailymotion.com/video/${dailymotion}`;

  // Genel CDN URL'leri — daha geniş arama (uzantısız token'lı URL'ler dahil)
  // Önce uzantılı
  const cdnVid = html.match(/["'](https?:\/\/(?:cdn|medya|media|video|stream|vod|live)[^"'\s]*\.(?:mp4|m3u8)(?:\?[^"'\s]*)?)["']/i)?.[1];
  if (cdnVid && cdnVid.length < 600) return cdnVid;

  // Herhangi bir .mp4 veya .m3u8 URL (son çare)
  const anyMp4 = html.match(/["'](https?:\/\/[^"'\s]+\.(?:mp4|m3u8)(?:\?[^"'\s]*)?)["']/i)?.[1];
  if (anyMp4 && anyMp4.length < 600) return anyMp4;

  return null;
}

async function fetchArticleHtmlAndExtractVideo(url) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done(null), 7000);
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
    }, (res) => {
      let html = '';
      res.on('data', (c) => { html += c; if (html.length > 80000) res.destroy(); });
      res.on('end', () => { clearTimeout(timer); done(extractWebVideo(html)); });
      res.on('error', () => { clearTimeout(timer); done(null); });
    });
    req.on('error', () => { clearTimeout(timer); done(null); });
    req.setTimeout(6000, () => { req.destroy(); clearTimeout(timer); done(null); });
  });
}

// ─── Wikipedia Görsel Arama ───────────────────────────────────────────────────

function extractSubjects(title) {
  const cleaned = title.replace(/[''][a-züöşçğıİ]+/gi, '');
  const candidates = [];
  const multiWord = cleaned.match(/\b([A-ZÇĞİÖŞÜ][a-züöşçğı]+(?:\s[A-ZÇĞİÖŞÜ][a-züöşçğı]+){1,2})/g);
  if (multiWord) candidates.push(...multiWord);
  const singleWord = cleaned.match(/\b([A-ZÇĞİÖŞÜ][a-züöşçğı]{3,})\b/g);
  if (singleWord) {
    const stopWords = new Set(['Son', 'Bir', 'İki', 'Üç', 'Dört', 'Beş', 'Bu', 'Şu', 'O', 'Ve', 'İle', 'De', 'Da']);
    candidates.push(...singleWord.filter(w => !stopWords.has(w)));
  }
  return [...new Set(candidates)].sort((a, b) => b.length - a.length).slice(0, 4);
}

function fetchWikipediaImage(query) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    const timer = setTimeout(() => done(null), 7000);

    const searchUrl = `https://tr.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json`;

    https.get(searchUrl, { headers: { 'User-Agent': 'TelegramNewsBot/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const json = JSON.parse(data);
          const pageTitle = json?.query?.search?.[0]?.title;
          if (!pageTitle) return done(null);

          const summaryUrl = `https://tr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`;
          https.get(summaryUrl, { headers: { 'User-Agent': 'TelegramNewsBot/1.0' } }, (res2) => {
            let data2 = '';
            res2.on('data', c => { data2 += c; });
            res2.on('end', () => {
              try {
                const page = JSON.parse(data2);
                const img = page?.originalimage?.source || page?.thumbnail?.source || null;
                done(img);
              } catch { done(null); }
            });
            res2.on('error', () => done(null));
          }).on('error', () => done(null));
        } catch { done(null); }
      });
      res.on('error', () => { clearTimeout(timer); done(null); });
    }).on('error', () => { clearTimeout(timer); done(null); });
  });
}

async function fetchSubjectImage(title) {
  const subjects = extractSubjects(title);
  for (const subject of subjects) {
    console.log(`🔎 Wikipedia görseli aranıyor: "${subject}"`);
    const img = await fetchWikipediaImage(subject);
    if (img) {
      console.log(`🖼 Wikipedia görseli bulundu: ${subject}`);
      return img;
    }
  }
  return null;
}

// ─── Yardımcı Fonksiyonlar ────────────────────────────────────────────────────

function cleanTitle(title) {
  let t = (title || '').trim();
  // "Gerçek Haber... 19 Mayıs 2026 İlker Karagöz ile Çalar Saat" → sadece "Gerçek Haber"
  t = t.replace(/\s*\.{2,3}\s*\d{1,2}\s+\w+\s+\d{4}.*$/, '').trim();
  // "Haber Başlığı - Program Adı" veya "- İlker Karagöz ile ..." → sonu kes
  t = t.replace(/\s*[-–|]\s*[A-ZĞÜŞÖÇİa-zğüşöçı]+\s+(?:ile|de|da)\s+.+$/, '').trim();
  // Başta tarih öneki: "19 Mayıs 2026 Haber başlığı" → tarihi çıkar
  t = t.replace(/^\d{1,2}\s+[A-Za-zğüşöçİĞÜŞÖÇı]+\s+\d{4}\s+/, '').trim();
  // Orijinal: sondaki "- kaynak adı" temizle
  t = t.replace(/\s*-\s*[^-]{3,}$/, '').trim();
  return t || title || '';
}

const SON_DAKIKA_KEYWORDS = ['son dakika', 'acil', 'flaş', 'flash', 'breaking'];

function isSonDakika(title, feed) {
  const lowerTitle = (title || '').toLowerCase();
  const lowerLabel = (feed.label || '').toLowerCase();
  return (
    lowerLabel.includes('son dakika') ||
    SON_DAKIKA_KEYWORDS.some((kw) => lowerTitle.includes(kw))
  );
}

async function tryPin(messageId) {
  try {
    await bot.pinChatMessage(CHANNEL_ID, messageId, { disable_notification: false });
    console.log(`📌 Mesaj sabitlendi (id: ${messageId})`);
  } catch (err) {
    console.error(`⚠️ Sabitleme başarısız: ${err.message}`);
  }
}

function matchesFilters(title, description, filters) {
  if (!filters || filters.length === 0) return false;
  const text = `${title} ${description}`.toLowerCase();
  return filters.some((kw) => text.includes(kw));
}

function matchedTags(title, description, filters) {
  const text = `${title} ${description}`.toLowerCase();
  return filters.filter((kw) => text.includes(kw)).map((kw) => `#${kw}`).join(' ');
}

async function notifyFilterUsers(title, description, url) {
  for (const [chatId, userData] of Object.entries(users)) {
    if (!matchesFilters(title, description, userData.filters)) continue;
    const tags = matchedTags(title, description, userData.filters);
    const text = `🔔 Filtre eşleşmesi: ${tags}\n\n📰 ${cleanTitle(title)}\n\n🔗 ${url}`;
    try {
      await bot.sendMessage(chatId, text, { disable_web_page_preview: false });
    } catch (err) {
      if (err.message.includes('blocked') || err.message.includes('chat not found')) {
        delete users[chatId];
        saveUsers(users);
      }
    }
  }
}

// ─── Haber Kalite Filtreleri ──────────────────────────────────────────────────

const BLOCKED_TITLE_PATTERNS = [
  /bülten/i, /özet/i, /haftalık/i, /aylık/i, /günlük özet/i,
  /bülten\s*-?\s*\d+/i, /ajans haberleri/i, /haber bülteni/i,
  /toplantı notları/i, /basın açıklaması listesi/i,
  /#canl[iı]/i, /canl[iı]\s*yay[iı]n/i, /\bLIVE\b/i,
  /\b(ile\s+rota|ile\s+başak|programı?|özel yayın|stüdyo|röportaj kuşağı)\b/i,
  // TV program / yayın listesi başlıkları
  /\bçalar saat\b/i,
  /\bana haber(ler)?\b/i,
  /\bsabah bülteni\b/i,
  /\bhaber kuşağı\b/i,
  /\bhaberleri.*\b\d{4}\b/i,
  /\byayın akışı\b/i,
  /\bkuşak yayın\b/i,
  // Sadece tarih + program adından oluşan başlıklar (gerçek haber değil)
  /^\d{1,2}\s+[A-Za-zğüşöçİĞÜŞÖÇı]+\s+\d{4}\s+[A-ZĞÜŞÖÇİ]/,
];

function isRecentNews(item) {
  const rawDate = item.pubDate || item.published || item.isoDate;
  if (!rawDate) return true;
  const date = new Date(rawDate);
  if (isNaN(date.getTime())) return true;
  const maxAgeMs = (settings.maxAgeHours || 24) * 60 * 60 * 1000;
  return Date.now() - date.getTime() < maxAgeMs;
}

function isValidNewsItem(item, feed) {
  const title = (item.title || '').trim();
  const description = (item.contentSnippet || item.summary || '').trim();

  if (title.length < 10) return false;
  if (title.toLowerCase() === feed.source.toLowerCase()) return false;
  if (/^https?:\/\//i.test(title)) return false;
  if (BLOCKED_TITLE_PATTERNS.some((p) => p.test(title))) return false;

  if (description && description.length < 20) {
    const descLower = description.toLowerCase();
    if (descLower === feed.source.toLowerCase()) return false;
    if (/^https?:\/\//i.test(description)) return false;
  }

  if (!isRecentNews(item)) {
    const rawDate = item.pubDate || item.published || item.isoDate;
    console.log(`⏭ Eski haber atlandı (${rawDate}): ${title.slice(0, 40)}`);
    return false;
  }

  // Medya kontrolü artık yayın aşamasında yapılıyor (og:image çekimi sonrası)
  // RSS'te medya olmasa da web'den og:image çekilebilir
  return true;
}

function itemHasVideo(it) {
  const enc = it.enclosure;
  if (enc?.url && enc?.type && VIDEO_TYPES.some(t => enc.type.startsWith(t.split('/')[0] + '/'))) return true;
  const mc = it.mediaContent || it['media:content'];
  if (mc?.$?.url) {
    const mime = mc.$.type || mc.$.medium || '';
    if (mime === 'video' || VIDEO_TYPES.some(t => mime.startsWith(t.split('/')[0] + '/'))) return true;
  }
  const content = it.content || it['content:encoded'] || it.summary || '';
  return /<(?:video|source)[^>]+src=/i.test(content);
}

function itemHasImage(it) {
  const enc = it.enclosure;
  if (enc?.url && enc?.type?.startsWith('image/')) return true;
  const mc = it.mediaContent || it['media:content'];
  if (mc?.$?.url) return true;
  const mt = it.mediaThumbnail || it['media:thumbnail'];
  if (mt?.$?.url) return true;
  const mg = it.mediaGroup || it['media:group'];
  if (mg?.['media:thumbnail']?.[0]?.$?.url) return true;
  const content = it.content || it['content:encoded'] || it.summary || '';
  return /<img/i.test(content);
}

function sortByNeededMedia(items, needed) {
  if (needed === 'video') {
    const video = items.filter(itemHasVideo);
    const image = items.filter(it => !itemHasVideo(it) && itemHasImage(it));
    const text  = items.filter(it => !itemHasVideo(it) && !itemHasImage(it));
    return [...video, ...image, ...text];
  }
  const image = items.filter(it => itemHasImage(it) && !itemHasVideo(it));
  const video = items.filter(itemHasVideo);
  const text  = items.filter(it => !itemHasImage(it) && !itemHasVideo(it));
  return [...image, ...video, ...text];
}

function upgradeImageUrl(url) {
  if (!url) return url;
  return url
    .replace(/([?&])w=\d+/g, '$1')
    .replace(/([?&])h=\d+/g, '$1')
    .replace(/([?&])width=\d+/g, '$1')
    .replace(/([?&])height=\d+/g, '$1')
    .replace(/([?&])resize=\d+,\d+/g, '$1')
    .replace(/([?&])fit=\d+,\d+/g, '$1')
    .replace(/([?&])size=\d+/g, '$1')
    .replace(/([?&])q=\d+/g, '$1quality=95')
    .replace(/\?&+/g, '?').replace(/&&+/g, '&').replace(/[?&]$/g, '')
    .replace(/_\d+x\d+\.(jpg|jpeg|png|webp)/i, '.$1')
    .replace(/-\d+x\d+\.(jpg|jpeg|png|webp)/i, '.$1')
    .replace(/\/\d+x\d+\//i, '/full/')
    .replace(/\/small\//i, '/large/')
    .replace(/\/thumb\//i, '/full/')
    .replace(/\/thumbnail\//i, '/original/')
    .replace(/\/medium\//i, '/large/')
    .replace(/\/low\//i, '/high/')
    .replace(/\/preview\//i, '/original/')
    .replace(/\/hqdefault\.jpg/, '/maxresdefault.jpg')
    .replace(/\/mqdefault\.jpg/, '/maxresdefault.jpg')
    .replace(/\/sddefault\.jpg/, '/maxresdefault.jpg');
}

// ─── Video İndirme ───────────────────────────────────────────────────────────

const MAX_VIDEO_SIZE_BYTES = 48 * 1024 * 1024;


// ─── Invidious API ile YouTube İndirme ────────────────────────────────────────
// Railway IP'si YouTube'u engelliyor; Invidious proxy üzerinden gidiyoruz.
// Tüm HTTP istekleri native https/http modülü ile yapılıyor (axios yok).

const INVIDIOUS_INSTANCES = [
  'https://inv.tux.pizza',
  'https://invidious.flokinet.to',
  'https://yt.artemislena.eu',
  'https://invidious.privacydev.net',
  'https://yewtu.be',
  'https://invidious.fdn.fr',
  'https://invidious.drgns.space',
  'https://invidious.io.lol',
];

// Native https ile JSON GET isteği
function httpsGetJson(url, timeoutMs = 12000, _redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TelegramBot/1.0)',
        'Accept': 'application/json',
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (_redirectCount > 5) return reject(new Error('too many redirects'));
        return httpsGetJson(res.headers.location, timeoutMs, _redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON parse hatası')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Native https ile stream indir → dosyaya yaz
function httpsDownloadToFile(url, destPath, maxBytes, referer, timeoutMs = 180000, _redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TelegramBot/1.0)',
        'Referer': referer || '',
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (_redirectCount > 5) return reject(new Error('too many redirects'));
        return httpsDownloadToFile(res.headers.location, destPath, maxBytes, referer, timeoutMs, _redirectCount + 1)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const writer = fs.createWriteStream(destPath);
      let downloaded = 0;
      res.on('data', chunk => {
        downloaded += chunk.length;
        if (downloaded > maxBytes) {
          res.destroy(); writer.destroy();
          reject(new Error(`Dosya çok büyük (${Math.round(downloaded/1024/1024)}MB)`));
        }
      });
      res.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('download timeout')); });
  });
}

// Invidious API'den 720p-1080p video URL'i al
async function getInvidiousVideoUrl(videoId) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const apiUrl = `${instance}/api/v1/videos/${videoId}?fields=formatStreams,adaptiveFormats`;
      console.log(`🔍 Invidious deniyor: ${instance}`);
      const data = await httpsGetJson(apiUrl, 12000);

      const streams = (data.formatStreams || []).filter(s => s.url);
      const pick =
        streams.find(s => (s.qualityLabel || s.quality || '').startsWith('1080')) ||
        streams.find(s => (s.qualityLabel || s.quality || '').startsWith('720')) ||
        streams.find(s => (s.qualityLabel || s.quality || '').startsWith('480')) ||
        streams[0];

      if (pick?.url) {
        console.log(`✅ Invidious ${instance} → ${pick.qualityLabel || pick.quality || '?'}`);
        return { url: pick.url, quality: pick.qualityLabel || pick.quality || 'unknown', instance };
      }
    } catch (e) {
      console.log(`⚠️ Invidious ${instance}: ${e.message?.slice(0, 60)}`);
    }
  }
  return null;
}

// Invidious proxy ile video indir — önce API'den mevcut itag'leri al, sonra paralel indir

// ─── cobalt.tools API ile YouTube/web video indir ─────────────────────────────
// Cobalt kendi altyapısından indirir — Railway datacenter IP'si YouTube'u bloklasa da çalışır

// ═══════════════════════════════════════════════════════════════════════════
// VİDEO SİSTEMİ — URL-önce yaklaşım
// Railway videoyu indirmez → Telegram'a URL verir → Telegram kendi sunucusundan indirir
// ═══════════════════════════════════════════════════════════════════════════

// ── 1. cobalt.tools → direkt MP4 URL al (indirme yok) ─────────────────────
async function getCobaltDirectUrl(videoUrl) {
  const COBALT_INSTANCES = [
    'https://api.cobalt.tools',
    'https://cobalt.api.timelessnesses.me',
    'https://cobalt.lunar.icu',
    'https://cobalt-api.kwiatekmiki.com',
    'https://co.wuk.sh',
  ];

  // cobalt v10+ API formatı
  const bodyV10 = JSON.stringify({
    url: videoUrl,
    videoQuality: '720',
    downloadMode: 'auto',
    youtubeVideoCodec: 'h264',
    audioBitrate: '128',
  });
  // Eski format (bazı instance'lar hâlâ eski API)
  const bodyOld = JSON.stringify({
    url: videoUrl,
    vQuality: '720',
    isAudioOnly: false,
  });

  async function tryCobalt(instance, body) {
    const cobaltHost = new URL(instance);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: cobaltHost.hostname,
        port: cobaltHost.port || 443,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; if (raw.length > 100000) res.destroy(); });
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('json')); } });
      });
      req.on('error', reject);
      const t = setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, 20000);
      req.on('close', () => clearTimeout(t));
      req.write(body); req.end();
    });
  }

  for (const instance of COBALT_INSTANCES) {
    for (const body of [bodyV10, bodyOld]) {
      try {
        const data = await tryCobalt(instance, body);
        console.log(`🔍 cobalt ${instance}: status=${data?.status}`);
        if (data?.url && !['error', 'redirect_error', 'rate-limit'].includes(data.status)) {
          console.log(`✅ cobalt URL (${data.status}): ${data.url.slice(0, 70)}`);
          return data.url;
        }
        if (data?.status === 'picker' && data?.picker?.[0]?.url) {
          console.log(`✅ cobalt picker URL: ${data.picker[0].url.slice(0, 70)}`);
          return data.picker[0].url;
        }
        break; // bu instance yanıt verdi ama URL yok, eski formatı deneme
      } catch (e) {
        console.log(`⚠️ cobalt ${instance}: ${e.message?.slice(0, 40)}`);
        break;
      }
    }
  }
  return null;
}

// ── 2. yt-dlp -g → direkt stream URL al (indirme yok, sadece URL çıkar) ────
async function getYtdlpStreamUrl(videoUrl) {
  // Birden fazla player_client dene — datacenter IP'de bazıları çalışır
  const clientSets = [
    'tv_embedded',
    'mweb',
    'web_creator',
  ];
  for (const client of clientSets) {
    const result = await new Promise((resolve) => {
      const args = [
        '-g',
        '--no-playlist',
        '--extractor-args', `youtube:player_client=${client}`,
        '-f', '18/22/mp4/best[height<=480]',
        '--no-check-certificate',
        '--geo-bypass',
        '--no-warnings',
        '--no-part',
        '--socket-timeout', '15',
        videoUrl,
      ];
      let proc;
      try { proc = spawn(YTDLP_BIN, args); } catch { resolve(null); return; }
      let stdout = '', stderr = '';
      proc.stdout.on('data', d => { stdout += d; });
      proc.stderr.on('data', d => { stderr += d; });
      const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(null); }, 25000);
      proc.on('error', () => { clearTimeout(killTimer); resolve(null); });
      proc.on('close', code => {
        clearTimeout(killTimer);
        if (code !== 0) {
          console.log(`⚠️ yt-dlp [${client}] hata: ${stderr.slice(-200)}`);
          tgLog(`⚠️ yt-dlp [${client}]: ${stderr.slice(-150)}`);
          resolve(null); return;
        }
        const urls = stdout.trim().split('\n').filter(l => l.startsWith('http'));
        if (urls.length > 0) { console.log(`✅ yt-dlp [${client}] URL: ${urls[0].slice(0, 70)}`); resolve(urls[0]); }
        else resolve(null);
      });
    });
    if (result) return result;
  }
  return null;
}

// ── 3. Invidious'tan direkt stream URL al (Railway indirmez, sadece URL) ────
async function getInvidiousStreamUrl(videoId) {
  for (const instance of INVIDIOUS_INSTANCES.slice(0, 5)) {
    try {
      // itag=22 = 720p mp4 (video+audio birleşik)
      const proxyUrl = `${instance}/latest_version?id=${videoId}&itag=22`;
      // HEAD isteği ile URL'nin gerçek hedefini bul
      const finalUrl = await new Promise((resolve, reject) => {
        const u = new URL(proxyUrl);
        const req = https.request({
          hostname: u.hostname, port: u.port || 443,
          path: u.pathname + u.search, method: 'HEAD',
          headers: { 'User-Agent': 'Mozilla/5.0' },
        }, (res) => {
          // Redirect varsa son URL'yi al
          if (res.headers.location) { resolve(res.headers.location); return; }
          // Redirect yoksa doğrudan bu URL kullanılabilir
          if (res.statusCode === 200) { resolve(proxyUrl); return; }
          reject(new Error(`HTTP ${res.statusCode}`));
        });
        req.on('error', reject);
        const t = setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, 8000);
        req.on('close', () => clearTimeout(t));
        req.end();
      });
      if (finalUrl && finalUrl.startsWith('http')) {
        // googlevideo.com ise mükemmel — Telegram doğrudan indirebilir
        console.log(`✅ Invidious stream URL: ${finalUrl.slice(0, 70)}`);
        return finalUrl;
      }
    } catch (e) {
      console.log(`⚠️ Invidious stream ${instance}: ${e.message?.slice(0, 40)}`);
    }
  }
  return null;
}

// ── 4. Telegram'a video URL gönder (Telegram'ın kendi sunucusu indirir) ─────
async function sendVideoByUrl(channelId, videoUrl, caption, extra = {}) {
  try {
    console.log(`📤 Telegram'a URL gönderiliyor: ${videoUrl.slice(0, 70)}`);
    await bot.sendVideo(channelId, videoUrl, {
      caption,
      supports_streaming: true,
      ...extra,
    });
    console.log('✅ Video URL ile gönderildi');
    return true;
  } catch (e) {
    console.log(`⚠️ URL ile gönderme başarısız: ${e.message?.slice(0, 60)}`);
    return false;
  }
}

// ── 5. YouTube video gönder: URL önce, indirme son çare ────────────────────
async function sendYouTubeVideoSmart(channelId, videoUrl, caption) {
  const videoId =
    videoUrl.match(/[?&]v=([^&]+)/)?.[1] ||
    videoUrl.match(/youtu\.be\/([^?]+)/)?.[1] ||
    videoUrl.match(/shorts\/([^?/]+)/)?.[1];

  if (!videoId) { tgLog('❌ YouTube video ID çıkarılamadı'); return false; }
  console.log(`🎬 YouTube gönderme: ${videoId}`);
  tgLog(`🎬 YouTube video deneniyor: ${videoId}`);

  // 1. cobalt.tools → direkt MP4 URL
  tgLog('1️⃣ cobalt.tools deneniyor...');
  const cobaltUrl = await getCobaltDirectUrl(videoUrl);
  if (cobaltUrl) {
    const ok = await sendVideoByUrl(channelId, cobaltUrl, caption);
    if (ok) { tgLog('✅ cobalt ile video gönderildi!'); return true; }
    tgLog('⚠️ cobalt URL Telegram tarafından reddedildi');
  } else { tgLog('⚠️ cobalt URL alınamadı'); }

  // 2. Invidious stream URL
  tgLog('2️⃣ Invidious stream deneniyor...');
  const invUrl = await getInvidiousStreamUrl(videoId);
  if (invUrl) {
    const ok = await sendVideoByUrl(channelId, invUrl, caption);
    if (ok) { tgLog('✅ Invidious ile video gönderildi!'); return true; }
    tgLog('⚠️ Invidious URL çalışmadı');
  } else { tgLog('⚠️ Invidious URL alınamadı'); }

  // 3. yt-dlp tam indirme
  tgLog('3️⃣ yt-dlp indirme deneniyor...');
  const filePath = await downloadYoutubeVideo(videoUrl);
  if (filePath) {
    try {
      await bot.sendVideo(channelId, { source: filePath }, { caption, supports_streaming: true });
      try { fs.rmSync(path.dirname(filePath), { recursive: true, force: true }); } catch {}
      tgLog('✅ yt-dlp ile video yüklendi!');
      return true;
    } catch (e) {
      tgLog(`⚠️ Video yükleme başarısız: ${e.message?.slice(0, 80)}`);
      try { fs.rmSync(path.dirname(filePath), { recursive: true, force: true }); } catch {}
    }
  } else { tgLog('⚠️ yt-dlp indirme başarısız'); }

  tgLog('❌ YouTube: video gönderilemedi, atlanıyor');
  return false;
}

// ── 6. Makale/web URL'sinden video gönder ──────────────────────────────────
async function sendArticleVideoSmart(channelId, articleUrl, caption) {
  // 1. yt-dlp -g → stream URL → Telegram (YouTube değil, haber sitesi için)
  console.log(`⬇️ yt-dlp -g: ${articleUrl.slice(0, 70)}`);
  const streamUrl = await getYtdlpStreamUrl(articleUrl);
  if (streamUrl) {
    const ok = await sendVideoByUrl(channelId, streamUrl, caption);
    if (ok) return true;
    // URL çalışmadıysa yine de streamUrl bilgisi var, indirmeyi dene
  }

  // 2. HTML'den direkt video URL bul → URL'yi Telegram'a gönder
  const articleHtml = await fetchArticleHtmlRaw(articleUrl);
  if (articleHtml) {
    const directVid = extractWebVideoEnhanced(articleHtml);
    if (directVid) {
      console.log(`🎬 HTML video URL: ${directVid.slice(0, 60)}`);
      if (/youtube\.com|youtu\.be/i.test(directVid)) {
        const ok = await sendYouTubeVideoSmart(channelId, directVid, caption);
        if (ok) return true;
      } else if (/\.m3u8/i.test(directVid)) {
        // m3u8 — Railway ffmpeg ile indir (küçük çünkü canlı yayın segmenti)
        const ok = await sendWebVideo(channelId, directVid, caption, null);
        if (ok) return true;
      } else {
        // Direkt mp4 URL → Telegram indirir
        const ok = await sendVideoByUrl(channelId, directVid, caption);
        if (ok) return true;
      }
    }
    // HTML'deki YouTube iframe ID'leri
    const ytIds = extractYouTubeIdsFromHtml(articleHtml);
    for (const ytId of ytIds.slice(0, 2)) {
      const ok = await sendYouTubeVideoSmart(channelId, `https://www.youtube.com/watch?v=${ytId}`, caption);
      if (ok) return true;
    }
  }

  // 3. yt-dlp tam indirme (son çare)
  console.log(`⬇️ yt-dlp tam indirme: ${articleUrl.slice(0, 60)}`);
  const gPath = await downloadGenericWithYtdlp(articleUrl);
  if (gPath) {
    try {
      await bot.sendVideo(channelId, { source: gPath }, { caption, supports_streaming: true });
      try { fs.rmSync(path.dirname(gPath), { recursive: true, force: true }); } catch {}
      return true;
    } catch {}
    try { fs.rmSync(path.dirname(gPath), { recursive: true, force: true }); } catch {}
  }

  return false;
}

async function downloadFromInvidious(videoId) {
  // Adım 1: Hangi instancetan API yanıtı alabiliyoruz ve hangi itag'ler mevcut?
  let bestItags = null;
  let workingInstance = null;

  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const apiUrl = `${instance}/api/v1/videos/${videoId}?fields=formatStreams`;
      console.log(`🔍 Invidious API: ${instance}`);
      const data = await httpsGetJson(apiUrl, 8000);
      const streams = (data.formatStreams || []).filter(s => s.itag && s.url);
      if (streams.length === 0) continue;
      // Kalite önceliği: 1080p (itag 37/299) → 720p (itag 22/298) → 480p → 360p (itag 18)
      const qualityOrder = [37, 299, 22, 298, 59, 78, 18];
      bestItags = qualityOrder.filter(t => streams.some(s => String(s.itag) === String(t)));
      if (bestItags.length === 0) bestItags = streams.map(s => s.itag);
      workingInstance = instance;
      console.log(`✅ Invidious API ${instance}: itag'ler: ${bestItags.join(',')}`);
      break;
    } catch (e) {
      console.log(`⚠️ Invidious API ${instance}: ${e.message?.slice(0, 60)}`);
    }
  }

  if (!bestItags || bestItags.length === 0) {
    // API yanıt vermedi — kör deneme (itag 22 ve 18)
    console.log('⚠️ Invidious API başarısız, kör itag denemesi yapılıyor...');
    bestItags = [22, 18];
  }

  // Adım 2: Her itag için tüm instanceları paralel dene
  for (const itag of bestItags) {
    const instances = workingInstance
      ? [workingInstance, ...INVIDIOUS_INSTANCES.filter(i => i !== workingInstance)]
      : INVIDIOUS_INSTANCES;

    const result = await Promise.any(
      instances.map(instance =>
        (async () => {
          const proxyUrl = `${instance}/latest_version?id=${videoId}&itag=${itag}&local=true`;
          const tmpDir = path.join(os.tmpdir(), `inv_${Date.now()}_${Math.random().toString(36).slice(2)}`);
          try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
          const filePath = path.join(tmpDir, 'video.mp4');
          await httpsDownloadToFile(proxyUrl, filePath, MAX_VIDEO_SIZE_BYTES, instance, 120000);
          const stat = fs.statSync(filePath);
          if (stat.size < 100000) throw new Error(`Çok küçük: ${stat.size} byte`);
          console.log(`✅ Invidious ${instance} itag:${itag} → ${Math.round(stat.size/1024/1024)}MB`);
          return filePath;
        })().catch(e => { console.log(`⚠️ itag:${itag} ${instance}: ${e.message?.slice(0,40)}`); throw e; })
      )
    ).catch(() => null);

    if (result) return result;
    console.log(`⚠️ itag ${itag} başarısız, sonraki deniyor...`);
  }

  console.error('❌ Invidious: tüm itag/instance kombinasyonları başarısız');
  return null;
}



const YTDLP_BIN = (() => {
  try {
    const r = spawnSync('which', ['yt-dlp'], { encoding: 'utf8', timeout: 3000 });
    if (r.stdout && r.stdout.trim()) { console.log('🔍 yt-dlp:', r.stdout.trim()); return r.stdout.trim(); }
  } catch {}
  const candidates = [
    '/root/.nix-profile/bin/yt-dlp',
    '/nix/var/nix/profiles/default/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    '/home/runner/workspace/.pythonlibs/bin/yt-dlp',
    'yt-dlp',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { console.log('🔍 yt-dlp:', c); return c; } } catch {}
  }
  console.warn('⚠️ yt-dlp bulunamadı!');
  return 'yt-dlp';
})();

// Bir video dosyasını Telegram'a yükle
async function sendVideoFile(channelId, filePath, caption) {
  const stat = fs.statSync(filePath);
  const mb = Math.round(stat.size / 1024 / 1024);
  if (stat.size > MAX_VIDEO_SIZE_BYTES) {
    console.log(`⚠️ Video çok büyük (${mb}MB), atlanıyor`);
    return false;
  }
  console.log(`📤 Telegram'a yükleniyor (${mb}MB)...`);
  try {
    await bot.sendVideo(channelId, { source: filePath }, { caption, supports_streaming: true });
    console.log(`✅ Video yüklendi (${mb}MB)`);
    return true;
  } catch (uploadErr) {
    console.error(`❌ Telegram yükleme hatası: ${uploadErr.message}`);
    return false;
  }
}

// yt-dlp ile video indir → dosya yolu döndür
async function downloadWithYtdlp(videoUrl, clientArg = 'android_testsuite') {
  const tmpDir = path.join(os.tmpdir(), `ytdlp_${Date.now()}`);
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
  const outputTemplate = path.join(tmpDir, 'video.%(ext)s');

  return new Promise((resolve) => {
    const args = [
      '--no-playlist',
      '--max-filesize', '48m',
      '--extractor-args', `youtube:player_client=${clientArg}`,
      '-f', '18/22/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=480]/best',
      '--merge-output-format', 'mp4',
      '--no-part',
      '--extractor-retries', '5',
      '--socket-timeout', '30',
      '--no-check-certificate',
      '--geo-bypass',
      '--geo-bypass-country', 'TR',
      '--match-filter', 'duration < 900',
      '-o', outputTemplate,
      '--no-warnings',
      '--add-headers', 'Cookie:SOCS=CAI',
      videoUrl,
    ];

    let proc;
    try { proc = spawn(YTDLP_BIN, args); }
    catch { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} resolve(null); return; }

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL');
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      resolve(null);
    }, 3 * 60 * 1000);

    proc.on('error', () => { clearTimeout(killTimer); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0) {
        console.error(`❌ yt-dlp kod=${code}: ${stderr.slice(-150)}`);
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        resolve(null); return;
      }
      try {
        const files = fs.readdirSync(tmpDir).filter(f => /\.(mp4|webm|mkv|mov)$/i.test(f));
        if (!files.length) { resolve(null); return; }
        resolve(path.join(tmpDir, files[0]));
      } catch { resolve(null); }
    });
  });
}

// cobalt.tools'dan video indir → dosya yolu döndür
async function downloadFromCobalt(videoUrl) {
  const cobaltUrl = await getCobaltDirectUrl(videoUrl);
  if (!cobaltUrl) return null;
  const tmpDir = path.join(os.tmpdir(), `cobalt_${Date.now()}`);
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
  const filePath = path.join(tmpDir, 'video.mp4');
  try {
    await httpsDownloadToFile(cobaltUrl, filePath, MAX_VIDEO_SIZE_BYTES, 'cobalt', 120000);
    const stat = fs.statSync(filePath);
    if (stat.size < 100000) throw new Error(`Çok küçük: ${stat.size} byte`);
    console.log(`✅ cobalt indirme: ${Math.round(stat.size / 1024 / 1024)}MB`);
    return filePath;
  } catch (e) {
    console.log(`⚠️ cobalt indirme başarısız: ${e.message?.slice(0, 60)}`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return null;
  }
}

// YouTube video indirme: cobalt → Invidious → yt-dlp
async function downloadYoutubeVideo(videoUrl) {
    console.log(`🎬 YouTube indiriliyor: ${videoUrl.slice(0, 60)}`);

    const videoId =
      videoUrl.match(/[?&]v=([^&]+)/)?.[1] ||
      videoUrl.match(/youtu\.be\/([^?]+)/)?.[1] ||
      videoUrl.match(/shorts\/([^?/]+)/)?.[1];

    if (!videoId) { console.error('❌ Video ID çıkarılamadı'); return null; }

    // 1. cobalt.tools — kendi altyapısından indirir, datacenter IP bloklamasını aşar
    console.log(`🌐 cobalt.tools deniyor (videoId: ${videoId})...`);
    const cobaltFile = await downloadFromCobalt(videoUrl);
    if (cobaltFile) return cobaltFile;

    // 2. Invidious proxy
    console.log(`🔄 Invidious deniyor...`);
    const invFile = await downloadFromInvidious(videoId);
    if (invFile) return invFile;

    // 3. yt-dlp farklı istemcilerle
    console.log('🔄 yt-dlp deneniyor...');
    for (const client of ['android_testsuite', 'tv_embedded', 'android', 'ios', 'mweb', 'web']) {
      const filePath = await downloadWithYtdlp(videoUrl, client);
      if (filePath) { console.log(`✅ yt-dlp başarılı (${client})`); return filePath; }
    }

    console.error('❌ Tüm yöntemler başarısız (cobalt + Invidious + yt-dlp)');
    return null;
  }

// sendYoutubeVideo: indir ve Telegram'a gönder
async function sendYoutubeVideo(channelId, videoUrl, caption) {
  const filePath = await downloadYoutubeVideo(videoUrl);
  if (!filePath) return false;
  try {
    const ok = await sendVideoFile(channelId, filePath, caption);
    return ok;
  } catch (err) {
    console.error(`❌ Video gönderme: ${err.message}`);
    return false;
  } finally {
    try { fs.rmSync(path.dirname(filePath), { recursive: true, force: true }); } catch {}
  }
}


// Web sayfasından doğrudan .mp4 videoyu Telegram'a gönder
async function sendWebVideo(channelId, videoUrl, caption, replyToId = null) {
  const opts = (extra = {}) => {
    const o = { caption, supports_streaming: true, ...extra };
    if (replyToId) o.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
    return o;
  };

  // 1. Önce URL'yi doğrudan Telegram'a göndermeyi dene (hızlı yol)
  try {
    await bot.sendVideo(channelId, videoUrl, opts());
    console.log('✅ Web video URL ile gönderildi');
    return true;
  } catch (err) {
    console.log(`⚠️ URL ile gönderme başarısız (${err.message}), dosya indiriliyor...`);
  }

  // 2. Videoyu kendimiz indir, dosya olarak gönder
  const tmpDir = path.join(os.tmpdir(), `webvid_${Date.now()}`);
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
  const filePath = path.join(tmpDir, 'video.mp4');

  // m3u8 / HLS stream — ffmpeg ile indir
  if (videoUrl.includes('.m3u8') || videoUrl.includes('m3u8')) {
    try {
      console.log('📡 m3u8 stream, ffmpeg ile indiriliyor...');
      await new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', [
          '-i', videoUrl,
          '-c', 'copy',
          '-movflags', '+faststart',
          '-fs', String(MAX_VIDEO_SIZE_BYTES),
          '-y', filePath,
        ]);
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg kod ${code}`)));
        proc.on('error', reject);
        setTimeout(() => { proc.kill(); reject(new Error('ffmpeg timeout')); }, 120000);
      });
      const stat = fs.statSync(filePath);
      const mb = Math.round(stat.size / 1024 / 1024);
      console.log(`📤 m3u8 indirildi (${mb}MB), gönderiliyor...`);
      await bot.sendVideo(channelId, { source: filePath }, opts());
      console.log('✅ m3u8 video gönderildi');
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return true;
    } catch (e) {
      console.error(`❌ m3u8 ffmpeg başarısız: ${e.message}`);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return false;
    }
  }

  try {
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      let totalBytes = 0;
      const doGet = (url, depth = 0) => {
        if (depth > 5) return reject(new Error('çok fazla yönlendirme'));
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': new URL(url).origin,
          }
        }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.destroy();
            doGet(res.headers.location, depth + 1);
            return;
          }
          if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
          res.on('data', (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > MAX_VIDEO_SIZE_BYTES) {
              req.destroy(); file.close();
              reject(new Error('dosya çok büyük'));
            }
          });
          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
          res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(90000, () => { req.destroy(); reject(new Error('zaman aşımı')); });
      };
      doGet(videoUrl);
    });

    const stat = fs.statSync(filePath);
    if (stat.size < 10000) throw new Error('dosya çok küçük (muhtemelen hata sayfası)');

    const mb = Math.round(stat.size / 1024 / 1024);
    console.log(`📤 Web video indirme tamamlandı (${mb}MB), Telegram'a yükleniyor...`);

    // m3u8 ise ffmpeg ile mp4'e dönüştür
    let uploadPath = filePath;
    if (videoUrl.includes('.m3u8') || fs.readFileSync(filePath, 'utf8').slice(0, 10).includes('#EXTM3U')) {
      const mp4Path = filePath.replace('.mp4', '_conv.mp4');
      try {
        await new Promise((res, rej) => {
          const proc = spawn('ffmpeg', ['-i', filePath, '-c', 'copy', '-movflags', '+faststart', '-y', mp4Path], { timeout: 120000 });
          proc.on('close', code => code === 0 ? res() : rej(new Error(`ffmpeg kod ${code}`)));
          proc.on('error', rej);
          setTimeout(() => { proc.kill(); rej(new Error('ffmpeg timeout')); }, 110000);
        });
        uploadPath = mp4Path;
        console.log('✅ ffmpeg dönüştürme tamamlandı');
      } catch (e) { console.error(`⚠️ ffmpeg dönüştürme başarısız: ${e.message}`); }
    }

    await bot.sendVideo(channelId, { source: uploadPath }, opts());
    console.log('✅ Web video dosya olarak gönderildi');
    return true;
  } catch (err) {
    console.error(`❌ Web video indirme/gönderme başarısız: ${err.message}`);
    return false;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ─── Feed Filtresi ────────────────────────────────────────────────────────────

function getActiveFeed() {
  const cat = settings.activeCategory;
  let pool;
  if (cat === 'hepsi') {
    pool = RSS_FEEDS;
  } else {
    pool = RSS_FEEDS.filter((f) => f.category === cat);
    if (pool.length === 0) pool = RSS_FEEDS;
  }

  // Video oranı düşükse önce direct/google feedlerden video çekmeyi dene
  // (publishNextNews içinde fetchArticleHtmlAndExtractVideo ile web sitelerinden video çekilir)
  // YouTube'u sadece kategori 'video' veya 'hepsi' olduğunda rotasyona dahil et
  const needed = getNeededMediaType();
  if (needed === 'video') {
    // Önce video kategorisindeki direct/google feedleri dene
    const videoNewsFeeds = pool.filter((f) => f.category === 'video' && f.type !== 'youtube');
    if (videoNewsFeeds.length > 0) {
      const idx = currentFeedIndex % videoNewsFeeds.length;
      currentFeedIndex++;
      return videoNewsFeeds[idx];
    }
    // Sonra herhangi bir direct/google feedi dene (web sayfasında video olabilir)
    const nonYtFeeds = pool.filter((f) => f.type !== 'youtube');
    if (nonYtFeeds.length > 0) {
      const idx = currentFeedIndex % nonYtFeeds.length;
      currentFeedIndex++;
      return nonYtFeeds[idx];
    }
  }

  // Normal rotasyon (youtube dahil ama sona koy)
  const nonYt = pool.filter((f) => f.type !== 'youtube');
  const yt = pool.filter((f) => f.type === 'youtube');
  const orderedPool = [...nonYt, ...yt];
  const idx = currentFeedIndex % orderedPool.length;
  currentFeedIndex++;
  return orderedPool[idx];
}

async function fetchFeed(feed) {
  try {
    // rss-parser bazı 301/302 redirect'leri takip etmez — elle takip et
    let url = feed.url;
    for (let i = 0; i < 3; i++) {
      const r = await new Promise((res) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)' } }, (resp) => {
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            resp.destroy();
            const loc = resp.headers.location;
            res({ redirect: loc.startsWith('http') ? loc : new URL(loc, url).href });
          } else {
            resp.destroy();
            res({ ok: true });
          }
        });
        req.on('error', () => res({ ok: true }));
        req.setTimeout(4000, () => { req.destroy(); res({ ok: true }); });
      });
      if (r.redirect) { url = r.redirect; } else { break; }
    }
    const result = await parser.parseURL(url);
    return result.items || [];
  } catch (err) {
    console.error(`❌ RSS hatası (${feed.source}): ${err.message}`);
    return [];
  }
}

// ─── Haber Yayınlama ──────────────────────────────────────────────────────────

function isWithinPublishHours() {
  const now = new Date();
  // Railway UTC saatini Türkiye saatine çevir (UTC+3)
  const hour = (now.getUTCHours() + 3) % 24;
  const start = settings.publishStartHour ?? 9;
  const end = settings.publishEndHour ?? 2;
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function buildItemMeta(item, feed) {
  const title = cleanTitle(item.title);
  const rawDesc = (item.contentSnippet || item.summary || '').trim();
  const description = rawDesc
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\b(iha|dha|aa|anka|ntv|trt|cnn türk?|sözcü|hürriyet|milliyet|cumhuriyet|haberturk|habertürk|halk tv?|krt tv?)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const sonDakika = isSonDakika(title, feed);
  const prefix = sonDakika ? '🚨 SON DAKİKA\n\n' : '';
  return { title, rawDesc, description, sonDakika, prefix };
}


// ─── Şimdi Yayınla: Anlık + Videoya Öncelik (7 Kademe) ──────────────────────
// publishNextNews'den farklı olarak: duraklat/saat kısıtı yok, video öncelikli

// ─── Şimdi Yayınla: Zorla Yayın (publishedUrls/duraklat/saat kısıtı YOK) ────



async function publishNowInstant() {
  const cat = settings.activeCategory;
  let feedPool = cat === 'hepsi' ? RSS_FEEDS : RSS_FEEDS.filter(f => f.category === cat);
  if (!feedPool.length) feedPool = RSS_FEEDS;
  // Haber siteleri önce (web video çekme), YouTube son çare
  feedPool = [
    ...feedPool.filter(f => f.type === 'direct'),
    ...feedPool.filter(f => f.type === 'google'),
    ...feedPool.filter(f => f.type === 'youtube'),
  ];
  console.log(`⚡ [Şimdi Yayınla] ${feedPool.length} feed...`);
  tgLog(`⚡ Şimdi Yayınla başladı — ${feedPool.length} kaynak taranıyor (kategori: ${cat})`);

  for (const feed of feedPool) {
    let items;
    try { items = await fetchFeed(feed); } catch (e) { tgLog(`⚠️ Feed hatası (${feed.label}): ${e.message?.slice(0,80)}`); continue; }
    if (!items || items.length === 0) { console.log(`ℹ️ Boş feed: ${feed.label}`); continue; }

    const candidates = items
      .filter(a => {
        if (!(a.link || a.guid)) return false;
        // Zaten yayınlanmış veya denenmiş URL'leri atla
        if (publishedUrls.has(a.link || a.guid)) return false;
        const t = cleanTitle(a.title);
        if (t.length < 10) return false;
        if (BLOCKED_TITLE_PATTERNS.some(p => p.test(t))) { console.log(`⛔ Junk başlık atlandı: ${t.slice(0,50)}`); return false; }
        return true;
      })
      .slice(0, 5);

    if (candidates.length === 0) { tgLog(`⏭ ${feed.label}: uygun içerik yok`); continue; }
    tgLog(`🔍 ${feed.label}: ${candidates.length} aday bulundu`);

    for (const item of candidates) {
      const url = item.link || item.guid;
      const { title, rawDesc, description, prefix } = buildItemMeta(item, feed);
      const sourceName = feed.source || '';
      tgLog(`📌 Deneniyor: "${title.slice(0, 80)}"`);

      const aiSummary = await summarizeNews(title, rawDesc || description);
      const catTag = detectCategory(title, rawDesc);
      const catEmoji = catTag ? `${catTag} ` : '';
      let caption = stripLinks(`${prefix}${catEmoji}${title}`);
      if (aiSummary && aiSummary.length > 5) caption += `\n\n${cleanArrows(stripLinks(aiSummary))}`;
      if (caption.length > 1024) caption = caption.slice(0, 1021) + '…';

      let sentType = 'none';

      try {
        // ═══ YouTube feed ════════════════════════════════════════════════
        if (feed.type === 'youtube') {
          console.log(`⚡ [ŞY] YouTube: ${url.slice(0, 60)}`);
          const ok = await sendYouTubeVideoSmart(CHANNEL_ID, url, caption);
          if (ok) {
            sentType = 'video'; mediaStats.video++;
            publishedUrls.add(url); persistPublishedUrls();
            await notifyFilterUsers(title, rawDesc, url);
            console.log(`✅ [ŞY] YouTube video: ${title.slice(0, 50)}`);
            return '✅ Video yayınlandı! 🎬';
          }
          // YouTube başarısız — sayfadaki gömülü video var mı dene
          tgLog(`⚠️ YouTube gönderilemedi, sayfa videosu aranıyor...`);
          const ytPageVid = await fetchArticleHtmlAndExtractVideo(url);
          if (ytPageVid && !/youtube|youtu\.be/i.test(ytPageVid)) {
            const ok2 = await sendWebVideo(CHANNEL_ID, ytPageVid, caption);
            if (ok2) {
              sentType = 'video'; mediaStats.video++;
              publishedUrls.add(url); persistPublishedUrls();
              await notifyFilterUsers(title, rawDesc, url);
              return '✅ Video yayınlandı! 🎬';
            }
          }
          continue;
        }

        // ═══ Google News → gerçek URL ════════════════════════════════════
        let realUrl = url;
        if (url.includes('news.google.com')) {
          tgLog(`🔗 URL çözülüyor...`);
          realUrl = (await resolveGoogleNewsUrl(url)) || url;
          tgLog(`🔗 → ${realUrl.slice(0, 80)}`);
        }

        // fetchOgMeta redirect'leri takip eder — Google News URL olsa bile çalışır
        // ═══ 1. og:image çek (hızlı — her URL türünde dene) ═════════════
        tgLog(`🖼 Görsel aranıyor...`);
        const ogMeta = await fetchOgMeta(realUrl);
        const rssMedia = extractMedia(item);
        if (rssMedia.url) rssMedia.url = upgradeImageUrl(rssMedia.url);
        let ogImg = ogMeta.image ? upgradeImageUrl(ogMeta.image) : (rssMedia.type === 'image' ? rssMedia.url : null);
        const ogImg2 = ogMeta.image2 ? upgradeImageUrl(ogMeta.image2) : null;

        // ═══ 2. Sayfadaki gömülü video var mı? (Google News değilse) ════
        let articleVidUrl = null;
        if (sentType === 'none' && !realUrl.includes('news.google.com')) {
          articleVidUrl = await fetchArticleHtmlAndExtractVideo(realUrl);
          if (articleVidUrl) tgLog(`🎬 Sayfa videosu bulundu: ${articleVidUrl.slice(0, 60)}`);
        }

        // ═══ 3. Video gönder (doğrudan, link/buton yok) ═════════════════
        if (sentType === 'none' && articleVidUrl) {
          const ok = await sendWebVideo(CHANNEL_ID, articleVidUrl, caption);
          if (ok) { sentType = 'video'; mediaStats.video++; }
        }

        // ═══ 4. Resim gönder ════════════════════════════════════════════
        if (sentType === 'none' && ogImg) {
          tgLog(`🖼 Görsel gönderiliyor: ${ogImg.slice(0, 60)}`);
          if (ogImg2) {
            try {
              await bot.sendMediaGroup(CHANNEL_ID, [
                { type: 'photo', media: ogImg, caption },
                { type: 'photo', media: ogImg2 },
              ]);
              sentType = 'image'; mediaStats.image++;
            } catch (e1) {
              tgLog(`⚠️ Media group hata: ${e1.message?.slice(0,80)}, tek foto deneniyor...`);
              try { await bot.sendPhoto(CHANNEL_ID, ogImg, { caption }); sentType = 'image'; mediaStats.image++; }
              catch (e2) { tgLog(`❌ Foto gönderilemedi: ${e2.message?.slice(0,100)}`); }
            }
          } else {
            try { await bot.sendPhoto(CHANNEL_ID, ogImg, { caption }); sentType = 'image'; mediaStats.image++; }
            catch (e) { tgLog(`❌ Foto gönderilemedi: ${e.message?.slice(0,100)}`); }
          }
        }

        // ═══ 5. Görsel de yok — sonraki habere geç ══════════════════════
        if (sentType === 'none') {
          tgLog(`⏭ Medya bulunamadı, sonraki aday deneniyor...`);
          // Bu URL'yi geçici olarak işaretle (session süresince tekrar deneme)
          publishedUrls.add(url);
          persistPublishedUrls();
        }

        if (sentType !== 'none') {
          publishedUrls.add(url); persistPublishedUrls();
          await notifyFilterUsers(title, rawDesc, url);
          console.log(`✅ [ŞY] [${sentType}] ${title.slice(0, 60)}`);
          return sentType === 'video'
            ? '✅ Video yayınlandı! 🎬'
            : sentType === 'image' ? '📸 Resimli haber yayınlandı.' : '📝 Metin haber yayınlandı.';
        }

        console.log(`⏭ [ŞY] Sonraki deneniyor...`);
      } catch (err) {
        console.error(`❌ [ŞY] Hata: ${err.message}`);
      }
    }
  }
  return '⚠️ Haber yayınlanamadı, lütfen tekrar deneyin.';
}

async function publishNextNews() {
  if (settings.paused) { console.log('⏸ Bot duraklatıldı.'); return; }
  if (!isWithinPublishHours()) {
    const start = String(settings.publishStartHour).padStart(2,'0');
    const end = String(settings.publishEndHour).padStart(2,'0');
    console.log(`🕐 Yayın saati dışında (${start}:00-${end}:00), atlanıyor.`);
    return;
  }

  const feed = getActiveFeed();
  console.log(`📡 ${feed.label} çekiliyor...`);
  const items = await fetchFeed(feed);

  const needed = getNeededMediaType();
  const validItems = sortByNeededMedia(
    items.filter((a) => (a.link || a.guid) && !publishedUrls.has(a.link || a.guid) && isValidNewsItem(a, feed)),
    needed
  );

  if (validItems.length === 0) {
    console.log(`ℹ️ ${feed.source}: yeni haber yok, atlanıyor.`);
    return;
  }

  // ── YouTube haberi ──────────────────────────────────────────────────────────
  if (feed.type === 'youtube') {
    const item = validItems[0];
    const url = item.link || item.guid;

    const { title: checkTitle } = buildItemMeta(item, feed);
    if (isTitleDuplicate(checkTitle)) {
      console.log(`⏭ Başlık zaten yayınlandı (session): ${checkTitle.slice(0, 40)}`);
      return;
    }

    publishedUrls.add(url);
    persistPublishedUrls();

    const { title, rawDesc, sonDakika, prefix } = buildItemMeta(item, feed);
    const aiSummary = await summarizeNews(title, rawDesc);
    const categoryTag = detectCategory(title, rawDesc);

    const catEmoji = categoryTag ? `${categoryTag} ` : '';
    let caption = stripLinks(`${prefix}${catEmoji}${title}`);
    if (aiSummary && aiSummary.length > 5) caption += `\n\n${cleanArrows(stripLinks(aiSummary))}`;
    if (caption.length > 1024) caption = caption.slice(0, 1021) + '…';

    const replyToId = findRelatedMessageId(title);

    const videoId = item.videoId || (url.match(/[?&]v=([^&]+)/) || [])[1] || (url.match(/youtu\.be\/([^?]+)/) || [])[1];
    const thumbUrl = videoId
      ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`
      : (() => { const mg = item.mediaGroup || item['media:group']; return mg?.['media:thumbnail']?.[0]?.$?.url ? upgradeImageUrl(mg['media:thumbnail'][0].$.url) : null; })();

    let sentMsg = null;
    let sentType = 'image';

    const replyParam = replyToId ? { reply_parameters: { message_id: replyToId, allow_sending_without_reply: true } } : {};

    // 1. YouTube videoyu indir, Telegram'a gönder
    const videoSent = await sendYouTubeVideoSmart(CHANNEL_ID, url, caption);
    if (videoSent) {
      sentType = 'video';
      if (sentMsg?.message_id) registerSentMessage(sentMsg.message_id, title);
      console.log(`✅ [${feed.source}] [youtube/video]${replyToId ? ' [reply]' : ''} ${title.slice(0, 50)}`);
      mediaStats.video++;
      const t = mediaStats.image + mediaStats.video + mediaStats.text;
      console.log(`📊 Resim:%${Math.round(mediaStats.image/t*100)} Video:%${Math.round(mediaStats.video/t*100)} Metin:%${Math.round(mediaStats.text/t*100)}`);
      if (sonDakika && sentMsg?.message_id) await tryPin(sentMsg.message_id);
      await notifyFilterUsers(title, rawDesc, url);
    } else {
      // Video indirilemedi — YouTube'dan resim GÖNDERME, haberi bu session'da atla
      console.log(`⏭ YouTube video indirilemedi, thumbnail gönderilmiyor — haber atlanıyor: ${title.slice(0,50)}`);
      // URL'yi publishedUrls'te bırak (sil değil) — aynı haberi tekrar deneme
      // Sadece session'da atla, kalıcı olarak kaydedilmiş durumda
    }
    return;
  }

  // ── Normal haber — medyalı öğe bul (max 10 deneme) ────────────────────────
  const MAX_TRIES = 10;
  let chosenItem = null;
  let chosenMedia = { type: null, url: null };
  let chosenMedia2 = null;  // İkinci görsel (media group için)
  let chosenOgDesc = null;
  let chosenArticleBody = null;

  for (let i = 0; i < Math.min(MAX_TRIES, validItems.length); i++) {
    const candidate = validItems[i];
    const rawCandidateUrl = candidate.link || candidate.guid;

    // Google News URL'lerini önce decode et (HTTP gerektirmez)
    let candidateUrl = rawCandidateUrl;
    if (rawCandidateUrl.includes('news.google.com')) {
      candidateUrl = (await resolveGoogleNewsUrl(rawCandidateUrl)) || rawCandidateUrl;
      if (candidateUrl !== rawCandidateUrl) console.log(`🔓 Çözüldü: ${candidateUrl.slice(0, 80)}`);
    }

    let media = extractMedia(candidate);
    if (media.url) { media.url = upgradeImageUrl(media.url); }

    // Web sayfasından video çıkar (her zaman dene)
    if (!media.url || media.type !== 'video') {
      const webVid = await fetchArticleHtmlAndExtractVideo(candidateUrl);
      if (webVid) { media = { type: 'video', url: webVid }; console.log(`🎬 Web video: ${webVid.slice(0, 60)}`); }
    }

    // OG meta çek (görsel + açıklama + 2. görsel)
    const ogMeta = await fetchOgMeta(candidateUrl);
    if (ogMeta.description && !chosenOgDesc) chosenOgDesc = ogMeta.description;
    if (ogMeta.articleBody && !chosenArticleBody) chosenArticleBody = ogMeta.articleBody;

    if (!media.url && ogMeta.image) {
      media = { type: 'image', url: upgradeImageUrl(ogMeta.image) };
    }

    // İkinci görsel topla (aynı haberden)
    if (media.type === 'image' && !chosenMedia2 && ogMeta.image2) {
      chosenMedia2 = upgradeImageUrl(ogMeta.image2);
    }

    if (media.url) { chosenItem = candidate; chosenMedia = media; break; }
  }

  // Görsel/video bulunamazsa haberi atla (metin olarak gönderme)
  if (!chosenMedia.url) {
    console.log(`⏭ [${feed.source}] Medyalı haber bulunamadı, atlanıyor.`);
    return;
  }

  if (!chosenItem) return;

  const url = chosenItem.link || chosenItem.guid;
  const { title: checkTitle2 } = buildItemMeta(chosenItem, feed);
  if (isTitleDuplicate(checkTitle2)) {
    console.log(`⏭ Başlık zaten yayınlandı (session): ${checkTitle2.slice(0, 40)}`);
    return;
  }

  publishedUrls.add(url);
  persistPublishedUrls();

  const { title, rawDesc, description, sonDakika, prefix } = buildItemMeta(chosenItem, feed);

  if (!chosenArticleBody && !chosenOgDesc) {
    try {
      const ogMeta = await fetchOgMeta(url);
      if (ogMeta.description) chosenOgDesc = ogMeta.description;
      if (ogMeta.articleBody) chosenArticleBody = ogMeta.articleBody;
    } catch {}
  }

  const bestDesc = chosenOgDesc || description || rawDesc;
  const aiSummary = await summarizeNews(title, bestDesc, chosenArticleBody);

  const categoryTag = detectCategory(title, bestDesc);

  const catEmoji2 = categoryTag ? `${categoryTag} ` : '';
  let caption = stripLinks(`${prefix}${catEmoji2}${title}`);
  if (aiSummary && aiSummary.length > 5) {
    caption += `\n\n${cleanArrows(stripLinks(aiSummary))}`;
  }

  if (caption.length > 1024) caption = caption.slice(0, 1021) + '…';

  const replyToId = findRelatedMessageId(title);

  let sentMsg = null;
  let sentType = 'text';
  const sendOpts = (extra = {}) => replyToId
    ? { ...extra, reply_parameters: { message_id: replyToId, allow_sending_without_reply: true } }
    : extra;

  try {
    if (chosenMedia.type === 'video') {
      const webSent = await sendWebVideo(CHANNEL_ID, chosenMedia.url, caption, replyToId);
      if (webSent) {
        sentType = 'video';
      } else {
        // Web video başarısız → OG image ile dene
        console.log('⚠️ Web video başarısız, görsel fallback deneniyor...');
        const ogMeta2 = await fetchOgMeta(chosenItem.link || chosenItem.guid);
        const fallbackImg = ogMeta2.image ? upgradeImageUrl(ogMeta2.image) : null;
        if (fallbackImg) {
          try {
            sentMsg = await bot.sendPhoto(CHANNEL_ID, fallbackImg, sendOpts({ caption }));
            sentType = 'image';
            console.log('🖼 Video yerine görsel gönderildi');
          } catch { sentType = 'skip'; }
        } else {
          sentType = 'skip';
          console.log('⏭ Görsel de yok, haber atlanıyor');
        }
      }
    } else if (chosenMedia.type === 'image') {
      // İki görsel varsa media group gönder
      if (chosenMedia2) {
        try {
          const mediaGroup = [
            { type: 'photo', media: chosenMedia.url, caption, parse_mode: undefined },
            { type: 'photo', media: chosenMedia2 },
          ];
          const msgs = await bot.sendMediaGroup(CHANNEL_ID, mediaGroup, replyToId ? { reply_parameters: { message_id: replyToId, allow_sending_without_reply: true } } : {});
          sentMsg = msgs?.[0] || null;
          sentType = 'image';
          console.log('📸📸 İki görsel (media group) gönderildi');
        } catch {
          // Media group başarısız → tek görsel
          sentMsg = await bot.sendPhoto(CHANNEL_ID, chosenMedia.url, sendOpts({ caption }));
          sentType = 'image';
        }
      } else {
        sentMsg = await bot.sendPhoto(CHANNEL_ID, chosenMedia.url, sendOpts({ caption }));
        sentType = 'image';
      }
    } else {
      // Medya yok — haberi atla (metin olarak gönderme)
      sentType = 'skip';
      console.log('⏭ Medya yok, haber atlanıyor (metin gönderme kapalı)');
    }
    console.log(`✅ [${feed.source}] [${sentType}]${replyToId ? ' [reply]' : ''} ${title.slice(0, 50)}`);
  } catch (err) {
    console.error(`❌ Gönderme hatası (${chosenMedia.type}): ${err.message}`);
    sentType = 'skip';
  }

  if (sentMsg?.message_id) registerSentMessage(sentMsg.message_id, title);

  mediaStats[sentType]++;
  const total = mediaStats.image + mediaStats.video + mediaStats.text;
  console.log(`📊 Resim:%${Math.round(mediaStats.image/total*100)} Video:%${Math.round(mediaStats.video/total*100)} Metin:%${Math.round(mediaStats.text/total*100)}`);
  if (sonDakika && sentMsg?.message_id) await tryPin(sentMsg.message_id);
  await notifyFilterUsers(title, rawDesc, url);
}

// ─── Dinamik Interval ─────────────────────────────────────────────────────────

let newsInterval = null;

function resetInterval() {
  if (newsInterval) clearInterval(newsInterval);
  const ms = Math.max(0.5, settings.intervalMinutes) * 60 * 1000;
  newsInterval = setInterval(publishNextNews, ms);
  console.log(`⏱ Yayın aralığı güncellendi: ${settings.intervalMinutes} dakika`);
}

  // ─── Son Dakika Tarayıcısı ────────────────────────────────────────────────────

  let breakingNewsInterval = null;
  const BREAKING_INTERVAL_MS = 60 * 1000; // 60 saniye
let lastBreakingNewsTime = 0;
const BREAKING_MIN_GAP_MS = 90 * 1000; // İki son dakika arası min 90 sn

  
  
// ─── Google News URL Çözücü (Base64 Decoder — HTTP isteği gerekmez) ──────────
// Google News article URL'leri CBMi... ile başlayan Base64 kodlu veri içerir.
// Bu veriyi decode edince asıl makale URL'si çıkar — Railway IP engelini aşar.
function decodeGoogleNewsUrl(googleUrl) {
  try {
    const match = googleUrl.match(/articles\/([A-Za-z0-9_-]+)/);
    if (!match) return null;
    const b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(b64 + '==', 'base64');
    // Buffer içinde "http" byte dizisini bul
    for (let i = 0; i < buf.length - 4; i++) {
      if (buf[i] === 0x68 && buf[i+1] === 0x74 && buf[i+2] === 0x74 && buf[i+3] === 0x70) {
        let end = i;
        while (end < buf.length && buf[end] >= 0x20 && buf[end] <= 0x7e) end++;
        const url = buf.slice(i, end).toString('ascii').split(/[\x00-\x1f\x10]/)[0];
        if (url.startsWith('http') && !url.includes('news.google.com')) return url;
      }
    }
  } catch {}
  return null;
}

// ─── Google News Redirect Çözücü ─────────────────────────────────────────────
async function resolveGoogleNewsUrl(googleUrl, depth) {
  depth = depth || 0;
  // 1. Önce Base64 decoder dene (HTTP gerektirmez, anlık)
  const decoded = decodeGoogleNewsUrl(googleUrl);
  if (decoded) { console.log(`🔓 Google News decode: ${decoded.slice(0, 80)}`); return decoded; }
  if (depth > 4) return null;
  // 2. HTTP redirect takip et
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done(null), 7000);
    const req = https.get(googleUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html,application/xhtml+xml' },
    }, (res) => {
      clearTimeout(timer);
      if ((res.statusCode >= 300 && res.statusCode < 400) && res.headers.location) {
        res.destroy();
        const loc = res.headers.location;
        resolveGoogleNewsUrl(loc.startsWith('http') ? loc : `https://news.google.com${loc}`, depth + 1).then(done);
        return;
      }
      let html = '';
      res.on('data', (c) => { html += c; if (html.length > 40000) res.destroy(); });
      res.on('end', () => {
        const metaUrl = html.match(/content=["'][^"']*url=([^"'&]+)/i)?.[1];
        if (metaUrl && metaUrl.startsWith('http') && !metaUrl.includes('google.com')) return done(decodeURIComponent(metaUrl));
        const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1];
        if (canonical && !canonical.includes('news.google.com')) return done(canonical);
        const jsUrl = html.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/)?.[1];
        if (jsUrl && jsUrl.startsWith('http') && !jsUrl.includes('news.google.com')) return done(jsUrl);
        done(null);
      });
      res.on('error', () => done(null));
    });
    req.on('error', () => { clearTimeout(timer); done(null); });
    req.setTimeout(6000, () => { req.destroy(); clearTimeout(timer); done(null); });
  });
}

// ─── Makale HTML'inden YouTube Video ID'lerini Çıkar ─────────────────────────
function extractYouTubeIdsFromHtml(html) {
  if (!html) return [];
  const ids = new Set();
  const patterns = [
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/g,
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/g,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/g,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/g,
    /"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/g,
    /data-video-id=["']([a-zA-Z0-9_-]{11})["']/g,
  ];
  for (const re of patterns) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(html)) !== null) {
      if (m[1] && m[1].length === 11) ids.add(m[1]);
    }
  }
  return [...ids].slice(0, 3);
}

// ─── Ham HTML Çekici (tam redirect desteği) ───────────────────────────────────
function fetchArticleHtmlRaw(url, redirectCount) {
  redirectCount = redirectCount || 0;
  if (redirectCount > 5) return Promise.resolve('');
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v || ''); } };
    const timer = setTimeout(() => done(''), 10000);
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
      },
    }, (res) => {
      clearTimeout(timer);
      if ((res.statusCode >= 300 && res.statusCode < 400) && res.headers.location) {
        res.destroy();
        fetchArticleHtmlRaw(res.headers.location, redirectCount + 1).then(done);
        return;
      }
      let html = '';
      res.on('data', (c) => { html += c; if (html.length > 150000) res.destroy(); });
      res.on('end', () => done(html));
      res.on('error', () => done(''));
    });
    req.on('error', () => { clearTimeout(timer); done(''); });
    req.setTimeout(9000, () => { req.destroy(); clearTimeout(timer); done(''); });
  });
}

// ─── Gelişmiş Web Video Çıkarıcı (Türk haber sitelerine özel) ────────────────
function extractWebVideoEnhanced(html) {
  if (!html) return null;

  // 1. og:video meta tag
  const ogVideo =
    html.match(/<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::url)?["']/i)?.[1];
  if (ogVideo && /\.(mp4|webm|m3u8)/i.test(ogVideo)) return ogVideo;

  // 2. <video> / <source> tag
  const videoSrc =
    html.match(/<video[^>]+src=["']([^"']+\.(?:mp4|webm|m3u8))["']/i)?.[1] ||
    html.match(/<source[^>]+src=["']([^"']+\.(?:mp4|webm|m3u8))["']/i)?.[1];
  if (videoSrc) return videoSrc;

  // 3. JSON player config (JW Player, Flowplayer, Videojs)
  const jsonVid =
    html.match(/"(?:videoUrl|video_url|hlsUrl|hls_url|streamUrl|manifestUrl|mp4Url|file|src)"\s*:\s*"(https?:\/\/[^"]+\.(?:mp4|m3u8|webm)[^"]*)"/i)?.[1] ||
    html.match(/'(?:videoUrl|video_url|hlsUrl|file|src)'\s*:\s*'(https?:\/\/[^']+\.(?:mp4|m3u8)[^']*)'/i)?.[1] ||
    html.match(/file\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8))["']/i)?.[1] ||
    html.match(/source\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8))["']/i)?.[1];
  if (jsonVid) return jsonVid;

  // 4. data-* attributes
  const dataVid =
    html.match(/data-(?:video-url|mp4|hls|stream|src|file)=["'](https?:\/\/[^"']+\.(?:mp4|m3u8))["']/i)?.[1] ||
    html.match(/data-src=["']([^"']+\.(?:mp4|webm|m3u8))["']/i)?.[1];
  if (dataVid) return dataVid;

  // 5. CDN URL'leri (Turkish news CDNs)
  const cdnVid =
    html.match(/["'](https?:\/\/(?:cdn|medya|video|stream|vod|content|media)[^"']*\.(?:mp4|m3u8)(?:\?[^"']*)?)["']/i)?.[1] ||
    html.match(/["'](https?:\/\/[^"']*\/(?:video|stream|vod)\/[^"']*\.(?:mp4|m3u8)(?:\?[^"']*)?)["']/i)?.[1] ||
    html.match(/["'](https?:\/\/[^"']{10,400}\.(?:mp4|m3u8))["']/i)?.[1];
  if (cdnVid && cdnVid.length < 600) return cdnVid;

  // 6. Dailymotion / Vimeo embed → döndür, yt-dlp indirir
  const dm = html.match(/dailymotion\.com\/embed\/video\/([a-zA-Z0-9]+)/i);
  if (dm) return `https://www.dailymotion.com/video/${dm[1]}`;

  const vimeo = html.match(/player\.vimeo\.com\/video\/(\d+)/i);
  if (vimeo) return `https://vimeo.com/${vimeo[1]}`;

  return null;
}

// ─── Genel URL için yt-dlp (1000+ platform) ──────────────────────────────────
async function downloadGenericWithYtdlp(pageUrl) {
  const tmpDir = path.join(os.tmpdir(), `generic_${Date.now()}`);
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
  const outputTpl = path.join(tmpDir, 'video.%(ext)s');

  return new Promise((resolve) => {
    const args = [
      '--no-playlist',
      '--max-filesize', '48m',
      '-f', 'bestvideo[height>=720][height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height>=480][ext=mp4]+bestaudio/best[height<=1080]/best',
      '--merge-output-format', 'mp4',
      '--no-part',
      '--socket-timeout', '60',
      '--no-check-certificate',
      '--geo-bypass',
      '--match-filter', 'duration < 600',
      '--extractor-retries', '2',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      '-o', outputTpl,
      '--no-warnings',
      '--quiet',
      pageUrl,
    ];
    let proc;
    try { proc = spawn(YTDLP_BIN, args); }
    catch { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} resolve(null); return; }

    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL');
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      resolve(null);
    }, 120000);

    proc.on('error', () => { clearTimeout(killTimer); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} resolve(null); });
    proc.on('close', (exitCode) => {
      clearTimeout(killTimer);
      if (exitCode !== 0) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} resolve(null); return; }
      try {
        const files = fs.readdirSync(tmpDir).filter(f => /\.(mp4|webm|mkv|mov)$/i.test(f));
        if (!files.length) { resolve(null); return; }
        const fullPath = path.join(tmpDir, files[0]);
        const stat = fs.statSync(fullPath);
        if (stat.size < 100000) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} resolve(null); return; }
        console.log(`✅ yt-dlp generic: ${files[0]} (${Math.round(stat.size / 1024 / 1024)}MB)`);
        resolve(fullPath);
      } catch { resolve(null); }
    });
  });
}

// ─── YouTube Başlık Araması (Invidious) ──────────────────────────────────────


// YouTube HTML scrape ile video ara — Invidious başarısız olursa
async function searchYouTubeScrape(query) {
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=CAI%253D`;
    const html = await new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'tr-TR,tr;q=0.9',
        }
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; if (data.length > 500000) res.destroy(); });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      setTimeout(() => req.destroy(new Error('timeout')), 10000);
    });
    // ytInitialData içindeki videoId'leri yakala
    const matches = [...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)];
    const ids = [...new Set(matches.map(m => m[1]))].slice(0, 3);
    if (ids.length > 0) { console.log(`🔍 YouTube scrape: ${ids[0]}`); return ids[0]; }
  } catch (e) {
    console.log(`⚠️ YouTube scrape başarısız: ${e.message?.slice(0, 40)}`);
  }
  return null;
}

async function searchYouTubeByTitle(title, source) {
  const sourcePrefix = source ? source.replace(/[<>"{}|^[`]/g, '').trim() + ' ' : '';
  const rawQuery = (sourcePrefix + title).slice(0, 100).replace(/[<>"{}|^[`]/g, ' ').trim();

  for (const instance of INVIDIOUS_INSTANCES.slice(0, 6)) {
    try {
      const url = `${instance}/api/v1/search?q=${encodeURIComponent(rawQuery)}&type=video&sort_by=date&page=1`;
      const results = await httpsGetJson(url, 9000);
      if (!Array.isArray(results) || results.length === 0) continue;
      const pick = results.slice(0, 8).find(r =>
        r.videoId && (r.lengthSeconds || 0) > 15 && (r.lengthSeconds || 9999) < 600
      );
      if (pick && pick.videoId) {
        console.log(`🔍 YouTube "${rawQuery.slice(0, 50)}" → ${pick.videoId}`);
        return pick.videoId;
      }
    } catch { /* sonraki */ }
  }

  if (source) {
    const fallback = title.slice(0, 80).replace(/[<>"{}|^[`]/g, ' ').trim();
    for (const instance of INVIDIOUS_INSTANCES.slice(0, 4)) {
      try {
        const url = `${instance}/api/v1/search?q=${encodeURIComponent(fallback)}&type=video&sort_by=date&page=1`;
        const results = await httpsGetJson(url, 8000);
        if (!Array.isArray(results) || results.length === 0) continue;
        const pick = results.slice(0, 5).find(r =>
          r.videoId && (r.lengthSeconds || 0) > 15 && (r.lengthSeconds || 9999) < 600
        );
        if (pick && pick.videoId) {
          console.log(`🔍 YouTube fallback "${fallback.slice(0, 40)}" → ${pick.videoId}`);
          return pick.videoId;
        }
      } catch {}
    }
  }
  // YouTube HTML scrape son çare
    const scrapeQuery = (sourcePrefix + title).slice(0, 80);
    console.log(`🔍 YouTube scrape fallback: "${scrapeQuery.slice(0,50)}"`);
    const scrapeId = await searchYouTubeScrape(scrapeQuery);
    if (scrapeId) return scrapeId;
    return null;
  }




async function checkBreakingNews() {
  if (settings.paused) return;

  const nowMs = Date.now();
  if (nowMs - lastBreakingNewsTime < BREAKING_MIN_GAP_MS) {
    const rem = Math.round((BREAKING_MIN_GAP_MS - (nowMs - lastBreakingNewsTime)) / 1000);
    console.log(`⏳ Son dakika bekleniyor: ${rem}sn`);
    return;
  }

  for (const feed of BREAKING_NEWS_FEEDS) {
    try {
      const items = await fetchFeed(feed);
      const newItems = items.filter(item => {
        const u = item.link || item.guid;
        return u && !publishedUrls.has(u) && isValidNewsItem(item, feed) && isBreakingNews(item.title || '');
      });

      for (const item of newItems.slice(0, 1)) {
        const url = item.link || item.guid;
        const { title: checkTitle } = buildItemMeta(item, feed);
        if (isTitleDuplicate(checkTitle)) continue;

        publishedUrls.add(url);
        persistPublishedUrls();
        lastBreakingNewsTime = Date.now();

        const { title, rawDesc } = buildItemMeta(item, feed);
        const sourceName = feed.source || '';
        const aiSummary = await summarizeNews(title, rawDesc);
        const categoryTag = detectCategory(title, rawDesc);
        const catEmoji = categoryTag ? `${categoryTag} ` : '';

        let caption = stripLinks(`🚨 SON DAKİKA\n\n${catEmoji}${title}`);
        if (aiSummary && aiSummary.length > 5) caption += `\n\n${cleanArrows(stripLinks(aiSummary))}`;
        if (caption.length > 1024) caption = caption.slice(0, 1021) + '…';

        let sentMsg = null;
        let sentType = 'text';

        try {
          let realUrl = url;
          if (url.includes('news.google.com')) {
            realUrl = (await resolveGoogleNewsUrl(url)) || url;
          }

          // Haber sitesinden video
          if (!realUrl.includes('news.google.com')) {
            const ok = await sendArticleVideoSmart(CHANNEL_ID, realUrl, caption);
            if (ok) { sentType = 'video'; mediaStats.video++; }
          }

          // YouTube araması
          if (sentType !== 'video' && sourceName) {
            const ytId = await searchYouTubeByTitle(title, sourceName);
            if (ytId) {
              const ok = await sendYouTubeVideoSmart(CHANNEL_ID, `https://www.youtube.com/watch?v=${ytId}`, caption);
              if (ok) { sentType = 'video'; mediaStats.video++; }
            }
          }

          // Resim
          if (sentType !== 'video') {
            const ogMeta = await fetchOgMeta(realUrl);
            const rssMedia = extractMedia(item);
            if (rssMedia.url) rssMedia.url = upgradeImageUrl(rssMedia.url);
            const img1 = ogMeta.image ? upgradeImageUrl(ogMeta.image) : (rssMedia.type === 'image' ? rssMedia.url : null);
            const img2 = ogMeta.image2 ? upgradeImageUrl(ogMeta.image2) : null;

            if (img1 && img2) {
              try {
                const msgs = await bot.sendMediaGroup(CHANNEL_ID, [
                  { type: 'photo', media: img1, caption }, { type: 'photo', media: img2 },
                ]);
                sentMsg = msgs?.[0] || null; sentType = 'image'; mediaStats.image++;
              } catch {
                try { sentMsg = await bot.sendPhoto(CHANNEL_ID, img1, { caption }); sentType = 'image'; mediaStats.image++; } catch {}
              }
            } else if (img1) {
              try {
                sentMsg = await bot.sendPhoto(CHANNEL_ID, img1, { caption });
                sentType = 'image'; mediaStats.image++;
              } catch {
                sentMsg = await bot.sendMessage(CHANNEL_ID, caption).catch(() => null);
                sentType = 'text'; mediaStats.text++;
              }
            } else {
              sentMsg = await bot.sendMessage(CHANNEL_ID, caption).catch(() => null);
              sentType = 'text'; mediaStats.text++;
            }
          }

          const pinId = sentMsg?.message_id || null;
          if (pinId) { registerSentMessage(pinId, title); await tryPin(pinId); }
          console.log(`✅ [Son Dakika] [${sentType}] ${title.slice(0, 60)}`);
          await notifyFilterUsers(title, rawDesc, url);
          return;

        } catch (err) {
          console.error(`❌ Son dakika hatası: ${err.message}`);
        }
      }
    } catch { /* feed hatası */ }
  }
}

function startBreakingNewsChecker() {
    if (breakingNewsInterval) clearInterval(breakingNewsInterval);
    breakingNewsInterval = setInterval(checkBreakingNews, BREAKING_INTERVAL_MS);
    console.log(`🚨 Son dakika tarayıcısı aktif (her ${BREAKING_INTERVAL_MS / 1000} saniyede bir)`);
  }

  

// ─── Admin Panel ──────────────────────────────────────────────────────────────

function adminPanelText() {
  const sh = String(settings.publishStartHour ?? 9).padStart(2, '0');
  const eh = String(settings.publishEndHour ?? 2).padStart(2, '0');
  const inWindow = isWithinPublishHours();
  return (
    `🔧 *Admin Paneli*\n\n` +
    `⏱ Yayın Sıklığı: *${settings.intervalMinutes} dakika*\n` +
    `📂 Aktif Kategori: *${CATEGORY_LABELS[settings.activeCategory] || settings.activeCategory}*\n` +
    `${settings.paused ? '⏸ Durum: *Duraklatıldı*' : `▶️ Durum: *${inWindow ? 'Çalışıyor' : 'Yayın saati dışı'}*`}\n` +
    `🕐 Yayın Saati: *${sh}:00 – ${eh}:00*\n` +
    `📅 Haber Yaşı: *Son ${settings.maxAgeHours || 24} saat*\n` +
    `📊 Yayınlanan: *${publishedUrls.size}* haber\n` +
    `👥 Kullanıcı: *${Object.keys(users).length}*`
  );
}

function adminPanelKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '⏱ Süre Ayarla', callback_data: 'admin_interval_menu' },
        { text: '📂 Kategori Seç', callback_data: 'admin_category_menu' },
      ],
      [
        { text: '📅 Haber Aralığı', callback_data: 'admin_daterange_menu' },
        { text: '🕐 Yayın Saati', callback_data: 'admin_timewindow_menu' },
      ],
      [
        { text: '▶️ Şimdi Yayınla', callback_data: 'admin_publish_now' },
        { text: settings.paused ? '▶️ Devam Et' : '⏸ Duraklat', callback_data: 'admin_toggle_pause' },
      ],
      [
        { text: '📊 İstatistik', callback_data: 'admin_stats' },
        { text: '📰 Kaynaklar', callback_data: 'admin_sources' },
      ],
    ],
  };
}

const DATE_RANGE_OPTIONS = [
  { label: 'Bugün (24s)', hours: 24 },
  { label: '2 Gün (48s)', hours: 48 },
  { label: '1 Hafta (168s)', hours: 168 },
];

function dateRangeKeyboard() {
  const rows = DATE_RANGE_OPTIONS.map((o) => ([{
    text: `${o.hours === settings.maxAgeHours ? '✅ ' : ''}${o.label}`,
    callback_data: `set_daterange_${o.hours}`,
  }]));
  rows.push([{ text: '◀️ Geri', callback_data: 'admin_back' }]);
  return { inline_keyboard: rows };
}

const START_HOURS = [6, 7, 8, 9, 10, 11, 12];
const END_HOURS = [0, 1, 2, 3, 22, 23, 24];

function timeWindowKeyboard(mode) {
  if (mode === 'start') {
    const rows = [];
    for (let i = 0; i < START_HOURS.length; i += 4) {
      rows.push(START_HOURS.slice(i, i + 4).map((h) => ({
        text: `${h === settings.publishStartHour ? '✅ ' : ''}${String(h).padStart(2,'0')}:00`,
        callback_data: `set_start_hour_${h}`,
      })));
    }
    rows.push([{ text: '◀️ Geri', callback_data: 'admin_timewindow_menu' }]);
    return { inline_keyboard: rows };
  }
  const rows = [];
  for (let i = 0; i < END_HOURS.length; i += 4) {
    rows.push(END_HOURS.slice(i, i + 4).map((h) => ({
      text: `${h === settings.publishEndHour ? '✅ ' : ''}${String(h % 24).padStart(2,'0')}:00`,
      callback_data: `set_end_hour_${h}`,
    })));
  }
  rows.push([{ text: '◀️ Geri', callback_data: 'admin_timewindow_menu' }]);
  return { inline_keyboard: rows };
}

function timeWindowMenuKeyboard() {
  const sh = String(settings.publishStartHour ?? 9).padStart(2, '0');
  const eh = String(settings.publishEndHour ?? 2).padStart(2, '0');
  return {
    inline_keyboard: [
      [
        { text: `🟢 Başlangıç: ${sh}:00`, callback_data: 'admin_timewindow_start' },
        { text: `🔴 Bitiş: ${eh}:00`, callback_data: 'admin_timewindow_end' },
      ],
      [{ text: '◀️ Geri', callback_data: 'admin_back' }],
    ],
  };
}

function intervalKeyboard() {
  const rows = [];
  const row1 = INTERVAL_OPTIONS.slice(0, 4).map((m) => ({
    text: `${m === settings.intervalMinutes ? '✅ ' : ''}${m} dk`,
    callback_data: `set_interval_${m}`,
  }));
  const row2 = INTERVAL_OPTIONS.slice(4).map((m) => ({
    text: `${m === settings.intervalMinutes ? '✅ ' : ''}${m} dk`,
    callback_data: `set_interval_${m}`,
  }));
  rows.push(row1);
  if (row2.length) rows.push(row2);
  rows.push([{ text: '◀️ Geri', callback_data: 'admin_back' }]);
  return { inline_keyboard: rows };
}

function categoryKeyboard() {
  const cats = Object.entries(CATEGORY_LABELS);
  const rows = [];
  for (let i = 0; i < cats.length; i += 2) {
    const row = cats.slice(i, i + 2).map(([key, label]) => ({
      text: `${key === settings.activeCategory ? '✅ ' : ''}${label}`,
      callback_data: `set_category_${key}`,
    }));
    rows.push(row);
  }
  rows.push([{ text: '◀️ Geri', callback_data: 'admin_back' }]);
  return { inline_keyboard: rows };
}

// ─── Bot Komutları ────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  const user = getUser(msg.chat.id);
  user.name = msg.from?.first_name || '';
  saveUsers(users);
  bot.sendMessage(
    msg.chat.id,
    `👋 Merhaba ${user.name}!\n\n` +
    `Ben güncel Türk haberlerini takip eden bir botum.\n` +
    `Kanalda her ${settings.intervalMinutes} dakikada haber yayınlıyorum.\n\n` +
    `🔔 Kişisel filtre kurarak ilgilendiğin konulardaki haberleri doğrudan buraya alabilirsin!\n\n` +
    `📌 Komutlar:\n` +
    `/filtre ekle <kelime> — Filtre ekle\n` +
    `/filtre sil <kelime> — Filtre sil\n` +
    `/filtrelerim — Filtrelerimi göster\n` +
    `/filtre temizle — Tüm filtreleri sil\n` +
    `/haber — Anında haber yayınla\n` +
    `/kaynaklar — Haber kaynakları\n` +
    `/durum — Bot durumu`
  );
});

bot.onText(/\/myid/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `🪪 Chat ID'niz:\n\n<code>${chatId}</code>\n\nBu sayıyı Railway'de <b>ADMIN_CHAT_ID</b> olarak kaydedin.`, { parse_mode: 'HTML' });
});

bot.onText(/\/admin/, (msg) => {
  const chatId = String(msg.chat.id);
  if (!isAdmin(chatId)) {
    bot.sendMessage(msg.chat.id,
      '🔐 Admin paneline erişmek için:\n\n' +
      '`/setadmin <şifre>`\n\n' +
      'Şifreyi bilen kişi admin olabilir.',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  bot.sendMessage(msg.chat.id, adminPanelText(), {
    parse_mode: 'Markdown',
    reply_markup: adminPanelKeyboard(),
  });
});

bot.onText(/\/setadmin (.+)/, (msg, match) => {
  const password = match[1].trim();
  const chatId = String(msg.chat.id);
  if (password !== ADMIN_PASSWORD) {
    bot.sendMessage(msg.chat.id, '❌ Yanlış şifre!');
    return;
  }
  if (!settings.adminChatIds.includes(chatId)) {
    settings.adminChatIds.push(chatId);
    saveSettings();
  }
  console.log(`✅ Admin giriş: chatId=${chatId} — Railway'de kalıcı yapmak için ADMIN_CHAT_ID=${chatId} ekleyin`);
  bot.sendMessage(msg.chat.id, `✅ Admin yetkisi verildi!

📌 Kalıcı admin için Railway'e şunu ekleyin:
ADMIN_CHAT_ID = ${chatId}

/admin komutuyla panele erişebilirsin.`, {
    reply_markup: adminPanelKeyboard(),
  });
  bot.sendMessage(msg.chat.id, adminPanelText(), {
    parse_mode: 'Markdown',
    reply_markup: adminPanelKeyboard(),
  });
});

// ─── Admin Callback Sorguları ─────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const chatId = String(query.message.chat.id);
  const data = query.data;
  const msgId = query.message.message_id;

  if (!isAdmin(chatId)) {
    bot.answerCallbackQuery(query.id, { text: '❌ Admin yetkisi gerekli!' }).catch(() => {});
    return;
  }

  // Her işlemi try-catch içinde çalıştır; hata olursa yine de query'yi yanıtla
  try {

  if (data.startsWith('set_daterange_')) {
    const hours = parseInt(data.replace('set_daterange_', ''));
    settings.maxAgeHours = hours;
    saveSettings();
    const label = DATE_RANGE_OPTIONS.find((o) => o.hours === hours)?.label || `${hours}s`;
    await bot.answerCallbackQuery(query.id, { text: `✅ Haber aralığı: ${label}` });
    await bot.editMessageText(adminPanelText(), {
      chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
      reply_markup: adminPanelKeyboard(),
    });
    return;
  }

  if (data.startsWith('set_start_hour_')) {
    const h = parseInt(data.replace('set_start_hour_', ''));
    settings.publishStartHour = h;
    saveSettings();
    await bot.answerCallbackQuery(query.id, { text: `✅ Yayın başlangıcı: ${String(h).padStart(2,'0')}:00` });
    await bot.editMessageText(
      `🕐 *Yayın Saati Ayarı*\n\nŞu an: *${String(settings.publishStartHour).padStart(2,'0')}:00 – ${String(settings.publishEndHour).padStart(2,'0')}:00*`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: timeWindowMenuKeyboard() }
    );
    return;
  }

  if (data.startsWith('set_end_hour_')) {
    const h = parseInt(data.replace('set_end_hour_', ''));
    settings.publishEndHour = h % 24;
    saveSettings();
    await bot.answerCallbackQuery(query.id, { text: `✅ Yayın bitişi: ${String(h % 24).padStart(2,'0')}:00` });
    await bot.editMessageText(
      `🕐 *Yayın Saati Ayarı*\n\nŞu an: *${String(settings.publishStartHour).padStart(2,'0')}:00 – ${String(settings.publishEndHour).padStart(2,'0')}:00*`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: timeWindowMenuKeyboard() }
    );
    return;
  }

  if (data.startsWith('set_interval_')) {
    const val = parseFloat(data.replace('set_interval_', ''));
    settings.intervalMinutes = val;
    saveSettings();
    resetInterval();
    await bot.answerCallbackQuery(query.id, { text: `✅ Aralık ${val} dakika olarak ayarlandı!` });
    await bot.editMessageText(adminPanelText(), {
      chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
      reply_markup: adminPanelKeyboard(),
    });
    return;
  }

  if (data.startsWith('set_category_')) {
    const cat = data.replace('set_category_', '');
    settings.activeCategory = cat;
    saveSettings();
    await bot.answerCallbackQuery(query.id, { text: `✅ Kategori: ${CATEGORY_LABELS[cat] || cat}` });
    await bot.editMessageText(adminPanelText(), {
      chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
      reply_markup: adminPanelKeyboard(),
    });
    return;
  }

  switch (data) {
    case 'admin_interval_menu':
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await bot.editMessageText(
        `⏱ *Yayın Sıklığı*\n\nŞu an: *${settings.intervalMinutes} dakika*\n\nYeni süreyi seç:`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: intervalKeyboard() }
      );
      break;

    case 'admin_daterange_menu':
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await bot.editMessageText(
        `📅 *Haber Yaş Aralığı*\n\nŞu an: *Son ${settings.maxAgeHours || 24} saat*\n\nKaç saatlik haberleri yayınlayalım?`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: dateRangeKeyboard() }
      );
      break;

    case 'admin_timewindow_menu': {
      const sh = String(settings.publishStartHour ?? 9).padStart(2, '0');
      const eh = String(settings.publishEndHour ?? 2).padStart(2, '0');
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await bot.editMessageText(
        `🕐 *Yayın Saati Ayarı*\n\nŞu an: *${sh}:00 – ${eh}:00*\n\nBaşlangıç veya bitiş saatini seç:`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: timeWindowMenuKeyboard() }
      );
      break;
    }

    case 'admin_timewindow_start':
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await bot.editMessageText(
        `🟢 *Yayın Başlangıç Saati*\n\nŞu an: *${String(settings.publishStartHour ?? 9).padStart(2,'0')}:00*`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: timeWindowKeyboard('start') }
      );
      break;

    case 'admin_timewindow_end':
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await bot.editMessageText(
        `🔴 *Yayın Bitiş Saati*\n\nŞu an: *${String(settings.publishEndHour ?? 2).padStart(2,'0')}:00*`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: timeWindowKeyboard('end') }
      );
      break;

    case 'admin_category_menu':
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await bot.editMessageText(
        `📂 *Kategori Seçimi*\n\nŞu an: *${CATEGORY_LABELS[settings.activeCategory] || settings.activeCategory}*\n\nHaberler bu kategoriden yayınlanır:`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: categoryKeyboard() }
      );
      break;

    case 'admin_publish_now': {
      await bot.answerCallbackQuery(query.id, { text: '⚡ Başlatılıyor...' }).catch(() => {});
      await bot.editMessageText(adminPanelText(), {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: adminPanelKeyboard(),
      }).catch(() => {});
      const progressMsg = await bot.sendMessage(chatId, '⏳ Video/haber aranıyor, bekle...').catch(() => null);
      publishNowInstant().then(async (resultMsg) => {
        const text = resultMsg || '✅ Yayınlandı.';
        if (progressMsg) bot.editMessageText(text, { chat_id: chatId, message_id: progressMsg.message_id }).catch(() => bot.sendMessage(chatId, text).catch(() => {}));
        else bot.sendMessage(chatId, text).catch(() => {});
      }).catch(async (err) => {
        const errText = '❌ Hata: ' + (err?.message || String(err)).slice(0, 200);
        if (progressMsg) bot.editMessageText(errText, { chat_id: chatId, message_id: progressMsg.message_id }).catch(() => bot.sendMessage(chatId, errText).catch(() => {}));
        else bot.sendMessage(chatId, errText).catch(() => {});
      });
      break;
    }

    case 'admin_toggle_pause':
      settings.paused = !settings.paused;
      saveSettings();
      await bot.answerCallbackQuery(query.id, {
        text: settings.paused ? '⏸ Bot duraklatıldı' : '▶️ Bot devam ediyor',
      }).catch(() => {});
      await bot.editMessageText(adminPanelText(), {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: adminPanelKeyboard(),
      });
      break;

    case 'admin_stats': {
      const totalUsers = Object.keys(users).length;
      const filtered = Object.values(users).filter((u) => u.filters.length > 0).length;
      const statsText =
        `📊 *İstatistikler*\n\n` +
        `📰 Yayınlanan haber: *${publishedUrls.size}*\n` +
        `👥 Kayıtlı kullanıcı: *${totalUsers}*\n` +
        `🔔 Filtreli kullanıcı: *${filtered}*\n` +
        `📡 Kanal: *${CHANNEL_ID}*\n` +
        `⏱ Yayın aralığı: *${settings.intervalMinutes} dk*\n` +
        `📂 Kategori: *${CATEGORY_LABELS[settings.activeCategory] || settings.activeCategory}*\n` +
        `📰 Kaynak sayısı: *${RSS_FEEDS.length}*`;
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await bot.editMessageText(statsText, {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '◀️ Geri', callback_data: 'admin_back' }]] },
      });
      break;
    }

    case 'admin_sources': {
      const list = RSS_FEEDS.map((f, i) => `${i + 1}. ${f.label} [${f.category}]`).join('\n');
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await bot.editMessageText(
        `📰 *Aktif Kaynaklar (${RSS_FEEDS.length})*\n\n${list}`,
        {
          chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '◀️ Geri', callback_data: 'admin_back' }]] },
        }
      );
      break;
    }

    case 'admin_back':
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await bot.editMessageText(adminPanelText(), {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: adminPanelKeyboard(),
      });
      break;

    default:
      await bot.answerCallbackQuery(query.id).catch(() => {});
  }

  } catch (err) {
    console.error('❌ callback_query hatası:', err?.message);
    bot.answerCallbackQuery(query.id).catch(() => {});
  }
});

// ─── Kullanıcı Komutları ──────────────────────────────────────────────────────

bot.onText(/\/filtre ekle (.+)/, (msg, match) => {
  const keyword = match[1].trim();
  const added = addFilter(msg.chat.id, keyword);
  bot.sendMessage(
    msg.chat.id,
    added
      ? `✅ "${keyword}" filtresi eklendi!\n\nBu kelimeyi içeren haberler sana otomatik gelecek.`
      : `ℹ️ "${keyword}" zaten filtrelerinde var.`
  );
});

bot.onText(/\/filtre sil (.+)/, (msg, match) => {
  const keyword = match[1].trim();
  const removed = removeFilter(msg.chat.id, keyword);
  bot.sendMessage(
    msg.chat.id,
    removed ? `🗑 "${keyword}" filtresi silindi.` : `ℹ️ "${keyword}" filtrelerinde bulunamadı.`
  );
});

bot.onText(/\/filtre temizle/, (msg) => {
  clearFilters(msg.chat.id);
  bot.sendMessage(msg.chat.id, '🗑 Tüm filtrelerin temizlendi.');
});

bot.onText(/\/filtrelerim/, (msg) => {
  const user = getUser(msg.chat.id);
  if (user.filters.length === 0) {
    bot.sendMessage(msg.chat.id,
      '📭 Henüz filtre eklemedin.\n\nÖrnek:\n/filtre ekle ekonomi\n/filtre ekle deprem\n/filtre ekle galatasaray'
    );
  } else {
    const list = user.filters.map((f, i) => `${i + 1}. ${f}`).join('\n');
    bot.sendMessage(msg.chat.id,
      `🔍 Aktif filtrellerin (${user.filters.length} adet):\n\n${list}\n\nSilmek için: /filtre sil <kelime>`
    );
  }
});


  bot.onText(/\/sondakika/, async (msg) => {
    if (!isAdmin(msg.chat.id)) return;
    await bot.sendMessage(msg.chat.id, '🚨 Son dakika haberleri taranıyor...');
    await checkBreakingNews();
    await bot.sendMessage(msg.chat.id, '✅ Son dakika taraması tamamlandı!');
  });

  bot.onText(/\/haber/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '📰 Haber çekiliyor...');
  await publishNextNews();
});

bot.onText(/\/video/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '🎬 Video aranıyor (YouTube + haber siteleri)...');
  let sent = false;

  // 1) YouTube feedlerinden yt-dlp ile indir
  const youtubeFeeds = RSS_FEEDS.filter(f => f.type === 'youtube');
  for (const feed of youtubeFeeds) {
    if (sent) break;
    try {
      const parsed = await parser.parseURL(feed.url);
      const items = (parsed.items || []).slice(0, 8);
      for (const item of items) {
        const url = item.link || item.guid;
        if (publishedUrls.has(url)) continue;
        const { title } = buildItemMeta(item, feed);
        if (isTitleDuplicate(title)) continue;
        await bot.sendMessage(msg.chat.id, `⬇️ İndiriliyor: ${title.slice(0, 50)}...`);
        const videoPath = await downloadYoutubeVideo(url);
        if (videoPath) {
          const aiSummary = await summarizeNews(title, '');
          const categoryTag = detectCategory(title, '');
          const catE = categoryTag ? `${categoryTag} ` : '';
          let caption = `${catE}${title}`;
          if (aiSummary) caption += `\n\n${cleanArrows(aiSummary)}`;
          caption = caption.slice(0, 1024);
          try {
            await bot.sendVideo(CHANNEL_ID, { source: videoPath }, { caption, supports_streaming: true });
            publishedUrls.add(url);
            persistPublishedUrls();
            try { fs.rmSync(path.dirname(videoPath), { recursive: true, force: true }); } catch {}
            await bot.sendMessage(msg.chat.id, '✅ YouTube videosu kanala gönderildi!');
            sent = true;
            break;
          } catch (e) {
            try { fs.rmSync(path.dirname(videoPath), { recursive: true, force: true }); } catch {}
            console.error(`❌ Video gönderme: ${e.message}`);
          }
        }
      }
    } catch {}
  }

  // 2) Haber sitelerinden direkt .mp4 URL ara
  if (!sent) {
    await bot.sendMessage(msg.chat.id, '🔍 Haber sitelerinde direkt video aranıyor...');
    const newsFeeds = RSS_FEEDS.filter(f => f.type !== 'youtube').slice(0, 6);
    for (const feed of newsFeeds) {
      if (sent) break;
      try {
        const parsed = await parser.parseURL(feed.url);
        const items = (parsed.items || []).slice(0, 5);
        for (const item of items) {
          const url = item.link || item.guid;
          if (publishedUrls.has(url)) continue;
          const { title } = buildItemMeta(item, feed);
          if (isTitleDuplicate(title)) continue;
          const videoUrl = await fetchArticleHtmlAndExtractVideo(url);
          if (videoUrl) {
            const aiSummary = await summarizeNews(title, '');
            const categoryTag = detectCategory(title, '');
            const catE2 = categoryTag ? `${categoryTag} ` : '';
            let caption = `${catE2}${title}`;
            if (aiSummary) caption += `\n\n${cleanArrows(aiSummary)}`;
            caption = caption.slice(0, 1024);
            const webSent = await sendWebVideo(CHANNEL_ID, videoUrl, caption);
            if (webSent) {
              publishedUrls.add(url);
              persistPublishedUrls();
              isTitleDuplicate(title);
              await bot.sendMessage(msg.chat.id, `✅ Haber videosu kanala gönderildi! (${feed.label})`);
              sent = true;
              break;
            }
          }
        }
      } catch {}
    }
  }

  if (!sent) {
    await bot.sendMessage(msg.chat.id, '⚠️ Hiçbir kaynaktan video bulunamadı. YouTube bot koruması veya haberlerde video yok.');
  }
});

bot.onText(/\/dur/, (msg) => {
  settings.paused = true;
  saveSettings();
  bot.sendMessage(msg.chat.id, '⏸ Bot durduruldu. Devam ettirmek için admin panelinden "▶️ Devam Et"e basın veya /baslat yazın.');
});

bot.onText(/\/baslat/, (msg) => {
  settings.paused = false;
  saveSettings();
  bot.sendMessage(msg.chat.id, '▶️ Bot yeniden başlatıldı!');
});

bot.onText(/\/durum/, (msg) => {
  const totalUsers = Object.keys(users).length;
  bot.sendMessage(
    msg.chat.id,
    `${settings.paused ? '⏸ Bot duraklatıldı' : '✅ Bot aktif!'}\n\n` +
    `📊 Yayınlanan haber: ${publishedUrls.size}\n` +
    `⏱ Yayın aralığı: ${settings.intervalMinutes} dakika\n` +
    `📂 Aktif kategori: ${CATEGORY_LABELS[settings.activeCategory] || settings.activeCategory}\n` +
    `📡 Kanal: ${CHANNEL_ID}\n` +
    `📰 Kaynak sayısı: ${RSS_FEEDS.length}\n` +
    `👥 Kayıtlı kullanıcı: ${totalUsers}`
  );
});

bot.onText(/\/kaynaklar/, (msg) => {
  const list = RSS_FEEDS.map((f, i) => `${i + 1}. ${f.label}`).join('\n');
  bot.sendMessage(msg.chat.id, `📰 Aktif haber kaynakları:\n\n${list}`);
});

bot.onText(/\/saglik/, async (msg) => {
  const uptimeMs = Date.now() - botStartTime;
  const uptimeSec = Math.floor(uptimeMs / 1000);
  const hours = Math.floor(uptimeSec / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);
  const secs = uptimeSec % 60;
  const uptimeStr = hours > 0
    ? `${hours}sa ${mins}dk`
    : mins > 0 ? `${mins}dk ${secs}sn` : `${secs}sn`;

  const total = mediaStats.image + mediaStats.video + mediaStats.text;
  const imgPct  = total ? Math.round(mediaStats.image / total * 100) : 0;
  const vidPct  = total ? Math.round(mediaStats.video / total * 100) : 0;
  const txtPct  = total ? Math.round(mediaStats.text  / total * 100) : 0;

  // yt-dlp varlığını kontrol et
  let ytdlpVersion = 'Bulunamadı ❌';
  try {
    const { execSync } = await import('child_process');
    const ver = execSync(`${YTDLP_BIN} --version 2>/dev/null`, { timeout: 5000 }).toString().trim();
    ytdlpVersion = ver ? `${ver} ✅` : 'Kurulu ✅';
  } catch { ytdlpVersion = 'Yüklü değil / erişilemiyor ❌'; }

  // ffmpeg varlığını kontrol et
  let ffmpegOk = '❌';
  try {
    const { execSync } = await import('child_process');
    execSync('ffmpeg -version', { timeout: 5000 });
    ffmpegOk = '✅';
  } catch { ffmpegOk = '❌'; }

  const botStatus = settings.paused ? '⏸ Duraklatıldı' : '✅ Aktif';

  let text = `🩺 *Bot Sağlık Raporu*\n\n`;
  text += `⚡ Durum: ${botStatus}\n`;
  text += `⏱ Çalışma süresi: ${uptimeStr}\n`;
  text += `📅 Yayın aralığı: ${settings.intervalMinutes} dakika\n\n`;

  text += `📊 *Bu oturumda yayınlanan (${total} haber)*\n`;
  text += `🖼 Görsel: ${mediaStats.image} (%${imgPct})\n`;
  text += `🎬 Video: ${mediaStats.video} (%${vidPct})\n`;
  text += `📝 Metin: ${mediaStats.text} (%${txtPct})\n`;
  text += `📂 Toplam kayıtlı URL: ${publishedUrls.size}\n\n`;

  text += `🔧 *Araçlar*\n`;
  text += `yt-dlp: ${ytdlpVersion}\n`;
  text += `ffmpeg: ${ffmpegOk}\n\n`;

  if (recentErrors.length > 0) {
    text += `⚠️ *Son hatalar*\n`;
    recentErrors.slice(0, 3).forEach(e => { text += `• ${e}\n`; });
  } else {
    text += `✅ Son hata yok`;
  }

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});


  bot.onText(/\/debug/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;

    const send = (text) => bot.sendMessage(chatId, text).catch(() => {});

    await send('🔍 *Debug başlatıldı...*\n\nHer adım raporlanacak.', { parse_mode: 'Markdown' });

    // 1. yt-dlp kontrolü
    await send('⏳ 1/5 yt-dlp kontrol ediliyor...');
    try {
      const ytdlpResult = await new Promise((resolve) => {
        const proc = spawn(YTDLP_BIN, ['--version']);
        let out = '';
        proc.stdout.on('data', d => { out += d; });
        proc.on('close', code => resolve(code === 0 ? '✅ yt-dlp: ' + out.trim() : '❌ yt-dlp hata kodu: ' + code));
        proc.on('error', e => resolve('❌ yt-dlp spawn hatası: ' + e.message));
        setTimeout(() => { proc.kill(); resolve('❌ yt-dlp timeout'); }, 8000);
      });
      await send(ytdlpResult);
    } catch (e) { await send('❌ yt-dlp: ' + e.message); }

    // 2. yt-dlp path
    await send('⏳ 2/5 yt-dlp path: ' + YTDLP_BIN);

    // 3. RSS feed testi
    await send('⏳ 3/5 RSS feed test ediliyor...');
    try {
      const testFeed = RSS_FEEDS.find(f => f.type !== 'youtube') || RSS_FEEDS[0];
      const items = await fetchFeed(testFeed);
      if (items && items.length > 0) {
        const item = items[0];
        const url = item.link || item.guid;
        await send('✅ RSS feed çalışıyor: ' + (item.title || '').slice(0, 60) + '\n URL: ' + (url || '').slice(0, 80));

        // 4. Google News URL çözme
        if (url && url.includes('news.google.com')) {
          await send('⏳ 4/5 Google News URL çözülüyor...');
          const resolved = await resolveGoogleNewsUrl(url);
          if (resolved && !resolved.includes('google.com')) {
            await send('✅ URL çözüldü: ' + resolved.slice(0, 100));

            // 5. yt-dlp -g testi
            await send('⏳ 5/5 yt-dlp -g video URL testi: ' + resolved.slice(0, 60));
            const streamUrl = await getYtdlpStreamUrl(resolved);
            if (streamUrl) {
              await send('✅ yt-dlp -g BAŞARILI!\n URL: ' + streamUrl.slice(0, 100));
            } else {
              await send('❌ yt-dlp -g başarısız (video bulunamadı veya site desteklenmiyor)');
            }
          } else {
            await send('❌ Google News URL çözülemedi! resolved: ' + (resolved || 'null'));
            await send('⏳ 5/5 Kaynak URL ile yt-dlp -g testi: ' + url.slice(0, 60));
            const streamUrl = await getYtdlpStreamUrl(url);
            await send(streamUrl ? '✅ yt-dlp -g BAŞARILI: ' + streamUrl.slice(0, 80) : '❌ yt-dlp -g başarısız');
          }
        } else if (url) {
          await send('⏳ 4-5/5 Direkt URL ile yt-dlp -g: ' + (url || '').slice(0, 80));
          const streamUrl = await getYtdlpStreamUrl(url);
          await send(streamUrl ? '✅ yt-dlp -g BAŞARILI: ' + streamUrl.slice(0, 80) : '❌ yt-dlp -g başarısız');
        }
      } else {
        await send('❌ RSS feed boş geldi: ' + testFeed.label);
      }
    } catch (e) { await send('❌ RSS/test hatası: ' + e.message); }

    // 6. cobalt test
    await send('⏳ cobalt.tools testi...');
    const cobaltUrl = await getCobaltDirectUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    if (cobaltUrl) {
      await send('✅ cobalt çalışıyor! URL: ' + cobaltUrl.slice(0, 80));
    } else {
      await send('❌ cobalt çalışmıyor (tüm instance başarısız)');
    }

    await send('✅ *Debug tamamlandı!*', { parse_mode: 'Markdown' });
  });
// ─── Kaynak Kanaldan Video Aktar ─────────────────────────────────────────────
bot.on('channel_post', async (msg) => {
  try {
    const chatUsername = (msg.chat.username || '').toLowerCase();
    if (!VIDEO_SOURCE_CHANNELS.includes(chatUsername)) return;

    // Sadece video veya animasyon içeren mesajları al
    const hasVideo = !!(msg.video || msg.animation || (msg.document && msg.document.mime_type?.startsWith('video/')));
    if (!hasVideo) return;

    // Flood önleme — çok sık video gönderme
    const now = Date.now();
    if (now - lastVideoForwardTime < VIDEO_FORWARD_MIN_GAP_MS) {
      console.log(`⏭ Video kanalı: flood önleme (son videodan ${Math.round((now - lastVideoForwardTime)/1000)}s geçti)`);
      return;
    }

    // Orijinal caption varsa al, yoksa boş bırak (AI ekleyebilir)
    const originalCaption = msg.caption || msg.text || '';
    const title = originalCaption.slice(0, 100) || 'Video Haber';

    // Duplicate kontrolü
    const dedupKey = `channel_post_${msg.chat.id}_${msg.message_id}`;
    if (publishedUrls.has(dedupKey)) return;

    console.log(`📹 [${chatUsername}] Video mesajı alındı: ${title.slice(0,60)}`);

    // AI ile kısa özet/başlık üret
    let caption = '';
    if (originalCaption.length > 5) {
      const aiSum = await summarizeNews(title, originalCaption).catch(() => null);
      const catTag = detectCategory(title, originalCaption);
      const catEmoji = catTag ? `${catTag} ` : '📹 ';
      caption = stripLinks(`${catEmoji}${title}`);
      if (aiSum && aiSum.length > 5) caption += `

${cleanArrows(stripLinks(aiSum))}`;
    } else {
      caption = '📹 Video Haber';
    }
    if (caption.length > 1024) caption = caption.slice(0, 1021) + '…';

    // Mesajı kopyala (orijinal sender gizlenir, bot göndermiş gibi görünür)
    await bot.copyMessage(CHANNEL_ID, msg.chat.id, msg.message_id, { caption });
    publishedUrls.add(dedupKey);
    persistPublishedUrls();
    lastVideoForwardTime = now;
    mediaStats.video++;
    console.log(`✅ [${chatUsername}] Video @muhalif_gazete'ye aktarıldı`);
  } catch (err) {
    console.error(`❌ channel_post hatası: ${err.message}`);
  }
});

bot.on('polling_error', (err) => {
  trackError('polling', err.message);
  console.error(`⚠️ Polling hatası: ${err.message}`);
});

// ─── Temiz Kapanış ────────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM alındı, bot durduruluyor...');
  bot.stopPolling().finally(() => {
    persistPublishedUrls();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  bot.stopPolling().finally(() => {
    persistPublishedUrls();
    process.exit(0);
  });
});

// ─── Başlat ───────────────────────────────────────────────────────────────────

console.log('🚀 Telegram Haber Botu başlatılıyor...');
console.log(`📡 Kanal: ${CHANNEL_ID}`);
console.log(`⏱ Yayın aralığı: ${settings.intervalMinutes} dakika`);
console.log(`📂 Aktif kategori: ${settings.activeCategory}`);
console.log(`📰 Kaynak sayısı: ${RSS_FEEDS.length} (${RSS_FEEDS.filter(f=>f.type==='youtube').length} YouTube)`);
console.log(`🔑 Admin şifresi ayarlı: ${ADMIN_PASSWORD !== 'admin2024' ? 'Evet' : 'Hayır (varsayılan)'}`);

publishNextNews();
resetInterval();
startBreakingNewsChecker();
checkBreakingNews(); // İlk kontrol hemen yap

// Başlangıçta bir YouTube videosu kanala gönder
setTimeout(() => {
  publishNowInstant().then(r => console.log('🎬 Başlangıç video:', r || 'tamamlandı')).catch(e => console.error('🎬 Başlangıç video hata:', e.message));
}, 10000);

// ─── Yorum Sistemi ────────────────────────────────────────────────────────────
// Kullanıcılar bota mesaj gönderir → admin'e iletilir → admin yanıtlayabilir
const pendingReplies = new Map(); // adminMsgId → { userId, userName }

bot.on('message', async (msg) => {
  if (!msg.text) return;
  if (msg.text.startsWith('/')) return; // komutlar zaten işleniyor
  if (msg.chat.type !== 'private') return;
  const chatId = String(msg.chat.id);

  // Admin ise normal davran
  if (isAdmin(chatId)) {
    // Admin bot üzerinden bir yoruma yanıt veriyorsa kullanıcıya ilet
    if (msg.reply_to_message && pendingReplies.has(msg.reply_to_message.message_id)) {
      const { userId, userName } = pendingReplies.get(msg.reply_to_message.message_id);
      try {
        await bot.sendMessage(userId, `📣 *Editörden yanıt:*\n\n${msg.text}`, { parse_mode: 'Markdown' });
        await bot.sendMessage(msg.chat.id, `✅ Yanıtın ${userName} kullanıcısına iletildi.`);
      } catch (e) {
        await bot.sendMessage(msg.chat.id, `⚠️ Kullanıcıya iletilemedi: ${e.message}`);
      }
    }
    return;
  }

  // Kullanıcı yorumu — admin'e ilet
  const userName = msg.from?.first_name || msg.from?.username || 'Anonim';
  const adminId = ADMIN_CHAT_ID || settings.adminChatIds[0];
  if (!adminId) return;

  try {
    const forwarded = await bot.sendMessage(
      adminId,
      `💬 *Yeni Yorum*\n👤 ${userName} (ID: ${chatId})\n\n${msg.text.slice(0, 1000)}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '↩️ Yanıtla', callback_data: `reply_user_${chatId}` }
          ]]
        }
      }
    );
    pendingReplies.set(forwarded.message_id, { userId: chatId, userName });
    await bot.sendMessage(msg.chat.id, '✅ Yorumunuz editöre iletildi, teşekkürler!');
  } catch (e) {
    console.error('Yorum iletilemedi:', e.message);
  }
});

// Admin "Yanıtla" butonuna basarsa
bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = String(query.message.chat.id);
  if (!data?.startsWith('reply_user_')) return;
  if (!isAdmin(chatId)) return;

  const userId = data.replace('reply_user_', '');
  await bot.answerCallbackQuery(query.id);
  await bot.sendMessage(
    query.message.chat.id,
    `✏️ Kullanıcıya (${userId}) yanıt yazın — bu mesajı alıntılayarak (reply) gönderin:`,
    { reply_markup: { force_reply: true } }
  );
});

console.log('✅ Bot çalışıyor!');
