import WebSocket from "ws";
import dotenv from "dotenv";
dotenv.config();

// === CONFIG ===
const SYMBOL = "frxXAUUSD";
let STAKE = parseFloat(process.env.STAKE || "1.0");
const MIN_STAKE = 0.5;
const DURATION = 1;
const DURATION_UNIT = "m";
const COOLDOWN = 30;
const MULTIPLIER = 50;
const REQUIRE_EXTERNAL = true;  // Only trade on external signals

// === MULTI-ACCOUNT CLASS ===
class DerivAccount {
  constructor(token, name) {
    this.token = token;
    this.name = name;
    this.ws = null;
    this.lastTradeTime = 0;
    this.isProposalPending = false;
    this.externalSignal = null;
    this.lastPing = Date.now();
    this.heartbeat = null;
    this.connect();
  }

  connect() {
    this.ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=110261");
    this.setupListeners();

    // 🫀 Send ping every 20 seconds
    this.heartbeat = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ ping: 1 }));
      }
    }, 20000);

    // 🕒 Check for frozen connection
    this.monitor = setInterval(() => {
      if (Date.now() - this.lastPing > 60000) {
        console.warn(`⚠️ Account ${this.name}: No data for 60s, reconnecting...`);
        this.reconnect();
      }
    }, 30000);
  }

  setupListeners() {
    this.ws.on("open", () => {
      console.log(`✅ Account ${this.name}: Connected to Deriv`);
      this.ws.send(JSON.stringify({ authorize: this.token }));
    });

    this.ws.on("message", (msg) => {
      this.lastPing = Date.now();
      this.handleMessage(JSON.parse(msg));
    });

    this.ws.on("error", (err) => {
      console.error(`💥 Account ${this.name} Error:`, err.message);
    });

    this.ws.on("close", () => {
      console.warn(`⚠️ Account ${this.name}: Disconnected. Reconnecting in 10s...`);
      setTimeout(() => this.reconnect(), 10000);
    });
  }

  handleMessage(data) {
    // === AUTH SUCCESS ===
    if (data.msg_type === "authorize" && data.authorize) {
      console.log(`🔑 Account ${this.name}: Authorized as ${data.authorize.loginid}`);
      sendToDashboard({ type: "session", loginid: data.authorize.loginid, account: this.name });

      // reset trade states
      this.isProposalPending = false;
      this.externalSignal = null;
      this.subscribeTicks();
    }

    // === PRICE UPDATE ===
    if (data.msg_type === "tick" && data.tick) {
      const price = data.tick.quote;
      sendToDashboard({ type: "price", value: price, account: this.name });
      this.handlePrice(price);
    }

    // === PROPOSAL READY ===
    if (data.msg_type === "proposal" && data.proposal) {
      const { id, payout, ask_price } = data.proposal;
      console.log(`💡 Account ${this.name}: Proposal ready: Buy=${ask_price}, Payout=${payout}`);
      sendToDashboard({ type: "proposal", ask_price, payout, stake: STAKE, account: this.name });
      this.buyContract(id);
    }

    // === BUY SUCCESS ===
    if (data.msg_type === "buy" && data.buy) {
      console.log(`🟢 Account ${this.name}: Trade executed. ID: ${data.buy.contract_id}`);
      sendToDashboard({
        type: "trade",
        status: "success",
        contract_id: data.buy.contract_id,
        account: this.name
      });
      this.isProposalPending = false;
    }

    // === ERROR HANDLING ===
    if (data.error) {
      console.error(`❌ Account ${this.name}:`, data.error.message);
      sendToDashboard({ type: "error", message: data.error.message, account: this.name });
      this.isProposalPending = false;

      // Handle insufficient balance
      if (data.error.code === "InsufficientBalance") {
        STAKE = Math.max(MIN_STAKE, STAKE * 0.5);
        console.warn(`⚠️ ${this.name}: Lowering stake to ${STAKE}`);
      }
    }
  }

  handlePrice(price) {
    const now = Date.now();
    if (this.isProposalPending) return;
    if (now - this.lastTradeTime < COOLDOWN * 1000) return;

    // Require external signal if enabled
    if (REQUIRE_EXTERNAL && !this.externalSignal) return;

    const signal = this.externalSignal;
    this.externalSignal = null;

    console.log(`📈 Account ${this.name}: Signal ${signal} at ${price}`);
    sendToDashboard({ type: "signal", action: signal, price, account: this.name });

    this.isProposalPending = true;
    this.lastTradeTime = now;
    this.requestProposal(signal);
  }

  subscribeTicks() {
    this.ws.send(JSON.stringify({ ticks: SYMBOL }));
  }

  requestProposal(direction) {
    const contract_type = direction === "CALL" ? "MULTUP" : "MULTDOWN";
    this.ws.send(JSON.stringify({
      proposal: 1,
      amount: STAKE,
      basis: "stake",
      contract_type,
      currency: "USD",
      duration: DURATION,
      duration_unit: DURATION_UNIT,
      symbol: SYMBOL,
      multiplier: MULTIPLIER,
    }));
  }

  buyContract(proposal_id) {
    this.ws.send(JSON.stringify({ buy: proposal_id, price: 0 }));
  }

  reconnect() {
    console.warn(`🔁 Reconnecting ${this.name}...`);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.monitor) clearInterval(this.monitor);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
    }
    this.connect();
  }
}

// === INITIALIZE ACCOUNTS ===
const tokens = (process.env.DERIV_TOKENS || "")
  .split(",")
  .map(t => t.trim())
  .filter(Boolean);

const accounts = tokens.map((token, i) => new DerivAccount(token, `Account${i + 1}`));

// === DASHBOARD CONNECTION ===
let dashboardWS = new WebSocket("ws://localhost:5000");

function sendToDashboard(payload) {
  if (dashboardWS.readyState === WebSocket.OPEN) {
    dashboardWS.send(JSON.stringify(payload));
  }
}

dashboardWS.on("open", () => {
  console.log("📡 Connected to dashboard");
  sendToDashboard({ type: "status", message: "Multi-account bot connected" });
});

dashboardWS.on("close", () => {
  console.warn("⚠️ Dashboard disconnected. Reconnecting in 5s...");
  setTimeout(() => {
    dashboardWS = new WebSocket("ws://localhost:5000");
  }, 5000);
});

dashboardWS.on("message", (msg) => {
  try {
    const data = JSON.parse(msg.toString());
    if (data?.type === "signal" && data?.side) {
      const signal = data.side === "buy" ? "CALL" : "PUT";
      if (data.account) {
        const account = accounts.find(a => a.name === data.account);
        if (account) account.externalSignal = signal;
      } else {
        accounts.forEach(a => a.externalSignal = signal);
      }
      console.log("➡️ Signal received:", data.side, data.account ?? 'ALL');
    }
  } catch (e) {
    console.warn("Invalid dashboard message:", e.message);
  }
});

// === GRACEFUL EXIT ===
process.on("SIGINT", () => {
  console.log("\n🧹 Shutting down cleanly...");
  accounts.forEach(a => {
    if (a.heartbeat) clearInterval(a.heartbeat);
    if (a.monitor) clearInterval(a.monitor);
    if (a.ws) a.ws.close();
  });
  dashboardWS.close();
  process.exit(0);
});
