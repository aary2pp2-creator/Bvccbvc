import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import Stripe from 'stripe';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const STORE = process.env.STORE_FILE || '/tmp/ai-dollar-orders.json';
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const products = {
  captions: { name: '10 Social Media Captions', amount: 500, description: 'Ten tailored captions in English.' },
  content_pack: { name: '30-Day Content Pack', amount: 1500, description: 'Thirty post ideas with captions.' },
  calendar: { name: 'Monthly Content Calendar', amount: 2900, description: 'A practical 30-day publishing calendar.' }
};
await fs.mkdir(path.dirname(STORE), { recursive: true });
try { await fs.access(STORE); } catch { await fs.writeFile(STORE, '[]'); }
const readOrders = async () => JSON.parse(await fs.readFile(STORE, 'utf8').catch(() => '[]'));
const writeOrders = async orders => fs.writeFile(STORE, JSON.stringify(orders, null, 2));
const sendTelegram = async (chatId, text) => {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  if (!r.ok) throw new Error('Telegram sendMessage failed');
};
async function makeContent(key, brief) {
  if (!process.env.AI_API_KEY) return `Your order brief: ${brief}\n\nAI content generation is not enabled yet. The owner must add AI_API_KEY to Render.`;
  const base = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.AI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.AI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: `Create ${products[key].name} in polished English for this customer brief: ${brief}` }] })
  });
  if (!r.ok) throw new Error('AI provider returned ' + r.status);
  return (await r.json()).choices?.[0]?.message?.content || 'No content returned.';
}
function pdfBuffer(title, body) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 }), chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.fontSize(20).text(title); doc.moveDown(); doc.fontSize(10).text('AI Dollar Business | Digital delivery'); doc.moveDown();
    doc.fontSize(11).text(body, { lineGap: 4 }); doc.end();
  });
}
async function deliver(order) {
  const content = await makeContent(order.key, order.brief);
  const pdf = await pdfBuffer(order.name, content);
  if (order.chatId && process.env.TELEGRAM_BOT_TOKEN) {
    const form = new FormData();
    form.append('chat_id', String(order.chatId));
    form.append('caption', 'Your digital product is ready.');
    form.append('document', new Blob([pdf], { type: 'application/pdf' }), order.id + '.pdf');
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
  }
}
app.get('/health', (_req, res) => res.json({ ok: true, service: 'AI Dollar Business Telegram bot' }));
app.use(express.json({ limit: '256kb' }));
app.post('/telegram/webhook', async (req, res) => {
  if (process.env.TELEGRAM_WEBHOOK_SECRET &&
      req.get('x-telegram-bot-api-secret-token') !== process.env.TELEGRAM_WEBHOOK_SECRET) return res.sendStatus(401);
  res.sendStatus(200);
  try {
    const m = req.body?.message; if (!m?.text) return;
    const chatId = m.chat.id, t = m.text.trim();
    if (t === '/start' || t === '/help') {
      await sendTelegram(chatId, 'Welcome to AI Dollar Business!\n\n/services - View products\n/buy - Order a digital product\n\nExample:\n/buy captions | A coffee shop targeting young professionals');
    } else if (t === '/services') {
      await sendTelegram(chatId, 'Digital products:\n• 10 Social Media Captions — $5\n• 30-Day Content Pack — $15\n• Monthly Content Calendar — $29\n\nUse /buy captions | your brief');
    } else if (t.startsWith('/buy')) {
      const match = t.match(/^\/buy\s+(captions|content_pack|calendar)\s*\|\s*(.{12,})$/i);
      if (!match) { await sendTelegram(chatId, 'Format: /buy captions | Describe your business, audience and goal (at least 12 characters).'); return; }
      if (!stripe) { await sendTelegram(chatId, 'Orders are not accepting payment yet. The owner must configure Stripe before purchases can be completed.'); return; }
      const key = match[1].toLowerCase(), p = products[key];
      const order = { id: crypto.randomUUID(), key, name: p.name, amount: p.amount, brief: match[2], chatId };
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: p.amount, product_data: { name: p.name, description: p.description } } }],
        metadata: { orderId: order.id },
        success_url: (process.env.PUBLIC_BASE_URL || 'https://example.com') + '/success',
        cancel_url: (process.env.PUBLIC_BASE_URL || 'https://example.com') + '/cancel'
      });
      const orders = await readOrders(); orders.push({ ...order, sessionId: session.id }); await writeOrders(orders);
      await sendTelegram(chatId, 'Complete your secure payment here: ' + session.url);
    } else await sendTelegram(chatId, 'Use /services to view products or /start for help.');
  } catch (e) { console.error('Telegram update error:', e); }
});
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.sendStatus(503);
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET); }
  catch { return res.sendStatus(400); }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object, orders = await readOrders();
    const order = orders.find(o => o.id === session.metadata?.orderId);
    if (order && !order.delivered) {
      try { await deliver(order); order.delivered = true; await writeOrders(orders); }
      catch (e) { console.error('Delivery error:', e); }
    }
  }
  res.json({ received: true });
});
app.listen(PORT, '0.0.0.0', () => {
  console.log('AI Dollar Business bot listening on ' + PORT);
  // Register Telegram's webhook automatically whenever the service starts.
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    if (!baseUrl) {
      console.error('PUBLIC_BASE_URL is missing; Telegram webhook was not registered.');
      return;
    }
    const payload = { url: baseUrl + '/telegram/webhook' };
    if (process.env.TELEGRAM_WEBHOOK_SECRET) {
      payload.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;
    }
    fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/setWebhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(async response => {
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.description || 'setWebhook failed');
      console.log('Telegram webhook registered successfully.');
    }).catch(error => console.error('Telegram webhook registration failed:', error.message));
  } else {
    console.log('TELEGRAM_BOT_TOKEN is not set; webhook registration is waiting for the bot token.');
  }
});
