import axios from "axios";
import chalk from "chalk";

// === CONFIG ===
const MT5_BRIDGE_URL = "http://127.0.0.1:5000/trade"; // must match your mt5_bridge.py
const SYMBOL = "XAUUSD";

// === INSTANT TEST SIGNAL ===
async function sendTestSignal(direction = "BUY") {
  try {
    const tickPrice = 3980; // Example price; you can adjust manually or link to live data
    const lot = 0.10;

    // Set test SL/TP — for example, 400 pips away
    const sl = direction === "BUY" ? tickPrice - 40 : tickPrice + 40;
    const tp = direction === "BUY" ? tickPrice + 80 : tickPrice - 80;

    console.log(chalk.yellow(`\n🚀 Sending ${direction} signal to MT5...`));
    const response = await axios.post(MT5_BRIDGE_URL, {
      action: direction,
      symbol: SYMBOL,
      lot,
      sl,
      tp,
    });

    if (response.data.status === "success") {
      console.log(chalk.green(`✅ ${direction} trade executed successfully!`));
      console.log(response.data.details);
    } else {
      console.log(chalk.red(`❌ Trade failed: ${JSON.stringify(response.data)}`));
    }
  } catch (err) {
    console.error(chalk.red(`⚠️ Error sending ${direction} signal:`), err.message);
  }
}

// === RUN ===
(async () => {
  console.log(chalk.cyan("=== Instant Signal Test ==="));
  // Change to "SELL" if you want to test a sell
  await sendTestSignal("BUY");
})();
