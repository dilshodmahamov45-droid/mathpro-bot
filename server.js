/*
 * MathPro Telegram bot
 * ---------------------
 * Tugmalar: "🧪 Testni boshlash", "📊 Natijalarim", "🔍 Test tahlili"
 * Bot foydalanuvchisi bilan Firestore'dagi javoblarni (`responses` kolleksiyasi)
 * `telegramId` maydoni orqali bog'laydi. Bu maydon sayt tomonidan (index.html)
 * Telegram Mini App ichida test topshirilganda avtomatik yoziladi.
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
 *   PORT                       - Render o'zi avtomatik beradi, qo'lda kerak emas
 */

const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
const WEBHOOK_URL = (process.env.WEBHOOK_URL || '').replace(/\/$/, '');
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
  await sendResultsList(ctx, false);
});

bot.hears('🔍 Test tahlili', async (ctx) => {
  await sendResultsList(ctx, true);
});

// Oddiy matn xabarlari — faqat "PIN kutilmoqda" holatida ishlov beriladi
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
  // Boshqa holatda hech narsa qilmaymiz (tugmalar reply-keyboard orqali ishlaydi)
});

// O'quvchining o'z Telegram ID'siga bog'langan javoblarini Firestore'dan olib keladi
async function fetchMyResponses(telegramId, limit = 10) {
  const snap = await db.collection('responses')
    .where('telegramId', '==', telegramId)
    .orderBy('submittedAt', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('uz-UZ') + ' ' + d.toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}

async function sendResultsList(ctx, detailed) {
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
  if (!detailed) {
    // "Natijalarim" — qisqa ro'yxat, oddiy matn
    const lines = items.map((r, i) => {
      const score = round1(r.score);
      const total = round1(r.total);
      return `${i + 1}. ${r.testTitle || 'Test'} — ${score}/${total} ball  (${formatDate(r.submittedAt)})`;
    });
    ctx.reply('📊 So\'nggi natijalaringiz:\n\n' + lines.join('\n'));
    return;
  }
  // "Test tahlili" — har biri uchun batafsil ko'rish tugmasi (Mini App ichida ochiladi)
  const buttons = items.map(r => {
    const score = round1(r.score);
    const total = round1(r.total);
    const label = `${r.testTitle || 'Test'} — ${score}/${total}`;
    const url = `${SITE_URL}/?review=${r.id}`;
    return [Markup.button.webApp(label, url)];
  });
  ctx.reply('🔍 Batafsil ko\'rish uchun testni tanlang:', Markup.inlineKeyboard(buttons));
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
