import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { handleTradingCommand } from './trading.js';

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

async function generateContent(key, brief, strict = false) {
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn('OPENROUTER_API_KEY is missing; using offline templates.');
    if (strict) throw new Error('OPENROUTER_API_KEY is missing in Render environment variables.');
    return makeContent(key, brief);
  }

  const productInstructions = {
    captions: 'Write exactly 10 distinct, polished, ready-to-use social media captions in English. Include suitable calls to action and relevant hashtags.',
    content_pack: 'Create a useful 30-day social media content pack in English. For each day include a topic, format, complete caption, and call to action.',
    calendar: 'Create a practical 30-day social media content calendar in English. For each day include topic, format, content goal, and a concise posting note.'
  };

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.PUBLIC_BASE_URL || 'https://ai-dollar-business-2026.onrender.com',
        'X-Title': 'AI Dollar Business'
      },
      body: JSON.stringify({
        model: 'openrouter/free',
        messages: [
          {
            role: 'system',
            content: 'You are a professional social media content creator. Write original, specific, useful business content in clear English. Do not invent customer testimonials, statistics, or business facts. If details are missing, use sensible general wording.'
          },
          {
            role: 'user',
            content: productInstructions[key] + '\\n\\nCustomer brief: ' + String(brief || 'General small business').slice(0, 3000) + '\\n\\nMake the result specific to this brief. Return only the finished product.'
          }
        ],
        temperature: 0.7,
        max_tokens: key === 'captions' ? 1800 : 4000
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error?.message || 'OpenRouter request failed with HTTP ' + response.status);
    }
    const generated = data?.choices?.[0]?.message?.content;
    if (typeof generated !== 'string' || !generated.trim()) {
      throw new Error('OpenRouter returned an empty response');
    }
    console.log('OpenRouter content generation succeeded for ' + key);
    return generated.trim();
  } catch (error) {
    console.error('OpenRouter generation failed; using offline templates:', error.message);
    if (strict) throw error;
    return makeContent(key, brief);
  }
}

const aiTestCooldowns = new Map();
let lastAiTestAt = 0;

function makeContent(key, brief) {
  const context = String(brief || 'your business').replace(/\s+/g, ' ').trim();
  const topics = [
    'Introduce your business and the problem it solves',
    'Share one practical tip for your audience',
    'Explain a common mistake and how to avoid it',
    'Show a behind-the-scenes moment',
    'Answer a frequently asked customer question',
    'Highlight one product or service benefit',
    'Share a short customer success story (use a real one)',
    'Explain how your process works',
    'Post a useful checklist',
    'Share a myth and the facts behind it',
    'Introduce the people behind the business',
    'Compare two ways to solve a customer problem',
    'Share a quick tutorial',
    'Explain who benefits most from your offer',
    'Invite followers to ask questions',
    'Share a thoughtful industry observation',
    'Show how to get started with your service',
    'Highlight a feature customers often overlook',
    'Share a frequently used resource or tool',
    'Tell the story behind your business',
    'Give a step-by-step tip',
    'Address a common hesitation',
    'Share a helpful do-and-don’t list',
    'Explain what makes your approach different',
    'Invite the audience to share an opinion',
    'Show a product or service in use',
    'Share a short lesson learned',
    'Answer a beginner-level question',
    'Summarize the biggest benefit you offer',
    'Invite the audience to take the next step'
  ];
  const formats = ['Single-image post', 'Carousel', 'Short video', 'Story', 'Text post'];
  const cta = ['What would you add? Tell us below.', 'Save this tip for later.', 'Send us a message to learn more.', 'Share this with someone who needs it.', 'Follow for more practical ideas.'];

  if (key === 'captions') {
    const captions = [
      `A better way to think about ${context}: focus on the value you bring, one helpful step at a time. What would make the biggest difference for you today? #SmallBusiness #HelpfulTips`,
      `Your goals deserve a clear plan. At ${context}, we believe useful solutions should feel simple and practical. What are you working toward? #BusinessGrowth #YourGoals`,
      `Quick reminder: progress comes from consistent, useful action—not trying to do everything at once. Save this for the days you need a reset. #Motivation #Consistency`,
      `Looking for a smarter next step? Start by identifying the one challenge you want to solve, then choose an action you can take today. #PracticalAdvice #BusinessTips`,
      `Behind every strong result is a process built with care. We are here to make the next step clearer and easier. Send us your questions. #CustomerCare #SmallBusiness`,
      `Let's make things simpler. Choose one priority, give it your attention, and build from there. What is your number-one priority this week? #Focus #Progress`,
      `A question worth asking: does your current approach make life easier for the people you serve? Keep their needs at the centre of every decision. #CustomerFirst #BusinessAdvice`,
      `Small improvements can create meaningful momentum. Try one new idea, learn from the result, and keep refining your approach. #KeepImproving #Entrepreneurship`,
      `Not sure where to begin? Tell us what you are trying to achieve and what is getting in the way. We would love to hear your perspective. #Community #LetsTalk`,
      `Thank you for being part of our community. Your questions, ideas, and feedback help shape what we share next. What topic should we cover? #ThankYou #CommunityFirst`
    ];
    return '10 Social Media Captions\n\nCustomer brief: ' + context + '\n\n' +
      captions.map((caption, index) => (index + 1) + '. ' + caption).join('\n\n') +
      '\n\nNote: These captions are prepared from ready-made templates without an AI service. Review and personalize details before publishing.';
  }

  if (key === 'content_pack') {
    return '30-Day Content Pack\n\nCustomer brief: ' + context + '\n\n' +
      topics.map((topic, index) => {
        const day = index + 1;
        return 'Day ' + day + ' — ' + topic + '\nFormat: ' + formats[index % formats.length] +
          '\nCaption starter: ' + topic + '. Share one useful point related to ' + context + ' and explain how your audience can apply it.' +
          '\nCall to action: ' + cta[index % cta.length];
      }).join('\n\n') +
      '\n\nNote: This is a ready-made content framework generated without an AI service. Add your real examples, product details, and brand voice before publishing.';
  }

  if (key === 'calendar') {
    return 'Monthly Content Calendar\n\nCustomer brief: ' + context + '\n\n' +
      topics.map((topic, index) => {
        const day = index + 1;
        return 'Day ' + day + ': ' + topic + '\nSuggested format: ' + formats[index % formats.length] +
          '\nGoal: ' + (index % 3 === 0 ? 'Build awareness' : index % 3 === 1 ? 'Educate and build trust' : 'Encourage conversation') +
          '\nPlanning note: Create a post about ' + topic.toLowerCase() + ' for ' + context + '.';
      }).join('\n\n') +
      '\n\nNote: This is a ready-made monthly planning template generated without an AI service. Adjust dates and topics to suit your audience and business.';
  }

  return 'Thank you for your order.\n\nCustomer brief: ' + context +
    '\n\nPlease contact /paysupport if you need help.';
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
  const content = await generateContent(order.key, order.brief);
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
app.use(express.static(path.join(process.cwd(), 'public')));

const orderRateLimits = new Map();
app.post('/api/orders', async (req, res) => {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const last = orderRateLimits.get(ip) || 0;
  if (now - last < 30000) return res.status(429).json({ ok: false, message: 'Please wait before sending another order.' });

  const { name, contact, service, details, language } = req.body || {};
  const clean = value => String(value || '').trim().slice(0, 1500);
  const customerName = clean(name);
  const customerContact = clean(contact);
  const serviceName = clean(service);
  const brief = clean(details);
  if (!customerName || !customerContact || !serviceName || brief.length < 10) {
    return res.status(400).json({ ok: false, message: 'Please complete all fields and provide at least 10 characters of details.' });
  }
  if (!process.env.ADMIN_CHAT_ID) {
    console.error('ADMIN_CHAT_ID is missing; website order notification was not sent.');
    return res.status(503).json({ ok: false, message: 'Order notifications are not configured yet. Please try again later.' });
  }
  const message = [
    '🛍️ New website order — AI Dollar Business',
    'Name: ' + customerName,
    'Contact: ' + customerContact,
    'Service: ' + serviceName,
    'Language: ' + (language === 'fa' ? 'Persian' : 'English'),
    'Details: ' + brief
  ].join('\n');
  try {
    await sendTelegram(process.env.ADMIN_CHAT_ID, message);
    orderRateLimits.set(ip, now);
    return res.json({ ok: true, message: 'Your order request has been sent. We will contact you soon.' });
  } catch (error) {
    console.error('Website order notification failed:', error.message);
    return res.status(502).json({ ok: false, message: 'We could not send your request right now. Please try again later.' });
  }
});


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
    if (await handleTradingCommand(t, chatId, message.from.id, sendTelegram)) return;

    if (t === '/aitest') {
      if (message.chat.type !== 'private') {
        await sendTelegram(chatId, 'Please run /aitest in a private chat with this bot.');
        return;
      }
      const now = Date.now();
      const lastForChat = aiTestCooldowns.get(String(chatId)) || 0;
      if (now - lastAiTestAt < 60000 || now - lastForChat < 600000) {
        await sendTelegram(chatId, 'The AI test is rate-limited. Please try again in a few minutes.');
        return;
      }
      lastAiTestAt = now;
      aiTestCooldowns.set(String(chatId), now);
      await sendTelegram(chatId, 'Testing the OpenRouter connection. No purchase or payment is required.');
      try {
        const sample = await generateContent('captions', 'A coffee shop targeting young professionals', true);
        await sendTelegram(chatId, 'OpenRouter connection successful. Here is a short sample:\\n\\n' + sample.slice(0, 3000));
      } catch (error) {
        console.error('OpenRouter test command failed:', error.message);
        await sendTelegram(chatId, 'OpenRouter test failed: ' + error.message.slice(0, 700) + '\\n\\nPlease check the OPENROUTER_API_KEY value in Render Environment settings. Do not send the key in chat.');
      }
      return;
    } else if (t === '/start' || t === '/help') {
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
