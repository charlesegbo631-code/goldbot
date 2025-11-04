from flask import Flask, request, jsonify
import MetaTrader5 as mt5
import time

app = Flask(__name__)

# === CONFIG ===
LOGIN = 32003537           # your MT5 login
PASSWORD = "Deriv#2022"    # your MT5 password
SERVER = "Deriv-Demo"      # Deriv-Demo or Deriv-Real

# === CONNECT ===
def connect_mt5():
    """Initialize and login to MetaTrader 5"""
    if not mt5.initialize():
        print("❌ MT5 initialization failed:", mt5.last_error())
        return False
    if not mt5.login(LOGIN, PASSWORD, SERVER):
        print("❌ Login failed:", mt5.last_error())
        return False
    print(f"✅ MT5 connected successfully: {SERVER} — Account {LOGIN}")
    return True

connect_mt5()

@app.route("/trade", methods=["POST"])
def trade():
    data = request.get_json(force=True)
    action = data.get("action", "").upper()
    symbol = data.get("symbol", "XAUUSD")
    lot = float(data.get("lot", 0.1))
    sl = data.get("sl")
    tp = data.get("tp")

    # === Ensure connection ===
    if not mt5.initialize():
        connect_mt5()

    # === Ensure symbol is available ===
    symbol_info = mt5.symbol_info(symbol)
    if not symbol_info:
        return jsonify({"status": "error", "message": f"Symbol {symbol} not found"}), 400
    if not symbol_info.visible:
        mt5.symbol_select(symbol, True)

    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        return jsonify({"status": "error", "message": "No tick data available"}), 500

    # === BUY / SELL ===
    if action in ["BUY", "SELL"]:
        price = tick.ask if action == "BUY" else tick.bid
        order_type = mt5.ORDER_TYPE_BUY if action == "BUY" else mt5.ORDER_TYPE_SELL

        filling_modes = [mt5.ORDER_FILLING_RETURN, mt5.ORDER_FILLING_FOK]
        for mode in filling_modes:
            request_params = {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": symbol,
                "volume": lot,
                "type": order_type,
                "price": price,
                "deviation": 20,
                "magic": 123456,
                "comment": "Bridge trade",
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": mode,
            }

            if sl:
                request_params["sl"] = float(sl)
            if tp:
                request_params["tp"] = float(tp)

            result = mt5.order_send(request_params)

            if result and result.retcode == mt5.TRADE_RETCODE_DONE:
                print(f"✅ {action} executed successfully on {symbol} at {price} (mode {mode})")
                return jsonify({"status": "success", "details": result._asdict()})

            # Retry if unsupported fill mode
            if result and "Unsupported filling mode" in str(result.comment):
                print(f"⚠️ Retrying with next fill mode... ({mode})")
                time.sleep(0.5)
                continue
            else:
                print("❌ Trade execution failed:", result)
                return jsonify({"status": "error", "details": result._asdict()}), 500

        return jsonify({"status": "error", "message": "All filling modes failed"}), 500

    # === CLOSE PARTIAL ===
    elif action == "CLOSE_PARTIAL":
        positions = mt5.positions_get(symbol=symbol)
        if not positions:
            return jsonify({"status": "error", "message": f"No open position for {symbol}"}), 400

        position = positions[0]
        close_request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": float(data["lot"]),
            "type": mt5.ORDER_TYPE_SELL if position.type == 0 else mt5.ORDER_TYPE_BUY,
            "position": position.ticket,
            "price": mt5.symbol_info_tick(symbol).bid if position.type == 0 else mt5.symbol_info_tick(symbol).ask,
            "deviation": 20,
            "comment": "Partial close",
            "type_filling": mt5.ORDER_FILLING_IOC,
        }

        result = mt5.order_send(close_request)
        print(f"🟡 Partial close executed on {symbol} ({data['lot']} lots)")
        return jsonify({"status": "partial_closed", "result": str(result)})

    # === MODIFY (for trailing stop) ===
    elif action == "MODIFY":
        positions = mt5.positions_get(symbol=symbol)
        if not positions:
            return jsonify({"status": "error", "message": f"No open position for {symbol}"}), 400

        position = positions[0]
        modify_request = {
            "action": mt5.TRADE_ACTION_SLTP,
            "symbol": symbol,
            "sl": float(data.get("sl")) if data.get("sl") else position.sl,
            "tp": float(data.get("tp")) if data.get("tp") else position.tp,
            "position": position.ticket,
        }

        result = mt5.order_send(modify_request)
        print(f"🟢 Modified SL/TP for {symbol} | SL={data.get('sl')} TP={data.get('tp')}")
        return jsonify({"status": "modified", "result": str(result)})

    # === INVALID ACTION ===
    else:
        return jsonify({"status": "error", "message": "Invalid action. Use BUY, SELL, CLOSE_PARTIAL, or MODIFY"}), 400


@app.route("/status", methods=["GET"])
def status():
    """Check MT5 connection"""
    if not mt5.initialize():
        connect_mt5()
    info = mt5.account_info()
    if info:
        return jsonify({
            "status": "connected",
            "balance": info.balance,
            "login": info.login,
            "server": info.server
        })
    return jsonify({"status": "disconnected", "error": str(mt5.last_error())})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000)

from flask import Flask, request, jsonify
import MetaTrader5 as mt5
import time

app = Flask(__name__)

# === CONFIG ===
LOGIN = 32003537           # your MT5 login
PASSWORD = "Deriv#2022"    # your MT5 password
SERVER = "Deriv-Demo"      # Deriv-Demo or Deriv-Real

# === CONNECT ===
def connect_mt5():
    """Initialize and login to MetaTrader 5"""
    if not mt5.initialize():
        print("❌ MT5 initialization failed:", mt5.last_error())
        return False
    if not mt5.login(LOGIN, PASSWORD, SERVER):
        print("❌ Login failed:", mt5.last_error())
        return False
    print(f"✅ MT5 connected successfully: {SERVER} — Account {LOGIN}")
    return True

connect_mt5()

@app.route("/trade", methods=["POST"])
def trade():
    data = request.get_json(force=True)
    action = data.get("action", "").upper()
    symbol = data.get("symbol", "XAUUSD")
    lot = float(data.get("lot", 0.1))
    sl = data.get("sl")
    tp = data.get("tp")

    # === Ensure connection ===
    if not mt5.initialize():
        connect_mt5()

    # === Ensure symbol is available ===
    symbol_info = mt5.symbol_info(symbol)
    if not symbol_info:
        return jsonify({"status": "error", "message": f"Symbol {symbol} not found"}), 400
    if not symbol_info.visible:
        mt5.symbol_select(symbol, True)

    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        return jsonify({"status": "error", "message": "No tick data available"}), 500

    # === BUY / SELL ===
    if action in ["BUY", "SELL"]:
        price = tick.ask if action == "BUY" else tick.bid
        order_type = mt5.ORDER_TYPE_BUY if action == "BUY" else mt5.ORDER_TYPE_SELL

        filling_modes = [mt5.ORDER_FILLING_RETURN, mt5.ORDER_FILLING_FOK]
        for mode in filling_modes:
            request_params = {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": symbol,
                "volume": lot,
                "type": order_type,
                "price": price,
                "deviation": 20,
                "magic": 123456,
                "comment": "Bridge trade",
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": mode,
            }

            if sl:
                request_params["sl"] = float(sl)
            if tp:
                request_params["tp"] = float(tp)

            result = mt5.order_send(request_params)

            if result and result.retcode == mt5.TRADE_RETCODE_DONE:
                print(f"✅ {action} executed successfully on {symbol} at {price} (mode {mode})")
                return jsonify({"status": "success", "details": result._asdict()})

            # Retry if unsupported fill mode
            if result and "Unsupported filling mode" in str(result.comment):
                print(f"⚠️ Retrying with next fill mode... ({mode})")
                time.sleep(0.5)
                continue
            else:
                print("❌ Trade execution failed:", result)
                return jsonify({"status": "error", "details": result._asdict()}), 500

        return jsonify({"status": "error", "message": "All filling modes failed"}), 500

    # === CLOSE PARTIAL ===
    elif action == "CLOSE_PARTIAL":
        positions = mt5.positions_get(symbol=symbol)
        if not positions:
            return jsonify({"status": "error", "message": f"No open position for {symbol}"}), 400

        position = positions[0]
        close_request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": float(data["lot"]),
            "type": mt5.ORDER_TYPE_SELL if position.type == 0 else mt5.ORDER_TYPE_BUY,
            "position": position.ticket,
            "price": mt5.symbol_info_tick(symbol).bid if position.type == 0 else mt5.symbol_info_tick(symbol).ask,
            "deviation": 20,
            "comment": "Partial close",
            "type_filling": mt5.ORDER_FILLING_IOC,
        }

        result = mt5.order_send(close_request)
        print(f"🟡 Partial close executed on {symbol} ({data['lot']} lots)")
        return jsonify({"status": "partial_closed", "result": str(result)})

    # === MODIFY (for trailing stop) ===
    elif action == "MODIFY":
        positions = mt5.positions_get(symbol=symbol)
        if not positions:
            return jsonify({"status": "error", "message": f"No open position for {symbol}"}), 400

        position = positions[0]
        modify_request = {
            "action": mt5.TRADE_ACTION_SLTP,
            "symbol": symbol,
            "sl": float(data.get("sl")) if data.get("sl") else position.sl,
            "tp": float(data.get("tp")) if data.get("tp") else position.tp,
            "position": position.ticket,
        }

        result = mt5.order_send(modify_request)
        print(f"🟢 Modified SL/TP for {symbol} | SL={data.get('sl')} TP={data.get('tp')}")
        return jsonify({"status": "modified", "result": str(result)})

    # === INVALID ACTION ===
    else:
        return jsonify({"status": "error", "message": "Invalid action. Use BUY, SELL, CLOSE_PARTIAL, or MODIFY"}), 400


@app.route("/status", methods=["GET"])
def status():
    """Check MT5 connection"""
    if not mt5.initialize():
        connect_mt5()
    info = mt5.account_info()
    if info:
        return jsonify({
            "status": "connected",
            "balance": info.balance,
            "login": info.login,
            "server": info.server
        })
    return jsonify({"status": "disconnected", "error": str(mt5.last_error())})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000)

