import dotenv from 'dotenv';
import WebSocket from 'ws';
import readline from 'readline';

dotenv.config();

const DERIV_WS = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
const SYMBOL = 'frxXAUUSD';

// Create CLI interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function forceTrade(token, direction, amount) {
  const ws = new WebSocket(DERIV_WS);
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('Request timeout'));
    }, 10000);

    ws.on('open', () => {
      // First authorize
      ws.send(JSON.stringify({
        authorize: token,
        req_id: 1
      }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        
        if (msg.error) {
          clearTimeout(timer);
          ws.close();
          reject(new Error(msg.error.message));
          return;
        }

        // After authorization, place the trade
        if (msg.authorize) {
          ws.send(JSON.stringify({
            proposal: 1,
            amount: amount,
            barrier: undefined,
            basis: "stake",
            contract_type: direction === 'buy' ? "CALL" : "PUT",
            currency: "USD",
            duration: 5,
            duration_unit: "m",
            symbol: SYMBOL,
            req_id: 2
          }));
        }

        // Handle trade confirmation
        if (msg.proposal) {
          // Place the actual trade
          ws.send(JSON.stringify({
            buy: msg.proposal.id,
            price: amount,
            req_id: 3
          }));
        }

        if (msg.buy) {
          clearTimeout(timer);
          ws.close();
          resolve(msg);
        }
      } catch (e) {
        console.error('Parse error:', e);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main() {
  try {
    // Get tokens
    const tokens = (process.env.DERIV_TOKENS || '').split(',').map(t => t.trim()).filter(Boolean);
    if (!tokens.length) {
      console.error('No tokens found in DERIV_TOKENS');
      process.exit(1);
    }

    // Select account
    console.log('\nAvailable accounts:');
    tokens.forEach((_, i) => console.log(`${i + 1}. Account ${i + 1}`));
    const accIdx = parseInt(await question('Select account number: ')) - 1;
    
    if (accIdx < 0 || accIdx >= tokens.length) {
      throw new Error('Invalid account number');
    }

    // Get trade details
    const direction = (await question('Enter direction (buy/sell): ')).toLowerCase();
    if (direction !== 'buy' && direction !== 'sell') {
      throw new Error('Invalid direction. Use buy or sell');
    }

    const amount = parseFloat(await question('Enter lot size (e.g. 0.1): '));
    if (isNaN(amount) || amount <= 0) {
      throw new Error('Invalid lot size');
    }

    console.log(`\nPlacing ${direction} order for ${amount} lots...`);
    
    const result = await forceTrade(tokens[accIdx], direction, amount);
    console.log('\nTrade placed successfully:', JSON.stringify(result, null, 2));

  } catch (err) {
    console.error('\nError:', err.message);
  } finally {
    rl.close();
  }
}

main();