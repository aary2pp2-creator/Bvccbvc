import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const STORE = process.env.STORE_FILE || '/tmp/ai-dollar-orders.json';

const products = {
  captions: { name: '10 Social Media Captions', stars: 350, description: 'Ten tailored captions in English.' },
  content_pack: { name: '30-Day Content Pack', stars: 1000, description: 'Thirty post ideas with captions.' },
  calendar: { name: 'Monthly Content Calendar', stars: 1900, description: 'A practical 30-day publishing calendar.' }
};

await fs.mkdir(path.dirname(STORE), { recursive: true });
try { await fs.access(STORE); } catch { await fs.writeFile(STORE, '[]'); }

const readOrders = async () => JSON.parse(await fs.readFile(STORE, 'utf8').catch(() => '[]'));
const writeOrders = async orders => fs.writeFile(STORE, JSON.stringify(orders, null, 2));

async function telegram(method, body) {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram ${method} failed`);
  return result.result;
}

async function sendTelegram(chatId, text) {
  return telegram('sendMessage', { chat_id: chatId, text });
}

async function makeContent(key, brief) {
  if (!process.env.AI_API_KEY) {
    return `Thank you for your order.\n\nCustomer brief: ${brief}\n\nThis product is being prepared. The shop owner must configure AI_API_KEY on Render before automated AI content generation can be enabled.`;
  }
  const base = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const response = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.AI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.AI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: `Create ${products[key].name} in polished English for this customer brief: ${brief}` }]
    })
  });
  if (!response.ok) throw new Error('AI provider returned ' + response.status);
  return (await response.json()).choices?.[0]?.message?.content || 'No content returned.';
}

function pdfBuffer(title, body) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(20).text(title);
    doc.moveDown();
    doc.fontSize(10).text('AI Dollar Business | Digital delivery');
    doc.moveDown();
    doc.fontSize(11).text(body, { lineGap: 4 });
    doc.end();
  });
}

async function deliver(order) {
  const content = await makeContent(order.key, order.brief);
  const pdf = await pdfBuffer(order.name, content);
  const form = new FormData();
  form.append('chat_id', String(order.chatId));
  form.append('caption', 'Your digital product is ready. Thank you for your purchase!');
  form.append('document', new Blob([pdf], { type: 'application/pdf' }), order.id + '.pdf');
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: 'POST',
    body: form
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || 'Telegram document delivery failed');
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'AI Dollar Business Telegram Stars bot' }));
app.use(express.json({ limit: '256kb' }));

app.post('/telegram/webhook', async (req, res) => {
  if (process.env.TELEGRAM_WEBHOOK_SECRET &&
      req.get('x-telegram-bot-api-secret-token') !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }

  // Acknowledge Telegram quickly; payment queries are answered immediately below.
  res.sendStatus(200);

  try {
    const update = req.body;

    if (update?.pre_checkout_query) {
      const query = update.pre_checkout_query;
      const orders = await readOrders();
      const order = orders.find(item => item.id === query.invoice_payload && !item.delivered);
      const valid = order && query.currency === 'XTR' && query.total_amount === order.stars && String(query.from.id) === String(order.userId);
      await telegram('answerPreCheckoutQuery', {
        pre_checkout_query_id: query.id,
        ok: Boolean(valid),
        ...(!valid ? { error_message: 'This order is no longer valid. Please start again with /buy.' } : {})
      });
      return;
    }

    const message = update?.message;
    if (!message) return;
    const chatId = message.chat.id;

    if (message.successful_payment) {
      const payment = message.successful_payment;
      const orders = await readOrders();
      const order = orders.find(item => item.id === payment.invoice_payload && String(item.chatId) === String(chatId));
      if (!order || payment.currency !== 'XTR' || payment.total_amount !== order.stars) {
        await sendTelegram(chatId, 'We could not match this payment to an order. Please contact /paysupport.');
        return;
      }
      if (order.delivered) return;
      order.telegramPaymentChargeId = payment.telegram_payment_charge_id;
      order.paid = true;
      await writeOrders(orders);
      try {
        await deliver(order);
        order.delivered = true;
        await writeOrders(orders);
      } catch (error) {
        console.error('Delivery error:', error);
        await sendTelegram(chatId, 'Payment received, but automatic delivery failed. Please use /paysupport and we will help.');
      }
      return;
    }

    if (!message.text) return;
    const t = message.text.trim();

    if (t === '/start' || t === '/help') {
      await sendTelegram(chatId,
        'Welcome to AI Dollar Business!\n\n/services - View digital products\n/buy - Purchase a product\n/terms - Terms of sale\n/paysupport - Payment help\n\nExample:\n/buy captions | A coffee shop targeting young professionals');
    } else if (t === '/services') {
      await sendTelegram(chatId,
        'Digital products (paid with Telegram Stars):\n• 10 Social Media Captions — 350 Stars\n• 30-Day Content Pack — 1000 Stars\n• Monthly Content Calendar — 1900 Stars\n\nUse /buy captions | Describe your business and goal.');
    } else if (t === '/terms') {
      await sendTelegram(chatId,
        'Terms: Digital products are prepared from the brief you provide and delivered in this Telegram chat after successful payment. For help or a payment issue, use /paysupport. Please review the product description before paying.');
    } else if (t === '/paysupport') {
      await sendTelegram(chatId,
        'Payment support: Please reply with your order details and a short description of the issue. Keep your Telegram payment receipt until the issue is resolved.');
    } else if (t.startsWith('/buy')) {
      const match = t.match(/^\/buy\s+(captions|content_pack|calendar)\s*\|\s*(.{12,})$/i);
      if (!match) {
        await sendTelegram(chatId, 'Format: /buy captions | Describe your business, audience and goal (at least 12 characters).');
        return;
      }
      const key = match[1].toLowerCase();
      const product = products[key];
      const order = {
        id: crypto.randomUUID(),
        key,
        name: product.name,
        stars: product.stars,
        brief: match[2],
        chatId,
        userId: message.from.id,
        paid: false,
        delivered: false
      };
      const orders = await readOrders();
      orders.push(order);
      await writeOrders(orders);
      await telegram('sendInvoice', {
        chat_id: chatId,
        title: product.name,
        description: product.description,
        payload: order.id,
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: product.name, amount: product.stars }]
      });
    } else {
      await sendTelegram(chatId, 'Use /services to view products or /start for help.');
    }
  } catch (error) {
    console.error('Telegram update error:', error);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('AI Dollar Business Telegram Stars bot listening on ' + PORT);
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    if (!baseUrl) {
      console.error('PUBLIC_BASE_URL is missing; Telegram webhook was not registered.');
      return;
    }
    const payload = { url: baseUrl + '/telegram/webhook' };
    if (process.env.TELEGRAM_WEBHOOK_SECRET) payload.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;
    telegram('setWebhook', payload)
      .then(() => console.log('Telegram webhook registered successfully.'))
      .catch(error => console.error('Telegram webhook registration failed:', error.message));
  } else {
    console.log('TELEGRAM_BOT_TOKEN is not set; webhook registration is waiting for the bot token.');
  }
});
