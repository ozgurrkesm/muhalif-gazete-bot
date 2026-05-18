# Telegram Haber Botu — Railway Kurulum Rehberi

## Railway'e Deploy Etme Adımları

### 1. GitHub'a Yükle
Projeyi GitHub'a push et (tüm monorepo veya sadece bu klasör).

### 2. Railway'de Yeni Proje Oluştur
1. [railway.app](https://railway.app) adresine git
2. "New Project" → "Deploy from GitHub repo" seç
3. Repoyu seç

### 3. Root Directory Ayarla (Monorepo kullanıyorsan)
Railway dashboard → Settings → Source:
- **Root Directory:** `artifacts/telegram-bot`

### 4. Ortam Değişkenlerini Ekle
Railway dashboard → Variables sekmesine şunları ekle:

| Değişken | Değer | Zorunlu |
|---|---|---|
| `BOT_TOKEN` | BotFather'dan alınan token | ✅ Evet |
| `CHANNEL_ID` | `@muhalif_gazete` veya kanal ID | ✅ Evet |
| `ADMIN_PASSWORD` | Admin şifresi | ✅ Evet |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | OpenAI proxy URL | ❌ İsteğe bağlı |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | OpenAI API anahtarı | ❌ İsteğe bağlı |

### 5. Deploy Et
Railway otomatik olarak `node index.js` komutunu çalıştıracak.

## Önemli Notlar

- **Tek instance:** Bot aynı anda sadece tek bir yerde çalışabilir.
  Railway'e geçince Replit'teki botu durdur (veya tam tersi).
- **Veri kalıcılığı:** `users.json`, `settings.json`, `published.json` dosyaları
  Railway volume olmadan her yeniden başlamada sıfırlanır.
  Kalıcı veri için Railway'de Volume ekle.

## Admin Komutları (Telegram'da)

1. `/setadmin <şifre>` — Admin yetkisi al
2. `/admin` — Admin panelini aç
