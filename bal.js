import dotenv from 'dotenv';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config();

const DERIV_WS = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
const TOKEN = process.env.DERIV_TOKEN; // set this in .env

if (!TOKEN) {
  console.error('DERIV_TOKEN missing. Add DERIV_TOKEN to .env');
  process.exit(1);
}

function checkBalance(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS);

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Deriv balance request timed out'));
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({ authorize: TOKEN, req_id: 1 }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        // Deriv returns authorize field on successful auth
        if (msg.authorize) {
          clearTimeout(timer);
          ws.close();
          // balance may be string — convert to number if possible
          const balRaw = msg.authorize.balance ?? msg.authorize.client_balance ?? null;
          const balance = balRaw != null ? Number(balRaw) : null;
          resolve({ ok: true, raw: msg.authorize, balance });
          return;
        }

        // handle error responses
        if (msg.error) {
          clearTimeout(timer);
          ws.close();
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          return;
        }
      } catch (e) {
        // ignore non-JSON messages
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    ws.on('close', () => {
      // if closed before auth response, reject via timer or below
    });
  });
}

// replace the old filename check with a proper module-vs-script guard
const __filename = fileURLToPath(import.meta.url);
const __basename = path.basename(__filename);

if (process.argv[1] && path.basename(process.argv[1]) === __basename) {
  (async () => {
    try {
      const res = await checkBalance();
      if (res.balance != null && !Number.isNaN(res.balance)) {
        console.log(`Account balance: ${res.balance}`);
      } else {
        console.log('Balance returned (raw):', res.raw);
      }
    } catch (err) {
      console.error('Balance check failed:', err.message);
      process.exitCode = 2;
    }
  })();
}