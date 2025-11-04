<<<<<<< HEAD
// === force_trade.js ===
import axios from "axios";
import chalk from "chalk";

async function forceTrade(action = "BUY", symbol = "XAUUSD", lot = 0.1) {
  try {
    console.log(chalk.yellow(`📤 Sending ${action} trade to MT5...`));

    const res = await axios.post("http://127.0.0.1:5000/trade", {
      action: action.toUpperCase(),
      symbol,
      lot,
    });

    console.log(chalk.green(`✅ MT5 Bridge Response:`));
    console.log(res.data);
  } catch (err) {
    console.error(chalk.red("❌ Error sending trade to MT5:"));
    console.error(err.response?.data || err.message);
  }
}

// Change "BUY" to "SELL" to test both directions
forceTrade("BUY", "XAUUSD", 0.1);
=======
// === force_trade.js ===
import axios from "axios";
import chalk from "chalk";

async function forceTrade(action = "BUY", symbol = "XAUUSD", lot = 0.1) {
  try {
    console.log(chalk.yellow(`📤 Sending ${action} trade to MT5...`));

    const res = await axios.post("http://127.0.0.1:5000/trade", {
      action: action.toUpperCase(),
      symbol,
      lot,
    });

    console.log(chalk.green(`✅ MT5 Bridge Response:`));
    console.log(res.data);
  } catch (err) {
    console.error(chalk.red("❌ Error sending trade to MT5:"));
    console.error(err.response?.data || err.message);
  }
}

// Change "BUY" to "SELL" to test both directions
forceTrade("BUY", "XAUUSD", 0.1);
>>>>>>> b132b96 (Add Flask bridge and update Render deployment config)
