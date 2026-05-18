import TelegramBot from 'node-telegram-bot-api';
import RssParser from 'rss-parser';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';
import { spawn } from 'child_process';
import os from 'os';
import OpenAI from 'openai';

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

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

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

// ─── RSS + YouTube Kaynakları ─────────────────────────────────────────────────

const RSS_FEEDS = [
  {
    url: 'https://news.google.com/rss/search?q=site:iha.com.tr&hl=tr&gl=TR&ceid=TR:tr',
    label: '📡 İHA',
    source: 'İHA',
    type: 'google',
    category: 'genel',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:dha.com.tr&hl=tr&gl=TR&ceid=TR:tr',
    label: '📡 DHA',
    source: 'DHA',
    type: 'google',
    category: 'genel',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:ankaajans.com&hl=tr&gl=TR&ceid=TR:tr',
    label: '📡 ANKA',
    source: 'ANKA',
    type: 'google',
    category: 'politika',
  },
  {
    url: 'https://www.aa.com.tr/tr/rss/default?cat=guncel',
    label: '📡 AA | Güncel',
    source: 'AA',
    type: 'direct',
    category: 'genel',
  },
  {
    url: 'https://www.aa.com.tr/tr/rss/default?cat=spor',
    label: '⚽ AA | Spor',
    source: 'AA',
    type: 'direct',
    category: 'spor',
  },
  {
    url: 'https://www.aa.com.tr/tr/rss/default?cat=ekonomi',
    label: '💰 AA | Ekonomi',
    source: 'AA',
    type: 'direct',
    category: 'ekonomi',
  },
  {
    url: 'https://www.hurriyet.com.tr/rss/anasayfa',
    label: '🗞 Hürriyet',
    source: 'Hürriyet',
    type: 'direct',
    category: 'genel',
  },
  {
    url: 'https://www.milliyet.com.tr/rss/rssNew/gundemRss.xml',
    label: '🗞 Milliyet | Gündem',
    source: 'Milliyet',
    type: 'direct',
    category: 'genel',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:sozcu.com.tr&hl=tr&gl=TR&ceid=TR:tr',
    label: '🗞 Sözcü',
    source: 'Sözcü',
    type: 'google',
    category: 'genel',
  },
  {
    url: 'https://www.cumhuriyet.com.tr/rss/son_dakika.xml',
    label: '🗞 Cumhuriyet | Son Dakika',
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
    url: 'https://www.cumhuriyet.com.tr/rss/8',
    label: '⚽ Cumhuriyet | Spor',
    source: 'Cumhuriyet',
    type: 'direct',
    category: 'spor',
  },
  {
    url: 'https://www.cumhuriyet.com.tr/rss/10',
    label: '💻 Cumhuriyet | Teknoloji',
    source: 'Cumhuriyet',
    type: 'direct',
    category: 'teknoloji',
  },
  {
    url: 'https://www.haberturk.com/rss',
    label: '🗞 HaberTürk',
    source: 'HaberTürk',
    type: 'direct',
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
    url: 'https://www.ntv.com.tr/son-dakika.rss',
    label: '📺 NTV | Son Dakika',
    source: 'NTV',
    type: 'direct',
    category: 'genel',
  },
  {
    url: 'https://www.youtube.com/feeds/videos.xml?user=ntv',
    label: '▶️ NTV YouTube',
    source: 'NTV',
    type: 'youtube',
    category: 'video',
  },
  {
    url: 'https://www.youtube.com/feeds/videos.xml?user=trthaber',
    label: '▶️ TRT Haber YouTube',
    source: 'TRT Haber',
    type: 'youtube',
    category: 'video',
  },
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
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCJCYKGZ4ZyjjshYa6fhRgRw',
    label: '▶️ CNN Türk YouTube',
    source: 'CNN Türk',
    type: 'youtube',
    category: 'video',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:sozcu.com.tr+video&hl=tr&gl=TR&ceid=TR:tr',
    label: '▶️ Sözcü TV',
    source: 'Sözcü TV',
    type: 'google',
    category: 'video',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:krttv.com.tr+video&hl=tr&gl=TR&ceid=TR:tr',
    label: '▶️ KRT TV Video',
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

// ─── Başlık bazlı tekrar engeli (Railway restart'ta sıfırlanır ama URL dosyası kalır) ──
const publishedTitlesSession = new Set();

function normalizeTitle(title) {
  return (title || '').toLowerCase()
    .replace(/[^a-züöşçğı0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function isTitleDuplicate(title) {
  const norm = normalizeTitle(title);
  if (publishedTitlesSession.has(norm)) return true;
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
  if (videoRatio < 0.20) return 'video';
  if (imageRatio < 0.75) return 'image';
  return 'any';
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

        done({ image, description, articleBody });
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
  const fullContent = [inputText, bodyText].filter(Boolean).join('\n\n').slice(0, 1500);

  if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) return fullContent || inputText || null;
  try {
    const prompt = fullContent
      ? `Aşağıdaki Türkçe haberi 2-3 cümleyle, sade ve akıcı bir şekilde özetle. Önemli detayları (kim ne dedi, ne oldu, nerede) mutlaka dahil et. Kaynak adı, tarih veya link ekleme. Sadece özet metni yaz.\n\nBaşlık: ${title}\nİçerik: ${fullContent}`
      : `Aşağıdaki haber başlığını Türkçe olarak 1-2 cümleyle kısaca açıkla. Ne olduğunu belirt. Kaynak adı ya da tarih ekleme.\n\nBaşlık: ${title}`;

    const response = await aiClient.chat.completions.create({
      model: 'gpt-5-nano',
      max_completion_tokens: 250,
      messages: [{ role: 'user', content: prompt }],
    });
    const result = (response.choices[0]?.message?.content || '').trim();
    if (!result || result.length < 10) return fullContent || inputText || null;
    return result;
  } catch {
    return fullContent || inputText || null;
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
  const ogVideo =
    html.match(/<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::url)?["']/i)?.[1];
  if (ogVideo && /\.(mp4|webm|ogg)/i.test(ogVideo)) return ogVideo;

  const videoSrc =
    html.match(/<video[^>]+src=["']([^"']+\.(?:mp4|webm|ogg))["']/i)?.[1] ||
    html.match(/<source[^>]+src=["']([^"']+\.(?:mp4|webm|ogg))["']/i)?.[1];
  if (videoSrc) return videoSrc;

  const dataSrc = html.match(/data-src=["']([^"']+\.(?:mp4|webm))["']/i)?.[1];
  if (dataSrc) return dataSrc;

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
  return (title || '').replace(/\s*-\s*[^-]+$/, '').trim() || title || '';
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

// Cobalt API — Railway IP'si YouTube tarafından bloklanıyor, Cobalt kendi
// sunucularından indirip bize bir stream URL veriyor.
async function downloadViaCobalt(videoUrl) {
  const tmpDir = path.join(os.tmpdir(), `cobalt_${Date.now()}`);
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
  const filePath = path.join(tmpDir, 'video.mp4');

  const cobaltInstances = [
    'https://api.cobalt.tools',
    'https://cobalt.api.timelessnesses.me',
    'https://cobalt-api.hyper.lol',
  ];

  let downloadUrl = null;

  for (const base of cobaltInstances) {
    try {
      console.log(`🌐 Cobalt deneniyor: ${base}`);
      const res = await fetch(`${base}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'TelegramNewsBot/1.0',
        },
        body: JSON.stringify({
          url: videoUrl,
          videoQuality: '720',
          filenameStyle: 'basic',
          downloadMode: 'auto',
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      console.log(`📦 Cobalt yanıtı: status=${data.status}`);
      if (['stream', 'redirect', 'tunnel'].includes(data.status) && data.url) {
        downloadUrl = data.url;
        break;
      }
    } catch (e) {
      console.error(`❌ Cobalt ${base} hatası: ${e.message}`);
    }
  }

  if (!downloadUrl) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return null;
  }

  // Video dosyasını indir
  try {
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      let totalBytes = 0;
      const doGet = (url, depth = 0) => {
        if (depth > 5) return reject(new Error('çok fazla yönlendirme'));
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { headers: { 'User-Agent': 'TelegramNewsBot/1.0' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.destroy();
            doGet(res.headers.location, depth + 1);
            return;
          }
          if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
          res.on('data', (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > MAX_VIDEO_SIZE_BYTES) { req.destroy(); file.close(); reject(new Error('çok büyük')); }
          });
          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
          res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(120000, () => { req.destroy(); reject(new Error('zaman aşımı')); });
      };
      doGet(downloadUrl);
    });

    const stat = fs.statSync(filePath);
    const mb = Math.round(stat.size / 1024 / 1024);
    if (stat.size < 50000) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} return null; }
    console.log(`✅ Cobalt indirme tamamlandı: ${mb}MB`);
    return filePath;
  } catch (err) {
    console.error(`❌ Cobalt indirme hatası: ${err.message}`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return null;
  }
}
const YTDLP_BIN = (() => {
  const candidates = [
    'yt-dlp',
    '/home/runner/workspace/.pythonlibs/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    '/nix/var/nix/profiles/default/bin/yt-dlp',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
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
  await bot.sendVideo(channelId, fs.createReadStream(filePath), { caption, supports_streaming: true });
  console.log(`✅ Video yüklendi (${mb}MB)`);
  return true;
}

// yt-dlp ile video indir → dosya yolu döndür
async function downloadWithYtdlp(videoUrl) {
  const tmpDir = path.join(os.tmpdir(), `ytdlp_${Date.now()}`);
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
  const outputTemplate = path.join(tmpDir, 'video.%(ext)s');

  return new Promise((resolve) => {
    const args = [
      '--no-playlist',
      '--max-filesize', '48m',
      '--extractor-args', 'youtube:player_client=android,web',
      '-f', 'bestvideo[height>=720][height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height>=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--no-part',
      '--extractor-retries', '3',
      '--socket-timeout', '60',
      '--no-check-certificate',
      '--geo-bypass',
      '--match-filter', 'duration < 600',
      '--user-agent', 'com.google.android.youtube/17.36.4 (Linux; U; Android 12) gzip',
      '-o', outputTemplate,
      '--no-warnings',
      '--quiet',
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

// Ana video indirme: Cobalt → yt-dlp sırası ile dener
async function downloadYoutubeVideo(videoUrl) {
  console.log(`🎬 Video indiriliyor: ${videoUrl.slice(0, 60)}`);

  // 1. Önce Cobalt dene (Railway IP'si YouTube'u geçemez, Cobalt geçiyor)
  const cobaltPath = await downloadViaCobalt(videoUrl);
  if (cobaltPath) { console.log('✅ Cobalt başarılı'); return cobaltPath; }

  // 2. Fallback: yt-dlp
  console.log('⚠️ Cobalt başarısız, yt-dlp deneniyor...');
  const ytdlpPath = await downloadWithYtdlp(videoUrl);
  if (ytdlpPath) { console.log('✅ yt-dlp başarılı'); return ytdlpPath; }

  console.error('❌ Her iki yöntem de başarısız oldu');
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
  try {
    const opts = { caption, supports_streaming: true };
    if (replyToId) opts.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
    await bot.sendVideo(channelId, videoUrl, opts);
    return true;
  } catch (err) {
    console.error(`❌ Web video gönderme hatası: ${err.message}`);
    return false;
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

  const needed = getNeededMediaType();
  if (needed === 'video') {
    const youtubePools = pool.filter((f) => f.type === 'youtube');
    if (youtubePools.length > 0) {
      const idx = currentFeedIndex % youtubePools.length;
      currentFeedIndex++;
      return youtubePools[idx];
    }
  }

  const idx = currentFeedIndex % pool.length;
  currentFeedIndex++;
  return pool[idx];
}

async function fetchFeed(feed) {
  try {
    const result = await parser.parseURL(feed.url);
    return result.items || [];
  } catch (err) {
    console.error(`❌ RSS hatası (${feed.source}): ${err.message}`);
    return [];
  }
}

// ─── Haber Yayınlama ──────────────────────────────────────────────────────────

function isWithinPublishHours() {
  const now = new Date();
  const hour = now.getHours();
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

  if (validItems.length === 0) { console.log(`ℹ️ ${feed.source} uygun yeni içerik yok.`); return; }

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

    // === FİX 1: Caption'a YouTube linkini ekle — kullanıcılar tıklayarak izleyebilsin ===
    const catEmoji = categoryTag ? `${categoryTag} ` : '';
    let caption = `${prefix}${catEmoji}${title}`;
    if (aiSummary && aiSummary.length > 5) caption += `\n\n${cleanArrows(aiSummary)}`;
    caption += `\n\n🎬 ${url}`;
    if (caption.length > 1024) caption = caption.slice(0, 1021) + '…';

    const replyToId = findRelatedMessageId(title);

    const videoId = item.videoId || (url.match(/[?&]v=([^&]+)/) || [])[1] || (url.match(/youtu\.be\/([^?]+)/) || [])[1];
    const thumbUrl = videoId
      ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`
      : (() => { const mg = item.mediaGroup || item['media:group']; return mg?.['media:thumbnail']?.[0]?.$?.url ? upgradeImageUrl(mg['media:thumbnail'][0].$.url) : null; })();

    let sentMsg = null;
    let sentType = 'image';

    const replyParam = replyToId ? { reply_parameters: { message_id: replyToId, allow_sending_without_reply: true } } : {};

    // 1. Önce yt-dlp ile videoyu indir, Telegram'a direkt gönder
    const videoSent = await sendYoutubeVideo(CHANNEL_ID, url, caption);
    if (videoSent) {
      sentType = 'video';
    } else {
      // 2. İndirme başarısız → thumbnail + link caption ile gönder
      const thumbCandidates = videoId ? [
        `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      ] : (thumbUrl ? [thumbUrl] : []);

      let sent = false;
      for (const tUrl of thumbCandidates) {
        try {
          // Caption'da YouTube linki var, kullanıcı tıklayarak izleyebilir
          sentMsg = await bot.sendPhoto(CHANNEL_ID, tUrl, { caption, ...replyParam });
          sentType = 'image';
          sent = true;
          console.log(`🖼 YouTube thumbnail gönderildi (link caption'da mevcut)`);
          break;
        } catch {}
      }

      // === FİX 2: Thumbnail da başarısızsa — link önizlemeli mesaj gönder ===
      // Telegram YouTube linklerini otomatik olarak gömüyor (thumbnail + izle butonu)
      if (!sent) {
        try {
          sentMsg = await bot.sendMessage(CHANNEL_ID, caption, {
            disable_web_page_preview: false, // Telegram YouTube videosunu otomatik önizler
            ...replyParam,
          });
          sentType = 'text';
          console.log(`🔗 YouTube link önizlemesi gönderildi`);
        } catch (err) { console.error(`❌ YouTube metin gönderme: ${err.message}`); }
      }
    }

    if (sentMsg?.message_id) registerSentMessage(sentMsg.message_id, title);

    console.log(`✅ [${feed.source}] [youtube/${sentType}]${replyToId ? ' [reply]' : ''} ${title.slice(0, 50)}`);
    mediaStats[sentType]++;
    const t = mediaStats.image + mediaStats.video + mediaStats.text;
    console.log(`📊 Resim:%${Math.round(mediaStats.image/t*100)} Video:%${Math.round(mediaStats.video/t*100)} Metin:%${Math.round(mediaStats.text/t*100)}`);
    if (sonDakika && sentMsg?.message_id) await tryPin(sentMsg.message_id);
    await notifyFilterUsers(title, rawDesc, url);
    return;
  }

  // ── Normal haber — medyalı öğe bul (max 5 deneme) ─────────────────────────
  const MAX_TRIES = 5;
  let chosenItem = null;
  let chosenMedia = { type: null, url: null };
  let chosenOgDesc = null;
  let chosenArticleBody = null;

  for (let i = 0; i < Math.min(MAX_TRIES, validItems.length); i++) {
    const candidate = validItems[i];
    const candidateUrl = candidate.link || candidate.guid;

    let media = extractMedia(candidate);
    if (media.url) { media.url = upgradeImageUrl(media.url); }

    // Her haber için direkt .mp4 URL ara (sadece video modunda değil, her zaman)
    if (!media.url || media.type !== 'video') {
      const webVid = await fetchArticleHtmlAndExtractVideo(candidateUrl);
      if (webVid) { media = { type: 'video', url: webVid }; console.log(`🎬 Direkt video bulundu: ${webVid.slice(0, 60)}`); }
    }

    if (!media.url) {
      console.log(`🔍 og:meta aranıyor (${i+1}. deneme)...`);
      const ogMeta = await fetchOgMeta(candidateUrl);
      if (ogMeta.image) media = { type: 'image', url: upgradeImageUrl(ogMeta.image) };
      if (ogMeta.description) chosenOgDesc = ogMeta.description;
      if (ogMeta.articleBody) chosenArticleBody = ogMeta.articleBody;
    } else {
      fetchOgMeta(candidateUrl).then(ogMeta => {
        if (ogMeta.description && !chosenOgDesc) chosenOgDesc = ogMeta.description;
        if (ogMeta.articleBody && !chosenArticleBody) chosenArticleBody = ogMeta.articleBody;
      }).catch(() => {});
    }

    if (media.url) { chosenItem = candidate; chosenMedia = media; break; }
  }

  // 4) DuckDuckGo görseli — DEVRE DIŞI (alakasız görseller çekiyor)
  // DuckDuckGo araması atlandı — sadece haberle ilgili görseller kullanılıyor

  // 5) Wikipedia görseli — DEVRE DIŞI (alakasız görseller gelebiliyor)
  // Görsel bulunamazsa haber sadece metin olarak gönderilecek
  if (!chosenMedia.url) {
    chosenItem = chosenItem || validItems[0];
    chosenMedia = { type: null, url: null };
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
  let caption = `${prefix}${catEmoji2}${title}`;
  if (aiSummary && aiSummary.length > 5) {
    caption += `\n\n${cleanArrows(aiSummary)}`;
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
      if (webSent) { sentType = 'video'; }
      else {
        sentMsg = await bot.sendMessage(CHANNEL_ID, caption, sendOpts({ disable_web_page_preview: true }));
        sentType = 'text';
      }
    } else if (chosenMedia.type === 'image') {
      sentMsg = await bot.sendPhoto(CHANNEL_ID, chosenMedia.url, sendOpts({ caption }));
      sentType = 'image';
    } else {
      sentMsg = await bot.sendMessage(CHANNEL_ID, caption, sendOpts({ disable_web_page_preview: true }));
      sentType = 'text';
    }
    console.log(`✅ [${feed.source}] [${sentType}]${replyToId ? ' [reply]' : ''} ${title.slice(0, 50)}`);
  } catch (err) {
    console.error(`❌ Gönderme hatası (${chosenMedia.type}): ${err.message}`);
    try {
      sentMsg = await bot.sendMessage(CHANNEL_ID, caption, sendOpts({ disable_web_page_preview: true }));
      sentType = 'text';
    } catch (err2) { console.error(`❌ Metin gönderme de başarısız: ${err2.message}`); }
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
    await bot.answerCallbackQuery(query.id, { text: '❌ Admin yetkisi gerekli!' });
    return;
  }

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
      await bot.answerCallbackQuery(query.id);
      await bot.editMessageText(
        `⏱ *Yayın Sıklığı*\n\nŞu an: *${settings.intervalMinutes} dakika*\n\nYeni süreyi seç:`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: intervalKeyboard() }
      );
      break;

    case 'admin_daterange_menu':
      await bot.answerCallbackQuery(query.id);
      await bot.editMessageText(
        `📅 *Haber Yaş Aralığı*\n\nŞu an: *Son ${settings.maxAgeHours || 24} saat*\n\nKaç saatlik haberleri yayınlayalım?`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: dateRangeKeyboard() }
      );
      break;

    case 'admin_timewindow_menu': {
      const sh = String(settings.publishStartHour ?? 9).padStart(2, '0');
      const eh = String(settings.publishEndHour ?? 2).padStart(2, '0');
      await bot.answerCallbackQuery(query.id);
      await bot.editMessageText(
        `🕐 *Yayın Saati Ayarı*\n\nŞu an: *${sh}:00 – ${eh}:00*\n\nBaşlangıç veya bitiş saatini seç:`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: timeWindowMenuKeyboard() }
      );
      break;
    }

    case 'admin_timewindow_start':
      await bot.answerCallbackQuery(query.id);
      await bot.editMessageText(
        `🟢 *Yayın Başlangıç Saati*\n\nŞu an: *${String(settings.publishStartHour ?? 9).padStart(2,'0')}:00*`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: timeWindowKeyboard('start') }
      );
      break;

    case 'admin_timewindow_end':
      await bot.answerCallbackQuery(query.id);
      await bot.editMessageText(
        `🔴 *Yayın Bitiş Saati*\n\nŞu an: *${String(settings.publishEndHour ?? 2).padStart(2,'0')}:00*`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: timeWindowKeyboard('end') }
      );
      break;

    case 'admin_category_menu':
      await bot.answerCallbackQuery(query.id);
      await bot.editMessageText(
        `📂 *Kategori Seçimi*\n\nŞu an: *${CATEGORY_LABELS[settings.activeCategory] || settings.activeCategory}*\n\nHaberler bu kategoriden yayınlanır:`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: categoryKeyboard() }
      );
      break;

    case 'admin_publish_now':
      await bot.answerCallbackQuery(query.id, { text: '📰 Haber yayınlanıyor...' });
      await publishNextNews();
      await bot.editMessageText(adminPanelText(), {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: adminPanelKeyboard(),
      });
      break;

    case 'admin_toggle_pause':
      settings.paused = !settings.paused;
      saveSettings();
      await bot.answerCallbackQuery(query.id, {
        text: settings.paused ? '⏸ Bot duraklatıldı' : '▶️ Bot devam ediyor',
      });
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
      await bot.answerCallbackQuery(query.id);
      await bot.editMessageText(statsText, {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '◀️ Geri', callback_data: 'admin_back' }]] },
      });
      break;
    }

    case 'admin_sources': {
      const list = RSS_FEEDS.map((f, i) => `${i + 1}. ${f.label} [${f.category}]`).join('\n');
      await bot.answerCallbackQuery(query.id);
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
      await bot.answerCallbackQuery(query.id);
      await bot.editMessageText(adminPanelText(), {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: adminPanelKeyboard(),
      });
      break;

    default:
      await bot.answerCallbackQuery(query.id);
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
            await bot.sendVideo(CHANNEL_ID, fs.createReadStream(videoPath), { caption, supports_streaming: true });
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

console.log('✅ Bot çalışıyor!');
