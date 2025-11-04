<<<<<<< HEAD
// === close_all.js ===
// Sends a request to your Python MT5 bridge to close all open trades

import axios from "axios";
import chalk from "chalk";

async function closeAllTrades() {
  try {
    // Choose which account to close (use "Account1" or "Account2")
    const account = "Account1";

    console.log(chalk.cyan(`🔌 Sending request to close all trades for ${account}...`));

    const res = await axios.post("http://127.0.0.1:5001/close_all", {
      account: account,
    });

    if (res.data.status === "completed") {
      console.log(chalk.green(`✅ Closed ${res.data.total_closed} trades successfully.`));
      if (res.data.failed.length > 0) {
        console.log(chalk.red(`❌ Failed to close: ${res.data.failed.join(", ")}`));
      }
    } else {
      console.log(chalk.yellow(`⚠️ Response: ${res.data.message || "Unknown status"}`));
    }

  } catch (err) {
    console.error(chalk.red("❌ Error closing trades:"), err.message);
  }
}

// Run
closeAllTrades();
=======
// === close_all.js ===
// Sends a request to your Python MT5 bridge to close all open trades

import axios from "axios";
import chalk from "chalk";

async function closeAllTrades() {
  try {
    // Choose which account to close (use "Account1" or "Account2")
    const account = "Account1";

    console.log(chalk.cyan(`🔌 Sending request to close all trades for ${account}...`));

    const res = await axios.post("http://127.0.0.1:5001/close_all", {
      account: account,
    });

    if (res.data.status === "completed") {
      console.log(chalk.green(`✅ Closed ${res.data.total_closed} trades successfully.`));
      if (res.data.failed.length > 0) {
        console.log(chalk.red(`❌ Failed to close: ${res.data.failed.join(", ")}`));
      }
    } else {
      console.log(chalk.yellow(`⚠️ Response: ${res.data.message || "Unknown status"}`));
    }

  } catch (err) {
    console.error(chalk.red("❌ Error closing trades:"), err.message);
  }
}

// Run
closeAllTrades();
>>>>>>> b132b96 (Add Flask bridge and update Render deployment config)
