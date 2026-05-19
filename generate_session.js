import { TelegramClient } from 'telegram';
  import { StringSession } from 'telegram/sessions/index.js';
  import { createInterface } from 'readline';

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const question = (q) => new Promise(r => rl.question(q, r));

  const apiId = parseInt(await question('API_ID (my.telegram.org): '));
  const apiHash = await question('API_HASH: ');

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

  await client.start({
    phoneNumber: () => question('Telefon numarası (+90...): '),
    password: () => question('2FA şifresi (yoksa Enter): '),
    phoneCode: () => question('SMS kodu: '),
    onError: (err) => console.error('Hata:', err),
  });

  console.log('\n✅ SESSION_STRING (Railway\'e ekle):');
  console.log(client.session.save());
  rl.close();
  process.exit(0);
  