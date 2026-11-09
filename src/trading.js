import fs from 'node:fs/promises';

const PAPER_FILE = process.env.PAPER_TRADING_FILE || '/tmp/ai-dollar-paper-trading.json';
const STARTING_CASH = 10000;
const FEE_RATE = 0.001; // 0.10% simulated fee per side
const SYMBOLS = {
  BTC: { label: 'Bitcoin', market: 'crypto', binance: 'BTCUSDT' },
  ETH: { label: 'Ethereum', market: 'crypto', binance: 'ETHUSDT' },
  EURUSD: { label: 'EUR/USD', market: 'forex', yahoo: 'EURUSD=X' },
  GBPUSD: { label: 'GBP/USD', market: 'forex', yahoo: 'GBPUSD=X' },
  USDJPY: { label: 'USD/JPY', market: 'forex', yahoo: 'USDJPY=X' },
  XAUUSD: { label: 'Gold (futures proxy)', market: 'forex', yahoo: 'GC=F' }
};
const quoteCache = new Map();

async function readAccounts() {
  try { return JSON.parse(await fs.readFile(PAPER_FILE, 'utf8')); }
  catch { return {}; }
}
async function writeAccounts(accounts) {
  await fs.mkdir('/tmp', { recursive: true });
  await fs.writeFile(PAPER_FILE, JSON.stringify(accounts, null, 2));
}
function accountFor(accounts, userId) {
  if (!accounts[userId]) accounts[userId] = { cash: STARTING_CASH, positions: {}, realizedPnl: 0, trades: [] };
  return accounts[userId];
}
function sma(values, period) {
  const sample = values.slice(-period);
  return sample.length ? sample.reduce((a, b) => a + b, 0) / sample.length : null;
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    if (delta > 0) gains += delta; else losses -= delta;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}
async function getQuote(symbol) {
  const key = symbol.toUpperCase();
  const asset = SYMBOLS[key];
  if (!asset) throw new Error('Unknown symbol. Use BTC, ETH, EURUSD, GBPUSD, USDJPY or XAUUSD.');
  const cached = quoteCache.get(key);
  if (cached && Date.now() - cached.at < 60000) return cached.value;

  let closes = [], price, updatedAt = new Date().toISOString();
  if (asset.market === 'crypto') {
    const response = await fetch('https://api.binance.com/api/v3/klines?symbol=' + asset.binance + '&interval=1d&limit=60');
    if (!response.ok) throw new Error('Crypto market data is temporarily unavailable.');
    const candles = await response.json();
    closes = candles.map(c => Number(c[4])).filter(Number.isFinite);
    price = closes.at(-1);
    updatedAt = new Date(Number(candles.at(-1)?.[6] || Date.now())).toISOString();
  } else {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(asset.yahoo) + '?range=3mo&interval=1d';
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) throw new Error('Forex/gold market data is temporarily unavailable.');
    const payload = await response.json();
    const result = payload?.chart?.result?.[0];
    closes = (result?.indicators?.quote?.[0]?.close || []).filter(v => Number.isFinite(v));
    price = Number(result?.meta?.regularMarketPrice || closes.at(-1));
    updatedAt = result?.meta?.regularMarketTime ? new Date(result.meta.regularMarketTime * 1000).toISOString() : updatedAt;
  }
  if (!Number.isFinite(price) || closes.length < 20) throw new Error('Not enough valid market data for ' + key + '.');
  const fast = sma(closes, 20), slow = sma(closes, 50), momentum = rsi(closes);
  let signal = 'HOLD';
  if (fast !== null && slow !== null && fast > slow && momentum >= 45 && momentum <= 70) signal = 'BUY (paper only)';
  if (fast !== null && slow !== null && fast < slow && momentum >= 30 && momentum <= 55) signal = 'SELL (paper only)';
  const value = { symbol: key, label: asset.label, market: asset.market, price, fast, slow, rsi: momentum, signal, updatedAt };
  quoteCache.set(key, { at: Date.now(), value });
  return value;
}
function money(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
}
async function explainWithAI(quote) {
  if (!process.env.OPENROUTER_API_KEY) return 'AI explanation is not configured; the signal above comes from transparent SMA20/SMA50 + RSI rules.';
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY, 'Content-Type': 'application/json', 'X-Title': 'AI Dollar Trading Bot' },
      body: JSON.stringify({
        model: 'openrouter/free',
        temperature: 0.2,
        max_tokens: 160,
        messages: [
          { role: 'system', content: 'Explain technical indicators briefly and cautiously. Do not promise profit or present a signal as financial advice. State clearly that this is paper trading.' },
          { role: 'user', content: JSON.stringify({ symbol: quote.symbol, price: quote.price, sma20: quote.fast, sma50: quote.slow, rsi14: quote.rsi, ruleSignal: quote.signal }) }
        ]
      })
    });
    const data = await response.json();
    return data?.choices?.[0]?.message?.content?.trim() || 'AI explanation unavailable; rule-based signal only.';
  } catch {
    return 'AI explanation temporarily unavailable; rule-based signal only.';
  }
}
async function showSignal(chatId, symbol, send) {
  const q = await getQuote(symbol);
  const ai = await explainWithAI(q);
  await send(chatId,
    '📊 ' + q.label + ' (' + q.symbol + ')\n' +
    'Market: ' + (q.market === 'crypto' ? 'Crypto' : 'Forex / commodities') + '\n' +
    'Latest quote: ' + q.price.toPrecision(8) + (q.market === 'crypto' ? ' USDT' : '') + '\n' +
    'SMA20: ' + q.fast.toPrecision(8) + ' | SMA50: ' + (q.slow === null ? 'N/A' : q.slow.toPrecision(8)) + '\n' +
    'RSI14: ' + (q.rsi === null ? 'N/A' : q.rsi.toFixed(1)) + '\n' +
    'Rule signal: ' + q.signal + '\n\n' + ai +
    '\n\nData time: ' + q.updatedAt + '\nEducational demo only — not investment advice.'
  );
}
async function showPortfolio(chatId, userId, send) {
  const accounts = await readAccounts();
  const account = accountFor(accounts, String(userId));
  let total = account.cash, lines = [];
  for (const [symbol, position] of Object.entries(account.positions)) {
    try {
      const q = await getQuote(symbol);
      const value = position.units * q.price;
      total += value;
      lines.push(symbol + ': ' + position.units.toFixed(8) + ' units | value ' + money(value) + ' | unrealized ' + money(value - position.cost));
    } catch {
      lines.push(symbol + ': ' + position.units.toFixed(8) + ' units | current price unavailable');
    }
  }
  await send(chatId,
    '📒 PAPER PORTFOLIO (virtual only)\n' +
    'Cash: ' + money(account.cash) + '\n' +
    'Estimated total: ' + money(total) + '\n' +
    'Realized P/L: ' + money(account.realizedPnl) + '\n' +
    'Completed paper trades: ' + account.trades.length + '\n\n' +
    (lines.length ? lines.join('\n') : 'No open positions yet.') +
    '\n\nStarting virtual balance: ' + money(STARTING_CASH) + '. No real funds are connected.'
  );
  await writeAccounts(accounts);
}
async function paperBuy(chatId, userId, symbol, amount, send) {
  const q = await getQuote(symbol);
  const notional = Number(amount);
  if (!Number.isFinite(notional) || notional < 10 || notional > 5000) throw new Error('Enter an amount between 10 and 5,000 virtual USD.');
  const accounts = await readAccounts();
  const account = accountFor(accounts, String(userId));
  const fee = notional * FEE_RATE;
  const totalCost = notional + fee;
  if (totalCost > account.cash) throw new Error('Not enough virtual cash. Available: ' + money(account.cash));
  const units = notional / q.price;
  const old = account.positions[symbol] || { units: 0, cost: 0 };
  account.positions[symbol] = { units: old.units + units, cost: old.cost + totalCost };
  account.cash -= totalCost;
  account.trades.push({ side: 'BUY', symbol, units, price: q.price, notional, fee, at: new Date().toISOString() });
  await writeAccounts(accounts);
  await send(chatId, '✅ PAPER BUY recorded\n' + symbol + ' | ' + units.toFixed(8) + ' units\nPrice: ' + q.price + '\nNotional: ' + money(notional) + '\nSimulated fee: ' + money(fee) + '\nRemaining virtual cash: ' + money(account.cash));
}
async function paperSell(chatId, userId, symbol, send) {
  const q = await getQuote(symbol);
  const accounts = await readAccounts();
  const account = accountFor(accounts, String(userId));
  const position = account.positions[symbol];
  if (!position || position.units <= 0) throw new Error('No open paper position for ' + symbol + '.');
  const gross = position.units * q.price;
  const fee = gross * FEE_RATE;
  const net = gross - fee;
  const pnl = net - position.cost;
  account.cash += net;
  account.realizedPnl += pnl;
  account.trades.push({ side: 'SELL', symbol, units: position.units, price: q.price, notional: gross, fee, pnl, at: new Date().toISOString() });
  delete account.positions[symbol];
  await writeAccounts(accounts);
  await send(chatId, '✅ PAPER SELL recorded\n' + symbol + ' | ' + position.units.toFixed(8) + ' units\nExit price: ' + q.price + '\nNet proceeds: ' + money(net) + '\nRealized P/L after simulated fees: ' + money(pnl) + '\nNo real order was sent.');
}

export async function handleTradingCommand(text, chatId, userId, send) {
  const input = String(text || '').trim();
  const lower = input.toLowerCase();
  if (!['/trade', '/market', '/signal', '/portfolio', '/paper'].some(prefix => lower === prefix || lower.startsWith(prefix + ' '))) return false;
  try {
    if (lower === '/trade' || lower === '/trade help') {
      await send(chatId,
        '🤖 AI DOLLAR TRADING — PAPER MODE\n\n' +
        '/market — quotes and rule signals for all demo markets\n' +
        '/signal BTC — analyze one symbol\n' +
        '/portfolio — your virtual portfolio\n' +
        '/paper buy BTC 100 — buy 100 virtual USD of BTC\n' +
        '/paper sell BTC — sell the full BTC paper position\n\n' +
        'Symbols: BTC, ETH, EURUSD, GBPUSD, USDJPY, XAUUSD\n' +
        'Virtual starting balance: $10,000. No real orders, deposits or withdrawals.'
      );
      return true;
    }
    if (lower === '/market') {
      const symbols = Object.keys(SYMBOLS);
      const results = await Promise.allSettled(symbols.map(getQuote));
      const lines = results.map((r, i) => r.status === 'fulfilled'
        ? r.value.symbol + ': ' + r.value.price.toPrecision(8) + ' | ' + r.value.signal
        : symbols[i] + ': quote unavailable');
      await send(chatId, '📈 MARKET WATCH (paper demo)\n\n' + lines.join('\n') + '\n\nSignals use daily SMA20/SMA50 and RSI14. Quotes may be delayed.');
      return true;
    }
    if (lower.startsWith('/signal ')) {
      await showSignal(chatId, input.split(/\s+/)[1].toUpperCase(), send);
      return true;
    }
    if (lower === '/portfolio') {
      await showPortfolio(chatId, userId, send);
      return true;
    }
    if (lower.startsWith('/paper buy ')) {
      const parts = input.split(/\s+/);
      if (parts.length !== 4) throw new Error('Format: /paper buy BTC 100');
      await paperBuy(chatId, userId, parts[2].toUpperCase(), parts[3], send);
      return true;
    }
    if (lower.startsWith('/paper sell ')) {
      const parts = input.split(/\s+/);
      if (parts.length !== 3) throw new Error('Format: /paper sell BTC');
      await paperSell(chatId, userId, parts[2].toUpperCase(), send);
      return true;
    }
    if (lower === '/paper') {
      await send(chatId, 'Use /trade to see paper-trading commands.');
      return true;
    }
    await send(chatId, 'Unknown paper-trading command. Use /trade for help.');
    return true;
  } catch (error) {
    await send(chatId, 'Trading demo: ' + String(error.message || error).slice(0, 500));
    return true;
  }
}
