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
        await new Promise(r => setTimeout(r, 8000));
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

// ─── Yakalanmayan hataları yakala — rss-parser timeout bug'ı botu çökertiyor ──
process.on('uncaughtException', (err) => {
  console.error('⚠️ Yakalanmayan hata (bot devam ediyor):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Yakalanmayan promise reddi (bot devam ediyor):', reason?.message || reason);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERS_FILE = path.join(__dirname, 'users.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const PUBLISHED_FILE = path.join(__dirname, 'published.json');

// AI istemcisi: Cloudflare > Gemini > Groq > OpenAI/Replit AI Integrations
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN  = process.env.CLOUDFLARE_API_TOKEN;
const CF_AI_ENABLED = !!(CF_ACCOUNT_ID && CF_API_TOKEN);

const AI_ENABLED = CF_AI_ENABLED || !!(
  process.env.GEMINI_API_KEY ||
  process.env.GROQ_API_KEY ||
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL
);

const AI_MODEL = CF_AI_ENABLED
  ? '@cf/meta/llama-3.1-8b-instruct'
  : process.env.GEMINI_API_KEY ? 'gemini-2.0-flash'
  : process.env.GROQ_API_KEY ? 'llama-3.1-8b-instant'
  : 'gpt-4o-mini';

const aiClient = CF_AI_ENABLED
  ? new OpenAI({
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1`,
      apiKey: CF_API_TOKEN,
    })
  : new OpenAI({
      baseURL: process.env.GEMINI_API_KEY
        ? 'https://generativelanguage.googleapis.com/v1beta/openai/'
        : process.env.GROQ_API_KEY
          ? 'https://api.groq.com/openai/v1'
          : (process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || 'https://api.openai.com/v1'),
      apiKey: process.env.GEMINI_API_KEY
        || process.env.GROQ_API_KEY
        || process.env.AI_INTEGRATIONS_OPENAI_API_KEY
        || 'dummy',
    });

if (AI_ENABLED) {
  const src = CF_AI_ENABLED ? 'Cloudflare Workers AI'
    : process.env.GEMINI_API_KEY ? 'Google Gemini'
    : process.env.GROQ_API_KEY ? 'Groq' : 'OpenAI';
  console.log(`✅ AI aktif — ${src} (${AI_MODEL})`);
} else {
  console.log('⚠️  AI devre dışı — CLOUDFLARE_API_TOKEN, GEMINI_API_KEY, GROQ_API_KEY veya AI_INTEGRATIONS_OPENAI_BASE_URL ayarlanmamış');
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID || '@muhalif_gazete';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin2024';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';

console.log('🤖 Bot v2.27 — sd_publish gorsel+video akisi otomatik yayinla ayni — 2026-05-22');

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN eksik!');
  process.exit(1);
}

// Her ortamda polling kullan — önce webhook sil, sonra polling başlat
const WEBHOOK_PATH = '/tg-webhook';
const WEBHOOK_URL  = '';

// polling: false ile başlat — webhook silindikten SONRA polling açılacak
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

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
  dbSaveSettings();
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
  Object.entries(users).forEach(([chatId, data]) => dbSaveUser(chatId, data));
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
    url: 'https://news.google.com/rss/search?q=ANKA+ajans+haber&hl=tr&gl=TR&ceid=TR:tr',
    label: '📡 ANKA Ajans',
    source: 'ANKA',
    type: 'google',
    category: 'politika',
  },
  {
    url: 'https://www.cumhuriyet.com.tr/rss',
    label: '🗞 Cumhuriyet',
    source: 'Cumhuriyet',
    type: 'direct',
    category: 'genel',
  },
  {
    url: 'https://www.cumhuriyet.com.tr/rss',
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
    url: 'https://halktv.com.tr/export/rss',
    label: '📺 Halk TV',
    source: 'Halk TV',
    type: 'direct',
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
    url: 'https://www.birgun.net/rss',
    label: '🗞 BirGün',
    source: 'BirGün',
    type: 'direct',
    category: 'politika',
  },
  {
    url: 'https://www.odatv.com/rss.xml',
    label: '🗞 OdaTV',
    source: 'OdaTV',
    type: 'direct',
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
    url: 'https://artigercek.com/feed',
    label: '🗞 Artı Gerçek',
    source: 'Artı Gerçek',
    type: 'direct',
    category: 'politika',
  },
  {
    url: 'https://bianet.org/rss/bianet',
    label: '🗞 Bianet',
    source: 'Bianet',
    type: 'direct',
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
  // ── Teknoloji Kaynakları ───────────────────────────────────────────────────
  {
    url: 'https://news.google.com/rss/search?q=teknoloji+yapay+zeka+TR&hl=tr&gl=TR&ceid=TR:tr',
    label: '💻 Google Teknoloji',
    source: 'Google Teknoloji',
    type: 'google',
    category: 'teknoloji',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:webrazzi.com&hl=tr&gl=TR&ceid=TR:tr',
    label: '💻 Webrazzi',
    source: 'Webrazzi',
    type: 'google',
    category: 'teknoloji',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:shiftdelete.net&hl=tr&gl=TR&ceid=TR:tr',
    label: '💻 ShiftDelete',
    source: 'ShiftDelete',
    type: 'google',
    category: 'teknoloji',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:webtekno.com&hl=tr&gl=TR&ceid=TR:tr',
    label: '💻 Webtekno',
    source: 'Webtekno',
    type: 'google',
    category: 'teknoloji',
  },
  {
    url: 'https://news.google.com/rss/search?q=yapay+zeka+OR+iphone+OR+android+OR+siber+guvenlik+site:cumhuriyet.com.tr&hl=tr&gl=TR&ceid=TR:tr',
    label: '💻 Cumhuriyet Teknoloji',
    source: 'Cumhuriyet',
    type: 'google',
    category: 'teknoloji',
  },
  // ── Ekonomi Kaynakları ─────────────────────────────────────────────────────
  {
    url: 'https://news.google.com/rss/search?q=site:bloomberght.com&hl=tr&gl=TR&ceid=TR:tr',
    label: '💰 Bloomberg HT',
    source: 'Bloomberg HT',
    type: 'google',
    category: 'ekonomi',
  },
  {
    url: 'https://news.google.com/rss/search?q=ekonomi+dolar+faiz+enflasyon&hl=tr&gl=TR&ceid=TR:tr',
    label: '💰 Google Ekonomi',
    source: 'Google Ekonomi',
    type: 'google',
    category: 'ekonomi',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:dunya.com&hl=tr&gl=TR&ceid=TR:tr',
    label: '💰 Dünya Gazetesi',
    source: 'Dünya',
    type: 'google',
    category: 'ekonomi',
  },
  {
    url: 'https://news.google.com/rss/search?q=TCMB+OR+borsa+OR+bist+OR+enflasyon&hl=tr&gl=TR&ceid=TR:tr',
    label: '💰 Piyasalar',
    source: 'Piyasalar',
    type: 'google',
    category: 'ekonomi',
  },
  // YouTube feed'leri kaldırıldı — web gömülü video kullanılıyor
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
  // ── İçerik bazlı kategori eşleşme kontrolü ──────────────────────────────────
  function matchesActiveCategory(title, description, category) {
    if (!category || category === 'hepsi') return true;
    const text = `${title || ''} ${description || ''}`.toLowerCase();
    const CATEGORY_KEYWORDS = {
      spor: ['futbol','maç ','maçı','gol','transfer','fenerbahçe','galatasaray','beşiktaş','trabzonspor','milli takım','süper lig','basketbol','tenis','formula','olimpiyat','şampiyon','teknik direktör','taraftar',' lig ',' lig,','kulüp','atlet','maraton','yüzme','voleybol','spor','stadyum','deplasman','forma','golcü','kaleci','defans','hücum','turnuva','kupası','derbi'],
      ekonomi: ['dolar','euro','faiz','enflasyon','tcmb','borsa','bist','merkez bankası','ihracat','ithalat','büyüme','bütçe','vergi','işsizlik','piyasa','hisse','altın','döviz','kredi','hazine','ekonomi','gdp','gsyih','ticaret','sterlin','yen','yuan','ruble','emtia','petrol','doğalgaz','akaryakıt','benzin','motorin','elektrik faturası','fiyat artışı','zam','indirim','maaş','asgari ücret','işçi','sendika','grev','banka','merkez bankası','faiz kararı','enflasyon rakamı','tüfe','üfe','büyüme rakamı','cari açık','dış ticaret','sanayi üretimi','imalat','ihracat rekoru','yatırım','fon','kripto para','bitcoin','ethereum','altın fiyatı','dolar kuru','euro kuru','konut','kira','gayrimenkul','inşaat','konut fiyatı'],
      dunya: ['ukrayna','rusya','abd ','nato','birleşmiş milletler','bm ','suriye','gazze','israil','filistin','irak','iran','çin','almanya','fransa','ingiltere','putin','biden','trump','savaş','uluslararası','küresel','dış politika','avrupa','ab ','avrupa birliği','yunanistan','balkanlar','japonya','hindistan','pakistan','afganistan','mısır','suudi arabistan','körfez','orta doğu','ortadoğu','new york','washington','londra','paris','berlin','moskova','pekin','birleşik krallık','dışişleri','büyükelçi','diplomatik','yabancı','uluslararası','dünya genelinde','ülke','ülkeleri','küresel kriz','insani yardım','mülteci','göç'],
      teknoloji: ['yapay zeka','ai ','teknoloji','yazılım','donanım','uygulama','sosyal medya','twitter','instagram','google','apple','microsoft','blockchain','kripto','iphone','android','elektrikli araç','elektrikli otomobil','tesla','spacex','elon musk','nükleer enerji','yenilenebilir enerji','siber güvenlik','siber saldırı','veri ihlali','startup','girişim','unicorn','e-ticaret','metaverse','5g','6g','quantum','kuantum','robot','otomasyon','drone','insansız','uzay','roket','satellite','uydu','chip','çip','semiconductör','nvidia','amd','intel','samsung','huawei','tiktok','youtube','netflix','spotify','openai','chatgpt','gemini','claude','llm','büyük dil','oyun','gaming','playstation','xbox','steam','twitch','uygulama mağazası'],
      politika: ['cumhurbaşkanı','erdoğan','meclis','hükümet','bakan','chp','akp','mhp','hdp','dip','parti ','muhalefet','seçim','milletvekili','tbmm','anayasa','siyasi','muhalif','sandık','koalisy'],
    };
    const words = CATEGORY_KEYWORDS[category];
    if (!words) return true;
    return words.some(w => text.includes(w));
  }
  
const BREAKING_INTERVAL_MS = 2 * 60 * 1000; // 2 dakika

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
      url: 'https://www.cumhuriyet.com.tr/rss',
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
  {
    url: 'https://haber.sol.org.tr/rss.xml',
    label: '🔴 soL Haber',
    source: 'soL Haber',
    type: 'direct',
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
  timeout: 8000,
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

async function persistPublishedUrls() {
  try {
    let arr = [...publishedUrls];
    if (arr.length > 5000) arr = arr.slice(arr.length - 3000);
    fs.writeFileSync(PUBLISHED_FILE, JSON.stringify(arr));
    if (dbReady && pgClient && arr.length > 0) {
      for (let i = 0; i < arr.length; i += 500) {
        const chunk = arr.slice(i, i + 500);
        const placeholders = chunk.map((_, idx) => `($${idx + 1})`).join(',');
        await pgClient.query(
          `INSERT INTO published_urls(url) VALUES ${placeholders} ON CONFLICT(url) DO NOTHING`,
          chunk
        );
      }
    }
  } catch (e) { console.error('persistPublishedUrls hatası:', e.message); }
}

const publishedUrls = loadPublishedUrls();
setInterval(persistPublishedUrls, 30 * 1000);

// Son dakika için ayrı in-memory cache — disk'e yazılmaz, restart'ta sıfırlanır
// Böylece publishedUrls'teki eski kayıtlar son dakikayı engellemez
const breakingPublishedUrls = new Set();
let breakingNewsInterval = null;
let lastBreakingNewsTime = 0;
let isCheckingBreaking = false;
const BREAKING_MIN_GAP_MS = 5 * 60 * 1000; // 5 dakika min aralık
// Her 2 saatte bir temizle (çok büyümemesi için)
setInterval(() => { breakingPublishedUrls.clear(); console.log('🔄 breakingPublishedUrls temizlendi'); }, 2 * 60 * 60 * 1000);

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

async function persistPublishedTitles() {
  try {
    let arr = [...publishedTitlesSession];
    if (arr.length > 3000) arr = arr.slice(arr.length - 2000);
    fs.writeFileSync(PUBLISHED_TITLES_FILE, JSON.stringify(arr));
    if (dbReady && pgClient && arr.length > 0) {
      for (let i = 0; i < arr.length; i += 500) {
        const chunk = arr.slice(i, i + 500);
        const placeholders = chunk.map((_, idx) => `($${idx + 1})`).join(',');
        await pgClient.query(
          `INSERT INTO published_titles(title) VALUES ${placeholders} ON CONFLICT(title) DO NOTHING`,
          chunk
        );
      }
    }
  } catch (e) { console.error('persistPublishedTitles hatası:', e.message); }
}
setInterval(persistPublishedTitles, 30 * 1000);

// ─── PostgreSQL Kalıcı Depolama ────────────────────────────────────────────────

let pgClient = null;
let dbReady = false;

async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    console.log('ℹ️ DATABASE_URL yok — dosya tabanlı depolama kullanılıyor');
    return;
  }
  try {
    const pgModule = await import('pg');
    const { Pool } = pgModule.default || pgModule;
    // Pool kullan: eş zamanlı sorgular desteklenir (Client tek bağlantıda kilitlenir)
    try {
      pgClient = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
      await pgClient.query('SELECT 1');
    } catch (sslErr) {
      if (sslErr.message.includes('SSL') || sslErr.message.includes('ssl')) {
        console.log(`ℹ️ SSL desteklenmiyor, SSL'siz bağlanılıyor...`);
        pgClient = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
        await pgClient.query('SELECT 1');
      } else {
        throw sslErr;
      }
    }
    await pgClient.query(`
      CREATE TABLE IF NOT EXISTS bot_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS bot_users (
        chat_id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS published_urls (
        url TEXT PRIMARY KEY,
        added_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS published_titles (
        title TEXT PRIMARY KEY,
        added_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    dbReady = true;
    console.log('✅ PostgreSQL bağlandı, tablolar hazır');

    const [settingsRes, usersRes, urlsRes, titlesRes] = await Promise.all([
      pgClient.query("SELECT value FROM bot_settings WHERE key = 'settings'"),
      pgClient.query('SELECT chat_id, data FROM bot_users'),
      pgClient.query(`SELECT url FROM published_urls WHERE added_at > NOW() - INTERVAL '6 hours' ORDER BY added_at DESC`),
      pgClient.query(`SELECT title FROM published_titles WHERE added_at > NOW() - INTERVAL '6 hours' ORDER BY added_at DESC`),
    ]);

    if (settingsRes.rows.length > 0) {
      const dbSettings = JSON.parse(settingsRes.rows[0].value);
      Object.assign(settings, dbSettings);
      console.log("✅ Ayarlar DB'den yüklendi");
    }
    usersRes.rows.forEach(r => { users[r.chat_id] = r.data; });
    if (usersRes.rows.length) console.log(`✅ ${usersRes.rows.length} kullanıcı DB'den yüklendi`);
    urlsRes.rows.forEach(r => publishedUrls.add(r.url));
    if (urlsRes.rows.length) console.log(`✅ ${urlsRes.rows.length} yayınlanan URL DB'den yüklendi`);
    titlesRes.rows.forEach(r => publishedTitlesSession.add(r.title));
    if (titlesRes.rows.length) console.log(`✅ ${titlesRes.rows.length} başlık DB'den yüklendi`);
  } catch (e) {
    console.error('⚠️ PostgreSQL bağlanamadı, dosya sistemi kullanılıyor:', e.message);
    try { if (pgClient) pgClient.end(); } catch {}
    pgClient = null;
    dbReady = false;
  }
}

function dbSaveSettings() {
  if (!dbReady || !pgClient) return;
  pgClient.query(
    "INSERT INTO bot_settings(key,value,updated_at) VALUES('settings',$1,NOW()) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=NOW()",
    [JSON.stringify(settings)]
  ).catch(e => console.error('DB settings hatası:', e.message));
}

function dbSaveUser(chatId, data) {
  if (!dbReady || !pgClient) return;
  pgClient.query(
    'INSERT INTO bot_users(chat_id,data,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(chat_id) DO UPDATE SET data=$2,updated_at=NOW()',
    [String(chatId), JSON.stringify(data)]
  ).catch(e => console.error('DB user hatası:', e.message));
}

function normalizeTitle(title) {
  return (title || '').toLowerCase()
    .replace(/[^a-züöşçğı0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

// Kelime örtüşme benzerlik kontrolü — %65+ aynı kelime = duplicate
function isSimilarTitle(a, b) {
  const stopWords = new Set(['ile','için','bir','bu','da','de','ve','ya','ama','ki','mi','mu','mü','mı','en','bu','şu','ne','var','yok','olan','oldu','olacak','etti','eder','gibi','daha','çok','az','son','ilk','yeni']);
  const wordsA = new Set(a.split(' ').filter(w => w.length > 3 && !stopWords.has(w)));
  const wordsB = new Set(b.split(' ').filter(w => w.length > 3 && !stopWords.has(w)));
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  let overlap = 0;
  for (const w of wordsA) { if (wordsB.has(w)) overlap++; }
  return overlap / Math.min(wordsA.size, wordsB.size) >= 0.65;
}

function isTitleDuplicate(title, { add = true } = {}) {
  const norm = normalizeTitle(title);
  if (publishedTitlesSession.has(norm)) return true;
  // Benzerlik kontrolü (son 300 başlık)
  const recent = [...publishedTitlesSession].slice(-300);
  if (recent.some(t => isSimilarTitle(norm, t))) return true;
  if (add) publishedTitlesSession.add(norm);
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
  // Her 4 haberden 1'i web gömülü video olsun (%25 hedef)
  if (videoRatio < 0.25) return 'video';
  return 'image';
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
    if (mime.startsWith('image/') || (!mime && /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(item.enclosure.url))) {
      if (isLiveBroadcastImage(item.enclosure.url)) { console.log(`🚫 Canlı yayın görseli atlandı (enclosure): ${item.enclosure.url.slice(0,80)}`); return { type: null, url: null }; }
      return { type: 'image', url: item.enclosure.url };
    }
  }
  const mc = item.mediaContent || item['media:content'];
  if (mc?.$?.url) {
    const mime = mc.$.type || mc.$.medium || '';
    if (isVideoType(mime) || mime === 'video') return { type: 'video', url: mc.$.url };
    if (isLiveBroadcastImage(mc.$.url)) { console.log(`🚫 Canlı yayın görseli atlandı (media:content): ${mc.$.url.slice(0,80)}`); return { type: null, url: null }; }
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
  if (redirectCount > 5) return Promise.resolve({ image: null, description: null });
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    const timer = setTimeout(() => done({ image: null, image2: null, description: null, articleBody: null }), 12000);
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'Referer': (() => { try { const u = new URL(url); return u.origin + '/'; } catch(e) { return 'https://www.google.com/'; } })(),
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
        let image = imgMatch ? imgMatch[1] : null;
        // Canlı yayın overlay görseli ise atla
        if (isLiveBroadcastImage(image)) { console.log(`🚫 Canlı yayın görseli atlandı (og:image): ${(image||'').slice(0,80)}`); image = null; }
        // JSON-LD structured data (NewsArticle, Article, etc.)
        if (!image) {
          const ldScripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
          for (const ldScript of ldScripts) {
            try {
              const ld = JSON.parse(ldScript[1]);
              const ldArr = Array.isArray(ld) ? ld : [ld];
              for (const entry of ldArr) {
                const img = (entry.image && typeof entry.image === 'string') ? entry.image
                  : entry.image?.url || (Array.isArray(entry.image) ? (entry.image[0]?.url || entry.image[0]) : null)
                  || entry.thumbnailUrl || null;
                if (img && typeof img === 'string' && img.startsWith('http')) { image = img; break; }
              }
            } catch {}
            if (image) break;
          }
        }
        // itemprop="image" (schema.org microdata)
        if (!image) {
          const ipMatch = html.match(/<(?:meta|link)[^>]+itemprop=["']image["'][^>]+(?:content|href)=["']([^"']+)["']/i) ||
                          html.match(/<(?:meta|link)[^>]+(?:content|href)=["']([^"']+)["'][^>]+itemprop=["']image["']/i);
          if (ipMatch && ipMatch[1]?.startsWith('http')) image = ipMatch[1];
        }

        const descMatch =
          html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{20,}?)["']/i) ||
          html.match(/<meta[^>]+content=["']([^"']{20,}?)["'][^>]+property=["']og:description["']/i) ||
          html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{20,}?)["']/i) ||
          html.match(/<meta[^>]+content=["']([^"']{20,}?)["'][^>]+name=["']description["']/i) ||
          html.match(/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']{20,}?)["']/i);
        const rawDesc = descMatch ? descMatch[1].replace(/&#?[a-z0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim() : null;
        const description = rawDesc && !isGarbageText(rawDesc) ? rawDesc : null;

        const pMatches = html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
        const bodyText = pMatches
          .map(p => p.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim())
          .filter(t => t.length > 40 && !isGarbageText(t))
          .slice(0, 8)
          .join(' ');
        const articleBody = bodyText.length > 80 ? bodyText.slice(0, 1500) : null;

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
    req.setTimeout(11000, () => { req.destroy(); clearTimeout(timer); done({ image: null, image2: null, description: null, articleBody: null }); });
  });
}

async function fetchOgImage(url) {
  const meta = await fetchOgMeta(url);
  return meta.image;
}

// Görseli Railway sunucusunda buffer'a indir — Wikipedia/Wikimedia gibi
// Telegram URL'si engelleyen sitelerde buffer ile gönderiyoruz
function downloadImageBuffer(url, redirectCount = 0) {
  if (redirectCount > 5) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done(null), 15000);
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/*,*/*;q=0.8',
        'Referer': 'https://www.google.com/',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy(); clearTimeout(timer);
        const loc = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        downloadImageBuffer(loc, redirectCount + 1).then(done);
        return;
      }
      if (res.statusCode !== 200) { res.destroy(); clearTimeout(timer); done(null); return; }
      const ct = res.headers['content-type'] || '';
      if (!ct.startsWith('image/')) { res.destroy(); clearTimeout(timer); done(null); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        if (buf.length < 1000) { done(null); return; } // çok küçük → geçersiz
        const ext = ct.includes('png') ? 'png' : ct.includes('gif') ? 'gif' : ct.includes('webp') ? 'webp' : 'jpg';
        done({ buffer: buf, filename: `image.${ext}`, contentType: ct });
      });
      res.on('error', () => { clearTimeout(timer); done(null); });
    }).on('error', () => { clearTimeout(timer); done(null); });
  });
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
function stripSourceDate(text) {
  if (!text) return text;
  return text
    .replace(/kaynak\s*:\s*[^\n,]{2,40}(?:,\s*\d{1,2}\s+\w+\s+\d{4})?\s*\.?/gi, '')
    .replace(/\b\d{1,2}\s+(Ocak|\u015eubat|Mart|Nisan|May\u0131s|Haziran|Temmuz|A\u011fustos|Eyl\u00fcl|Ekim|Kas\u0131m|Aral\u0131k)\s+\d{4}\b[,.]?\s*/gi, '')
    .replace(/\(\s*\d{1,2}\s+\w+\s+\d{4}[^)]*\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

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
  if (!AI_ENABLED) {
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
        model: AI_MODEL,
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

// ─── Detaylı AI Özetleme (/ara için) ────────────────────────────────────────
async function summarizeNewsDetailed(title, description, articleBody = null) {
  const rawText = (description || '').trim();
  const inputText = isGarbageText(rawText) ? '' : rawText;
  const bodyText = articleBody && !isGarbageText(articleBody) ? articleBody : '';
  const fullContent = [inputText, bodyText].filter(Boolean).join('\n\n').slice(0, 3000);

  if (!AI_ENABLED) {
    // Başlıkla birebir aynı veya çok yakın metni özet olarak döndürme
    const isTitleRepeat = (text) => {
      if (!text || text.length < 20) return true;
      const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      const t = norm(title), tx = norm(text);
      return tx === t || tx.startsWith(t) || t.startsWith(tx) || (tx.includes(t) && tx.length < t.length + 30);
    };
    // Makale gövdesi > og:description > null (başlık tekrarı hiçbir zaman dönme)
    if (bodyText.length > 80 && !isTitleRepeat(bodyText)) return bodyText.slice(0, 800);
    if (inputText.length > 40 && !isTitleRepeat(inputText)) return inputText.slice(0, 800);
    return null;
  }
  try {
    const prompt = fullContent
      ? `Sen Türkçe bir haber kanalının deneyimli editörüsün. Aşağıdaki haberi okuyuculara kapsamlı ve açıklayıcı biçimde anlat. 4-6 cümle yaz. Şunlara dikkat et: başlıkta yazanı kelimesi kelimesine tekrarlama; kim, ne, nerede, ne zaman, neden ve nasıl sorularını yanıtla; gerçek rakamlar, kararlar, alıntılar varsa mutlaka yaz; olayın arka planını ve önemini açıkla. Kaynak adı, tarih, link EKLEME. Sadece özeti yaz, başka hiçbir şey ekleme.

Başlık: ${title}
İçerik: ${fullContent}`
      : `Sen Türkçe bir haber kanalının deneyimli editörüsün. Aşağıdaki haber başlığını oku. Konuyu 3-4 cümleyle arka plan bağlamı ve önemini de içerecek şekilde açıkla. Başlığı kelime kelime tekrarlama. Kaynak adı, tarih, link ekleme. Sadece açıklamayı yaz.

Başlık: ${title}`;

    const response = await Promise.race([
      aiClient.chat.completions.create({
        model: AI_MODEL,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('AI timeout')), 10000)),
    ]);
    const result = (response.choices[0]?.message?.content || '').trim();
    if (!result || result.length < 10) return fullContent.slice(0, 800) || null;
    return result;
  } catch {
    const best = bodyText.length > 80 ? bodyText.slice(0, 800) : (inputText.length > 20 ? inputText.slice(0, 800) : null);
    return best;
  }
}

// ─── DuckDuckGo Görsel Arama ──────────────────────────────────────────────────

// ─── Bing Image Search: m={} attribute'unu HTML-decode ederek parse et ────────
// ─── Resim Arama: Wikipedia REST API (garantili, hiç bloklanmaz) ───────────────
// Başlıktan anlamlı kelimeler çıkar (özel isimler, teknik terimler)
function extractKeywords(title) {
  const stop = new Set([
    'bir','iki','üç','dört','beş','bu','şu','ve','ile','de','da','ki',
    'mi','mı','mu','mü','için','olan','gibi','artık','nasıl','neden',
    'ne','hangi','son','yeni','büyük','küçük','ilk','son','daki','deki',
    'den','dan','tan','ten','ten','ten','ın','in','un','ün','nın','nin',
    'nın','nün','nun','dan','den','ndan','nden','ile','için','kadar',
    'çok','az','en','daha','ancak','ama','fakat','veya','ya','ya da',
  ]);
  return title
    .replace(/[!?.,;:()[]{}'"`]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stop.has(w.toLowerCase()))
    .filter(w => /^[A-ZĞÜŞÖÇİa-zğüşöçı0-9]/u.test(w))
    .slice(0, 5);
}

// Wikipedia REST summary API — tek çağrı, anında döner
function wikiImage(term) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(null), 8000);

    const tryLang = (lang, next) => {
      const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term)}`;
      https.get(url, { headers: { 'User-Agent': 'Newsbot/1.0 (Telegram news aggregator)' } }, (res) => {
        if (res.statusCode === 404 || res.statusCode === 400) {
          res.destroy(); return next ? tryLang(next, null) : finish(null);
        }
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.destroy(); return next ? tryLang(next, null) : finish(null);
        }
        let d = ''; res.on('data', ch => d += ch);
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            const orig  = j?.originalimage?.source || null;
            const thumb = j?.thumbnail?.source || null;
            // Önce SVG olmayan originalimage'i dene (genelde daha büyük)
            if (orig && !/\.svg$/i.test(orig)) { clearTimeout(timer); return finish(orig); }
            // Sonra thumbnail — Wikimedia thumbnail'leri .svg.png olabilir, geçerli PNG
            if (thumb) { clearTimeout(timer); return finish(thumb); }
          } catch {}
          next ? tryLang(next, null) : finish(null);
        });
        res.on('error', () => (next ? tryLang(next, null) : finish(null)));
      }).on('error', () => (next ? tryLang(next, null) : finish(null)));
    };

    tryLang('tr', 'en');
  });
}

// ─── Türkçe → İngilizce anahtar kelime çevirisi (LoremFlickr için) ──────────────
const TR_EN_MAP = {
  // Ekonomi & Finans
  'ekonomi':'economy','siyaset':'politics','spor':'sports','futbol':'football',
  'seçim':'election','deprem':'earthquake','savaş':'war','teknoloji':'technology',
  'sağlık':'health','eğitim':'education','para':'money','borsa':'stock market',
  'dolar':'dollar','euro':'euro','altın':'gold','petrol':'oil','enerji':'energy',
  'mahkeme':'court','meclis':'parliament','yangın':'fire','sel':'flood',
  'iklim':'climate','çevre':'nature','uçak':'airplane','tren':'train',
  'asker':'military','ordu':'military','polis':'police','suç':'crime',
  'turizm':'tourism','konut':'housing','inşaat':'construction','tarım':'agriculture',
  'ithalat':'import','ihracat':'export','enflasyon':'inflation','faiz':'interest',
  'türkiye':'turkey','istanbul':'istanbul','ankara':'ankara','erdoğan':'president',
  'müzik':'music','sanat':'art','film':'film','kitap':'book','bilim':'science',
  'uzay':'space','yapay':'technology','zeka':'intelligence',
  'bitcoin':'bitcoin','kripto':'cryptocurrency','sosyal':'social media',
  'galatasaray':'football','fenerbahçe':'football','beşiktaş':'football',
  'trabzonspor':'football','maç':'football','gol':'goal','transfer':'transfer',
  // Ek kelimeler
  'cumhurbaşkanı':'president','bakan':'minister','hükümet':'government',
  'muhalefet':'opposition','parti':'politics','milletvekili':'parliament',
  'tbmm':'parliament','anayasa':'constitution','sandık':'election',
  'gözaltı':'police','tutuklama':'arrest','dava':'court','yargı':'justice',
  'ukrayna':'ukraine','rusya':'russia','gazze':'war','filistin':'palestine',
  'israil':'israel','nato':'military','abd':'usa','çin':'china',
  'almanya':'germany','fransa':'france','ingiltere':'england',
  'döviz':'currency','kredi':'credit','bütçe':'budget','vergi':'tax',
  'işsizlik':'unemployment','büyüme':'growth','ihale':'business',
  'hastane':'hospital','doktor':'doctor','aşı':'vaccine','ilaç':'medicine',
  'deprem':'earthquake','tsunami':'tsunami','kasırga':'hurricane',
  'basketbol':'basketball','tenis':'tennis','olimpiyat':'olympic',
  'şampiyon':'champion','kupa':'trophy','liga':'league','stadyum':'stadium',
  'kanal':'channel','gazete':'newspaper','haber':'news','basın':'press',
  'sermaye':'capital','yatırım':'investment','şirket':'company','fabrika':'factory',
  'çiftçi':'farmer','köy':'village','şehir':'city','istanbul':'istanbul',
  'mülteci':'refugee','göçmen':'immigrant','sınır':'border',
  'enerji':'energy','doğalgaz':'gas','elektrik':'electricity','nükleer':'nuclear',
  'iklim':'climate','orman':'forest','deniz':'sea','hava':'weather',
  'okul':'school','üniversite':'university','öğrenci':'student','öğretmen':'teacher',
  'emekli':'retirement','maaş':'salary','işçi':'worker','grev':'strike',
  // Yerel yönetim & hukuk
  'kayyum':'government','belediye':'city hall','başkan':'mayor','vali':'governor',
  'prefekt':'government','atama':'appointment','görev':'duty','yönetim':'administration',
  'şişli':'istanbul','kadıköy':'istanbul','üsküdar':'istanbul','bağcılar':'istanbul',
  'beşiktaş':'istanbul','beyoğlu':'istanbul','fatih':'istanbul','ataşehir':'istanbul',
  'izmir':'izmir','bursa':'bursa','antalya':'antalya','adana':'adana','gaziantep':'city',
  'kocaeli':'turkey','konya':'turkey','mersin':'turkey','diyarbakır':'turkey',
  // Güncel siyasi terimler
  'muhtır':'government','fesih':'politics','lağvetme':'politics','kapatma':'court',
  'baro':'lawyer','avukat':'lawyer','hâkim':'judge','savcı':'prosecutor',
  'ceza':'prison','tahliye':'prison','infaz':'justice','af':'justice',
  'protesto':'protest','gösteri':'demonstration','yürüyüş':'march','eylem':'protest',
  'sendika':'union','dernek':'association','vakıf':'foundation','stk':'organization',
  'ihraç':'dismissal','açığa alma':'government','görevden alma':'dismissal',
  'istihdam':'employment','ücret':'salary','zam':'raise','asgari':'minimum wage',
  'konut':'housing','kira':'rent','ev':'house','arsa':'land','inşaat':'construction',
  'trafik':'traffic','kaza':'accident','hayat':'life','ölü':'death','yaralı':'injury',
  'terör':'terror','pkk':'terror','fetö':'terror','uyuşturucu':'drugs',
  'silah':'weapon','bomba':'explosion','patlama':'explosion','saldırı':'attack',
  'seçim':'election','oy':'vote','sandık':'election','aday':'candidate',
  'bütçe':'budget','açık':'deficit','borç':'debt','ödenek':'grant',
};

function translateKeywordsToEn(keywords) {
  return keywords.map(k => TR_EN_MAP[k.toLowerCase()] || k).slice(0, 3);
}

// ─── Kaynak Site Domain Haritası ─────────────────────────────────────────────
const SOURCE_DOMAINS = {
  'cumhuriyet':'https://www.cumhuriyet.com.tr',
  'sözcü':'https://www.sozcu.com.tr','sozcu':'https://www.sozcu.com.tr',
  't24':'https://t24.com.tr',
  'odatv':'https://www.odatv.com','oda tv':'https://www.odatv.com',
  'birgun':'https://www.birgun.net','birgün':'https://www.birgun.net','birgun.net':'https://www.birgun.net',
  'bianet':'https://bianet.org',
  'halk tv':'https://halktv.com.tr','halktv':'https://halktv.com.tr',
  'tele1':'https://www.tele1.com.tr','tele 1':'https://www.tele1.com.tr',
  'artı gerçek':'https://artigercek.com','arti gercek':'https://artigercek.com',
  'gazete duvar':'https://www.gazeteduvar.com.tr',
  'ntv':'https://www.ntv.com.tr','ntv haber':'https://www.ntv.com.tr',
  'yeniçağ gazetesi':'https://www.yenicaggazetesi.com.tr','yeniçağ':'https://www.yenicaggazetesi.com.tr',
  'tgrt haber':'https://www.tgrthaber.com.tr','tgrt':'https://www.tgrthaber.com.tr',
  'haberler.com':'https://www.haberler.com','haberler':'https://www.haberler.com',
  'milliyet':'https://www.milliyet.com.tr',
  'hürriyet':'https://www.hurriyet.com.tr','hurriyet':'https://www.hurriyet.com.tr',
  'sabah':'https://www.sabah.com.tr',
  'habertürk':'https://www.haberturk.com','haberturk':'https://www.haberturk.com',
  'a haber':'https://www.ahaber.com.tr','ahaber':'https://www.ahaber.com.tr',
  'cnn türk':'https://www.cnnturk.com','cnn turk':'https://www.cnnturk.com',
  'dha':'https://www.dha.com.tr',
  'aa':'https://www.aa.com.tr','anadolu ajansı':'https://www.aa.com.tr',
  'krt':'https://www.krttv.com.tr','krt tv':'https://www.krttv.com.tr',
  'medyascope':'https://medyascope.tv',
  'diken':'https://www.diken.com.tr',
  'dokuz8haber':'https://dokuz8haber.net',
  'sendika.org':'https://www.sendika.org','sendika':'https://www.sendika.org',
  'evrensel':'https://www.evrensel.net',
  'gazeteoksijen':'https://gazeteoksijen.com',
  'haber global':'https://www.haberglobal.com.tr',
  'fox haber':'https://www.fox.com.tr','fox':'https://www.fox.com.tr',
  'star':'https://www.star.com.tr',
  'takvim':'https://www.takvim.com.tr',
  'yeni şafak':'https://www.yenisafak.com','yeni safak':'https://www.yenisafak.com',
  'karar':'https://www.karar.com',
  'bloomberg ht':'https://www.bloomberght.com',
  'dünya':'https://www.dunya.com',
  'ekonomim':'https://www.ekonomim.com',
  'sporx':'https://www.sporx.com',
  'fanatik':'https://www.fanatik.com.tr',
  'goal':'https://www.goal.com/tr',
  'ntv spor':'https://www.ntvspor.net',
};

// Google News RSS başlığından kaynak site domain'ini çıkar
// Örn: "Başlık - birgun.net" → "https://www.birgun.net"
// Örn: "Başlık - Odatv" → "https://www.odatv.com"
function extractSourceDomain(rawTitle) {
  if (!rawTitle) return null;
  // Başlık sonundaki " - Kaynak Adı" kısmını al
  const match = rawTitle.match(/\s*[-–]\s*([^\-–\n]{2,60}?)\s*$/);
  if (!match) return null;
  const sourceName = match[1].trim();
  const sourceKey = sourceName.toLowerCase();

  // 1. Harita araması (tam eşleşme)
  if (SOURCE_DOMAINS[sourceKey]) return SOURCE_DOMAINS[sourceKey];

  // 2. Kısmi eşleşme (örn. "Afyon Türkeli Gazetesi" → bulunamaz ama denenir)
  for (const [k, v] of Object.entries(SOURCE_DOMAINS)) {
    if (sourceKey.includes(k) || k.includes(sourceKey)) return v;
  }

  // 3. Direkt domain (birgun.net, odatv.com gibi nokta içeriyorsa)
  if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,6}$/.test(sourceName.replace(/^www\./i, ''))) {
    return `https://www.${sourceName.replace(/^www\./i, '').toLowerCase()}`;
  }

  return null;
}

// ─── LoremFlickr — ücretsiz, API anahtarsız, konuyla alakalı HD fotoğraf ─────
function _flickrFetch(term) {
  return new Promise((resolve) => {
    const url = `https://loremflickr.com/1280/720/${encodeURIComponent(term)}`;
    const req = https.request(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      res.destroy();
      // LoremFlickr redirect ile gerçek Flickr CDN URL'sine yönlendirir
      const loc = res.headers['location'] || '';
      if (!loc) return resolve(null);
      const direct = loc.startsWith('http') ? loc : `https://loremflickr.com${loc}`;
      // staticflickr.com veya .jpg/.jpeg/.png içeriyorsa geçerli kabul et
      const isFlickrCdn = direct.includes('staticflickr.com') || direct.includes('live.staticflickr.com');
      const hasImageExt = /\.(jpg|jpeg|png|webp)/i.test(direct);
      if (isFlickrCdn || hasImageExt) {
        resolve(direct);
      } else {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function fetchLoremFlickrImage(query) {
  const rawKws = extractKeywords(query);
  // TR_EN_MAP'te bulunanları İngilizceye çevir; bulunamayanları da dene (özel isimler için)
  const enKws = rawKws
    .map(k => TR_EN_MAP[k.toLowerCase()] || (k.length > 3 ? k : null))
    .filter(Boolean);

  // Denenecek terimler: çift kelime → tek kelime (jenerik "turkey,news" vb. fallback'ler kaldırıldı)
  const candidates = [];
  if (enKws.length >= 2) candidates.push(enKws.slice(0, 2).join(','));
  if (enKws.length >= 1) candidates.push(enKws[0]);
  if (enKws.length >= 3) candidates.push(enKws[1]);
  if (enKws.length >= 2) candidates.push(enKws[1]);

  for (const term of candidates) {
    const img = await _flickrFetch(term).catch(() => null);
    if (img) {
      console.log(`🖼 LoremFlickr (${term}): ${img.slice(0, 80)}`);
      return img;
    }
  }
  return null;
}

// ─── Serper.dev Google Images API (SERPER_API_KEY varsa) ─────────────────────
async function fetchSerperImage(query) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return null;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(null), 8000);
    const body = JSON.stringify({ q: query, num: 5, gl: 'tr', hl: 'tr' });
    const req = https.request({
      hostname: 'google.serper.dev', path: '/images', method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = ''; res.on('data', ch => d += ch);
      res.on('end', () => {
        try {
          const results = JSON.parse(d)?.images || [];
          const img = results.find(r => r.imageUrl && /https?:/.test(r.imageUrl))?.imageUrl || null;
          if (img) console.log('✅ Serper resmi:', img.slice(0, 80));
          finish(img);
        } catch { finish(null); }
      });
      res.on('error', () => finish(null));
    });
    req.on('error', () => finish(null));
    req.write(body); req.end();
  });
}

// ─── Ana resim arama: Serper (opsiyonel) — stok foto fallback YOK ─────────────
// Stok foto servisleri (LoremFlickr, Wikipedia) habere özgü görsel vermediğinden kaldırıldı.
// Yalnızca RSS enclosure / og:image kullanılır; görsel yoksa haber atlanır.
async function fetchDuckDuckGoImage(query) {
  // Serper.dev (Google Images) — SERPER_API_KEY varsa kullan
  const serperImg = await fetchSerperImage(query).catch(() => null);
  if (serperImg) { console.log(`🖼 Serper: ${serperImg.slice(0, 80)}`); return serperImg; }
  console.log(`⚠️ Serper görsel bulunamadı: "${query.slice(0, 60)}"`);
  return null;
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

  // YouTube iframe embed — haber siteleri videoları genellikle böyle gömer
  const ytEmbed = html.match(/(?:youtube\.com\/embed\/|youtu\.be\/)([A-Za-z0-9_\-]{11})/i)?.[1];
  if (ytEmbed) return `https://www.youtube.com/watch?v=${ytEmbed}`;

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



// ─── Yardımcı Fonksiyonlar ────────────────────────────────────────────────────

function stripNewsSource(title) {
  // " - Kaynak Adı" veya "| Kaynak" gibi sonekleri kaldır — geniş kaynak listesi
  return (title || '')
    .replace(/\s*[-–|]\s*(Sözcü|T24|Cumhuriyet|Hürriyet|Milliyet|Sabah|HaberTürk|Habertürk|NTV|CNN Türk|TRT|Halk TV|Tele1|BirGün|OdaTV|ANKA|Bianet|Gazete Duvar|Artı Gerçek|KRT|DHA|AA|İHA|Sputnik|BBC|Reuters|AFP|Fox|Fanatik|Sporx|Goal|A Spor|FOTOMAÇ|Fotomaç|Fotospor|Spor Arena|Spor Toto|Aspor|GZT|Gazete Oksijen|Oksijen|sporx|Spor Gazete|İleri Haber|Gerçek Hayat|Gerçekgündem|Dünya|Ekonomim|Bloomberg HT|Dünya Gazetesi|Dünyabülteni|Sabah Spor|Milliyet Spor|Hürriyet Spor|NTV Spor|A Spor|Bein Sports|Fanatik Spor|İnternetHaber|Haberler|Haberturk|Haberler\.com|Takvim|Türkiye|Akşam|Star|Güneş|Posta|Vatan|Radikal|Yeniçağ|Yeni Şafak|Karar|Türk Haber|Haber Global|Flash Haber|24 TV|360|Medyascope|Diken|Dokuz8Haber|Artı TV|Haber Sol|soL Haber|soL|Gerçek Gündem|Sendika|Evrensel|Birgün|Aydınlık|Yurt|Tercüman|Milli Gazete|Yeni Akit)[^|\-]*$/i, '')
    .trim();
}

function cleanTitle(title) {
  let t = (title || '').trim();
  // "Gerçek Haber... 19 Mayıs 2026 İlker Karagöz ile Çalar Saat" → sadece "Gerçek Haber"
  t = t.replace(/\s*\.{2,3}\s*\d{1,2}\s+\w+\s+\d{4}.*$/, '').trim();
  // "Haber Başlığı - Program Adı" veya "- İlker Karagöz ile ..." → sonu kes
  t = t.replace(/\s*[-–|]\s*[A-ZĞÜŞÖÇİa-zğüşöçı]+\s+(?:ile|de|da)\s+.+$/, '').trim();
  // Başta tarih öneki: "19 Mayıs 2026 Haber başlığı" → tarihi çıkar
  t = t.replace(/^\d{1,2}\s+[A-Za-zğüşöçİĞÜŞÖÇı]+\s+\d{4}\s+/, '').trim();
  // Pipe-separated kategori/şehir/kaynak tagleri: "| Trabzon haberleri | Son dakika haberleri"
  // İlk pipe'dan sonrasını tümüyle sil (Google News RSS başlık formatı)
  if (t.includes(' | ')) t = t.split(' | ')[0].trim();
  // Orijinal: sondaki "- kaynak adı" temizle (pipe temizliğinden sonra)
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
  /\bçalar saat\b/i,
  /\bana haber(ler)?\b/i,
  /\bsabah bülteni\b/i,
  /\bhaber kuşağı\b/i,
  /\bhaberleri.*\b\d{4}\b/i,
  /\byayın akışı\b/i,
  /\bkuşak yayın\b/i,
  /^\d{1,2}\s+[A-Za-zğüşöçİĞÜŞÖÇı]+\s+\d{4}\s+[A-ZĞÜŞÖÇİ]/,

  // ─── Magazin / dedikodu / clickbait filtresi ─────────────────────────────
  // Duygusal clickbait kalıpları
  /bakışlarıyla.*vurdu|gözleriyle.*vurdu|vuruldu.*bakış/i,
  /\b(aşk bombası|aşka geldi|aşkını ilan|gönlünü kaptır|gönlünü çald|kalpleri çald)/i,
  /\b(büyük randevu|yasak aşk|gizli aşk|sır aşk)/i,
  /\b(birbirine (girdi|daldı|sardı)|kol kola yakalandı|ele ele görüntülendi)/i,
  /\b(ayrıldığı (ortaya çıktı|iddia)|boşanma kararı|boşandılar|boşanıyor)/i,
  /\b(nişanlandı|evlendi|düğün haberi|evlilik haberi).*magazin/i,
  /\b(hamile (olduğu|kaldığı)|bebek bekliyor|bebek haberi)/i,
  /\bgözler.*üzerine (çevrildi|dikildi)|herkes.*konuşuyor/i,
  // Horoskop / burç içerikleri
  /\b(günlük|haftalık|aylık)\s+(burç|horoskop|astroloji)/i,
  /\bburç\s+(yorumu|tahmin|öngörü)/i,
  // Magazin kaynak etiketleri ile gelen içerik
  /son dakika magazin/i,
  /magazin\s+haberleri?/i,
  // Ünlü ilişki/skandal clickbait
  /\b(ünlü (isim|çift|oyuncu|şarkıcı)).*\b(ihanet|aldatt|şok görüntü|olay görüntü)/i,
  /şok (görüntü|ifade|itiraf|açıklama).*magazin/i,
  // Spor dışı "17'den vurdu" tarzı saçma başlıklar
  /\d+['']?den vurdu/i,
  /\d+\s*yaşında(ki)?\s+(ünlü|oyuncu|şarkıcı|model)/i,
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

// ─── Görsel URL Normalizer — aynı görsel farklı paramla gelmesin ───────────────
function normalizeImageUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    // Boyut, kalite, format parametrelerini at — sadece path kalsın
    const keepParams = [];
    for (const [k, v] of u.searchParams) {
      if (!/^(w|h|width|height|s|size|q|quality|fit|resize|format|thumb|crop|dim|dims)$/i.test(k)) {
        keepParams.push(k + '=' + v);
      }
    }
    return u.origin + u.pathname + (keepParams.length ? '?' + keepParams.join('&') : '');
  } catch {
    // URL parse hatası — query'yi komple at
    return url.split('?')[0];
  }
}

// ─── Canlı Yayın Görseli Filtresi ────────────────────────────────────────────
// "CANLI YAYIN", "SON DAKİKA" overlay'li jenerik thumbnail'leri atar
function isLiveBroadcastImage(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  // Açık canlı yayın URL kalıpları
  if (/canl[iy][-_]?yayin|canliyayin|canli[-_]?tv|live[-_]?stream|live[-_]?broadcast/.test(u)) return true;
  if (/son[-_]?dakika[-_]?cover|breaking[-_]?cover|sd[-_]?kapak|sd[-_]?cover/.test(u)) return true;
  // Türk haber kanallarının bilinen yolu: /canli/ klasörü
  if (u.includes('/canli/') && /\.(jpg|jpeg|png|webp)/i.test(u)) return true;
  // ntv/cnn/haberturk vb. canlı yayın görselleri
  if (/(ntv|cnnturk|haberturk|trtworld|trthaber|a2tv|teve2|fox[-_]?tv|showtv|atv|kanal[d7]|bloomberg|360tv)[./].*canl/i.test(u)) return true;
  // "canli" kelimesi path segmentinde
  if (/\/canli[-_]|[-_]canli\//.test(u)) return true;
  // Canlı yayın / stream içeriği belirten genel kalıplar
  if (/\/live\//i.test(u) && /\.(jpg|jpeg|png|webp)/i.test(u)) return true;
  if (/\/stream\//i.test(u) && /\.(jpg|jpeg|png|webp)/i.test(u)) return true;
  if (/\/tv[-_]stream|stream[-_]thumb|live[-_]thumb|thumb[-_]live/.test(u)) return true;
  // Yaygın Türk TV kanalı CDN'leri — tüm alt yollar
  if (/(star[-_]?tv|show[-_]?tv|fox[-_]?tv|tgrt|ulusal|halk[-_]?tv|krt|tele[-_]?1|cem[-_]?tv|beyaz[-_]?tv|24[-_]?tv|artı[-_]?1|tv[-_]?100)[./]/.test(u)
      && /(canl|live|stream|yayin)/i.test(u)) return true;
  // Bilinen canlı yayın görsel isimleri
  if (/\/(canli|live|yayin|broadcast)([-_.]|$)/.test(u) && /\.(jpg|jpeg|png|webp)/i.test(u)) return true;
  // YouTube canlı yayın thumbnail işaretleri
  if (/ytimg\.com.*\/vi\//.test(u) && /hqdefault|maxresdefault/.test(u) && /live/i.test(u)) return true;
  return false;
}

// Başlık bazlı canlı yayın tespiti — URL filtresi yakalamasa bile
function isGenericOrLive(url) {
  if (!url) return true;
  if (isLiveBroadcastImage(url)) return true;
  const u = url.toLowerCase();
  return /logo|default|og[-_]default|share[-_]img|twitter[-_]card|social[-_]share|placeholder|noimage|no[-_]image|banner[-_]default|favicon|icon[-_]|[-_]icon\.|opengraph[-_]default/i.test(u);
}

function isLiveBroadcastTitle(title) {
  if (!title) return false;
  return /\bcanl[iı]\s*(yayin|yayını?|anlatim|bağlantı|yayın)|\blive\s*stream|\bcanl[iı]\b.*\byayin/i.test(title);
}


function upgradeImageUrl(url) {
  if (!url) return url;
  let u = url;
  // ── Query param boyut temizliği ──────────────────────────────────────
  // Boyut parametrelerini sil (w, h, width, height, s, size, resize vb.)
  u = u.replace(/([?&])(w|h|width|height|s|size|resize|fit|crop|thumb|thumbnail|dim|dims|maxw|maxh|wid|hei)=[\d,x]+/gi, (_, sep) => sep);
  // Kalite parametresini yüksek tut (q, quality, qual)
  u = u.replace(/([?&])(?:q|quality|qual)=\d+/gi, '$1q=95');
  // format=webp veya format=jpg bırak, format=thumb kaldır
  u = u.replace(/([?&])format=(?:thumb|thumbnail|small|low|preview)/gi, (_, sep) => sep);
  // Temizlik: ?& && sondaki ? veya &
  u = u.replace(/[?&]([?&])+/g, (m) => m[0]).replace(/[?&]$/g, '');
  // Boş soru işareti/& kaldır
  u = u.replace(/[?&]$/, '');

  // ── Path tabanlı boyut temizliği (Türk CDN'leri) ────────────────────
  // /144x81/ /300x200/ /800x600/ → orijinal yol
  u = u.replace(/\/\d{2,4}x\d{2,4}\//gi, '/');
  // _144x81.jpg  -300x200.jpg → .jpg
  u = u.replace(/[_-]\d{2,4}x\d{2,4}(\.(jpg|jpeg|png|webp|gif))/gi, '$1');
  // _144w.jpg  _80h.jpg tek-boyut soneki → .jpg
  u = u.replace(/[_-]\d{2,4}[wh](\.(jpg|jpeg|png|webp|gif))/gi, '$1');
  // /144/ veya /80/ gibi tek sayıdan oluşan CDN path segmenti → /
  u = u.replace(/\/(\d{2,4})\//g, (m, n) => (parseInt(n) <= 1200 ? '/' : m));
  // /w_144/ /w144/ /h_80/ CDN kalıpları → /
  u = u.replace(/\/[wh]_?\d{2,4}\//gi, '/');
  // /thumb/ /small/ /medium/ /low/ /preview/ /thumbnail/ → /
  u = u.replace(/\/(thumb|small|medium|low|preview|thumbnail|mini|tiny|crop)\//gi, '/');
  // /original/ /large/ /full/ /high/ → zaten büyük, bırak

  // ── YouTube kalite yükseltme ─────────────────────────────────────────
  u = u.replace(/\/(hqdefault|mqdefault|sddefault|default)\.jpg/, '/maxresdefault.jpg');

  // ── Sabah/NTV/Haberler tipi CDN kalıpları ────────────────────────────
  // ia.sabah.com.tr/thumb/144/81/... → /thumb/0/0/...
  u = u.replace(/(sabah\.com\.tr\/thumb\/?)\d+\/\d+\//, '$10/0/');
  // Haberler.com / Cumhuriyet: resize/144x81/ veya /144x81/ kaldır
  u = u.replace(/\/resize\/[\d]+x[\d]+\//gi, '/');
  // Sözcü / T24 CDN: /DosyaUpload/144/ → /DosyaUpload/
  u = u.replace(/(DosyaUpload|upload|Upload)\/\d+\//g, '$1/');
  // Milliyet / Hurriyet: /s144x81.jpg → .jpg
  u = u.replace(/\/s\d{2,4}x\d{2,4}(\.(jpg|jpeg|png|webp))/gi, '$1');

  return u;
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
      // api.cobalt.tools JWT gerektiriyor (2026+), devre dışı
      'https://cobalt.api.timelessnesses.me',
      'https://cobalt-api.kwiatekmiki.com',
      'https://cobalt.tools',
    ];

  // cobalt v10+ API formatı
  const bodyV10 = JSON.stringify({
    url: videoUrl,
    videoQuality: '720',
    downloadMode: 'auto',
    youtubeVideoCodec: 'h264',
    audioBitrate: '128',
    filenameStyle: 'classic',
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
        rejectUnauthorized: false,
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
    'android_testsuite',
    'android',
    'tv_embedded',
    'ios',
    'mweb',
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
          console.log(`⚠️ yt-dlp -g [${client}] hata: ${stderr.slice(-150)}`);
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

// ── 5. YouTube video gönder: yt-dlp -g önce (hızlı), tam indirme son çare ──
async function sendYouTubeVideoSmart(channelId, videoUrl, caption) {
  const videoId =
    videoUrl.match(/[?&]v=([^&]+)/)?.[1] ||
    videoUrl.match(/youtu\.be\/([^?]+)/)?.[1] ||
    videoUrl.match(/shorts\/([^?/]+)/)?.[1];

  if (!videoId) { console.log('❌ YouTube video ID çıkarılamadı'); return false; }
  console.log(`🎬 YouTube gönderme: ${videoId}`);

  // 1. yt-dlp -g → stream URL (hızlı, indirme yok, Telegram kendi alır)
  console.log('1️⃣ yt-dlp -g stream URL deneniyor...');
  const streamUrl = await getYtdlpStreamUrl(videoUrl);
  if (streamUrl) {
    const ok = await sendVideoByUrl(channelId, streamUrl, caption);
    if (ok) { console.log('✅ yt-dlp stream URL ile gönderildi!'); return true; }
    console.log('⚠️ Stream URL Telegram tarafından reddedildi, indirmeye geçiliyor...');
  } else {
    console.log('⚠️ yt-dlp -g başarısız');
  }

  // 2. Invidious stream URL (Railway'den Telegram'a URL ver)
  console.log('2️⃣ Invidious stream URL deneniyor...');
  const invUrl = await getInvidiousStreamUrl(videoId);
  if (invUrl) {
    const ok = await sendVideoByUrl(channelId, invUrl, caption);
    if (ok) { console.log('✅ Invidious stream ile gönderildi!'); return true; }
    console.log('⚠️ Invidious URL Telegram tarafından reddedildi');
  } else {
    console.log('⚠️ Invidious URL alınamadı');
  }

  // 3. yt-dlp tam indirme — farklı player client'larla dene
  console.log('3️⃣ yt-dlp tam indirme deneniyor...');
  tgLog('⬇️ YouTube video indiriliyor...');
  for (const client of ['android_testsuite', 'android', 'tv_embedded', 'ios', 'mweb']) {
    console.log(`   client: ${client}`);
    const filePath = await downloadWithYtdlp(videoUrl, client);
    if (filePath) {
      try {
        const ok = await sendVideoFile(channelId, filePath, caption);
        try { fs.rmSync(path.dirname(filePath), { recursive: true, force: true }); } catch {}
        if (ok) { tgLog('✅ Video gönderildi!'); return true; }
      } catch (e) {
        try { fs.rmSync(path.dirname(filePath), { recursive: true, force: true }); } catch {}
      }
    }
  }

  // 4. Invidious tam indirme (son çare)
  console.log('4️⃣ Invidious tam indirme deneniyor...');
  const invFile = await downloadFromInvidious(videoId);
  if (invFile) {
    try {
      const ok = await sendVideoFile(channelId, invFile, caption);
      try { fs.rmSync(path.dirname(invFile), { recursive: true, force: true }); } catch {}
      if (ok) { return true; }
    } catch {
      try { fs.rmSync(path.dirname(invFile), { recursive: true, force: true }); } catch {}
    }
  }

  console.log('❌ YouTube: tüm yöntemler başarısız');
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

// YouTube video indirme: yt-dlp → Invidious
async function downloadYoutubeVideo(videoUrl) {
    console.log(`🎬 YouTube indiriliyor: ${videoUrl.slice(0, 60)}`);

    const videoId =
      videoUrl.match(/[?&]v=([^&]+)/)?.[1] ||
      videoUrl.match(/youtu\.be\/([^?]+)/)?.[1] ||
      videoUrl.match(/shorts\/([^?/]+)/)?.[1];

    if (!videoId) { console.error('❌ Video ID çıkarılamadı'); return null; }

    // 1. yt-dlp farklı player client'larla dene
    for (const client of ['android_testsuite', 'android', 'tv_embedded', 'ios', 'mweb']) {
      console.log(`🔄 yt-dlp client=${client} deniyor...`);
      const filePath = await downloadWithYtdlp(videoUrl, client);
      if (filePath) { console.log(`✅ yt-dlp başarılı (${client})`); return filePath; }
    }

    // 2. Invidious proxy (yedek)
    console.log(`🔄 Invidious indirme deniyor...`);
    const invFile = await downloadFromInvidious(videoId);
    if (invFile) return invFile;

    console.error('❌ Tüm yöntemler başarısız (yt-dlp + Invidious)');
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
    // Sadece URL ile Telegram'a gönder — indirme yok (Railway'de bloke oluyor)
    try {
      await bot.sendVideo(channelId, videoUrl, opts());
      console.log('✅ Web video URL ile gönderildi');
      return true;
    } catch (err) {
      console.log(`⚠️ Web video URL ile gönderilemedi: ${err.message?.slice(0, 60)}`);
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

  // Düz rotasyon — sadece web feed'leri
  const idx = currentFeedIndex % pool.length;
  currentFeedIndex++;
  return pool[idx];
}

// Aktif kategorinin feed listesini döndür (döngü sayacı için)
function getActivePool() {
  const cat = settings.activeCategory;
  if (cat === 'hepsi') return RSS_FEEDS;
  const exact = RSS_FEEDS.filter((f) => f.category === cat);
  const general = RSS_FEEDS.filter((f) => f.category === 'genel');
  // Hem kategori feedleri hem genel feedler — genel feedlerde keyword filtresi uygulanır
  const pool = [...exact, ...general.filter(g => !exact.find(e => e.url === g.url))];
  return pool.length > 0 ? pool : RSS_FEEDS;
}

async function fetchFeedXml(url, maxRedirects = 5) {
  let currentUrl = url;
  for (let hop = 0; hop < maxRedirects; hop++) {
    const result = await new Promise((resolve, reject) => {
      const mod = currentUrl.startsWith('https') ? https : http;
      const req = mod.get(currentUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0', Accept: 'application/rss+xml,application/xml,text/xml,*/*' },
        rejectUnauthorized: false,
      }, (resp) => {
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
          resp.destroy();
          const loc = resp.headers.location;
          resolve({ redirect: loc.startsWith('http') ? loc : new URL(loc, currentUrl).href });
        } else if (resp.statusCode >= 200 && resp.statusCode < 300) {
          const chunks = [];
          resp.on('data', c => chunks.push(c));
          resp.on('end', () => resolve({ xml: Buffer.concat(chunks).toString('utf8') }));
          resp.on('error', reject);
        } else {
          resp.destroy();
          reject(new Error(`HTTP ${resp.statusCode}`));
        }
      });
      req.on('error', reject);
      req.setTimeout(6000, () => { req.destroy(); reject(new Error('timeout')); });
    });
    if (result.redirect) { currentUrl = result.redirect; continue; }
    return result.xml;
  }
  throw new Error('Too many redirects');
}

async function fetchFeed(feed) {
  try {
    let xml = await fetchFeedXml(feed.url);
    // Bozuk RSS feed'lerindeki geçersiz XML entity'leri düzelt
    xml = xml.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/g, '&amp;');
    const result = await parser.parseString(xml);
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
    .replace(/\b(iha|dha|aa|anka|ntv|trt|cnn türk?|sözcü|hürriyet|milliyet|cumhuriyet|haberturk|habertürk|halk tv?|krt tv?|sol haber|soL)\b/gi, '')
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
  if (publishNowInProgress) {
    if (Date.now() - publishNowStartTime > 2 * 60 * 1000) {
      console.log('⚠️ publishNowInstant: kendi kilidi 2dk+ aştı, zorla sıfırlanıyor.');
      publishNowInProgress = false;
    } else {
      console.log('⏭ publishNowInstant: zaten çalışıyor, atlanıyor.');
      return '⏳ Şu an haber aranıyor, lütfen 30 saniye bekleyin.';
    }
  }
  publishNowInProgress = true;
  publishNowStartTime = Date.now();
  try {
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
        // Aktif kategoriye uyan haberler — hepsi veya video seçiliyse filtre yok
        if (!['hepsi', 'video'].includes(cat)) {
          // Feed zaten doğru kategorideyse keyword kontrolü atla
          if (feed.category !== cat) {
            const desc = a.contentSnippet || a.summary || a.content || a.description || '';
            if (!matchesActiveCategory(t, desc, cat)) return false;
          }
        }
        return true;
      })
      .slice(0, 10);

    if (candidates.length === 0) { tgLog(`⏭ ${feed.label}: uygun içerik yok`); continue; }
    tgLog(`🔍 ${feed.label}: ${candidates.length} aday bulundu`);

    for (const item of candidates) {
      const url = item.link || item.guid;
      const { title, rawDesc, description, prefix } = buildItemMeta(item, feed);
      const sourceName = feed.source || '';
      tgLog(`📌 Deneniyor: "${title.slice(0, 80)}"`);

      // caption ogMeta çekildikten sonra oluşturulur (rawDesc genelde boş gelir)
      const catTag = detectCategory(title, rawDesc);
      const catEmoji = catTag ? `${catTag} ` : '';
      let caption = ''; // aşağıda doldurulur

      let sentType = 'none';

      try {
        // ═══ Google News → gerçek URL ════════════════════════════════════
        let realUrl = url;
        if (url.includes('news.google.com')) {
          tgLog(`🔗 URL çözülüyor...`);
          realUrl = (await resolveGoogleNewsUrl(url)) || url;
          tgLog(`🔗 → ${realUrl.slice(0, 80)}`);
        }

        // ═══ OG meta + DDG resim paralel çek ═══════════════════════════
        tgLog(`🖼 Görsel aranıyor...`);
        const rssMedia = extractMedia(item);
        const [ogMeta, ddgImgPrefetch] = await Promise.all([
          fetchOgMeta(realUrl).catch(() => ({ image: null, image2: null, description: null, articleBody: null })),
          fetchDuckDuckGoImage(title).catch(() => null),
        ]);
        // Caption oluştur
        { const bestD = ogMeta.description || rawDesc || description; const aiS = await summarizeNews(title, bestD, ogMeta.articleBody || null).catch(() => null); caption = stripLinks(`${prefix}${catEmoji}${title}`); if (aiS && aiS.length > 5) caption += `\n\n${cleanArrows(stripLinks(stripSourceDate(aiS)))}`; if (caption.length > 1024) caption = caption.slice(0, 1021) + '…'; }
        if (rssMedia.url) rssMedia.url = upgradeImageUrl(rssMedia.url);
        // Başlıkta "CANLI YAYIN" varsa görsel almayalım
        if (isLiveBroadcastTitle(title)) {
          rssMedia.type = null; rssMedia.url = null;
          console.log(`🚫 Canlı yayın başlığı — görsel atlandı: ${title.slice(0,60)}`);
        }
        let ogImg = ogMeta.image ? upgradeImageUrl(ogMeta.image) : (rssMedia.type === 'image' ? rssMedia.url : null);
        // og:image da canlı yayın filtresi
        if (ogImg && isLiveBroadcastImage(ogImg)) { console.log(`🚫 og:image canlı yayın — atlandı: ${ogImg.slice(0,60)}`); ogImg = null; }
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
          const _ogImg2 = ogImg2 && normalizeImageUrl(ogImg2) !== normalizeImageUrl(ogImg) ? ogImg2 : null;
          if (_ogImg2) {
            try {
              await bot.sendMediaGroup(CHANNEL_ID, [
                { type: 'photo', media: ogImg, caption },
                { type: 'photo', media: _ogImg2 },
              ]);
              sentType = 'image'; mediaStats.image++;
            } catch (e1) {
              tgLog(`⚠️ Media group hata: ${e1.message?.slice(0,80)}, tek foto deneniyor...`);
              try { await bot.sendPhoto(CHANNEL_ID, ogImg, { caption }); sentType = 'image'; mediaStats.image++; }
              catch (e2) {
                tgLog(`⚠️ URL foto başarısız, buffer deneniyor...`);
                const buf4a = await downloadImageBuffer(ogImg).catch(() => null);
                if (buf4a) {
                  try { await bot.sendPhoto(CHANNEL_ID, buf4a, { caption }); sentType = 'image'; mediaStats.image++; }
                  catch { tgLog(`❌ Buffer foto da gönderilemedi: ${e2.message?.slice(0,100)}`); }
                } else { tgLog(`❌ Foto gönderilemedi: ${e2.message?.slice(0,100)}`); }
              }
            }
          } else {
            try { await bot.sendPhoto(CHANNEL_ID, ogImg, { caption }); sentType = 'image'; mediaStats.image++; }
            catch (e) {
              tgLog(`⚠️ URL foto başarısız, buffer deneniyor...`);
              const buf4b = await downloadImageBuffer(ogImg).catch(() => null);
              if (buf4b) {
                try { await bot.sendPhoto(CHANNEL_ID, buf4b, { caption }); sentType = 'image'; mediaStats.image++; }
                catch { tgLog(`❌ Buffer foto da gönderilemedi: ${e.message?.slice(0,100)}`); }
              } else { tgLog(`❌ Foto gönderilemedi: ${e.message?.slice(0,100)}`); }
            }
          }
        }

        // ═══ 5. Görsel yok → DuckDuckGo → atla (metin ASLA) ════════════
          if (sentType === 'none') {
            const ddgImg = ddgImgPrefetch || await fetchDuckDuckGoImage(title).catch(() => null);
            if (ddgImg) tgLog('🔎 DDG görseli kullanılıyor: ' + title.slice(0,40));
            if (ddgImg) {
              try {
                await bot.sendPhoto(CHANNEL_ID, ddgImg, { caption });
                sentType = 'image';
                mediaStats.image = (mediaStats.image || 0) + 1;
                tgLog('🖼 DDG görseli gönderildi');
              } catch (e) {
                tgLog('❌ DDG görseli reddedildi: ' + (e.message || '').slice(0,60));
              }
            }
            if (sentType === 'none') {
              tgLog('⏭ Görsel bulunamadı — sıradaki habere geçiliyor');
            }
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
  } finally {
    publishNowInProgress = false;
  }
}

let publishingInProgress = false;
let publishingStartTime = 0;
const PUBLISHING_TIMEOUT_MS = 2 * 60 * 1000; // 2 dakika sonra otomatik sıfırla
let publishNowInProgress = false;
let publishNowStartTime = 0;

  async function publishNextNews() {
    if (publishingInProgress) {
      if (Date.now() - publishingStartTime > PUBLISHING_TIMEOUT_MS) {
        console.log('⚠️ Yayın döngüsü 5 dakikayı aştı, zorla sıfırlanıyor.');
        publishingInProgress = false;
      } else {
        console.log('⏭ Önceki yayın döngüsü devam ediyor, atlanıyor.');
        return;
      }
    }
    publishingInProgress = true;
    publishingStartTime = Date.now();
    try {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('publishNextNews 2dk timeout')), 2 * 60 * 1000)
      );
      await Promise.race([_publishNextNewsInner(), timeout]);
    } catch (e) {
      console.error('⚠️ publishNextNews hata/timeout:', e.message);
    } finally {
      publishingInProgress = false;
    }
  }

  async function _publishNextNewsInner() {
    if (settings.paused) { console.log('⏸ Bot duraklatıldı.'); return; }
  if (!isWithinPublishHours()) {
    const start = String(settings.publishStartHour).padStart(2,'0');
    const end = String(settings.publishEndHour).padStart(2,'0');
    console.log(`🕐 Yayın saati dışında (${start}:00-${end}:00), atlanıyor.`);
    return;
  }

  // Bir feed boş gelirse sıradakine geç — aktif kategorideki tüm feedleri dene
  const needed = getNeededMediaType();
  let feed, items, validItems;
  // Her çağrıda pool'u karıştır — aynı kaynak hep ilk seçilmesin
  const activePool = [...getActivePool()].sort(() => Math.random() - 0.5);

  const maxTry = Math.min(5, activePool.length);
  // Feedleri paralel çek — sıralı bekleme yerine hepsi aynı anda başlasın
  const feedBatch = activePool.slice(0, maxTry);
  console.log(`📡 ${feedBatch.length} feed paralel çekiliyor... (kategori: ${settings.activeCategory})`);
  const batchResults = await Promise.allSettled(
    feedBatch.map(f => fetchFeed(f).then(its => ({ feed: f, items: its })))
  );
  for (const res of batchResults) {
    if (res.status !== 'fulfilled') continue;
    feed = res.value.feed;
    items = res.value.items;
    const withUrl = items.filter((a) => a.link || a.guid);
    const notPublished = withUrl.filter((a) => !publishedUrls.has(a.link || a.guid));
    const valid = notPublished.filter((a) => {
      if (!isValidNewsItem(a, feed)) return false;
      if (settings.activeCategory !== 'hepsi' && feed.category === settings.activeCategory) return true;
      const desc = a.contentSnippet || a.summary || a.content || a.description || '';
      return matchesActiveCategory(a.title, desc, settings.activeCategory);
    });
    console.log(`🔎 ${feed.source}: toplam=${items.length} yeni=${notPublished.length} geçerli=${valid.length}`);
    validItems = sortByNeededMedia(valid, needed);
    if (validItems.length > 0) { break; }
  }
  // shuffle zaten rotasyonu sağlar
  if (!validItems || validItems.length === 0) {
    console.log(`ℹ️ Tüm feedler denendi, yeni haber bulunamadı.`);
    return;
  }


  // ── YouTube haberi ──────────────────────────────────────────────────────────
  // ── Normal haber — medyalı öğe bul (max 10 deneme) ────────────────────────
  const MAX_TRIES = 10;
  let chosenItem = null;
  let chosenMedia = { type: null, url: null };
  let chosenMedia2 = null;
  let chosenOgDesc = null;
  let chosenArticleBody = null;
  let chosenCandidateUrl = null; // Çözülmüş asıl URL (Google News decode sonrası)
  let textFallbackItem = null;   // Medya bulunamazsa metin olarak gönderilecek ilk geçerli haber

  for (let i = 0; i < Math.min(MAX_TRIES, validItems.length); i++) {
    const candidate = validItems[i];
    const rawCandidateUrl = candidate.link || candidate.guid;

    // İlk geçerli haberi metin fallback olarak sakla
    if (!textFallbackItem) textFallbackItem = candidate;

    // Google News URL'lerini önce decode et
    let candidateUrl = rawCandidateUrl;
    if (rawCandidateUrl.includes('news.google.com')) {
      candidateUrl = (await Promise.race([
        resolveGoogleNewsUrl(rawCandidateUrl),
        new Promise((_, rej) => setTimeout(() => rej(new Error('resolveGoogleNews 15s timeout')), 15000))
      ]).catch(() => null)) || rawCandidateUrl;
      if (candidateUrl !== rawCandidateUrl) {
        console.log(`🔓 Çözüldü: ${candidateUrl.slice(0, 80)}`);
        // ── Tekrar engeli: çözümlenmiş URL zaten yayınlandıysa bu kandidatı atla ──
        if (publishedUrls.has(candidateUrl)) {
          publishedUrls.add(rawCandidateUrl);
          persistPublishedUrls();
          console.log(`⏭ Tekrar engellendi (çözümlenmiş URL): ${candidateUrl.slice(0, 60)}`);
          continue;
        }
        // Çözülmüş URL'yi de hemen engelle (aynı haber farklı wrapper ile gelmesin)
        publishedUrls.add(candidateUrl);
      }
    }

    let media = extractMedia(candidate);
    if (media.url) { media.url = upgradeImageUrl(media.url); }
    // Başlıkta canlı yayın varsa görseli temizle
    const _cTitle = candidate.title || '';
    if (isLiveBroadcastTitle(_cTitle) || (media.url && isLiveBroadcastImage(media.url))) {
      console.log(`🚫 Canlı yayın (başlık/url) — görsel silindi: ${_cTitle.slice(0,60)}`);
      media = { type: null, url: null };
    }

    // Web sayfasından video çıkar (30s timeout)
    if (!media.url || media.type !== 'video') {
      const webVid = await Promise.race([
        fetchArticleHtmlAndExtractVideo(candidateUrl),
        new Promise((_, rej) => setTimeout(() => rej(new Error('fetchArticle 30s timeout')), 30000))
      ]).catch(() => null);
      if (webVid) { media = { type: 'video', url: webVid }; console.log(`🎬 Web video: ${webVid.slice(0, 60)}`); }
    }

    // OG meta çek (görsel + açıklama) (25s timeout)
    const ogMeta = await Promise.race([
      fetchOgMeta(candidateUrl),
      new Promise((_, rej) => setTimeout(() => rej(new Error('fetchOgMeta 25s timeout')), 25000))
    ]).catch(() => ({}));
    if (ogMeta.description && !chosenOgDesc) chosenOgDesc = ogMeta.description;
    if (ogMeta.articleBody && !chosenArticleBody) chosenArticleBody = ogMeta.articleBody;

    // og:image varsa logo/default görselleri filtrele — makaleye özgü olmayan görselleri reddet
    if (!media.url && ogMeta.image) {
      const imgLower = ogMeta.image.toLowerCase();
      const isGenericSiteImage = /logo|default|og[-_]default|share[-_]img|twitter[-_]card|social[-_]share|placeholder|noimage|no[-_]image|banner[-_]default|favicon|icon[-_]|[-_]icon\.|opengraph[-_]default/i.test(imgLower);
      if (!isGenericSiteImage && !isLiveBroadcastImage(ogMeta.image)) {
        media = { type: 'image', url: upgradeImageUrl(ogMeta.image) };
      } else {
        console.log(`🚫 Logo/default/canlı yayın görseli atlandı: ${ogMeta.image.slice(0, 60)}`);
      }
    }

    if (media.type === 'image' && !chosenMedia2 && ogMeta.image2) {
      chosenMedia2 = upgradeImageUrl(ogMeta.image2);
    }

    if (media.url) {
      chosenItem = candidate;
      chosenMedia = media;
      chosenCandidateUrl = candidateUrl;
      break;
    }
  }

  // Medya bulunamazsa ilk geçerli haberi metin olarak gönder (atlamak yerine)
  if (!chosenMedia.url) {
    if (!textFallbackItem) {
      console.log(`⏭ [${feed.source}] Haber bulunamadı, atlanıyor.`);
      return;
    }
    console.log(`📝 [${feed.source}] Medya yok — metin olarak gönderiliyor.`);
    chosenItem = textFallbackItem;
    chosenCandidateUrl = textFallbackItem.link || textFallbackItem.guid;
  }

  if (!chosenItem) return;

  const url = chosenItem.link || chosenItem.guid;
  const { title: checkTitle2 } = buildItemMeta(chosenItem, feed);
  if (isTitleDuplicate(checkTitle2)) {
    console.log(`⏭ Başlık zaten yayınlandı (session): ${checkTitle2.slice(0, 40)}`);
    return;
  }

  // RSS URL ve çözülmüş asıl URL'nin ikisini de engelle (farklı wrapper'larla tekrar gelmesin)
  publishedUrls.add(url);
  if (chosenCandidateUrl && chosenCandidateUrl !== url) publishedUrls.add(chosenCandidateUrl);
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
    caption += `\n\n${cleanArrows(stripLinks(stripSourceDate(aiSummary)))}`;
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
      let webSent = false;
      if (/youtube\.com|youtu\.be/i.test(chosenMedia.url)) {
        webSent = await sendYouTubeVideoSmart(CHANNEL_ID, chosenMedia.url, caption);
      } else {
        webSent = await sendWebVideo(CHANNEL_ID, chosenMedia.url, caption, replyToId);
      }
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
      // İki görsel varsa — aynı görselse tek gönder
      const _img2 = chosenMedia2 && normalizeImageUrl(chosenMedia2) !== normalizeImageUrl(chosenMedia.url) ? chosenMedia2 : null;
      if (_img2) {
        try {
          const mediaGroup = [
            { type: 'photo', media: chosenMedia.url, caption, parse_mode: undefined },
            { type: 'photo', media: _img2 },
          ];
          const msgs = await bot.sendMediaGroup(CHANNEL_ID, mediaGroup, replyToId ? { reply_parameters: { message_id: replyToId, allow_sending_without_reply: true } } : {});
          sentMsg = msgs?.[0] || null;
          sentType = 'image';
          console.log('📸📸 İki görsel (media group) gönderildi');
        } catch {
          sentMsg = await bot.sendPhoto(CHANNEL_ID, chosenMedia.url, sendOpts({ caption }));
          sentType = 'image';
        }
      } else {
        sentMsg = await bot.sendPhoto(CHANNEL_ID, chosenMedia.url, sendOpts({ caption }));
        sentType = 'image';
      }
    } else {
        // Medya yok → DDG görsel dene → atla (metin ASLA)
        const ddgImg2 = await fetchDuckDuckGoImage(title).catch(() => null);
        if (ddgImg2) {
          try {
            sentMsg = await bot.sendPhoto(CHANNEL_ID, ddgImg2, sendOpts({ caption }));
            sentType = 'image';
            console.log('🖼 DDG görseli gönderildi (inner)');
          } catch (e) {
            console.log('❌ DDG reddedildi: ' + (e.message || '').slice(0,60));
            sentType = 'skip';
          }
        } else {
          sentType = 'skip';
          console.log('⏭ Görsel bulunamadı — haber atlandı');
        }
    }
  } catch (e) {
    console.error(`❌ [${feed.source}] Gönderim hatası: ${e?.message || e}`);
  }

  if (sentType === 'skip') return null;

  if (sentType === 'video') mediaStats.video = (mediaStats.video || 0) + 1;
  else mediaStats.image = (mediaStats.image || 0) + 1;

  console.log(`✅ [${feed.source}] [${sentType}] ${title.slice(0, 60)}`);

  if (sentMsg?.message_id) {
    registerSentMessage(sentMsg.message_id, title);
    await tryPin(sentMsg.message_id).catch(() => {});
  }

  await notifyFilterUsers(title, rawDesc, url).catch(() => {});

  return null;
}


  // ─── Google News URL Base64 Decoder ──────────────────────────────────────────
  function decodeGoogleNewsUrl(googleUrl) {
    try {
      // Google News RSS URL'lerinin encoded kısmını çöz
      const match = googleUrl.match(/articles\/(CBM[^?&\s]+)/);
      if (!match) return null;
      const encoded = match[1];
      // Base64url decode
      const buf = Buffer.from(encoded, 'base64url');
      const decoded = buf.toString('utf-8');
      // İçinden http/https URL bul
      const urlMatch = decoded.match(/(https?:\/\/[^\s\x00-\x1f\x7f-\xff]+)/);
      if (!urlMatch) return null;
      const url = urlMatch[1].replace(/[\x00-\x1f\x7f-\xff]+.*$/, '').trim();
      return url.startsWith('http') ? url : null;
    } catch {
      return null;
    }
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
  if (isCheckingBreaking) { console.log('⏳ Son dakika zaten kontrol ediliyor, atlandı'); return; }

  const nowMs = Date.now();
  if (nowMs - lastBreakingNewsTime < BREAKING_MIN_GAP_MS) {
    const rem = Math.round((BREAKING_MIN_GAP_MS - (nowMs - lastBreakingNewsTime)) / 1000);
    console.log(`⏳ Son dakika bekleniyor: ${rem}sn`);
    return;
  }

  isCheckingBreaking = true;

  // BREAKING_NEWS_FEEDS + ana muhalif feedlerden son dakika kelimesi içerenleri de tara
  const allBreakingFeeds = [
    ...BREAKING_NEWS_FEEDS,
    ...RSS_FEEDS.filter(f => ['politika', 'genel'].includes(f.category) && f.type !== 'youtube'),
  ];

  for (const feed of allBreakingFeeds) {
    try {
      const items = await fetchFeed(feed);
      const TWO_H_MS = 2 * 60 * 60 * 1000;
      const newItems = items.filter(item => {
        const u = item.link || item.guid;
        if (!u) return false;
        // Son 2 saat filtresi — pubDate yoksa isoDate fallback, her ikisi de yoksa atla
        const rawTs = item.pubDate || item.isoDate;
        const itemTs = rawTs ? new Date(rawTs).getTime() : 0;
        if (!itemTs || isNaN(itemTs) || Date.now() - itemTs > TWO_H_MS) return false;
        // breakingPublishedUrls: in-memory session engeli
        if (breakingPublishedUrls.has(u)) return false;
        // publishedUrls: DB'ye kalıcı kaydedilen — restart/temizlik sonrası da engeller
        if (publishedUrls.has(u)) return false;
        const isBreakingFeed = BREAKING_NEWS_FEEDS.some(bf => bf.url === feed.url);
        if (!isValidNewsItem(item, feed)) return false;
        // Özel son dakika feedlerinde başlık filtresi zorunlu değil (zaten SD içerik)
        // Normal feedlerden gelenler için başlık kontrolü zorunlu
        if (!isBreakingFeed && !isBreakingNews(item.title || '')) return false;
        return true;
      });

      // Feed başına 3 item dene — ilki başarısız olursa sıradaki denensin
      for (const item of newItems.slice(0, 3)) {
        const url = item.link || item.guid;
        const { title: checkTitle } = buildItemMeta(item, feed);
        if (isTitleDuplicate(checkTitle)) continue;

        // Sadece bu session'da tekrar göndermeyi engelle — başarılı gönderim sonrası kalıcı işaretlenecek
        breakingPublishedUrls.add(url);

        const { title, rawDesc } = buildItemMeta(item, feed);
        const sourceName = feed.source || '';
        const categoryTag = detectCategory(title, rawDesc);
        const catEmoji = categoryTag ? `${categoryTag} ` : '';
        let caption = '';
        let sentMsg = null;
        let sentType = 'text';

        try {
          let realUrl = url;
          if (url.includes('news.google.com')) {
            realUrl = (await resolveGoogleNewsUrl(url)) || url;
          }

          // OG meta + AI özeti (ogMeta hem caption hem resim için cache'lendi — tek çağrı)
          const ogMeta = await fetchOgMeta(realUrl).catch(() => ({}));
          const bestD = ogMeta.description || rawDesc || '';
          const aiS = await summarizeNews(title, bestD, ogMeta.articleBody || null);
          caption = stripLinks(`🚨 SON DAKİKA\n\n${catEmoji}${title}`);
          // Özet başlıkla aynı veya çok benzerse ekleme (Google News RSS'te sık karşılaşılan durum)
          if (aiS && aiS.length > 5) {
            const normTitle = title.toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
            const normAiS = aiS.toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
            const isSameAsTitle = normAiS.includes(normTitle) || normTitle.includes(normAiS);
            if (!isSameAsTitle) caption += `\n\n${cleanArrows(stripLinks(stripSourceDate(aiS)))}`;
          }
          if (caption.length > 1024) caption = caption.slice(0, 1021) + '…';

          // Haber sitesinden video — 20s timeout
          if (!realUrl.includes('news.google.com')) {
            const ok = await Promise.race([
              sendArticleVideoSmart(CHANNEL_ID, realUrl, caption).catch(() => false),
              new Promise(r => setTimeout(() => r(false), 20000)),
            ]);
            if (ok) { sentType = 'video'; mediaStats.video++; }
          }

          // YouTube araması — 15s timeout
          if (sentType !== 'video' && sourceName) {
            const ytId = await Promise.race([
              searchYouTubeByTitle(title, sourceName).catch(() => null),
              new Promise(r => setTimeout(() => r(null), 15000)),
            ]);
            if (ytId) {
              const ok = await sendYouTubeVideoSmart(CHANNEL_ID, `https://www.youtube.com/watch?v=${ytId}`, caption);
              if (ok) { sentType = 'video'; mediaStats.video++; }
            }
          }

          // Resim (cache'li ogMeta kullan — tekrar çekme)
          if (sentType !== 'video') {
            const rssMedia = extractMedia(item);
            if (rssMedia.url) rssMedia.url = upgradeImageUrl(rssMedia.url);
            // Canlı yayın filtresi — son koruma katmanı
            const rawImg1 = ogMeta.image ? upgradeImageUrl(ogMeta.image) : (rssMedia.type === 'image' ? rssMedia.url : null);
            const img1 = (rawImg1 && !isLiveBroadcastImage(rawImg1) && !isGenericOrLive(rawImg1)) ? rawImg1 : null;
            const rawImg2 = ogMeta.image2 ? upgradeImageUrl(ogMeta.image2) : null;
            const img2 = (rawImg2 && !isLiveBroadcastImage(rawImg2)) ? rawImg2 : null;

            const _img2sd = img2 && normalizeImageUrl(img2) !== normalizeImageUrl(img1) ? img2 : null;
            if (img1 && _img2sd) {
              try {
                const msgs = await bot.sendMediaGroup(CHANNEL_ID, [
                  { type: 'photo', media: img1, caption }, { type: 'photo', media: _img2sd },
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

          // Başarılı gönderim sonrası kalıcı olarak işaretle
          publishedUrls.add(url);
          persistPublishedUrls();
          lastBreakingNewsTime = Date.now();

          const pinId = sentMsg?.message_id || null;
          if (pinId) { registerSentMessage(pinId, title); await tryPin(pinId); }
          console.log(`✅ [Son Dakika] [${sentType}] ${title.slice(0, 60)}`);
          await notifyFilterUsers(title, rawDesc, url);
          isCheckingBreaking = false;
          return;

        } catch (err) {
          console.error(`❌ Son dakika hatası: ${err.message}`);
        }
      }
    } catch { /* feed hatası */ }
  }
  isCheckingBreaking = false;
}


  // ─── Yayın Zamanlayıcısı ──────────────────────────────────────────────────────
  let publishInterval = null;

  function resetInterval() {
    if (publishInterval) clearInterval(publishInterval);
    const intervalMs = (settings.intervalMinutes || 1.5) * 60 * 1000;
    publishInterval = setInterval(() => {
      publishNextNews().catch(e => console.error('⚠️ Zamanlayıcı hata:', e.message));
    }, intervalMs);
    console.log(`⏱ Zamanlayıcı kuruldu: her ${settings.intervalMinutes} dakikada bir haber`);
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
        { text: '🚨 Son Dakika', callback_data: 'admin_sondakika' },
        { text: '🔄 Haberleri Yenile', callback_data: 'admin_refresh' },
      ],
      [
        { text: '📊 İstatistik', callback_data: 'admin_stats' },
        { text: '📰 Kaynaklar', callback_data: 'admin_sources' },
      ],
      [
        { text: '📋 Komutlar', callback_data: 'admin_commands' },
        { text: '🔓 Kilidi Sıfırla', callback_data: 'admin_resetlock' },
      ],
      [
        { text: '✍️ Metin Paylaş', callback_data: 'admin_post_text' },
        { text: '🖼 Resim Paylaş', callback_data: 'admin_post_photo' },
      ],
      [
        { text: '🗑 Haber Kaldır', callback_data: 'admin_delete_msg' },
      ],
    ],
  };
}

// ─── Komut Listesi ────────────────────────────────────────────────────────────

const BOT_COMMANDS = [
  { cmd: '/start',              icon: '👋', desc: 'Botu başlatır ve tanıtım mesajı gönderir' },
  { cmd: '/admin',              icon: '🔧', desc: 'Admin yönetim panelini açar' },
  { cmd: '/setadmin <şifre>',   icon: '🔐', desc: 'Şifreyle admin yetkisi alır' },
  { cmd: '/haber',              icon: '📰', desc: 'Hemen bir haber yayınlar (beklemeden)' },
  { cmd: '/sondakika',          icon: '🚨', desc: 'Gerçek zamanlı son dakika haberlerini listeler ve kanala yayınlar' },
  { cmd: '/durum',              icon: '📊', desc: 'Botun durumunu ve istatistikleri gösterir' },
  { cmd: '/kaynaklar',          icon: '📡', desc: 'Aktif haber kaynaklarını listeler' },
  { cmd: '/filtre ekle <kw>',   icon: '🔔', desc: 'Anahtar kelime filtresi ekler — eşleşen haberler doğrudan gelir' },
  { cmd: '/filtre sil <kw>',    icon: '🗑', desc: 'Belirtilen filtreyi siler' },
  { cmd: '/filtrelerim',        icon: '📝', desc: 'Aktif filtrelerini listeler' },
  { cmd: '/filtre temizle',     icon: '🧹', desc: 'Tüm filtreleri tek seferde siler' },
  { cmd: '/video <url>',        icon: '🎬', desc: 'Verilen URL\'den video indirir ve kanala gönderir' },
  { cmd: '/myid',               icon: '🪪', desc: 'Kendi Telegram Chat ID\'ini gösterir' },
  { cmd: '/yorum',              icon: '💬', desc: 'Editörlere yorum veya görüş iletir' },
  { cmd: '/dur',                icon: '⏸', desc: 'Otomatik yayını duraklatır (sadece admin)' },
  { cmd: '/baslat',             icon: '▶️', desc: 'Duraklatılmış yayını yeniden başlatır (sadece admin)' },
  { cmd: '/saglik',             icon: '🩺', desc: 'Bot ve RSS kaynaklarının sağlık kontrolünü yapar' },
];

function commandsKeyboard() {
  const rows = BOT_COMMANDS.map((c) => ([{
    text: `${c.icon} ${c.cmd}`,
    callback_data: `cmd_info_${BOT_COMMANDS.indexOf(c)}`,
  }]));
  rows.push([{ text: '◀️ Admin Paneline Dön', callback_data: 'admin_back' }]);
  return { inline_keyboard: rows };
}

function commandInfoKeyboard(idx) {
  const rows = [];
  if (idx > 0) rows.push([{ text: '⬆️ Önceki', callback_data: `cmd_info_${idx - 1}` }]);
  if (idx < BOT_COMMANDS.length - 1) rows.push([{ text: '⬇️ Sonraki', callback_data: `cmd_info_${idx + 1}` }]);
  rows.push([{ text: '📋 Tüm Komutlar', callback_data: 'admin_commands' }]);
  rows.push([{ text: '◀️ Admin Paneli', callback_data: 'admin_back' }]);
  return { inline_keyboard: rows };
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
    `/sondakika — Gerçek zamanlı son dakika haberleri\n` +
    `/kaynaklar — Haber kaynakları\n` +
    `/durum — Bot durumu\n` +
    `/video <url> — URL'den video gönder`
  );
});

bot.onText(/\/myid/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `🪪 Chat ID'niz:\n\n<code>${chatId}</code>\n\nBu sayıyı Railway'de <b>ADMIN_CHAT_ID</b> olarak kaydedin.`, { parse_mode: 'HTML' });
});

bot.onText(/\/admin/, async (msg) => {
  const chatId = String(msg.chat.id);
  if (!isAdmin(chatId)) {
    // DB yükleniyorsa kısa süre bekle — Railway restart sonrası race condition
    if (!dbReady && process.env.DATABASE_URL) {
      await new Promise(r => setTimeout(r, 3000));
    }
    if (!isAdmin(chatId)) {
      bot.sendMessage(msg.chat.id,
        '🔐 Admin paneline erişmek için:\n\n' +
        '`/setadmin <şifre>`\n\n' +
        'Şifreyi bilen kişi admin olabilir.\n\n' +
        '💡 Railway\'de her restart\'ta şifreyi tekrar girmen gerekebilir. ' +
        'Kalıcı admin için: /chatid komutunu kullan ve ADMIN\\_CHAT\\_ID değişkenini Railway\'e ekle.',
        { parse_mode: 'Markdown' }
      );
      return;
    }
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

  // ─── /sondakika Haber Kanalına Yayınla ──────────────────────────────────────
  if (data.startsWith('sd_publish_')) {
    console.log(`📥 sd_publish_ callback alındı — chatId:${chatId} data:${data}`);
    if (!isAdmin(chatId)) {
      await bot.answerCallbackQuery(query.id, { text: '⛔ Sadece adminler yayınlayabilir.' });
      return;
    }
    const pendingItems = pendingSdResults.get(chatId);
    const idx = parseInt(data.replace('sd_publish_', ''));
    console.log(`📋 pendingItems: ${pendingItems ? pendingItems.length + ' haber' : 'YOK'}, idx:${idx}`);
    if (!pendingItems || !pendingItems[idx]) {
      await bot.answerCallbackQuery(query.id, { text: '❌ Bot yeniden başlatıldı. /sondakika tekrar yaz.' });
      bot.sendMessage(chatId, '⚠️ Bot yeniden başlatıldığı için haberler sıfırlandı.\n/sondakika yazarak tekrar listele.').catch(() => {});
      return;
    }
    const item = pendingItems[idx];
    const title = stripNewsSource(cleanTitle(item.title || ''));
    const rawLink = item.link || item.guid || '';
    await bot.answerCallbackQuery(query.id, { text: '📤 Yayınlanıyor...' });
    try {
      // Google News URL çözümü — kısa timeout ile
      let link = rawLink;
      if (rawLink.includes('news.google.com')) {
        link = await Promise.race([
          resolveGoogleNewsUrl(rawLink).catch(() => null),
          new Promise(r => setTimeout(() => r(null), 5000)),
        ]) || rawLink;
      }

      // HTML etiketleri ve linkleri temizlenmiş RSS açıklaması
      const rawDescRaw = item.contentSnippet || item.summary || item.description || '';
      const cleanDesc = rawDescRaw
        .replace(/<[^>]+>/g, ' ')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/&[a-z#0-9]+;/gi, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();

      const categoryTag = detectCategory(title, cleanDesc);
      const catE = categoryTag ? `${categoryTag} ` : '';

      // AI özeti — kendi içinde 8s timeout var; AI yoksa cleanDesc döner
      const aiSummary = await summarizeNews(title, cleanDesc).catch(() => null);

      // En iyi içerik: AI özeti > temizlenmiş RSS açıklaması
      const bestDesc = (aiSummary && aiSummary.length > 5)
        ? cleanArrows(stripLinks(aiSummary))
        : (cleanDesc && cleanDesc.length > 10)
          ? cleanDesc.slice(0, 600)
          : null;

      // Kesinlikle link yok, web önizlemesi kapalı
      let text = `🚨 SON DAKİKA\n\n${catE}${stripLinks(title)}`;
      if (bestDesc) text += `\n\n${bestDesc}`;
      text = text.slice(0, 4096);

      const sentMsg2 = await bot.sendMessage(CHANNEL_ID, text, { disable_web_page_preview: true });
      console.log(`✅ Son dakika kanala gönderildi — msg_id:${sentMsg2?.message_id} kanal:${CHANNEL_ID} başlık:${title.slice(0, 60)}`);

      publishedUrls.add(rawLink);
      if (link !== rawLink) publishedUrls.add(link);
      breakingPublishedUrls.add(rawLink);
      persistPublishedUrls();
      if (sentMsg2?.message_id) registerSentMessage(sentMsg2.message_id, title);

      await bot.sendMessage(chatId, `✅ Kanala yayınlandı!\n\n📰 ${title.slice(0, 200)}`).catch(() => {});
      await bot.editMessageText(`✅ Yayınlandı!`, { chat_id: chatId, message_id: msgId }).catch(() => {});
    } catch (e) {
      console.error(`❌ sd_publish_ hata — kanal:${CHANNEL_ID} hata:${e.message}`);
      bot.sendMessage(chatId, `❌ Yayınlama hatası!\nKanal: ${CHANNEL_ID}\nHata: ${e.message.slice(0, 300)}`).catch(() => {});
    }
    return;
  }

  if (data === 'sd_cancel') {
    pendingSdResults.delete(chatId);
    await bot.answerCallbackQuery(query.id, { text: '❌ İptal edildi' });
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────

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

  // ─── Dinamik silme onayı (switch'ten önce işleniyor) ─────────────────────
  if (data.startsWith('admin_confirm_delete_')) {
    const delMsgId = parseInt(data.replace('admin_confirm_delete_', ''));
    await bot.answerCallbackQuery(query.id).catch(() => {});
    try {
      await bot.deleteMessage(CHANNEL_ID, delMsgId);
      await bot.sendMessage(chatId, '✅ Mesaj kanaldan silindi!');
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Silinemedi: ${e.message?.slice(0,80)}`);
    }
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

    case 'admin_commands':
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await bot.editMessageText(
        `📋 *Bot Komutları*\n\nBir komuta tıklayarak ne işe yaradığını öğren:`,
        {
          chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
          reply_markup: commandsKeyboard(),
        }
      );
      break;

    case 'admin_sondakika': {
      await bot.answerCallbackQuery(query.id, { text: '🚨 Son dakika çekiliyor...' }).catch(() => {});
      const sdStatusMsg = await bot.sendMessage(chatId, '🚨 Son dakika haberleri çekiliyor...').catch(() => null);
      try {
        const SD_SOURCES_ADMIN = [
          'https://news.google.com/rss/search?q=%22son+dakika%22&hl=tr&gl=TR&ceid=TR:tr',
          'https://news.google.com/rss/search?q=%22son+dakika%22+site:cumhuriyet.com.tr&hl=tr&gl=TR&ceid=TR:tr',
          'https://news.google.com/rss/search?q=%22son+dakika%22+site:t24.com.tr&hl=tr&gl=TR&ceid=TR:tr',
          'https://news.google.com/rss/search?q=%22son+dakika%22+site:sozcu.com.tr&hl=tr&gl=TR&ceid=TR:tr',
          'https://www.cumhuriyet.com.tr/rss',
        ];
        const nowSd = Date.now();
        const SIX_H = 6 * 60 * 60 * 1000;
        const sdFetchResults = await Promise.allSettled(
          SD_SOURCES_ADMIN.map(url =>
            fetchFeedXml(url).then(xml => parser.parseString(xml)).then(f => f.items || []).catch(() => [])
          )
        );
        const seenSdLinks = new Set();
        const sdItems = [];
        for (const r of sdFetchResults) {
          if (r.status !== 'fulfilled') continue;
          for (const item of r.value) {
            const link = item.link || item.guid || '';
            const title = item.title || '';
            if (!link || seenSdLinks.has(link) || title.length < 10) continue;
            if (BLOCKED_TITLE_PATTERNS.some(p => p.test(title))) continue;
            seenSdLinks.add(link);
            const pubDate = (item.pubDate || item.isoDate) ? new Date(item.pubDate || item.isoDate).getTime() : 0;
            if (!pubDate || isNaN(pubDate) || nowSd - pubDate > SIX_H) continue;
            sdItems.push(item);
          }
        }
        const isSD2 = (t) => /son dakika|flaş|acil|breaking/i.test(t || '');
        sdItems.sort((a, b) => {
          const diff = (isSD2(b.title) ? 1 : 0) - (isSD2(a.title) ? 1 : 0);
          if (diff !== 0) return diff;
          return (new Date(b.pubDate||0).getTime()) - (new Date(a.pubDate||0).getTime());
        });
        const topSdItems = sdItems.slice(0, 8);
        if (topSdItems.length === 0) {
          const noText = '❌ Son 6 saatte son dakika haberi bulunamadı.';
          if (sdStatusMsg) await bot.editMessageText(noText, { chat_id: chatId, message_id: sdStatusMsg.message_id }).catch(() => bot.sendMessage(chatId, noText));
          break;
        }
        pendingSdResults.set(String(chatId), topSdItems);
        const timeAgoSd = (d) => {
          if (!d) return '';
          const diff = Math.floor((nowSd - new Date(d).getTime()) / 60000);
          if (diff < 1) return ' · şimdi'; if (diff < 60) return ` · ${diff}dk önce`;
          return ` · ${Math.floor(diff/60)}sa önce`;
        };
        let sdText = `🚨 *SON DAKİKA HABERLERİ*\n_Son 6 saat — ${topSdItems.length} haber_\n\n`;
        topSdItems.forEach((item, i) => {
          const t = stripNewsSource(cleanTitle(item.title||'')).slice(0,80);
          sdText += `${isSD2(item.title)?'🔴':'📌'} *${i+1}.* ${t}${timeAgoSd(item.pubDate)}\n`;
        });
        sdText += `\n_Kanala yayınlamak için bir habere bas:_`;
        const sdKeyboard = topSdItems.map((it, i) => [{
          text: `📤 ${i+1}. ${stripNewsSource(cleanTitle(it.title||'')).slice(0,50)}`,
          callback_data: `sd_publish_${i}`,
        }]);
        sdKeyboard.push([{ text: '❌ Kapat', callback_data: 'sd_cancel' }]);
        if (sdStatusMsg) {
          await bot.editMessageText(sdText, { chat_id: chatId, message_id: sdStatusMsg.message_id, parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: { inline_keyboard: sdKeyboard } }).catch(async () => {
            await bot.sendMessage(chatId, sdText, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: { inline_keyboard: sdKeyboard } });
          });
        }
      } catch (err) {
        const errText = `❌ Son dakika hatası: ${err.message.slice(0,200)}`;
        if (sdStatusMsg) await bot.editMessageText(errText, { chat_id: chatId, message_id: sdStatusMsg.message_id }).catch(() => bot.sendMessage(chatId, errText));
      }
      break;
    }

    case 'admin_refresh': {
      await bot.answerCallbackQuery(query.id, { text: '🔄 Kaynaklar taranıyor...' }).catch(() => {});
      const refreshMsg = await bot.sendMessage(chatId, '🔄 Haber kaynakları taranıyor...').catch(() => null);
      try {
        // Aktif kategoriye uyan feedleri al
        const activePool = RSS_FEEDS.filter(f =>
          f.type !== 'youtube' && (
            settings.activeCategory === 'hepsi' ||
            f.category === settings.activeCategory ||
            f.category === 'genel'
          )
        );
        const feedSlice = activePool.slice(0, 15);
        const TWO_H = 2 * 60 * 60 * 1000;
        const now = Date.now();

        const results = await Promise.allSettled(
          feedSlice.map(f => fetchFeed(f).catch(() => []))
        );

        let totalRecent = 0;    // Son 2 saatteki toplam haber
        let totalUnpublished = 0; // Bunların kaçı henüz yayınlanmamış
        const sourcesSummary = [];

        results.forEach((r, i) => {
          const feed = feedSlice[i];
          const items = r.status === 'fulfilled' ? r.value : [];
          const recentItems = items.filter(it => {
            const ts = (it.pubDate || it.isoDate) ? new Date(it.pubDate || it.isoDate).getTime() : 0;
            return ts && !isNaN(ts) && now - ts < TWO_H;
          });
          const unpublished = recentItems.filter(it => {
            const url = it.link || it.guid;
            return url && !publishedUrls.has(url);
          });
          totalRecent += recentItems.length;
          totalUnpublished += unpublished.length;
          if (recentItems.length > 0) sourcesSummary.push(`• ${feed.label}: ${recentItems.length} haber (${unpublished.length} yeni)`);
        });

        const summaryLines = sourcesSummary.slice(0, 8).join('\n');
        const moreCount = sourcesSummary.length > 8 ? `\n… ve ${sourcesSummary.length - 8} kaynak daha` : '';

        let refreshText =
          `🔄 *Haber Tarama Tamamlandı*\n\n` +
          `📡 Taranan kaynak: *${feedSlice.length}*\n` +
          `🕐 Son 2 saatteki haber: *${totalRecent}*\n` +
          `✨ Henüz yayınlanmamış: *${totalUnpublished}*\n` +
          `🗂 Toplam kayıtlı URL: *${publishedUrls.size}*\n\n`;

        if (summaryLines) refreshText += `*Kaynaklar:*\n${summaryLines}${moreCount}\n\n`;

        if (totalUnpublished > 0) {
          refreshText += `_${totalUnpublished} yeni haber var — "Şimdi Yayınla" ile ilk haberi yayınla._`;
        } else if (totalRecent > 0) {
          refreshText += `_Son 2 saatteki tüm haberler zaten yayınlandı. Otomatik zamanlayıcı devam ediyor._`;
        } else {
          refreshText += `_Son 2 saatte hiç haber bulunamadı. Feed kaynakları kontrol edilmeli._`;
        }

        const refreshKeyboard = {
          inline_keyboard: [
            [{ text: '▶️ Şimdi Yayınla', callback_data: 'admin_publish_now' }],
            [{ text: '◀️ Geri', callback_data: 'admin_back' }],
          ],
        };

        if (refreshMsg) {
          await bot.editMessageText(refreshText, {
            chat_id: chatId, message_id: refreshMsg.message_id,
            parse_mode: 'Markdown',
            reply_markup: refreshKeyboard,
          }).catch(async () => {
            await bot.sendMessage(chatId, refreshText, { parse_mode: 'Markdown', reply_markup: refreshKeyboard });
          });
        }
      } catch (err) {
        const errText = `❌ Yenileme hatası: ${err.message.slice(0,200)}`;
        if (refreshMsg) await bot.editMessageText(errText, { chat_id: chatId, message_id: refreshMsg.message_id }).catch(() => bot.sendMessage(chatId, errText));
      }
      break;
    }

    case 'admin_post_text': {
      pendingAdminAction.set(chatId, { action: 'post_text' });
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await bot.sendMessage(chatId,
        '✍️ *Kanala Metin Paylaş*\n\nPaylaşmak istediğiniz metni yazın:\n_(İptal için /admin yazın)_',
        { parse_mode: 'Markdown' }
      );
      break;
    }

    case 'admin_post_photo': {
      pendingAdminAction.set(chatId, { action: 'post_photo' });
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await bot.sendMessage(chatId,
        '🖼 *Kanala Resim Paylaş*\n\nFotoğrafı gönderin (opsiyonel açıklama da ekleyebilirsiniz):\n_(İptal için /admin yazın)_',
        { parse_mode: 'Markdown' }
      );
      break;
    }

    case 'admin_delete_msg': {
      pendingAdminAction.set(chatId, { action: 'delete_msg' });
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await bot.sendMessage(chatId,
        '🗑 *Haber Kaldır*\n\nSilmek istediğiniz kanal mesajını bota *iletin (forward)* VEYA mesaj ID numarasını yazın:\n_(İptal için /admin yazın)_',
        { parse_mode: 'Markdown' }
      );
      break;
    }

    case 'admin_resetlock': {
      publishingInProgress = false;
      publishNowInProgress = false;
      publishingStartTime = 0;
      publishNowStartTime = 0;
      await bot.answerCallbackQuery(query.id, { text: '🔓 Tüm kilitler sıfırlandı!' }).catch(() => {});
      await bot.editMessageText(
        adminPanelText() + '\n\n✅ _Yayın kilitleri sıfırlandı._',
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: adminPanelKeyboard() }
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

    default: {
      if (data.startsWith('reply_user_')) break; // 2. handler ele alır
      if (data.startsWith('cmd_info_')) {
        const idx = parseInt(data.replace('cmd_info_', ''), 10);
        const cmd = BOT_COMMANDS[idx];
        if (!cmd) { await bot.answerCallbackQuery(query.id).catch(() => {}); break; }
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.editMessageText(
          `${cmd.icon} *${cmd.cmd}*\n\n📌 ${cmd.desc}`,
          {
            chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
            reply_markup: commandInfoKeyboard(idx),
          }
        );
        break;
      }
      await bot.answerCallbackQuery(query.id).catch(() => {});
    }
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

// ─── /sondakika için bekleyen haberler (chatId → item listesi) ───────────────
const pendingSdResults = new Map();

// ─── /testkanal: Kanal bağlantısını test et ──────────────────────────────────
bot.onText(/\/testkanal/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, `🔍 Test başlıyor...\nKanal: ${CHANNEL_ID}`);
  try {
    const sentMsg = await bot.sendMessage(CHANNEL_ID, '🔧 Test mesajı — bot çalışıyor!');
    await bot.deleteMessage(CHANNEL_ID, sentMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, '✅ Kanal bağlantısı BAŞARILI! Bot kanala yazabiliyor.');
  } catch (err) {
    await bot.sendMessage(chatId,
      `❌ Kanal bağlantısı BAŞARISIZ!\n\nHata: ${err.message}\n\nOlası sebepler:\n• Bot kanalda admin değil\n• CHANNEL_ID yanlış (şu an: ${CHANNEL_ID})\n• Kanal username değişmiş`
    );
  }
});

// ─── /sondakika: Gerçek zamanlı son dakika haberleri — listele + kanala yayınla
bot.onText(/\/sondakika/, async (msg) => {
  const chatId = msg.chat.id;

  const statusMsg = await bot.sendMessage(chatId, '🚨 Son dakika haberleri çekiliyor...');

  try {
    // Birden fazla kaynaktan paralel çek
    const SD_SOURCES = [
      'https://news.google.com/rss/search?q=%22son+dakika%22&hl=tr&gl=TR&ceid=TR:tr',
      'https://news.google.com/rss/search?q=%22son+dakika%22+site:cumhuriyet.com.tr&hl=tr&gl=TR&ceid=TR:tr',
      'https://news.google.com/rss/search?q=%22son+dakika%22+site:t24.com.tr&hl=tr&gl=TR&ceid=TR:tr',
      'https://news.google.com/rss/search?q=%22son+dakika%22+site:sozcu.com.tr&hl=tr&gl=TR&ceid=TR:tr',
      'https://www.cumhuriyet.com.tr/rss',
    ];

    const now = Date.now();
    const SIX_HOURS = 6 * 60 * 60 * 1000;

    const fetchResults = await Promise.allSettled(
      SD_SOURCES.map(url =>
        fetchFeedXml(url)
          .then(xml => parser.parseString(xml))
          .then(f => f.items || [])
          .catch(() => [])
      )
    );

    // Tüm kaynakları birleştir, tekrarsız filtrele
    const seenLinks = new Set();
    const allItems = [];
    for (const r of fetchResults) {
      if (r.status !== 'fulfilled') continue;
      for (const item of r.value) {
        const link = item.link || item.guid || '';
        const title = item.title || '';
        if (!link || seenLinks.has(link)) continue;
        if (title.length < 10) continue;
        if (BLOCKED_TITLE_PATTERNS.some(p => p.test(title))) continue;
        seenLinks.add(link);

        // Tarih filtresi: son 6 saat — tarihsiz veya eski haberler kesinlikle atla
        const pubDate = (item.pubDate || item.isoDate) ? new Date(item.pubDate || item.isoDate).getTime() : 0;
        if (!pubDate || isNaN(pubDate) || now - pubDate > SIX_HOURS) continue;

        allItems.push(item);
      }
    }

    // Son dakika anahtar kelimesi içerenleri öne al, sonra tarihe göre sırala
    const isSD = (t) => /son dakika|flaş|acil|breaking/i.test(t || '');
    allItems.sort((a, b) => {
      const aSD = isSD(a.title) ? 1 : 0;
      const bSD = isSD(b.title) ? 1 : 0;
      if (bSD !== aSD) return bSD - aSD;
      const aDate = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      const bDate = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return bDate - aDate;
    });

    const topItems = allItems.slice(0, 8);

    if (topItems.length === 0) {
      await bot.editMessageText('❌ Son 6 saatte son dakika haberi bulunamadı.', {
        chat_id: chatId, message_id: statusMsg.message_id
      }).catch(() => {});
      return;
    }

    // Cache'e kaydet (kanala yayınlamak için)
    pendingSdResults.set(String(chatId), topItems);

    // Listeyi formatla
    const timeAgo = (dateStr) => {
      if (!dateStr) return '';
      const diff = Math.floor((now - new Date(dateStr).getTime()) / 60000);
      if (diff < 1) return ' · şimdi';
      if (diff < 60) return ` · ${diff}dk önce`;
      return ` · ${Math.floor(diff / 60)}sa önce`;
    };

    let text = `🚨 *SON DAKİKA HABERLERİ*\n_Son 6 saat — ${topItems.length} haber_\n\n`;
    topItems.forEach((item, i) => {
      const title = stripNewsSource(cleanTitle(item.title || '')).slice(0, 80);
      const ago = timeAgo(item.pubDate);
      const sdTag = isSD(item.title) ? '🔴 ' : '📌 ';
      text += `${sdTag}*${i + 1}.* ${title}${ago}\n`;
    });
    text += `\n_Kanala yayınlamak için bir habere bas:_`;

    const keyboard = topItems.map((it, i) => [{
      text: `📤 ${i + 1}. ${stripNewsSource(cleanTitle(it.title || '')).slice(0, 50)}`,
      callback_data: `sd_publish_${i}`,
    }]);
    keyboard.push([{ text: '❌ Kapat', callback_data: 'sd_cancel' }]);

    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard },
    }).catch(async () => {
      await bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: keyboard },
      });
    });

  } catch (err) {
    console.error('❌ /sondakika hatası:', err.message);
    await bot.editMessageText(`❌ Hata: ${err.message.slice(0, 200)}`, {
      chat_id: chatId, message_id: statusMsg.message_id
    }).catch(() => {});
  }
});

bot.onText(/\/haber/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '📰 Haber çekiliyor...');
  // publishNowInstant kullan: saat kısıtı ve duraklat kontrolü yok, her zaman çalışır
  const result = await publishNowInstant().catch(e => `❌ Hata: ${e.message}`);
  if (result) {
    await bot.sendMessage(msg.chat.id, result);
  } else {
    await bot.sendMessage(msg.chat.id, '⚠️ Şu an yayınlanacak uygun haber bulunamadı.');
  }
});

bot.onText(/\/video/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '🎬 Video aranıyor (YouTube + haber siteleri)...');
  let sent = false;

  // 1) YouTube feedlerinden yt-dlp ile indir
  const youtubeFeeds = RSS_FEEDS.filter(f => f.type === 'youtube');
  for (const feed of youtubeFeeds) {
    if (sent) break;
    try {
      const items = (await fetchFeed(feed)).slice(0, 8);
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
        const items = (await fetchFeed(feed)).slice(0, 5);
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
  if (!isAdmin(msg.chat.id)) return;
  settings.paused = true;
  saveSettings();
  bot.sendMessage(msg.chat.id, '⏸ Bot durduruldu. Devam ettirmek için admin panelinden "▶️ Devam Et"e basın veya /baslat yazın.');
});

bot.onText(/\/baslat/, (msg) => {
  if (!isAdmin(msg.chat.id)) return;
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


  // ── /video <url> — URL'den video indir ve kanala gönder ─────────────────────
  bot.onText(/^\/video\s+(https?:\/\/\S+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    const videoUrl = (match[1] || '').trim();
    if (!videoUrl) {
      bot.sendMessage(chatId, '⚠️ Kullanım: /video <url>\nÖrnek: /video https://youtube.com/watch?v=xxx');
      return;
    }
    bot.sendMessage(chatId, `⏳ Video işleniyor...\n${videoUrl.slice(0, 80)}`);
    try {
      const isYt = /youtube\.com|youtu\.be/i.test(videoUrl);
      let ok = false;
      if (isYt) {
        ok = await sendYouTubeVideoSmart(CHANNEL_ID, videoUrl, '📹 Video Haber');
      } else {
        // Direkt URL veya haber sayfası — web video dene
        ok = await sendWebVideo(CHANNEL_ID, videoUrl, '📹 Video Haber', null);
        if (!ok) {
          // yt-dlp ile genel indirme dene
          const gPath = await downloadGenericWithYtdlp(videoUrl).catch(() => null);
          if (gPath) {
            try {
              await bot.sendVideo(CHANNEL_ID, { source: gPath }, { caption: '📹 Video Haber', supports_streaming: true });
              try { fs.rmSync(path.dirname(gPath), { recursive: true, force: true }); } catch {}
              ok = true;
            } catch {}
          }
        }
      }
      if (ok) {
        mediaStats.video++;
        bot.sendMessage(chatId, '✅ Video kanala gönderildi!');
      } else {
        bot.sendMessage(chatId, '❌ Video gönderilemedi. URL geçerli bir video içermiyor olabilir.');
      }
    } catch (err) {
      bot.sendMessage(chatId, '❌ Hata: ' + err.message?.slice(0, 200));
    }
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
      await send('⚠️ cobalt kapalı/JWT gerekiyor — yt-dlp fallback aktif');
    }

    await send('✅ *Debug tamamlandı!*', { parse_mode: 'Markdown' });
  });
let _polling409Timer = null;
bot.on('polling_error', (err) => {
  trackError('polling', err.message);
  console.error(`⚠️ Polling hatası: ${err.message}`);
  // 409 = başka instance çalışıyor. Dur, 30sn bekle, yeniden başlat.
  if (err.message && err.message.includes('409') && !_polling409Timer) {
    console.log('⏳ 409 algılandı — 30sn bekleniyor (eski instance\'ın ölmesi için)...');
    bot.stopPolling().catch(() => {});
    _polling409Timer = setTimeout(() => {
      _polling409Timer = null;
      console.log('🔄 Polling yeniden başlatılıyor...');
      bot.startPolling({ interval: 300, params: { timeout: 10, limit: 100, allowed_updates: ['message','callback_query','channel_post','inline_query'] } });
    }, 30000);
  }
});

// ─── Temiz Kapanış ────────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM alındı — polling durduruluyor...');
  persistPublishedUrls();
  bot.stopPolling().catch(() => {});
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT alındı, çıkılıyor...');
  persistPublishedUrls();
  bot.stopPolling().catch(() => {}).finally(() => process.exit(0));
});

// ─── Başlat ───────────────────────────────────────────────────────────────────

console.log('🚀 Telegram Haber Botu başlatılıyor...');
console.log(`📡 Kanal: ${CHANNEL_ID}`);
console.log(`⏱ Yayın aralığı: ${settings.intervalMinutes} dakika`);
console.log(`📂 Aktif kategori: ${settings.activeCategory}`);
console.log(`📰 Kaynak sayısı: ${RSS_FEEDS.length} (${RSS_FEEDS.filter(f=>f.type==='youtube').length} YouTube)`);
console.log(`🔑 Admin şifresi ayarlı: ${ADMIN_PASSWORD !== 'admin2024' ? 'Evet' : 'Hayır (varsayılan)'}`);

// PostgreSQL DB'yi başlat (async — bot başlatmayı bloke etmez)
initDatabase().then(() => {
  console.log('🗄️ Veritabanı başlatıldı');
}).catch(e => {
  console.error('🗄️ Veritabanı başlatma hatası:', e.message);
});

// ── Başlatma: Railway'de webhook, yoksa polling ───────────────────────────────
const HEALTH_PORT = process.env.PORT || 3000;
const RAILWAY_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || '';
const WEBHOOK_URL_ACTIVE = RAILWAY_DOMAIN ? `https://${RAILWAY_DOMAIN}/tg-webhook` : '';
// Railway'de RAILWAY_ENVIRONMENT otomatik set edilir. Yoksa Replit/lokal ortam.
const IS_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL);
const LOCAL_POLLING = process.env.LOCAL_POLLING === 'true'; // Replit'te test için manuel aktif et
console.log(`🔧 Ortam: ${IS_RAILWAY ? 'RAILWAY' : 'REPLIT/LOKAL'} | Mod: ${WEBHOOK_URL_ACTIVE ? 'WEBHOOK → ' + WEBHOOK_URL_ACTIVE : IS_RAILWAY || LOCAL_POLLING ? 'POLLING' : 'SADECE-RSS (polling kapalı)'}`);

function startBot() {
  publishNextNews();
  resetInterval();
  startBreakingNewsChecker();
  checkBreakingNews();
  console.log('✅ Bot tamamen hazır');
}

http.createServer((req, res) => {
  if (WEBHOOK_URL_ACTIVE && req.method === 'POST' && req.url === '/tg-webhook') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { bot.processUpdate(JSON.parse(body)); } catch {}
      res.writeHead(200); res.end('OK');
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('OK');
  }
}).listen(HEALTH_PORT, () => {
  console.log(`✅ HTTP sunucu: port ${HEALTH_PORT}`);

  if (WEBHOOK_URL_ACTIVE) {
    // Railway: webhook modu — polling çakışması olmaz
    bot._request('setWebhook', { form: {
      url: WEBHOOK_URL_ACTIVE,
      drop_pending_updates: true,
      allowed_updates: JSON.stringify(['message','callback_query','channel_post','inline_query']),
    }})
    .then(() => {
      console.log(`🔗 Webhook aktif: ${WEBHOOK_URL_ACTIVE}`);
      startBot();
    })
    .catch(e => { console.error('❌ Webhook kurulamadı:', e.message); process.exit(1); });
  } else if (IS_RAILWAY || LOCAL_POLLING) {
    // Railway veya LOCAL_POLLING=true: polling modu
    bot._request('deleteWebhook', { form: { drop_pending_updates: true } })
      .then(() => {
        bot.startPolling({ interval: 300, params: { timeout: 10, limit: 100, allowed_updates: ['message','callback_query','channel_post','inline_query'] } });
        console.log('📡 Polling modu aktif');
        startBot();
      })
      .catch(e => { console.error('❌ Polling başlatılamadı:', e.message); process.exit(1); });
  } else {
    // Replit/lokal — polling YOK (Railway zaten çalışıyor, 409 engellemek için)
    console.log('⏸️ Replit ortamı — polling kapalı. Sadece RSS yayın motoru çalışıyor.');
    console.log('💡 Lokal Telegram testi için LOCAL_POLLING=true env ekle.');
    startBot(); // RSS yayını ve zamanlayıcılar çalışır, Telegram polling olmaz
  }
});

// ─── Yorum Sistemi ────────────────────────────────────────────────────────────
// Kullanıcılar bota mesaj gönderir → admin'e iletilir → admin yanıtlayabilir
const pendingReplies = new Map(); // adminMsgId → { userId, userName }
const pendingAdminAction = new Map(); // adminChatId → { action: 'post_text'|'post_photo'|'delete_msg' }

bot.on('message', async (msg) => {
  if (msg.chat.type !== 'private') return;
  if (msg.text?.startsWith('/')) return; // komutlar zaten işleniyor
  const chatId = String(msg.chat.id);

  // ── Admin işlemleri ──────────────────────────────────────────────────────────
  if (isAdmin(chatId)) {

    // Bekleyen admin aksiyonu var mı?
    if (pendingAdminAction.has(chatId)) {
      const { action } = pendingAdminAction.get(chatId);

      // Metin paylaşma
      if (action === 'post_text' && msg.text) {
        pendingAdminAction.delete(chatId);
        try {
          await bot.sendMessage(CHANNEL_ID, msg.text);
          await bot.sendMessage(chatId, '✅ Metin kanala paylaşıldı!');
        } catch (e) {
          await bot.sendMessage(chatId, `❌ Gönderilemedi: ${e.message?.slice(0,100)}`);
        }
        return;
      }

      // Resim paylaşma
      if (action === 'post_photo' && msg.photo) {
        pendingAdminAction.delete(chatId);
        const photo = msg.photo[msg.photo.length - 1];
        try {
          await bot.sendPhoto(CHANNEL_ID, photo.file_id, msg.caption ? { caption: msg.caption } : {});
          await bot.sendMessage(chatId, '✅ Fotoğraf kanala paylaşıldı!');
        } catch (e) {
          await bot.sendMessage(chatId, `❌ Gönderilemedi: ${e.message?.slice(0,100)}`);
        }
        return;
      }

      // Haber silme — forward veya ID
      if (action === 'delete_msg') {
        const chanUsername = CHANNEL_ID.replace('@', '');
        const isFwdFromChan = msg.forward_from_chat &&
          (msg.forward_from_chat.username === chanUsername || msg.forward_from_chat.type === 'channel');
        const fwdMsgId = isFwdFromChan ? msg.forward_from_message_id : null;
        const textMsgId = (!fwdMsgId && msg.text && /^\d+$/.test(msg.text.trim()))
          ? parseInt(msg.text.trim()) : null;
        const targetId = fwdMsgId || textMsgId;

        if (targetId) {
          pendingAdminAction.delete(chatId);
          await bot.sendMessage(chatId,
            `🗑 Mesaj ID: *${targetId}* kanaldan silinsin mi?`,
            {
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: [[
                { text: '✅ Evet, Sil', callback_data: `admin_confirm_delete_${targetId}` },
                { text: '❌ İptal', callback_data: 'admin_back' },
              ]] }
            }
          );
        } else {
          await bot.sendMessage(chatId,
            '⚠️ Lütfen kanal mesajını bota iletin (forward) veya mesaj ID numarasını yazın.'
          );
        }
        return;
      }
    }

    // Admin bot üzerinden bir yoruma yanıt veriyorsa kullanıcıya ilet
    if (msg.text && msg.reply_to_message && pendingReplies.has(msg.reply_to_message.message_id)) {
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

  // ── Kullanıcı yorumu — admin'e ilet (metin veya fotoğraf) ───────────────────
  if (!msg.text && !msg.photo) return;
  const userName = msg.from?.first_name || msg.from?.username || 'Anonim';
  const adminId = ADMIN_CHAT_ID || settings.adminChatIds[0];
  if (!adminId) return;

  try {
    let forwarded;
    if (msg.photo) {
      // Fotoğraflı yorum
      const photo = msg.photo[msg.photo.length - 1];
      forwarded = await bot.sendPhoto(
        adminId,
        photo.file_id,
        {
          caption: `💬 *Yeni Yorum (Fotoğraf)*\n👤 ${userName} (ID: ${chatId})${msg.caption ? '\n\n' + msg.caption.slice(0, 500) : ''}`,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '↩️ Yanıtla', callback_data: `reply_user_${chatId}` }]] }
        }
      );
    } else {
      // Metin yorumu
      forwarded = await bot.sendMessage(
        adminId,
        `💬 *Yeni Yorum*\n👤 ${userName} (ID: ${chatId})\n\n${msg.text.slice(0, 1000)}`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '↩️ Yanıtla', callback_data: `reply_user_${chatId}` }]] }
        }
      );
    }
    pendingReplies.set(forwarded.message_id, { userId: chatId, userName });
    await bot.sendMessage(msg.chat.id, '✅ Yorumunuz editöre iletildi, teşekkürler!');
  } catch (e) {
    console.error('Yorum iletilemedi:', e.message);
  }
});

// ─── /yorum komutu ──────────────────────────────────────────────────────────
bot.onText(/\/yorum/, (msg) => {
  if (msg.chat.type !== 'private') return;
  bot.sendMessage(msg.chat.id,
    '💬 *Yorum Yap*\n\nBir haber veya konu hakkında görüşünüzü paylaşmak için bu sohbete mesajınızı yazın — editörlere iletilecektir.\n\nFotoğraflı yorum da gönderebilirsiniz.',
    { parse_mode: 'Markdown' }
  );
});

// Admin "Yanıtla" butonuna basarsa
bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = String(query.message.chat.id);
  if (!data?.startsWith('reply_user_')) return;
  if (!isAdmin(chatId)) return;

  const userId = data.replace('reply_user_', '');
  await bot.answerCallbackQuery(query.id).catch(() => {});
  await bot.sendMessage(
    query.message.chat.id,
    `✏️ Kullanıcıya (${userId}) yanıt yazın — bu mesajı alıntılayarak (reply) gönderin:`,
    { reply_markup: { force_reply: true } }
  );
});

console.log('✅ Bot çalışıyor!');
