<<<<<<< HEAD
# === close_all.py ===
from flask import Flask, request, jsonify
import MetaTrader5 as mt5

app = Flask(__name__)

LOGIN = 32001916
PASSWORD = "Charles21."
SERVER = "Deriv-Demo"

def connect_mt5():
    if not mt5.initialize():
        print("❌ MT5 initialization failed:", mt5.last_error())
        return False
    authorized = mt5.login(LOGIN, PASSWORD, SERVER)
    if authorized:
        print(f"✅ Connected to {SERVER} — Account {LOGIN}")
        return True
    else:
        print("❌ Login failed:", mt5.last_error())
        return False

connect_mt5()

@app.route("/close_all", methods=["POST"])
def close_all():
    account = request.json.get("account", "Account1")
    print(f"🔒 Closing all open trades for {account}...")

    positions = mt5.positions_get()
    if not positions:
        return jsonify({"status": "no_trades", "message": "No open trades found."})

    closed = []
    failed = []

    for pos in positions:
        order_type = mt5.ORDER_TYPE_SELL if pos.type == 0 else mt5.ORDER_TYPE_BUY
        price = mt5.symbol_info_tick(pos.symbol).bid if order_type == mt5.ORDER_TYPE_BUY else mt5.symbol_info_tick(pos.symbol).ask

        result = mt5.order_send({
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": pos.symbol,
            "volume": pos.volume,
            "type": order_type,
            "position": pos.ticket,
            "price": price,
            "deviation": 20,
            "magic": 9999,
            "comment": "Closed via API",
        })

        if result and result.retcode == mt5.TRADE_RETCODE_DONE:
            closed.append(pos.ticket)
        else:
            failed.append(pos.ticket)

    return jsonify({
        "status": "completed",
        "total_closed": len(closed),
        "closed": closed,
        "failed": failed
    })


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001)
=======
# === close_all.py ===
from flask import Flask, request, jsonify
import MetaTrader5 as mt5

app = Flask(__name__)

LOGIN = 32001916
PASSWORD = "Charles21."
SERVER = "Deriv-Demo"

def connect_mt5():
    if not mt5.initialize():
        print("❌ MT5 initialization failed:", mt5.last_error())
        return False
    authorized = mt5.login(LOGIN, PASSWORD, SERVER)
    if authorized:
        print(f"✅ Connected to {SERVER} — Account {LOGIN}")
        return True
    else:
        print("❌ Login failed:", mt5.last_error())
        return False

connect_mt5()

@app.route("/close_all", methods=["POST"])
def close_all():
    account = request.json.get("account", "Account1")
    print(f"🔒 Closing all open trades for {account}...")

    positions = mt5.positions_get()
    if not positions:
        return jsonify({"status": "no_trades", "message": "No open trades found."})

    closed = []
    failed = []

    for pos in positions:
        order_type = mt5.ORDER_TYPE_SELL if pos.type == 0 else mt5.ORDER_TYPE_BUY
        price = mt5.symbol_info_tick(pos.symbol).bid if order_type == mt5.ORDER_TYPE_BUY else mt5.symbol_info_tick(pos.symbol).ask

        result = mt5.order_send({
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": pos.symbol,
            "volume": pos.volume,
            "type": order_type,
            "position": pos.ticket,
            "price": price,
            "deviation": 20,
            "magic": 9999,
            "comment": "Closed via API",
        })

        if result and result.retcode == mt5.TRADE_RETCODE_DONE:
            closed.append(pos.ticket)
        else:
            failed.append(pos.ticket)

    return jsonify({
        "status": "completed",
        "total_closed": len(closed),
        "closed": closed,
        "failed": failed
    })


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001)
>>>>>>> b132b96 (Add Flask bridge and update Render deployment config)
