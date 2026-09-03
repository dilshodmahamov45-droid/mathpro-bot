/*
 * MathPro Telegram bot
 * ---------------------
 * Tugmalar: "🧪 Testni boshlash", "📊 Natijalarim", "🔍 Test tahlili"
 * Bot foydalanuvchisi bilan Firestore'dagi javoblarni (`responses` kolleksiyasi)
 * `telegramId` maydoni orqali bog'laydi. Bu maydon sayt tomonidan (index.html)
 * Telegram Mini App ichida test topshirilganda avtomatik yoziladi.
 *
 * "Test tahlili" — istalgan turdagi material (video, PDF, rasm, matn xabar).
 * Admin (o'qituvchi) /addtahlil buyrug'i orqali PIN+nom+material yuboradi,
 * bot uni Firestore'ga (fromChatId+messageId sifatida) saqlab qo'yadi.
 * O'quvchi "Test tahlili"ni bosganda, ro'yxatdan testni tanlaydi, bot esa
 * o'sha aslidagi xabarni (qanday turda bo'lishidan qat'i nazar) unga
 * copyMessage orqali qayta yuboradi.
 *
 * Ishga tushirish uchun quyidagi muhit o'zgaruvchilari (environment variables)
 * kerak — Render'da "Environment" bo'limida qo'shiladi:
 *   BOT_TOKEN                 - @BotFather bergan token
 *   SITE_URL                  - masalan https://animated-selkie-003aff.netlify.app
 *   WEBHOOK_URL                - Render bergan asosiy manzil, masalan
 *                                 https://mathpro-bot.onrender.com (oxirida / bo'lmasin)
 *   FIREBASE_SERVICE_ACCOUNT   - Firebase konsolidan olingan xizmat hisobi
 *                                 (service account) JSON faylining TO'LIQ matni,
 *                                 bitta qatorga joylashtirilgan holda
 *   ADMIN_ID                   - sizning shaxsiy Telegram ID raqamingiz (/whoami
 *                                 buyrug'i orqali bilib olasiz), faqat shu odam
 *                                 "Test tahlili" material qo'sha oladi
 *   PORT                       - Render o'zi avtomatik beradi, qo'lda kerak emas
 */

const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
const WEBHOOK_URL = (process.env.WEBHOOK_URL || '').replace(/\/$/, '');
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) { console.error('BOT_TOKEN muhit o\'zgaruvchisi topilmadi!'); process.exit(1); }
if (!SITE_URL) { console.error('SITE_URL muhit o\'zgaruvchisi topilmadi!'); process.exit(1); }

// ---- Firebase Admin ulash ----
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  console.error('FIREBASE_SERVICE_ACCOUNT noto\'g\'ri JSON formatda!', e.message);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const bot = new Telegraf(BOT_TOKEN);

// Har bir chat uchun "hozir nima kutilmoqda" holatini eslab turamiz
// (masalan "Testni boshlash" bosilgach, keyingi xabar PIN kod deb kutiladi).
const pendingState = new Map();
// Admin "test tahlili" qo'shayotganda, PIN+nomni vaqtincha shu yerda saqlaymiz
const adminDraft = new Map();

const mainKeyboard = Markup.keyboard([
  ['🧪 Testni boshlash'],
  ['📊 Natijalarim', '🔍 Test tahlili']
]).resize();

bot.start((ctx) => {
  pendingState.delete(ctx.chat.id);
  const name = ctx.from.first_name || '';
  ctx.reply(
    `Assalomu alaykum${name ? ', ' + name : ''}! 👋\n\nQuyidagi tugmalardan birini tanlang:`,
    mainKeyboard
  );
});

bot.hears('🧪 Testni boshlash', (ctx) => {
  pendingState.set(ctx.chat.id, 'awaiting_pin');
  ctx.reply('Test PIN kodini yuboring (6 xonali):', Markup.removeKeyboard());
});

bot.hears('📊 Natijalarim', async (ctx) => {
  await sendResultsList(ctx);
});

bot.hears('🔍 Test tahlili', async (ctx) => {
  await sendTahlilList(ctx);
});

// Faqat admin (o'qituvchi) uchun: yangi "test tahlili" materiali qo'shish
bot.command('addtahlil', (ctx) => {
  if (!isAdmin(ctx)) { return; }
  pendingState.set(ctx.chat.id, 'admin_awaiting_pin');
  ctx.reply('Qaysi test uchun? PIN kodini yuboring:', Markup.removeKeyboard());
});

// O'zining Telegram ID raqamini bilish uchun (ADMIN_ID sozlamasiga kerak bo'ladi)
bot.command('whoami', (ctx) => {
  ctx.reply(`Sizning Telegram ID: ${ctx.from.id}`);
});

function isAdmin(ctx) {
  return ADMIN_ID && ctx.from.id === ADMIN_ID;
}

// Oddiy matn xabarlari — PIN yoki admin oqimidagi qadamlar uchun ishlov beriladi
bot.on('text', async (ctx) => {
  const state = pendingState.get(ctx.chat.id);

  if (state === 'awaiting_pin') {
    const pin = ctx.message.text.trim();
    if (!/^\d{6}$/.test(pin)) {
      ctx.reply('PIN kod 6 ta raqamdan iborat bo\'lishi kerak. Qayta urinib ko\'ring:');
      return;
    }
    pendingState.delete(ctx.chat.id);
    const url = `${SITE_URL}/?code=${pin}`;
    await ctx.reply(
      'Tayyor! Quyidagi tugmani bosib testni oching:',
      Markup.inlineKeyboard([Markup.button.webApp('📝 Testni ochish', url)])
    );
    await ctx.reply('Yana biror amal tanlang:', mainKeyboard);
    return;
  }

  if (state === 'admin_awaiting_pin' && isAdmin(ctx)) {
    const pin = ctx.message.text.trim();
    if (!/^\d{6}$/.test(pin)) {
      ctx.reply('PIN kod 6 ta raqamdan iborat bo\'lishi kerak. Qayta urinib ko\'ring:');
      return;
    }
    adminDraft.set(ctx.chat.id, { pin });
    pendingState.set(ctx.chat.id, 'admin_awaiting_title');
    ctx.reply('Bu material uchun qisqa nom bering (masalan: "1-mock test tahlili"):');
    return;
  }

  if (state === 'admin_awaiting_title' && isAdmin(ctx)) {
    const draft = adminDraft.get(ctx.chat.id) || {};
    draft.title = ctx.message.text.trim();
    adminDraft.set(ctx.chat.id, draft);
    pendingState.set(ctx.chat.id, 'admin_awaiting_content');
    ctx.reply('Endi materialning o\'zini yuboring — video, PDF, rasm yoki oddiy matn xabar bo\'lishi mumkin:');
    return;
  }

  // "admin_awaiting_content" holatida ham matn xabar kelishi mumkin (masalan
  // tahlil oddiy yozma matn bo'lsa) — shuni umumiy saqlash funksiyasiga uzatamiz
  if (state === 'admin_awaiting_content' && isAdmin(ctx)) {
    await saveTahlilContent(ctx);
    return;
  }
  // Boshqa holatda hech narsa qilmaymiz (tugmalar reply-keyboard orqali ishlaydi)
});

// Video, PDF (document), rasm — admin "material kutilmoqda" holatida bo'lsa saqlaymiz
bot.on(['video', 'document', 'photo'], async (ctx) => {
  const state = pendingState.get(ctx.chat.id);
  if (state === 'admin_awaiting_content' && isAdmin(ctx)) {
    await saveTahlilContent(ctx);
  }
});

// Admin yuborgan xabarni (matn, video, PDF, rasm — qanday bo'lishidan qat'i
// nazar) Firestore'ga "qayerdan olib kelish kerakligi" (chat+xabar ID) sifatida
// saqlaymiz. Keyinchalik shu ID orqali copyMessage bilan boshqa foydalanuvchiga
// aynan shu xabarni (turi qanday bo'lishidan qat'i nazar) qayta yuboramiz.
async function saveTahlilContent(ctx) {
  const draft = adminDraft.get(ctx.chat.id);
  if (!draft || !draft.pin) {
    ctx.reply('Xatolik: avval /addtahlil buyrug\'i bilan qaytadan boshlang.');
    return;
  }
  try {
    await db.collection('testAnalysis').doc(draft.pin).set({
      pin: draft.pin,
      title: draft.title || ('Test ' + draft.pin),
      fromChatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      addedAt: new Date().toISOString()
    });
    ctx.reply(`✅ Saqlandi! Endi o'quvchilar "🔍 Test tahlili" orqali "${draft.title}" materialini ko'ra oladi.`, mainKeyboard);
  } catch (e) {
    console.error(e);
    ctx.reply('Saqlashda xatolik yuz berdi: ' + e.message);
  } finally {
    pendingState.delete(ctx.chat.id);
    adminDraft.delete(ctx.chat.id);
  }
}

// Barcha mavjud "test tahlili" materiallarini ro'yxat qilib ko'rsatamiz
async function sendTahlilList(ctx) {
  let items;
  try {
    const snap = await db.collection('testAnalysis').get();
    items = snap.docs.map(d => d.data());
    items.sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
  } catch (e) {
    console.error(e);
    ctx.reply('Ro\'yxatni olishda xatolik yuz berdi. Birozdan so\'ng qayta urinib ko\'ring.');
    return;
  }
  if (!items.length) {
    ctx.reply('Hozircha hech qanday test tahlili qo\'shilmagan.');
    return;
  }
  const buttons = items.map(r => [Markup.button.callback('📄 ' + r.title, 'tahlil:' + r.pin)]);
  ctx.reply('🔍 Qaysi test tahlilini ko\'rmoqchisiz?', Markup.inlineKeyboard(buttons));
}

// Foydalanuvchi ro'yxatdan birini tanlaganda — o'sha aslidagi xabarni unga qayta yuboramiz
bot.action(/^tahlil:(\d{6})$/, async (ctx) => {
  const pin = ctx.match[1];
  await ctx.answerCbQuery();
  try {
    const doc = await db.collection('testAnalysis').doc(pin).get();
    if (!doc.exists) {
      ctx.reply('Bu material endi mavjud emas.');
      return;
    }
    const { fromChatId, messageId } = doc.data();
    await ctx.telegram.copyMessage(ctx.chat.id, fromChatId, messageId);
  } catch (e) {
    console.error(e);
    ctx.reply('Materialni yuborishda xatolik yuz berdi.');
  }
});

// O'quvchining o'z Telegram ID'siga bog'langan javoblarini Firestore'dan olib keladi.
// Diqqat: faqat where() ishlatamiz (orderBy() bilan birga ishlatilsa, Firestore
// maxsus "composite index" talab qilib, hali yaratilmagani uchun xato beradi) —
// tartiblashni o'zimiz JavaScript'da qilamiz, bu hech qanday indeks talab qilmaydi.
async function fetchMyResponses(telegramId, limit = 10) {
  const snap = await db.collection('responses')
    .where('telegramId', '==', telegramId)
    .get();
  const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  items.sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
  return items.slice(0, limit);
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('uz-UZ') + ' ' + d.toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}

async function sendResultsList(ctx) {
  const telegramId = ctx.from.id;
  let items;
  try {
    items = await fetchMyResponses(telegramId, 10);
  } catch (e) {
    console.error(e);
    ctx.reply('Natijalarni olishda xatolik yuz berdi. Birozdan so\'ng qayta urinib ko\'ring.');
    return;
  }
  if (!items.length) {
    ctx.reply('Hozircha hech qanday test topshirmagansiz. Avval "🧪 Testni boshlash" orqali test yeching.');
    return;
  }
  const lines = items.map((r, i) => {
    const score = round1(r.score);
    const total = round1(r.total);
    return `${i + 1}. ${r.testTitle || 'Test'} — ${score}/${total} ball  (${formatDate(r.submittedAt)})`;
  });
  ctx.reply('📊 So\'nggi natijalaringiz:\n\n' + lines.join('\n'));
}

function round1(n) {
  const x = Math.round((Number(n) || 0) * 10) / 10;
  return Number.isInteger(x) ? String(x) : String(x);
}

// ---- Webhook server ----
const app = express();
app.use(express.json());

const webhookPath = `/webhook/${BOT_TOKEN}`;
app.use(bot.webhookCallback(webhookPath));

app.get('/', (req, res) => res.send('MathPro bot ishlayapti.'));

app.listen(PORT, async () => {
  console.log(`Server ${PORT} portda ishga tushdi`);
  if (WEBHOOK_URL) {
    try {
      await bot.telegram.setWebhook(`${WEBHOOK_URL}${webhookPath}`);
      console.log('Webhook o\'rnatildi:', `${WEBHOOK_URL}${webhookPath}`);
    } catch (e) {
      console.error('Webhook o\'rnatishda xatolik:', e.message);
    }
  } else {
    console.warn('WEBHOOK_URL berilmagan — webhook o\'rnatilmadi.');
  }
});
