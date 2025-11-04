import dotenv from 'dotenv';
import WebSocket from 'ws';

dotenv.config();

const DERIV_WS = 'wss://ws.derivws.com/websockets/v3?app_id=1089';

function loadAccounts() {
  const list = (process.env.DERIV_TOKENS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.map((t, i) => [`account_${i+1}`, t]);
}

function checkBalanceForToken(token, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timeout'));
    }, timeoutMs);

    ws.on('open', () => {
      // Fix: Add numeric request ID as required by Deriv API
      ws.send(JSON.stringify({ 
        authorize: token, 
        req_id: 1 // Added numeric req_id
      }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.authorize) {
          clearTimeout(timer);
          ws.close();
          const balance = Number(msg.authorize.balance ?? msg.authorize.client_balance ?? NaN);
          resolve({ ok: true, balance: Number.isFinite(balance) ? balance : null, raw: msg.authorize });
        } else if (msg.error) {
          clearTimeout(timer);
          ws.close();
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        }
      } catch (e) {
        // ignore parse errors
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

(async () => {
  const accounts = loadAccounts();
  if (!accounts.length) {
    console.error('No tokens found. Set DERIV_TOKENS or DERIV_ACCOUNTS in .env');
    process.exit(1);
  }

  const promises = accounts.map(([name, token]) =>
    checkBalanceForToken(token)
      .then(res => ({ name, res }))
      .catch(err => ({ name, err: err.message }))
  );

  const results = await Promise.all(promises);
  results.forEach(r => {
    if (r.err) console.log(`${r.name}: ERROR -> ${r.err}`);
    else console.log(`${r.name}: balance = ${r.res.balance ?? JSON.stringify(r.res.raw)}`);
  });
})();