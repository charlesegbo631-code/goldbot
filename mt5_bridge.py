import os
import time
import logging
from functools import wraps
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

# third-party MT5 API
import MetaTrader5 as mt5

# load .env if present
load_dotenv()

# --- CONFIG (MT5 credentials use env; API key is hardcoded as requested) ---
MT5_LOGIN = int(os.getenv("MT5_LOGIN", "0"))          # default 0 — replace via env
MT5_PASSWORD = os.getenv("MT5_PASSWORD", "")
MT5_SERVER = os.getenv("MT5_SERVER", "")

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "5000"))

# ⚠️ Hardcoded API key (Option A)
API_KEY = "my_hardcoded_api_key_here"  # <= replace with your secret key

# Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

app = Flask(__name__)
CORS(app)  # enable CORS if you call from browser/local frontend

# --- MT5 Connection State ---
mt5_connected = False
last_init_time = None
INIT_RETRY_SECONDS = 5


def connect_mt5(force=False):
    """
    Ensure a single MT5 initialization and login.
    Returns True on success.
    """
    global mt5_connected, last_init_time
    try:
        # If already connected and not forced, check account info quickly
        if mt5_connected and not force:
            info = mt5.account_info()
            if info is not None:
                return True
            # fallback to re-init if account_info fails
            logging.warning("MT5 appears disconnected, reinitializing...")

        # shutdown first to get a clean state
        try:
            mt5.shutdown()
        except Exception:
            pass

        if not mt5.initialize():
            logging.error("MT5 initialize() failed: %s", mt5.last_error())
            mt5_connected = False
            return False

        # If login credentials provided, attempt login
        if MT5_LOGIN and MT5_PASSWORD and MT5_SERVER:
            if not mt5.login(MT5_LOGIN, MT5_PASSWORD, MT5_SERVER):
                logging.error("MT5 login failed: %s", mt5.last_error())
                mt5_connected = False
                return False

        # double-check
        info = mt5.account_info()
        if info is None:
            logging.error("MT5 account_info() returned None after init/login: %s", mt5.last_error())
            mt5_connected = False
            return False

        mt5_connected = True
        last_init_time = time.time()
        logging.info("✅ MT5 connected: server=%s login=%s balance=%s", info.server, info.login, info.balance)
        return True

    except Exception as e:
        logging.exception("Exception while connecting to MT5: %s", e)
        mt5_connected = False
        return False


# Try to connect once at start
connect_mt5()


# --- Utility helpers ---
def require_api_key(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        key = request.headers.get("x-api-key")
        if not key or key != API_KEY:
            return jsonify({"status": "error", "message": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return wrapper


def safe_result_to_dict(result):
    """
    Convert result-like objects from MetaTrader5 to dict safely.
    """
    try:
        return result._asdict()
    except Exception:
        try:
            return dict(result)
        except Exception:
            return {"result": str(result)}


def ensure_symbol(symbol):
    info = mt5.symbol_info(symbol)
    if not info:
        return False, f"Symbol {symbol} not found"
    if not info.visible:
        if not mt5.symbol_select(symbol, True):
            return False, f"Symbol {symbol} not available and symbol_select failed"
    return True, info


# --- Endpoints ---
@app.route("/trade", methods=["POST"])
@require_api_key
def trade():
    global mt5_connected

    # validate connection
    if not mt5_connected:
        ok = connect_mt5()
        if not ok:
            return jsonify({"status": "error", "message": "MT5 not connected"}), 500

    # parse and validate request
    try:
        data = request.get_json(force=True)
    except Exception:
        return jsonify({"status": "error", "message": "Invalid JSON payload"}), 400

    action = str(data.get("action", "")).upper()
    symbol = str(data.get("symbol", "XAUUSD"))
    lot = data.get("lot", None)
    ticket = data.get("ticket", None)  # optional: allow specifying which position to act on
    sl = data.get("sl", None)
    tp = data.get("tp", None)

    # basic validation for lot when provided
    try:
        if lot is not None:
            lot = float(lot)
    except Exception:
        return jsonify({"status": "error", "message": "Invalid lot value"}), 400

    # Ensure symbol is available
    ok, info_or_msg = ensure_symbol(symbol)
    if not ok:
        return jsonify({"status": "error", "message": info_or_msg}), 400
    symbol_info = info_or_msg

    # prepare tick safely
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return jsonify({"status": "error", "message": "No tick data available"}), 500

    # --- BUY / SELL ---
    if action in ["BUY", "SELL"]:
        if lot is None or lot <= 0:
            return jsonify({"status": "error", "message": "lot must be provided and > 0 for BUY/SELL"}), 400

        price = float(tick.ask) if action == "BUY" else float(tick.bid)
        order_type = mt5.ORDER_TYPE_BUY if action == "BUY" else mt5.ORDER_TYPE_SELL

        # optional SL/TP corrections (maintain correct direction & min distance)
        try:
            if sl is not None:
                sl = float(sl)
            if tp is not None:
                tp = float(tp)
        except Exception:
            return jsonify({"status": "error", "message": "Invalid sl/tp values"}), 400

        # fix directions
        if sl is not None and tp is not None:
            if action == "BUY":
                if sl >= price:
                    sl = price - max(abs(sl - price), symbol_info.point * 10)
                if tp <= price:
                    tp = price + max(abs(price - tp), symbol_info.point * 10)
            else:  # SELL
                if sl <= price:
                    sl = price + max(abs(price - sl), symbol_info.point * 10)
                if tp >= price:
                    tp = price - max(abs(tp - price), symbol_info.point * 10)

            # enforce stops level if available
            try:
                stop_level = int(symbol_info.trade_stops_level) * float(symbol_info.point)
                if stop_level > 0:
                    if abs(price - sl) < stop_level:
                        sl = price - stop_level if action == "BUY" else price + stop_level
                    if abs(price - tp) < stop_level:
                        tp = price + stop_level if action == "BUY" else price - stop_level
            except Exception:
                # if symbol_info doesn't provide trade_stops_level, ignore
                pass

        # prepare request structure and attempt several filling modes (FOK/IOC/RETURN)
        filling_modes = [mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_IOC, mt5.ORDER_FILLING_RETURN]
        last_error = None
        for mode in filling_modes:
            request_params = {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": symbol,
                "volume": float(lot),
                "type": order_type,
                "price": price,
                "deviation": 20,
                "magic": 123456,
                "comment": "Bridge trade",
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": mode,
            }
            if sl is not None:
                request_params["sl"] = float(sl)
            if tp is not None:
                request_params["tp"] = float(tp)

            try:
                result = mt5.order_send(request_params)
            except Exception as e:
                logging.exception("order_send exception for mode %s: %s", mode, e)
                last_error = str(e)
                time.sleep(0.2)
                continue

            if result is None:
                last_error = "MT5 order_send returned None"
                logging.warning("order_send returned None (mode=%s)", mode)
                time.sleep(0.2)
                continue

            # handle result robustly
            try:
                retcode = getattr(result, "retcode", None)
                # success codes differ across builds, test for TRADE_RETCODE_DONE or 10009 etc
                success = (retcode == mt5.TRADE_RETCODE_DONE) or (retcode == 10009) or (str(result).lower().find("done") != -1)
            except Exception:
                success = False

            if success:
                logging.info("%s executed successfully on %s at %s (mode %s)", action, symbol, price, mode)
                return jsonify({"status": "success", "details": safe_result_to_dict(result)})

            # If filling mode unsupported, try next
            msg = str(result.comment) if hasattr(result, "comment") else str(result)
            if "Unsupported filling mode" in msg or "filling" in msg.lower():
                logging.warning("Filling mode %s unsupported, trying next", mode)
                last_error = msg
                time.sleep(0.2)
                continue
            else:
                # other failure
                logging.error("Trade execution failed (mode=%s): %s", mode, safe_result_to_dict(result))
                return jsonify({"status": "error", "details": safe_result_to_dict(result)}), 500

        return jsonify({"status": "error", "message": "All filling modes failed", "last_error": last_error}), 500

    # --- CLOSE_PARTIAL ---
    elif action == "CLOSE_PARTIAL":
        # require lot param
        if lot is None:
            return jsonify({"status": "error", "message": "Provide 'lot' to close partially"}), 400
        try:
            close_volume = float(lot)
        except Exception:
            return jsonify({"status": "error", "message": "Invalid 'lot' value"}), 400

        # find the position to close: prefer explicit ticket if provided
        positions = mt5.positions_get(symbol=symbol)
        if not positions:
            return jsonify({"status": "error", "message": f"No open positions for {symbol}"}), 400

        position = None
        if ticket:
            # try to find matching ticket
            for p in positions:
                if int(getattr(p, "ticket", -1)) == int(ticket):
                    position = p
                    break
            if position is None:
                return jsonify({"status": "error", "message": f"Position with ticket {ticket} not found"}), 400
        else:
            # default: pick the largest volume position (safer heuristic)
            position = max(positions, key=lambda p: getattr(p, "volume", 0))

        if close_volume <= 0 or close_volume >= float(position.volume):
            return jsonify({"status": "error", "message": "Invalid partial close volume; must be >0 and < position.volume"}), 400

        # build close request: careful with direction (position.type: 0=buy 1=sell)
        position_type = int(getattr(position, "type", 0))
        close_type = mt5.ORDER_TYPE_SELL if position_type == 0 else mt5.ORDER_TYPE_BUY
        price_to_use = float(tick.bid) if position_type == 0 else float(tick.ask)

        close_request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": float(close_volume),
            "type": close_type,
            "position": int(getattr(position, "ticket")),
            "price": price_to_use,
            "deviation": 20,
            "comment": "Partial close",
            "type_filling": mt5.ORDER_FILLING_IOC,
        }

        try:
            result = mt5.order_send(close_request)
        except Exception as e:
            logging.exception("Partial close order_send exception: %s", e)
            return jsonify({"status": "error", "message": str(e)}), 500

        logging.info("Partial close requested: %s", safe_result_to_dict(result))
        return jsonify({"status": "partial_closed", "result": safe_result_to_dict(result)})

    # --- MODIFY (SL/TP update for a position) ---
    elif action == "MODIFY":
        # require at least sl or tp
        if sl is None and tp is None:
            return jsonify({"status": "error", "message": "Provide at least 'sl' or 'tp' to modify"}), 400

        try:
            sl_val = float(sl) if sl is not None else None
        except Exception:
            return jsonify({"status": "error", "message": "Invalid 'sl' value"}), 400
        try:
            tp_val = float(tp) if tp is not None else None
        except Exception:
            return jsonify({"status": "error", "message": "Invalid 'tp' value"}), 400

        # select which position to modify: by ticket preferred else by symbol (first)
        positions = mt5.positions_get(symbol=symbol)
        if not positions:
            return jsonify({"status": "error", "message": f"No open positions for {symbol}"}), 400

        position = None
        if ticket:
            for p in positions:
                if int(getattr(p, "ticket", -1)) == int(ticket):
                    position = p
                    break
            if position is None:
                return jsonify({"status": "error", "message": f"Position with ticket {ticket} not found"}), 400
        else:
            # prefer the same side position as the last one (simple heuristic)
            position = positions[0]

        modify_request = {
            "action": mt5.TRADE_ACTION_SLTP,
            "position": int(getattr(position, "ticket")),
            "symbol": symbol,
            # if None, use current values from position
            "sl": float(sl_val) if sl_val is not None else float(getattr(position, "sl", 0.0)),
            "tp": float(tp_val) if tp_val is not None else float(getattr(position, "tp", 0.0)),
        }

        try:
            result = mt5.order_send(modify_request)
        except Exception as e:
            logging.exception("Modify order_send exception: %s", e)
            return jsonify({"status": "error", "message": str(e)}), 500

        logging.info("Modify SL/TP result: %s", safe_result_to_dict(result))
        return jsonify({"status": "modified", "result": safe_result_to_dict(result)})

    else:
        return jsonify({"status": "error", "message": "Invalid action. Use BUY, SELL, CLOSE_PARTIAL, or MODIFY"}), 400


@app.route("/status", methods=["GET"])
@require_api_key
def status():
    """
    Check MT5 connection & basic account info.
    """
    global mt5_connected
    if not mt5_connected:
        ok = connect_mt5()
        if not ok:
            return jsonify({"status": "disconnected", "error": mt5.last_error()}), 500

    info = mt5.account_info()
    if info:
        return jsonify({
            "status": "connected",
            "balance": float(info.balance),
            "login": int(info.login),
            "server": str(info.server),
        })
    return jsonify({"status": "disconnected", "error": str(mt5.last_error())}), 500


# graceful shutdown helper if needed
def shutdown():
    try:
        mt5.shutdown()
    except Exception:
        pass


if __name__ == "__main__":
    logging.info("Starting MT5 Bridge API on %s:%d", HOST, PORT)
    try:
        app.run(host=HOST, port=PORT)
    finally:
        shutdown()
