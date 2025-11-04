import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import axios from 'axios';
import dotenv from 'dotenv';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { RSI, EMA } from 'technicalindicators';
import { spawn } from 'child_process';

dotenv.config();

function startMT5Bridge() {
  const bridge = spawn("python", ["mt5_bridge.py"], { stdio: "inherit" });
  bridge.on("close", (code) => {
    console.log(chalk.red(`⚠️ MT5 Bridge exited with code ${code}`));
    // Optional auto-restart
    setTimeout(startMT5Bridge, 5000);
  });
}

startMT5Bridge();


const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = parseInt(process.env.PORT || '8080', 10);
const STATS_FILE = path.resolve(process.cwd(), 'data', 'stats.json'); // ensure directory exists
const CANDLE_FETCH_RETRY_MS = 5000;
const CANDLE_LIMIT = 200;
const CANDLE_INTERVAL = '5m'; // used in log only; api query param used below
const SL_PERCENT = 0.002; // 0.2% stop loss
const TP_PERCENT = 0.004; // 0.4% take profit

// NEW CONFIG: partial close behavior
const PARTIAL_CLOSE_PCT = parseFloat(process.env.PARTIAL_CLOSE_PCT || '0.8'); // close 80% by default
const MIN_REMAINING_LOT = parseFloat(process.env.MIN_REMAINING_LOT || '0.0001');

// --- Trading & Performance state ---
let lotSize = parseFloat(process.env.DEFAULT_LOT || '0.1'); // lots (1 lot = 100 oz) — verify with your broker!
let activeTrade = null;
let lastSignal = null;

// persistent stats
const defaultStats = {
  totalTrades: 0,
  wins: 0,
  losses: 0,
  netProfit: 0 // in USD
};
let stats = { ...defaultStats };

// ensure data dir exists
try {
  fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
} catch (e) {
  console.warn('Could not create data directory:', e.message);
}
// === MT5 Bridge Connector ===
// === MT5 BRIDGE FUNCTION ===
async function sendTradeToMT5(action, symbol = "XAUUSD", lot = 0.1, sl = null, tp = null, ticket = null) {
  try {
    const payload = { 
      action: action.toUpperCase(), 
      symbol, 
      lot 
    };

    if (sl !== null) payload.sl = sl;
    if (tp !== null) payload.tp = tp;
    if (ticket !== null) payload.ticket = ticket;

    const response = await axios.post("http://127.0.0.1:5000/trade", payload);
    console.log(chalk.green(`📤 Sent ${action} to MT5 | ${JSON.stringify(response.data)}`));
  } catch (error) {
    console.error(chalk.red(`❌ Failed to send trade to MT5: ${error.response?.data || error.message}`));
  }
}


function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const raw = fs.readFileSync(STATS_FILE, 'utf8');
      stats = JSON.parse(raw);
      console.log(chalk.green('Loaded stats from file.'));
    } else {
      stats = { ...defaultStats };
      saveStats();
    }
  } catch (err) {
    console.error(chalk.red('Failed loading stats:'), err.message);
    stats = { ...defaultStats };
  }
}

function saveStats() {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf8');
  } catch (err) {
    console.error(chalk.red('Failed saving stats:'), err.message);
  }
}

// normalize outgoing broadcast with safe send
function safeSend(ws, obj) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch (e) {
    // ignore send errors for individual sockets
    console.warn('Failed to send to client:', e.message);
  }
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  // iterate wss.clients to avoid tracking our own clients array
  wss.clients.forEach((client) => {
    try {
      if (client.readyState === client.OPEN) client.send(msg);
    } catch (err) {
      // ignore per-client send errors
      console.warn('Broadcast send error:', err.message);
    }
  });
}

function sendPerformance() {
  const winRate = stats.totalTrades > 0 ? (stats.wins / stats.totalTrades) * 100 : 0;
  broadcast({ type: 'performance', stats: { ...stats, winRate } });
  saveStats();
}

function isActiveSession() {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const total = utcH * 60 + utcM;
  // London open ~07:00-10:00 UTC, overlap with NY roughly 12:30-15:30 (these windows are as in your original)
  return (total >= 7 * 60 && total <= 10 * 60) || (total >= 12 * 60 + 30 && total <= 15 * 60 + 30);
}

// === Fetch candles from Deriv via WebSocket (correct method) ===
import WebSocket from "ws";

async function fetchCandles() {
  const url = "wss://ws.derivws.com/websockets/v3?app_id=110261"; // test app_id, replace with your own later
  const ws = new WebSocket(url);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Deriv candle request timeout"));
    }, 10000);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          ticks_history: "frxXAUUSD", // Gold/USD on Deriv
          granularity: 300, // 5 minutes
          count: 1000,
          end: "latest",
          style: "candles",
        })
      );
    });

    ws.on("message", (msg) => {
      const data = JSON.parse(msg);
      if (data.error) {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(data.error.message));
        return;
      }

      if (data.candles) {
        clearTimeout(timeout);
        ws.close();
        const candles = data.candles.map((c) => ({
          openTime: c.epoch * 1000,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
          volume: parseFloat(c.tick_count || 0),
        }));

        console.log(chalk.green(`✅ Fetched ${candles.length} candles from Deriv`));
        broadcast({ type: "status", text: "✅ Deriv candle data loaded" });
        resolve(candles);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}


// Record a closed trade and update performance stats
function recordClosedTrade(entry, exit, side, lot) {
  // PnL calculation for gold: 1 lot = 100 oz. PnL = (exit - entry) * 100 * lots * direction
  // IMPORTANT: verify contract/lot size with your broker/exchange
  const direction = side === 'buy' ? 1 : -1; // buy profits when exit > entry
  const priceMove = (exit - entry) * direction; // positive means profit
  const pnl = priceMove * 100 * lot; // USD (subject to instrument contract size)

  stats.totalTrades += 1;
  if (pnl > 0) stats.wins += 1;
  else stats.losses += 1;
  stats.netProfit += pnl;

  broadcast({ type: 'closed_trade', trade: { entry, exit, side, lot, pnl } });
  console.log(chalk.magenta(`Recorded closed trade: ${side} ${lot} lots PnL=${pnl.toFixed(2)}`));
  saveStats();
  sendPerformance();
}

// TRADE MANAGEMENT (partial TP + trailing/stops)
async function manageTrade(latestClose) {

  if (!activeTrade) return;

  const { side, entry } = activeTrade;
  const tp = activeTrade.tp;
  const sl = activeTrade.sl;

  // Calculate 50% of the way to TP for early trail activation
  const halfwayToTP = side === 'buy' 
    ? entry + (tp - entry) * 0.5
    : entry - (entry - tp) * 0.5;

  // BUY side
  if (side === 'buy') {
    // Early trailing activation at 50% to TP
    if (!activeTrade.trailActivated && latestClose >= halfwayToTP) {
      activeTrade.trailActivated = true;
      activeTrade.trail = latestClose - (latestClose * 0.003); // 0.3% below price
      console.log(chalk.yellow(`Early trailing activated at ${latestClose} (50% to TP)`));
      broadcast({
  type: 'log',
  category: 'trail',
  text: `🟡 Early trailing activated @ ${latestClose.toFixed(2)}`,
  color: 'yellow'
});

      broadcast({ type: 'status', text: `Early trailing activated @ ${activeTrade.trail.toFixed(2)}` });
    }

    // TP reached -> close 80%
    if (tp != null && latestClose >= tp) {
      if (!activeTrade.partialClosed && activeTrade.lot > 0) {
        const closeLot = +(activeTrade.lot * 0.8).toFixed(6);
        const remaining = +(activeTrade.lot - closeLot).toFixed(6);

        // Close 80%
        await sendTradeToMT5("CLOSE_PARTIAL", "XAUUSD", closeLot);
        broadcast({ type: 'trade', side: 'sell', price: latestClose, reason: 'PARTIAL_TP', lot: closeLot });
        console.log(chalk.green(`Partial TP: closing ${closeLot} lots at ${latestClose}`));
        broadcast({
  type: 'log',
  category: 'partial',
  text: `💰 Partial TP hit — closed ${closeLot} lots @ ${latestClose}`,
  color: 'cyan'
});

        recordClosedTrade(entry, latestClose, side, closeLot);

        // Keep 20% running with trailing stop
        activeTrade.lot = remaining;
        activeTrade.partialClosed = true;
        activeTrade.tp = null;
        // Trail continues from current level if already active
        if (!activeTrade.trailActivated) {
          activeTrade.trailActivated = true;
          activeTrade.trail = latestClose - (latestClose * 0.003);
        }
        console.log(chalk.yellow(`Remaining ${remaining} lots. Trailing from ${activeTrade.trail.toFixed(2)}`));
        broadcast({ type: 'status', text: `Partial TP closed ${closeLot} lots, remaining ${remaining} lots. Trail=${activeTrade.trail.toFixed(2)}` });
        return;
      }
    }

    // SL hit -> close all
    if (latestClose <= sl) {
      await sendTradeToMT5(activeTrade.side === "BUY" ? "SELL" : "BUY", "XAUUSD", activeTrade.lot);

      broadcast({ type: 'trade', side: 'sell', price: latestClose, reason: 'SL' });
      console.log(chalk.red(`🛑 SL hit at ${latestClose}`));
      recordClosedTrade(entry, latestClose, side, activeTrade.lot);
      activeTrade = null;
      return;
    }

  if (activeTrade.trailActivated && latestClose > activeTrade.trail / 0.997) {
  activeTrade.trail = latestClose - (latestClose * 0.003);
  await sendTradeToMT5("MODIFY", "XAUUSD", activeTrade.lot, activeTrade.trail, activeTrade.tp);
  console.log(chalk.blue(`Trailing stop moved to ${activeTrade.trail.toFixed(2)}`));
  broadcast({ type: 'status', text: `Trailing moved to ${activeTrade.trail.toFixed(2)}` });

      console.log(chalk.blue(`Trailing stop moved to ${activeTrade.trail.toFixed(2)}`));
      broadcast({ type: 'status', text: `Trailing moved to ${activeTrade.trail.toFixed(2)}` });
    }

    if (activeTrade.trailActivated && latestClose <= activeTrade.trail) {
      await sendTradeToMT5(activeTrade.side === "BUY" ? "SELL" : "BUY", "XAUUSD", activeTrade.lot);

      broadcast({ type: 'trade', side: 'sell', price: latestClose, reason: 'TRAIL' });
      console.log(chalk.red(`🚨 Trailing Stop triggered at ${latestClose}`));
      broadcast({
  type: 'log',
  category: 'trail',
  text: `🚨 Trailing Stop triggered @ ${latestClose}`,
  color: 'red'
});

      recordClosedTrade(entry, latestClose, side, activeTrade.lot);
      activeTrade = null;
      return;
    }
  }

  // SELL side
  if (side === 'sell') {

// 🟡 Early trailing activation (when price reaches 50% toward TP)
if (!activeTrade.trailActivated && latestClose <= halfwayToTP) {
  activeTrade.trailActivated = true;
  // For SELL (short), trailing stop sits ABOVE price
  activeTrade.trail = latestClose + (latestClose * 0.003);
  console.log(chalk.yellow(`🔔 Early trailing activated at ${latestClose.toFixed(2)} (50% to TP)`));
  broadcast({ type: 'status', text: `Trailing stop activated @ ${activeTrade.trail.toFixed(2)}` });
}


    // Rest of SELL side logic similar to BUY but inverted
if (tp != null && latestClose <= tp) {
  if (!activeTrade.partialClosed && activeTrade.lot > 0) {
    const closeLot = +(activeTrade.lot * PARTIAL_CLOSE_PCT).toFixed(6); // use config
    const remaining = +(activeTrade.lot - closeLot).toFixed(6);

    // ask MT5 to close only the partial amount
    await sendTradeToMT5("CLOSE_PARTIAL", "XAUUSD", closeLot);

    broadcast({ type: 'trade', side: 'buy', price: latestClose, reason: 'PARTIAL_TP', lot: closeLot });
    console.log(chalk.green(`Partial TP: closing ${closeLot} lots at ${latestClose}`));
  
    recordClosedTrade(entry, latestClose, side, closeLot);

    activeTrade.lot = remaining;
    activeTrade.partialClosed = true;
    activeTrade.tp = null;
    // make sure trailing is active if it isn't already
    if (!activeTrade.trailActivated) {
      activeTrade.trailActivated = true;
      activeTrade.trail = latestClose + (latestClose * 0.003);
    }
    console.log(chalk.yellow(`Remaining ${remaining} lots. Trailing from ${activeTrade.trail.toFixed(2)}`));
    broadcast({ type: 'status', text: `Partial TP closed ${closeLot} lots, remaining ${remaining} lots. Trail=${activeTrade.trail.toFixed(2)}` });
    return;
  }
}


    // Rest of SELL side management remains same
if (latestClose >= sl) {
  // close remaining position fully
  await sendTradeToMT5(activeTrade.side === "buy" ? "SELL" : "BUY", "XAUUSD", activeTrade.lot);

  broadcast({ type: 'trade', side: 'buy', price: latestClose, reason: 'SL' });
  console.log(chalk.red(`🛑 SL hit at ${latestClose}`));
  broadcast({
  type: 'log',
  category: 'stoploss',
  text: `🛑 Stop Loss hit @ ${latestClose}`,
  color: 'red'
});

  recordClosedTrade(entry, latestClose, side, activeTrade.lot);
  activeTrade = null;
  return;
}


if (activeTrade.trailActivated && latestClose < activeTrade.trail / 1.003) {
  activeTrade.trail = latestClose + (latestClose * 0.003);
  await sendTradeToMT5("MODIFY", "XAUUSD", activeTrade.lot, activeTrade.trail, activeTrade.tp);
  console.log(chalk.blue(`Trailing stop moved to ${activeTrade.trail.toFixed(2)}`));
  broadcast({ type: 'status', text: `Trailing moved to ${activeTrade.trail.toFixed(2)}` });
}


    if (activeTrade.trailActivated && latestClose >= activeTrade.trail) {
      await sendTradeToMT5(activeTrade.side === "BUY" ? "SELL" : "BUY", "XAUUSD", activeTrade.lot);

      broadcast({ type: 'trade', side: 'buy', price: latestClose, reason: 'TRAIL' });
      console.log(chalk.red(`🚨 Trailing Stop triggered at ${latestClose}`));
      recordClosedTrade(entry, latestClose, side, activeTrade.lot);
      activeTrade = null;
      return;
    }
  }
}

let checkMarketRunning = false; // prevent overlapping runs

async function checkMarket() {
  if (!isActiveSession()) {
    // still broadcast performance so UI remains live
    sendPerformance();
    return;
  }

  if (checkMarketRunning) return;
  checkMarketRunning = true;

  try {
    const candles = await fetchCandles();
    if (!candles || candles.length < CANDLE_LIMIT) {
      // not enough candles — just broadcast and return
      broadcast({ type: 'status', text: `Insufficient candles (${candles.length || 0})` });
      checkMarketRunning = false;
      return;
    }

    const closes = candles.map((c) => c.close);

    // compute indicators safely
    const ema50 = EMA.calculate({ period: 50, values: closes });
    const ema200 = EMA.calculate({ period: 200, values: closes });
    const rsi = RSI.calculate({ period: 14, values: closes });

    if (!ema50.length || !ema200.length || !rsi.length) {
      broadcast({ type: 'status', text: 'Not enough data for indicators' });
      checkMarketRunning = false;
      return;
    }

    const latestClose = closes[closes.length - 1];
    const latestEMA50 = ema50[ema50.length - 1];
    const latestEMA200 = ema200[ema200.length - 1];
    const latestRSI = rsi[rsi.length - 1];

    // Manage open trade first
   await manageTrade(latestClose);

    if (activeTrade) {
      // there's an open trade, don't open a new one
      sendPerformance();
      checkMarketRunning = false;
      return;
    }

    let signal = null;
    if (latestEMA50 > latestEMA200 && latestRSI > 55) {
      signal = 'buy';
    } else if (latestEMA50 < latestEMA200 && latestRSI < 45) {
      signal = 'sell';
    }

   if (signal && signal.toLowerCase() !== lastSignal) {

 console.log(chalk.yellow(`📈 New signal detected: ${signal}`));
broadcast({
  type: 'log',
  category: 'signal',
  text: `📈 New ${signal.toUpperCase()} signal detected`,
  color: 'yellow'
});


  // Close existing trade before opening new one
  if (activeTrade) {
    const opposite = activeTrade.side === "buy" ? "SELL" : "BUY";
    await sendTradeToMT5(opposite, "XAUUSD", activeTrade.lot);
    console.log(chalk.gray(`🔁 Closed previous ${activeTrade.side} trade before opening new signal`));
    activeTrade = null;
  }

  // Open new trade
  const entryPrice = latestClose;
  const lotSize = 0.1; // You can also load this from .env
  const sl = signal === "BUY" ? entryPrice * (1 - SL_PERCENT) : entryPrice * (1 + SL_PERCENT);
  const tp = signal === "BUY" ? entryPrice * (1 + TP_PERCENT) : entryPrice * (1 - TP_PERCENT);

activeTrade = {
  side: signal,
  entry: entryPrice,    // <- use `entry` everywhere
  sl,
  tp,
  lot: lotSize,
  trail: 0,
  partialClosed: false,
};

  // ✅ Send trade to MT5 bridge
  await sendTradeToMT5(signal, "XAUUSD", lotSize, sl, tp);


  broadcast({
    type: 'trade_opened',
    side: signal,
    price: entryPrice,
    lot: lotSize,
    sl,
    tp,
  });

  console.log(chalk.green(`🚀 Opened ${signal} at ${entryPrice.toFixed(2)} | SL=${sl.toFixed(2)} TP=${tp.toFixed(2)}`));
  broadcast({
  type: 'log',
  category: 'trade',
  text: `🚀 ${signal.toUpperCase()} opened @ ${entryPrice.toFixed(2)} | SL=${sl.toFixed(2)} TP=${tp.toFixed(2)}`,
  color: 'green'
});

  lastSignal = signal.toLowerCase();


      sendPerformance();
    } else {
      // no new signal
      sendPerformance();
      broadcast({
        type: 'status',
        text: `No new signal. EMA50=${latestEMA50.toFixed(
          2
        )}, EMA200=${latestEMA200.toFixed(2)}, RSI=${latestRSI.toFixed(2)}`,
      });
    }
  } catch (err) {
    console.error(chalk.red('checkMarket error:'), err.message);
    broadcast({ type: 'error', text: `checkMarket error: ${err.message}` });
  } finally {
    checkMarketRunning = false;
  }
}

// schedule market checks every 60 seconds, aligned to second (not strictly required)
setInterval(() => {
  checkMarket().catch((e) => console.error('checkMarket top error:', e.message));
}, 60 * 1000);

// --- WebSocket connection handling ---
// heartbeat for clients to detect dead connections
function heartbeat() {
  this.isAlive = true;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  console.log(chalk.yellow('Frontend connected'));
  broadcast({ type: 'status', text: 'Frontend connected to backend' });

  // send current performance & lot size
  safeSend(ws, {
    type: 'performance',
    stats: { ...stats, winRate: stats.totalTrades > 0 ? (stats.wins / stats.totalTrades) * 100 : 0 },
  });
  safeSend(ws, { type: 'status', text: `Current lot size: ${lotSize}` });

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      // normalize incoming message shapes
      if (data.type === 'lotSize') {
        const v = parseFloat(data.value);
        if (!isNaN(v) && v > 0) {
          lotSize = v;
          broadcast({ type: 'status', text: `Lot size updated to ${lotSize}` });
          sendPerformance();
          console.log(chalk.magenta(`Lot size set to ${lotSize}`));
        } else {
          safeSend(ws, { type: 'error', text: 'Invalid lot size' });
        }
      } else if (data.type === 'resetStats') {
        stats = { ...defaultStats };
        saveStats();
        broadcast({ type: 'status', text: 'Performance stats reset' });
        sendPerformance();
        console.log(chalk.magenta('Performance stats reset'));
      } else {
        // unrecognized control messages can be logged
        console.log('WS message:', data);
      }
    } catch (e) {
      console.error('WS message parse error', e.message);
      safeSend(ws, { type: 'error', text: 'Invalid WS message format' });
    }
  });

  ws.on('close', () => {
    console.log(chalk.gray('Frontend disconnected'));
  });
});

// periodic ping to detect stale clients
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch (e) {
        // ignore
      }
      return;
    }
    ws.isAlive = false;
    try {
      ws.ping(() => {});
    } catch (e) {
      // ignore ping errors
    }
  });
}, 30 * 1000);

// basic express endpoint
app.get('/', (req, res) => res.send('XAU/USD Auto Trading Bot Backend Running'));

// optionally auto start deriv bot (enabled by env var)
if (process.env.AUTO_START_DERIV === 'true') {
  console.log(chalk.cyan('🤖 Launching Deriv bot...'));

  function spawnDerivBot() {
    const derivBot = spawn('node', ['derivbot.js'], { stdio: 'inherit' });
    derivBot.on('close', (code) => {
      console.log(chalk.red(`⚠️ Deriv bot exited with code ${code}`));
      // optional automatic restart when enabled
      if (process.env.AUTO_RESTART_DERIV === 'true') {
        console.log(chalk.yellow('🔁 Restarting Deriv bot in 5s...'));
        setTimeout(spawnDerivBot, 5000);
      }
    });
  }

  spawnDerivBot();
} else {
  console.log(chalk.gray('Deriv bot auto-start disabled (AUTO_START_DERIV != true)'));
}

// load persisted stats and start server
loadStats();
server.listen(PORT, () => {
  console.log(chalk.green(`🚀 Server running on port ${PORT}`));
});

// cleanup on exit
process.on('SIGINT', () => {
  console.log('Shutting down...');
  clearInterval(interval);
  saveStats();
  server.close(() => process.exit(0));
});