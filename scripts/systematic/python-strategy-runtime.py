#!/usr/bin/env python3
"""Private JSONL bootstrap for the Desic local Python strategy runtime.

This file is intentionally not a general Python shell. Strategy source enters only via a
validated load message and executes with a reduced builtins set. It receives only the
point-in-time research contract supplied by the desktop host.
"""

from __future__ import annotations

import ast
import builtins
import contextlib
import io
import json
import math
import re
import sys
from collections.abc import Mapping, Sequence
from types import MappingProxyType

PROTOCOL = "desic.systematic.python/v1"
MAX_SOURCE_BYTES = 256 * 1024
MAX_LINE_BYTES = 8 * 1024 * 1024
MAX_CACHED_BARS = 20_000
MAX_CACHED_LEDGER_ROWS = 1_000
ALLOWED_IMPORTS = {"collections", "dataclasses", "math", "numpy", "pandas", "sklearn", "statistics", "typing"}
FORBIDDEN_IMPORTS = {
    "aiohttp", "asyncio", "builtins", "ctypes", "fileinput", "ftplib", "glob", "http", "importlib",
    "io", "multiprocessing", "os", "pathlib", "pickle", "pty", "requests", "runpy", "shutil", "signal",
    "socket", "smtplib", "ssl", "subprocess", "sys", "tempfile", "telnetlib", "urllib", "webbrowser", "websockets",
}
FORBIDDEN_NAMES = {
    "__import__", "breakpoint", "compile", "delattr", "dir", "eval", "exec", "getattr", "globals",
    "help", "input", "locals", "open", "setattr", "vars",
}
TIMESTAMP_FIELDS = {
    "asOfMs", "closeTimeMs", "closedAtMs", "completedAtMs", "createdAtMs", "filledAtMs",
    "lastUpdatedMs", "observedAtMs", "openedAtMs", "openTimeMs", "publishedAtMs", "timestampMs",
    "tsMs", "updatedAtMs",
}
MAX_SAFE_INTEGER = 9_007_199_254_740_991
INSTRUMENT_ID_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9-]{1,62}[A-Z0-9]$")
INTERVAL_PATTERN = re.compile(r"^[1-9]\d*(?:m|H|D|W)$")
MARKET_INTERVALS = ("1m", "3m", "5m", "15m", "30m", "1H", "2H", "4H", "6H", "12H", "1D")
REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
STRATEGY_ACTIONS = {
    "open_long", "open_short", "close_long", "close_short", "set_protection",
    "cancel_protection", "cancel_order",
}
POSITION_SIDES = {"long", "short"}
ORDER_STATUSES = {"open", "partially_filled"}
ORDER_TYPES = {"market", "limit"}
HANDLER_ARGUMENTS = {
    "on_start": ("ctx",),
    "on_bar": ("ctx",),
    # Compatibility only: current adapters never dispatch this hook.
    "on_fill": ("ctx", "fill"),
    "on_rebalance": ("ctx",),
}
STRATEGY_CONTEXT_CALLS = {
    "position": (2, {"instrument_id", "side"}),
    "no_action": (1, {"reason"}),
    "market_order": (0, set()),
    "limit_order": (1, {"limit_price"}),
    "open_long": (1, {"reason", "protection", "execution", "metadata"}),
    "open_short": (1, {"reason", "protection", "execution", "metadata"}),
    "close_long": (1, {"reason", "execution", "metadata"}),
    "close_short": (1, {"reason", "execution", "metadata"}),
    "set_protection": (1, {"reason", "stop_loss_price", "take_profit_price", "metadata"}),
    "cancel_protection": (1, {"reason", "metadata"}),
    "cancel_order": (2, {"order_id", "reason", "metadata"}),
    # Legacy research helpers remain loadable for compatibility fixtures. New
    # single-contract strategy source should use the action methods above.
    "signal": (3, {"direction", "reason", "confidence", "metadata"}),
    "paper_intent": (3, {"action", "reason", "quantity", "metadata"}),
    "factor": (3, {"factor_id", "values", "metadata"}),
    "alpha": (4, {"model_id", "horizon_ms", "scores", "metadata"}),
    "portfolio_target": (1, {"weights", "metadata"}),
}
STRATEGY_CONTEXT_POSITIONAL_PARAMETERS = {
    "position": ("instrument_id", "side"),
    "no_action": ("reason",),
    "market_order": (),
    "limit_order": ("limit_price",),
    "open_long": ("reason",),
    "open_short": ("reason",),
    "close_long": ("reason",),
    "close_short": ("reason",),
    "set_protection": ("reason",),
    "cancel_protection": ("reason",),
    "cancel_order": ("order_id", "reason"),
    "signal": ("direction", "reason", "confidence"),
    "paper_intent": ("action", "reason", "quantity"),
    "factor": ("factor_id", "values", "metadata"),
    "alpha": ("model_id", "horizon_ms", "scores", "metadata"),
    "portfolio_target": ("weights",),
}
UNSET = object()


class ProtocolFailure(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class FrozenMap(Mapping):
    __slots__ = ("_values",)

    def __init__(self, values):
        object.__setattr__(self, "_values", MappingProxyType({key: freeze(value) for key, value in values.items()}))

    def __setattr__(self, _name, _value):
        raise TypeError("strategy context is immutable")

    def __getitem__(self, key):
        return self._values[key]

    def __iter__(self):
        return iter(self._values)

    def __len__(self):
        return len(self._values)

    def __getattr__(self, key):
        try:
            return self._values[key]
        except KeyError as error:
            raise AttributeError(key) from error

    def get(self, key, default=None):
        return self._values.get(key, default)


class ImmutableObject:
    __slots__ = ()

    def __setattr__(self, _name, _value):
        raise TypeError("strategy context is immutable")


def freeze(value):
    if isinstance(value, dict):
        return FrozenMap(value)
    if isinstance(value, list):
        return tuple(freeze(item) for item in value)
    return value


def finite_number(value, label):
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ProtocolFailure("invalid_shape", f"{label} must be a finite number")
    return value


def non_negative_number(value, label):
    number = finite_number(value, label)
    if number < 0:
        raise ProtocolFailure("invalid_shape", f"{label} must be zero or greater")
    return number


def positive_number(value, label):
    number = finite_number(value, label)
    if number <= 0:
        raise ProtocolFailure("invalid_shape", f"{label} must be greater than zero")
    return number


def positive_int(value, label):
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0 or value > MAX_SAFE_INTEGER:
        raise ProtocolFailure("invalid_shape", f"{label} must be a positive safe integer")
    return value


def plain_dict(value, label):
    if not isinstance(value, dict):
        raise ProtocolFailure("invalid_shape", f"{label} must be an object")
    return value


def nonempty_string(value, label, maximum=4096, pattern=None):
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ProtocolFailure("invalid_shape", f"{label} must be a non-empty string")
    if pattern is not None and pattern.fullmatch(value) is None:
        raise ProtocolFailure("invalid_shape", f"{label} has an invalid format")
    return value


def reject_unknown_fields(value, allowed, label):
    for key in value:
        if key not in allowed:
            raise ProtocolFailure("unknown_field", f"{label}.{key} is not part of the protocol")


def ensure_no_future_timestamps(value, cutoff_ms, label="event", depth=0, skip_keys=()):
    """Reject any timestamp past the event cutoff.

    ``skip_keys`` omits top-level keys whose subtree a dedicated validator has
    already walked with the same cutoff and the same rules. This keeps the
    accepted/rejected set identical while avoiding a second full traversal of
    the market series, which is the largest object in a steady-state event.
    """
    if depth > 16 or not isinstance(value, (dict, list)):
        return
    # Labels are only needed to describe a rejection, so they are built lazily.
    # Formatting one per visited node made the walk cost scale with the payload
    # even when every field was valid, which is the normal case for every bar.
    if isinstance(value, list):
        for index, child in enumerate(value):
            if isinstance(child, (dict, list)):
                ensure_no_future_timestamps(child, cutoff_ms, f"{label}[{index}]", depth + 1)
        return
    for key, child in value.items():
        if depth == 0 and key in skip_keys:
            continue
        if key in TIMESTAMP_FIELDS:
            positive_int(child, f"{label}.{key}")
            # An aggregate's nominal close is deliberately ahead of the
            # current cutoff while the bucket is still forming. Its OHLCV is
            # bounded by the current event and `confirmed=False` makes the
            # state explicit to strategy code.
            if child > cutoff_ms and not (
                key == "closeTimeMs" and value.get("confirmed") is False
            ):
                raise ProtocolFailure("future_data", f"{label}.{key} is later than event.asOfMs")
        if isinstance(child, (dict, list)):
            ensure_no_future_timestamps(child, cutoff_ms, f"{label}.{key}", depth + 1)


def validate_bar(bar, cutoff_ms, label):
    value = plain_dict(bar, label)
    reject_unknown_fields(value, {"openTimeMs", "closeTimeMs", "open", "high", "low", "close", "volume", "confirmed"}, label)
    open_time = positive_int(value.get("openTimeMs"), f"{label}.openTimeMs")
    close_time = positive_int(value.get("closeTimeMs"), f"{label}.closeTimeMs")
    if open_time >= close_time:
        raise ProtocolFailure("invalid_bar", f"{label} must open before it closes")
    confirmed = value.get("confirmed")
    if not isinstance(confirmed, bool):
        raise ProtocolFailure("invalid_bar", f"{label}.confirmed must be boolean")
    if confirmed and close_time > cutoff_ms:
        raise ProtocolFailure("future_data", f"{label}.closeTimeMs is later than event.asOfMs")
    if not confirmed and (open_time >= cutoff_ms or close_time <= cutoff_ms):
        raise ProtocolFailure("invalid_bar", f"{label} must be the active in-progress bucket")
    for field in ("open", "high", "low", "close", "volume"):
        finite_number(value.get(field), f"{label}.{field}")
    if value["high"] < max(value["open"], value["close"]) or value["low"] > min(value["open"], value["close"]) or value["high"] < value["low"]:
        raise ProtocolFailure("invalid_bar", f"{label} has invalid OHLC values")


def validate_series(item, cutoff_ms, label):
    value = plain_dict(item, label)
    reject_unknown_fields(value, {"instrumentId", "interval", "bars"}, label)
    nonempty_string(value.get("instrumentId"), f"{label}.instrumentId", 64, INSTRUMENT_ID_PATTERN)
    nonempty_string(value.get("interval"), f"{label}.interval", 12, INTERVAL_PATTERN)
    bars = value.get("bars")
    if not isinstance(bars, list) or not bars or len(bars) > 20_000:
        raise ProtocolFailure("invalid_series", f"{label}.bars must contain 1 to 20000 closed bars")
    previous_close = 0
    for bar_index, bar in enumerate(bars):
        validate_bar(bar, cutoff_ms, f"{label}.bars[{bar_index}]")
        if bar["closeTimeMs"] <= previous_close:
            raise ProtocolFailure("invalid_series", f"{label}.bars must be strictly chronological")
        if bar.get("confirmed") is False and bar_index != len(bars) - 1:
            raise ProtocolFailure("invalid_series", f"{label} may contain an unconfirmed bar only at the end")
        previous_close = bar["closeTimeMs"]


def validate_market(market, cutoff_ms):
    value = plain_dict(market, "event.market")
    reject_unknown_fields(value, {"series"}, "event.market")
    series = value.get("series")
    if not isinstance(series, list) or not series or len(series) > 256:
        raise ProtocolFailure("invalid_market", "event.market.series must contain 1 to 256 series")
    keys = set()
    for index, item in enumerate(series):
        validate_series(item, cutoff_ms, f"event.market.series[{index}]")
        key = (item["instrumentId"], item["interval"])
        if key in keys:
            raise ProtocolFailure("invalid_market", "event.market.series contains duplicate series")
        keys.add(key)
    ensure_no_future_timestamps(value, cutoff_ms, "event.market")


def validate_portfolio_position(position, cutoff_ms, label):
    value = plain_dict(position, label)
    reject_unknown_fields(value, {"instrumentId", "side", "quantity", "averageEntryPrice", "markPrice", "contractValue", "notionalUsdt", "usedMarginUsdt", "leverage", "marginSafetyMultiplier", "unrealizedPnlUsdt", "entryFeeUsdt", "fundingCashflowUsdt", "stopLossPrice", "takeProfitPrice", "openedAtMs", "updatedAtMs"}, label)
    nonempty_string(value.get("instrumentId"), f"{label}.instrumentId", 64, INSTRUMENT_ID_PATTERN)
    if value.get("side") not in POSITION_SIDES:
        raise ProtocolFailure("invalid_shape", f"{label}.side must be long or short")
    positive_number(value.get("quantity"), f"{label}.quantity")
    for field in ("averageEntryPrice", "markPrice", "contractValue", "notionalUsdt", "usedMarginUsdt", "leverage", "marginSafetyMultiplier"):
        if field in value:
            positive_number(value[field], f"{label}.{field}")
    for field in ("stopLossPrice", "takeProfitPrice"):
        if field in value and value[field] is not None:
            positive_number(value[field], f"{label}.{field}")
    for field in ("unrealizedPnlUsdt", "entryFeeUsdt", "fundingCashflowUsdt"):
        if field in value:
            finite_number(value[field], f"{label}.{field}")
    if "unrealizedPnlUsdt" in value:
        finite_number(value["unrealizedPnlUsdt"], f"{label}.unrealizedPnlUsdt")
    for field in ("openedAtMs", "updatedAtMs"):
        if field in value:
            positive_int(value[field], f"{label}.{field}")
    if "openedAtMs" in value and "updatedAtMs" in value and value["updatedAtMs"] < value["openedAtMs"]:
        raise ProtocolFailure("invalid_shape", f"{label}.updatedAtMs must not precede openedAtMs")
    ensure_no_future_timestamps(value, cutoff_ms, label)


def validate_portfolio_order(order, cutoff_ms, label):
    value = plain_dict(order, label)
    reject_unknown_fields(value, {"id", "instrumentId", "action", "quantity", "filledQuantity", "status", "createdAtMs", "price", "triggerPrice"}, label)
    nonempty_string(value.get("id"), f"{label}.id", 128, REQUEST_ID_PATTERN)
    nonempty_string(value.get("instrumentId"), f"{label}.instrumentId", 64, INSTRUMENT_ID_PATTERN)
    if value.get("action") not in STRATEGY_ACTIONS:
        raise ProtocolFailure("invalid_shape", f"{label}.action is invalid")
    quantity = positive_number(value.get("quantity"), f"{label}.quantity")
    filled = non_negative_number(value.get("filledQuantity"), f"{label}.filledQuantity")
    if filled >= quantity:
        raise ProtocolFailure("invalid_shape", f"{label}.filledQuantity must be lower than quantity for an open order")
    if value.get("status") not in ORDER_STATUSES:
        raise ProtocolFailure("invalid_shape", f"{label}.status must be open or partially_filled")
    positive_int(value.get("createdAtMs"), f"{label}.createdAtMs")
    for field in ("price", "triggerPrice"):
        if field in value:
            positive_number(value[field], f"{label}.{field}")
    ensure_no_future_timestamps(value, cutoff_ms, label)


def validate_portfolio_fill(fill, cutoff_ms, label):
    value = plain_dict(fill, label)
    reject_unknown_fields(value, {"id", "orderId", "instrumentId", "action", "quantity", "price", "notionalUsdt", "filledAtMs", "feeUsdt", "marginDeltaUsdt", "marginAfterUsdt"}, label)
    nonempty_string(value.get("id"), f"{label}.id", 128, REQUEST_ID_PATTERN)
    nonempty_string(value.get("orderId"), f"{label}.orderId", 128, REQUEST_ID_PATTERN)
    nonempty_string(value.get("instrumentId"), f"{label}.instrumentId", 64, INSTRUMENT_ID_PATTERN)
    if value.get("action") not in STRATEGY_ACTIONS:
        raise ProtocolFailure("invalid_shape", f"{label}.action is invalid")
    positive_number(value.get("quantity"), f"{label}.quantity")
    positive_number(value.get("price"), f"{label}.price")
    positive_int(value.get("filledAtMs"), f"{label}.filledAtMs")
    if "feeUsdt" in value:
        non_negative_number(value["feeUsdt"], f"{label}.feeUsdt")
    if "notionalUsdt" in value:
        positive_number(value["notionalUsdt"], f"{label}.notionalUsdt")
    if "marginDeltaUsdt" in value:
        finite_number(value["marginDeltaUsdt"], f"{label}.marginDeltaUsdt")
    if "marginAfterUsdt" in value:
        non_negative_number(value["marginAfterUsdt"], f"{label}.marginAfterUsdt")
    ensure_no_future_timestamps(value, cutoff_ms, label)


def validate_portfolio_trade(trade, cutoff_ms, label):
    value = plain_dict(trade, label)
    reject_unknown_fields(value, {"id", "instrumentId", "side", "quantity", "entryPrice", "exitPrice", "entryNotionalUsdt", "exitNotionalUsdt", "usedMarginUsdt", "leverage", "marginSafetyMultiplier", "openedAtMs", "closedAtMs", "realizedPnlUsdt", "feesUsdt"}, label)
    nonempty_string(value.get("id"), f"{label}.id", 128, REQUEST_ID_PATTERN)
    nonempty_string(value.get("instrumentId"), f"{label}.instrumentId", 64, INSTRUMENT_ID_PATTERN)
    if value.get("side") not in POSITION_SIDES:
        raise ProtocolFailure("invalid_shape", f"{label}.side must be long or short")
    positive_number(value.get("quantity"), f"{label}.quantity")
    positive_number(value.get("entryPrice"), f"{label}.entryPrice")
    positive_number(value.get("exitPrice"), f"{label}.exitPrice")
    positive_int(value.get("openedAtMs"), f"{label}.openedAtMs")
    positive_int(value.get("closedAtMs"), f"{label}.closedAtMs")
    if value["closedAtMs"] < value["openedAtMs"]:
        raise ProtocolFailure("invalid_shape", f"{label}.closedAtMs must not precede openedAtMs")
    if "realizedPnlUsdt" in value:
        finite_number(value["realizedPnlUsdt"], f"{label}.realizedPnlUsdt")
    if "feesUsdt" in value:
        non_negative_number(value["feesUsdt"], f"{label}.feesUsdt")
    for field in ("entryNotionalUsdt", "exitNotionalUsdt", "usedMarginUsdt", "leverage", "marginSafetyMultiplier"):
        if field in value:
            positive_number(value[field], f"{label}.{field}")
    ensure_no_future_timestamps(value, cutoff_ms, label)


def validate_portfolio(portfolio, cutoff_ms):
    value = plain_dict(portfolio, "event.portfolio")
    reject_unknown_fields(value, {"cashUsdt", "equityUsdt", "usedMarginUsdt", "availableMarginUsdt", "positions", "openOrders", "recentFills", "trades", "ledgerMode"}, "event.portfolio")
    if value.get("ledgerMode", "replace") not in {"replace", "append"}:
        raise ProtocolFailure("invalid_portfolio", "event.portfolio.ledgerMode must be replace or append")
    non_negative_number(value.get("cashUsdt"), "event.portfolio.cashUsdt")
    equity = non_negative_number(value.get("equityUsdt"), "event.portfolio.equityUsdt")
    used = non_negative_number(value.get("usedMarginUsdt", 0.0), "event.portfolio.usedMarginUsdt")
    available = non_negative_number(value.get("availableMarginUsdt"), "event.portfolio.availableMarginUsdt")
    if available > equity:
        raise ProtocolFailure("invalid_shape", "event.portfolio.availableMarginUsdt must not exceed equityUsdt")
    if used + available > equity + 1e-8:
        raise ProtocolFailure("invalid_shape", "event.portfolio.usedMarginUsdt plus availableMarginUsdt must not exceed equityUsdt")
    collections = (
        ("positions", 512, validate_portfolio_position, lambda row: f"{row['instrumentId']}|{row['side']}"),
        ("openOrders", 2_000, validate_portfolio_order, lambda row: row["id"]),
        ("recentFills", 5_000, validate_portfolio_fill, lambda row: row["id"]),
        ("trades", 10_000, validate_portfolio_trade, lambda row: row["id"]),
    )
    for field, maximum, validator, key_for in collections:
        rows = value.get(field)
        if not isinstance(rows, list) or len(rows) > maximum:
            raise ProtocolFailure("invalid_shape", f"event.portfolio.{field} must contain 0 to {maximum} rows")
        keys = set()
        for index, row in enumerate(rows):
            validator(row, cutoff_ms, f"event.portfolio.{field}[{index}]")
            key = key_for(row)
            if key in keys:
                raise ProtocolFailure("invalid_shape", f"event.portfolio.{field} contains duplicate {key}")
            keys.add(key)


def validate_active_instrument_event(event, cutoff_ms, kind):
    instrument_id = nonempty_string(event.get("instrumentId"), "event.instrumentId", 64, INSTRUMENT_ID_PATTERN)
    interval = nonempty_string(event.get("interval"), "event.interval", 12, INTERVAL_PATTERN)
    matching = next((item for item in event["market"]["series"] if item["instrumentId"] == instrument_id and item["interval"] == interval), None)
    if matching is None:
        raise ProtocolFailure("invalid_event", f"{kind} events must include the active instrument series in event.market.series")
    if kind == "bar":
        validate_bar(event.get("bar"), cutoff_ms, "event.bar")
        if event["bar"]["closeTimeMs"] != cutoff_ms:
            raise ProtocolFailure("invalid_event", "bar event.bar.closeTimeMs must exactly equal event.asOfMs")
        if matching["bars"][-1]["closeTimeMs"] != event["bar"]["closeTimeMs"]:
            raise ProtocolFailure("invalid_event", "bar event.bar must be the latest active series bar")


def validate_event(event):
    value = plain_dict(event, "event")
    kind = value.get("kind")
    if kind not in {"start", "bar", "rebalance"}:
        raise ProtocolFailure("invalid_event_kind", "event.kind must be start, bar, or rebalance")
    cutoff_ms = positive_int(value.get("asOfMs"), "event.asOfMs")
    nonempty_string(value.get("snapshotId"), "event.snapshotId", 128, REQUEST_ID_PATTERN)
    validate_market(value.get("market"), cutoff_ms)
    if "portfolio" in value:
        validate_portfolio(value["portfolio"], cutoff_ms)
    if kind in {"start", "bar"}:
        allowed = {"kind", "snapshotId", "asOfMs", "instrumentId", "interval", "market", "portfolio"}
        if kind == "bar":
            allowed.add("bar")
        reject_unknown_fields(value, allowed, "event")
        validate_active_instrument_event(value, cutoff_ms, kind)
        if kind == "start" and "portfolio" not in value:
            raise ProtocolFailure("invalid_portfolio", f"{kind} events require event.portfolio")
    else:
        reject_unknown_fields(value, {"kind", "snapshotId", "asOfMs", "market", "portfolio", "universe"}, "event")
        universe = value.get("universe")
        if not isinstance(universe, list) or not universe or len(universe) > 1_000:
            raise ProtocolFailure("invalid_universe", "rebalance event requires 1 to 1000 universe rows")
        ids = set()
        for index, row in enumerate(universe):
            row = plain_dict(row, f"event.universe[{index}]")
            reject_unknown_fields(row, {"instrumentId", "eligible"}, f"event.universe[{index}]")
            nonempty_string(row.get("instrumentId"), f"event.universe[{index}].instrumentId", 64, INSTRUMENT_ID_PATTERN)
            if row["instrumentId"] in ids:
                raise ProtocolFailure("invalid_universe", "event.universe contains duplicate instrumentId values")
            ids.add(row["instrumentId"])
            if "eligible" in row and not isinstance(row["eligible"], bool):
                raise ProtocolFailure("invalid_universe", f"event.universe[{index}].eligible must be boolean when present")
            ensure_no_future_timestamps(row, cutoff_ms, f"event.universe[{index}]")
    # `validate_market` already walked `event.market` with this same cutoff and
    # the same partial-bucket rule, and it is the largest subtree in a
    # steady-state event. Every other branch is still walked here, including
    # `event.portfolio`, whose row validators check timestamp *shape* but not
    # the cutoff.
    ensure_no_future_timestamps(value, cutoff_ms, skip_keys=("market",))
    return value


class FrozenSnapshotSeries(Sequence):
    """An immutable, point-in-time view over chunked frozen protocol rows.

    A strategy may retain a value returned from ``ctx.market.bars``. The view
    must therefore never observe bars appended by a later event. Chunks are
    immutable and a snapshot stores its own offset and length, avoiding a full
    history copy for every confirmed minute while preserving that guarantee.
    """

    __slots__ = ("_chunks", "_start", "_length")

    def __init__(self, chunks, start, length):
        object.__setattr__(self, "_chunks", chunks)
        object.__setattr__(self, "_start", start)
        object.__setattr__(self, "_length", length)

    def __setattr__(self, _name, _value):
        raise TypeError("strategy context is immutable")

    def __len__(self):
        return self._length

    def __iter__(self):
        remaining = self._length
        offset = self._start
        for chunk in self._chunks:
            if remaining <= 0:
                return
            available = min(len(chunk) - offset, remaining)
            if available > 0:
                yield from chunk[offset:offset + available]
                remaining -= available
            offset = 0

    def _value_at(self, index):
        if index < self._length // 2:
            remaining = self._start + index
            for chunk in self._chunks:
                if remaining < len(chunk):
                    return chunk[remaining]
                remaining -= len(chunk)
        else:
            remaining = self._length - 1 - index
            for chunk in reversed(self._chunks):
                if remaining < len(chunk):
                    return chunk[len(chunk) - 1 - remaining]
                remaining -= len(chunk)
        raise IndexError("index is outside the current protocol snapshot")

    def __getitem__(self, index):
        if isinstance(index, slice):
            start, stop, step = index.indices(self._length)
            return tuple(self._value_at(item) for item in range(start, stop, step))
        if not isinstance(index, int):
            raise TypeError("snapshot indexes must be integers or slices")
        normalized = index + self._length if index < 0 else index
        if normalized < 0 or normalized >= self._length:
            raise IndexError("index is outside the current protocol snapshot")
        return self._value_at(normalized)

    def tail(self, count):
        remaining_skip = max(0, self._length - count)
        values = []
        offset = self._start
        for chunk in self._chunks:
            available = len(chunk) - offset
            if remaining_skip >= available:
                remaining_skip -= available
            else:
                values.extend(chunk[offset + remaining_skip:])
                remaining_skip = 0
            offset = 0
        return tuple(values)


class MarketSeriesCache:
    """Append-only frozen storage with inexpensive, immutable snapshots."""

    __slots__ = ("_chunks", "_start", "_length", "_maximum")
    CHUNK_SIZE = 256

    def __init__(self, bars, maximum=MAX_CACHED_BARS):
        self._maximum = maximum
        self.replace(bars)

    def replace(self, bars):
        frozen_bars = tuple(freeze(bar) for bar in bars[-self._maximum:])
        chunks = tuple(
            frozen_bars[index:index + self.CHUNK_SIZE]
            for index in range(0, len(frozen_bars), self.CHUNK_SIZE)
        )
        self._chunks = chunks
        self._start = 0
        self._length = len(frozen_bars)

    def latest_close_time_ms(self):
        if self._length <= 0:
            return None
        return self._chunks[-1][-1].closeTimeMs

    def append(self, bar):
        evicted = None
        if self._length >= self._maximum:
            first_chunk = self._chunks[0]
            evicted = first_chunk[self._start]
            if self._start + 1 >= len(first_chunk):
                self._chunks = self._chunks[1:]
                self._start = 0
            else:
                self._start += 1
            self._length -= 1

        frozen_bar = freeze(bar)
        if not self._chunks or len(self._chunks[-1]) >= self.CHUNK_SIZE:
            self._chunks = self._chunks + ((frozen_bar,),)
        else:
            self._chunks = self._chunks[:-1] + (self._chunks[-1] + (frozen_bar,),)
        self._length += 1
        return evicted

    def replace_latest(self, bar):
        if self._length <= 0 or not self._chunks:
            raise ProtocolFailure("invalid_market", "cannot update an empty market series")
        frozen_bar = freeze(bar)
        last = self._chunks[-1]
        self._chunks = self._chunks[:-1] + (last[:-1] + (frozen_bar,),)

    def extend(self, rows):
        for row in rows:
            self.append(row)

    def snapshot(self):
        return FrozenSnapshotSeries(self._chunks, self._start, self._length)


class PortfolioSnapshot:
    __slots__ = (
        "cash_usdt", "equity_usdt", "used_margin_usdt", "available_margin_usdt", "positions",
        "open_orders", "recent_fills", "trades",
    )

    def __init__(self, portfolio, recent_fills, trades):
        object.__setattr__(self, "cash_usdt", portfolio["cashUsdt"])
        object.__setattr__(self, "equity_usdt", portfolio["equityUsdt"])
        object.__setattr__(self, "used_margin_usdt", portfolio.get("usedMarginUsdt", 0.0))
        object.__setattr__(self, "available_margin_usdt", portfolio["availableMarginUsdt"])
        object.__setattr__(self, "positions", tuple(freeze(item) for item in portfolio["positions"]))
        object.__setattr__(self, "open_orders", tuple(freeze(item) for item in portfolio["openOrders"]))
        object.__setattr__(self, "recent_fills", recent_fills)
        object.__setattr__(self, "trades", trades)


class PortfolioLedgerCache:
    """Rebuilds the strategy-visible ledger without resending it every bar."""

    __slots__ = ("_fills", "_trades", "_fill_ids", "_trade_ids", "_initialized")

    def __init__(self):
        self._fills = MarketSeriesCache([], maximum=MAX_CACHED_LEDGER_ROWS)
        self._trades = MarketSeriesCache([], maximum=MAX_CACHED_LEDGER_ROWS)
        self._fill_ids = set()
        self._trade_ids = set()
        self._initialized = False

    def _replace(self, cache, visible_ids, rows, label):
        visible_rows = rows[-MAX_CACHED_LEDGER_ROWS:]
        next_ids = set()
        for row in visible_rows:
            if row["id"] in next_ids:
                raise ProtocolFailure("invalid_portfolio", f"event.portfolio.{label} contains duplicate IDs")
            next_ids.add(row["id"])
        cache.replace(visible_rows)
        visible_ids.clear()
        visible_ids.update(next_ids)

    def _append(self, cache, visible_ids, rows, label):
        for row in rows:
            row_id = row["id"]
            if row_id in visible_ids:
                raise ProtocolFailure("invalid_portfolio", f"event.portfolio.{label} append repeats a visible ID")
            evicted = cache.append(row)
            if evicted is not None:
                visible_ids.discard(evicted["id"])
            visible_ids.add(row_id)

    def snapshot(self, portfolio):
        if portfolio is None:
            return None
        mode = portfolio.get("ledgerMode", "replace")
        if mode == "replace":
            self._replace(self._fills, self._fill_ids, portfolio["recentFills"], "recentFills")
            self._replace(self._trades, self._trade_ids, portfolio["trades"], "trades")
        else:
            if not self._initialized:
                raise ProtocolFailure("invalid_portfolio", "event.portfolio append must follow an initial replace snapshot")
            if portfolio["recentFills"]:
                self._append(self._fills, self._fill_ids, portfolio["recentFills"], "recentFills")
            if portfolio["trades"]:
                self._append(self._trades, self._trade_ids, portfolio["trades"], "trades")
        self._initialized = True
        return PortfolioSnapshot(portfolio, self._fills.snapshot(), self._trades.snapshot())


class MarketData(ImmutableObject):
    __slots__ = ("_series",)

    def __init__(self, series):
        object.__setattr__(self, "_series", MappingProxyType(dict(series)))

    def bars(self, instrument_id, interval, lookback=None):
        if not isinstance(instrument_id, str) or not isinstance(interval, str):
            raise ValueError("instrument_id and interval must be strings")
        values = self._series.get((instrument_id, interval))
        if values is None:
            raise KeyError(f"market series is unavailable: {instrument_id} {interval}")
        if lookback is None:
            return values
        if not isinstance(lookback, int) or isinstance(lookback, bool) or lookback <= 0:
            raise ValueError("lookback must be a positive integer")
        return values.tail(lookback)


class RollingIndicatorCache:
    """Per-runtime rolling indicator state keyed by visible market series.

    Values are stored by confirmed-bar close time, so a retained older context
    cannot read a value calculated from a later bar. A cache rebuild occurs
    only on first use or an unexpected series discontinuity; the ordinary
    append-one-bar path is O(1) per requested indicator.
    """

    __slots__ = ("_ema", "_atr")

    def __init__(self):
        self._ema = {}
        self._atr = {}

    @staticmethod
    def _key(instrument_id, interval, period):
        if not isinstance(period, int) or isinstance(period, bool) or period <= 0 or period > MAX_CACHED_BARS:
            raise ValueError("indicator period must be a positive integer no greater than the visible bar limit")
        return instrument_id, interval, period

    @staticmethod
    def _remember(state, close_time_ms, value):
        state["values"][close_time_ms] = value
        while len(state["values"]) > MAX_CACHED_BARS:
            del state["values"][next(iter(state["values"]))]

    @staticmethod
    def _ema_rebuild(bars, period):
        state = {"last": None, "ema": None, "seed": [], "values": {}}
        alpha = 2.0 / (period + 1.0)
        for bar in bars:
            close = bar.close
            if len(state["seed"]) < period:
                state["seed"].append(close)
                if len(state["seed"]) == period:
                    state["ema"] = sum(state["seed"]) / period
            else:
                state["ema"] = close * alpha + state["ema"] * (1.0 - alpha)
            state["last"] = bar.closeTimeMs
            RollingIndicatorCache._remember(state, bar.closeTimeMs, state["ema"])
        return state

    @staticmethod
    def _atr_rebuild(bars, period):
        state = {"last": None, "prev_close": None, "atr": None, "seed": [], "values": {}}
        for bar in bars:
            if state["prev_close"] is not None:
                tr = max(bar.high - bar.low, abs(bar.high - state["prev_close"]), abs(bar.low - state["prev_close"]))
                if len(state["seed"]) < period:
                    state["seed"].append(tr)
                    if len(state["seed"]) == period:
                        state["atr"] = sum(state["seed"]) / period
                else:
                    state["atr"] = (state["atr"] * (period - 1) + tr) / period
            state["prev_close"] = bar.close
            state["last"] = bar.closeTimeMs
            RollingIndicatorCache._remember(state, bar.closeTimeMs, state["atr"])
        return state

    @staticmethod
    def _update_ema(state, bar, period):
        if len(state["seed"]) < period:
            state["seed"].append(bar.close)
            if len(state["seed"]) == period:
                state["ema"] = sum(state["seed"]) / period
        else:
            alpha = 2.0 / (period + 1.0)
            state["ema"] = bar.close * alpha + state["ema"] * (1.0 - alpha)
        state["last"] = bar.closeTimeMs
        RollingIndicatorCache._remember(state, bar.closeTimeMs, state["ema"])

    @staticmethod
    def _update_atr(state, bar, period):
        if state["prev_close"] is not None:
            tr = max(bar.high - bar.low, abs(bar.high - state["prev_close"]), abs(bar.low - state["prev_close"]))
            if len(state["seed"]) < period:
                state["seed"].append(tr)
                if len(state["seed"]) == period:
                    state["atr"] = sum(state["seed"]) / period
            else:
                state["atr"] = (state["atr"] * (period - 1) + tr) / period
        state["prev_close"] = bar.close
        state["last"] = bar.closeTimeMs
        RollingIndicatorCache._remember(state, bar.closeTimeMs, state["atr"])

    @staticmethod
    def _target_bar(bars, offset):
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0 or offset >= MAX_CACHED_BARS:
            raise ValueError("indicator offset must be a non-negative integer below the visible bar limit")
        if offset >= len(bars):
            return None
        return bars[-1 - offset]

    def _value(self, cache, rebuild, update, instrument_id, interval, period, bars, offset):
        key = self._key(instrument_id, interval, period)
        target = self._target_bar(bars, offset)
        if target is None:
            return None
        latest = bars[-1]
        state = cache.get(key)
        if state is None:
            state = rebuild(bars, period)
            cache[key] = state
            return state["values"].get(target.closeTimeMs)
        if latest.closeTimeMs in state["values"]:
            return state["values"].get(target.closeTimeMs)
        if state["last"] is not None and latest.closeTimeMs < state["last"]:
            # An older retained context cannot mutate the current rolling
            # state. Rebuild a short-lived snapshot for that exact cutoff.
            return rebuild(bars, period)["values"].get(target.closeTimeMs)
        if state["last"] == latest.closeTimeMs:
            return state["values"].get(target.closeTimeMs)
        if len(bars) >= 2 and state["last"] == bars[-2].closeTimeMs:
            update(state, latest, period)
            return state["values"].get(target.closeTimeMs)
        state = rebuild(bars, period)
        cache[key] = state
        return state["values"].get(target.closeTimeMs)

    def ema(self, instrument_id, interval, period, bars, offset=0):
        return self._value(self._ema, self._ema_rebuild, self._update_ema, instrument_id, interval, period, bars, offset)

    def atr(self, instrument_id, interval, period, bars, offset=0):
        return self._value(self._atr, self._atr_rebuild, self._update_atr, instrument_id, interval, period, bars, offset)


class Indicators(ImmutableObject):
    __slots__ = ("_market", "_cache")

    def __init__(self, market, cache):
        object.__setattr__(self, "_market", market)
        object.__setattr__(self, "_cache", cache)

    def _one_minute_bars(self, instrument_id, interval):
        if interval != "1m":
            raise ValueError("rolling indicators currently support confirmed 1m bars only")
        return self._market.bars(instrument_id, interval)

    def ema(self, instrument_id, interval, period, offset=0):
        bars = self._one_minute_bars(instrument_id, interval)
        return self._cache.ema(instrument_id, interval, period, bars, offset)

    def atr(self, instrument_id, interval, period, offset=0):
        bars = self._one_minute_bars(instrument_id, interval)
        return self._cache.atr(instrument_id, interval, period, bars, offset)


class SimulatedPortfolio(ImmutableObject):
    __slots__ = ("cash_usdt", "equity_usdt", "used_margin_usdt", "available_margin_usdt", "positions", "open_orders", "recent_fills", "trades", "_positions")

    def __init__(self, portfolio):
        if isinstance(portfolio, PortfolioSnapshot):
            positions = portfolio.positions
            index = {(item["instrumentId"], item["side"]): item for item in positions}
            object.__setattr__(self, "cash_usdt", portfolio.cash_usdt)
            object.__setattr__(self, "equity_usdt", portfolio.equity_usdt)
            object.__setattr__(self, "used_margin_usdt", portfolio.used_margin_usdt)
            object.__setattr__(self, "available_margin_usdt", portfolio.available_margin_usdt)
            object.__setattr__(self, "positions", positions)
            object.__setattr__(self, "open_orders", portfolio.open_orders)
            object.__setattr__(self, "recent_fills", portfolio.recent_fills)
            object.__setattr__(self, "trades", portfolio.trades)
            object.__setattr__(self, "_positions", MappingProxyType(index))
            return
        value = portfolio or {
            "cashUsdt": 0.0,
            "equityUsdt": 0.0,
            "usedMarginUsdt": 0.0,
            "availableMarginUsdt": 0.0,
            "positions": [],
            "openOrders": [],
            "recentFills": [],
            "trades": [],
        }
        positions = tuple(freeze(item) for item in value["positions"])
        index = {(item["instrumentId"], item["side"]): item for item in positions}
        object.__setattr__(self, "cash_usdt", value["cashUsdt"])
        object.__setattr__(self, "equity_usdt", value["equityUsdt"])
        object.__setattr__(self, "used_margin_usdt", value.get("usedMarginUsdt", 0.0))
        object.__setattr__(self, "available_margin_usdt", value["availableMarginUsdt"])
        object.__setattr__(self, "positions", positions)
        object.__setattr__(self, "open_orders", tuple(freeze(item) for item in value["openOrders"]))
        object.__setattr__(self, "recent_fills", tuple(freeze(item) for item in value["recentFills"]))
        object.__setattr__(self, "trades", tuple(freeze(item) for item in value["trades"]))
        object.__setattr__(self, "_positions", MappingProxyType(index))

    def position(self, instrument_id, side):
        if not isinstance(instrument_id, str) or side not in POSITION_SIDES:
            raise ValueError("position requires an instrument_id and long or short side")
        return self._positions.get((instrument_id, side))

    def positions_for(self, instrument_id):
        if not isinstance(instrument_id, str):
            raise ValueError("instrument_id must be a string")
        return tuple(position for position in self.positions if position.instrumentId == instrument_id)


class StrategyContext(ImmutableObject):
    __slots__ = (
        "as_of_ms", "kind", "snapshot_id", "market", "indicators", "portfolio", "params", "instrument_id", "interval", "bar", "universe"
    )

    def __init__(self, event, market, portfolio=None, params=None, indicator_cache=None):
        object.__setattr__(self, "as_of_ms", event["asOfMs"])
        object.__setattr__(self, "kind", event["kind"])
        object.__setattr__(self, "snapshot_id", event["snapshotId"])
        market_view = MarketData(market)
        object.__setattr__(self, "market", market_view)
        object.__setattr__(self, "indicators", Indicators(market_view, indicator_cache or RollingIndicatorCache()))
        object.__setattr__(self, "portfolio", SimulatedPortfolio(portfolio if portfolio is not None else event.get("portfolio")))
        object.__setattr__(self, "params", FrozenMap(params or {}))
        object.__setattr__(self, "instrument_id", event.get("instrumentId"))
        object.__setattr__(self, "interval", event.get("interval"))
        object.__setattr__(self, "bar", freeze(event["bar"]) if event.get("bar") is not None else None)
        object.__setattr__(self, "universe", tuple(freeze(row) for row in event.get("universe", [])))

    def position(self, instrument_id, side):
        return self.portfolio.position(instrument_id, side)

    def no_action(self, reason=None):
        output = {"kind": "no_action", "asOfMs": self.as_of_ms}
        if reason is not None:
            output["reason"] = str(reason)
        return output

    def market_order(self):
        return {"orderType": "market"}

    def limit_order(self, limit_price):
        return {"orderType": "limit", "limitPrice": float(limit_price)}

    def _action(self, action, reason, quantity=None, protection=None, execution=None, order_id=None, metadata=None):
        if self.kind not in {"start", "bar"}:
            raise ValueError("strategy actions are valid only in on_start or on_bar")
        output = {
            "kind": "action",
            "asOfMs": self.as_of_ms,
            "instrumentId": self.instrument_id,
            "action": action,
            "reason": str(reason),
        }
        if quantity is not None:
            output["quantity"] = float(quantity)
        if protection is not None:
            output["protection"] = protection
        if execution is not None:
            output["execution"] = execution
        if order_id is not None:
            output["orderId"] = str(order_id)
        if metadata is not None:
            output["metadata"] = metadata
        return output

    def open_long(self, reason, protection=None, execution=None, metadata=None):
        return self._action("open_long", reason, protection=protection, execution=execution, metadata=metadata)

    def open_short(self, reason, protection=None, execution=None, metadata=None):
        return self._action("open_short", reason, protection=protection, execution=execution, metadata=metadata)

    def close_long(self, reason, execution=None, metadata=None):
        return self._action("close_long", reason, execution=execution, metadata=metadata)

    def close_short(self, reason, execution=None, metadata=None):
        return self._action("close_short", reason, execution=execution, metadata=metadata)

    def set_protection(self, reason, stop_loss_price=UNSET, take_profit_price=UNSET, metadata=None):
        if stop_loss_price is UNSET and take_profit_price is UNSET:
            raise ValueError("set_protection must update or clear stop_loss_price and/or take_profit_price")
        protection = {}
        if stop_loss_price is not UNSET:
            protection["stopLossPrice"] = stop_loss_price
        if take_profit_price is not UNSET:
            protection["takeProfitPrice"] = take_profit_price
        return self._action("set_protection", reason, protection=protection, metadata=metadata)

    def cancel_protection(self, reason, metadata=None):
        return self._action("cancel_protection", reason, metadata=metadata)

    def cancel_order(self, order_id, reason, metadata=None):
        return self._action("cancel_order", reason, order_id=order_id, metadata=metadata)

    # Legacy research-only helpers remain available for the trusted desktop
    # compatibility fixture. New strategy packages must use the action helpers.
    def signal(self, direction, reason, confidence=None, metadata=None):
        if self.kind != "bar":
            raise ValueError("signal is only valid in on_bar")
        output = {
            "kind": "signal",
            "asOfMs": self.as_of_ms,
            "instrumentId": self.instrument_id,
            "direction": str(direction),
            "reason": str(reason),
        }
        if confidence is not None:
            output["confidence"] = float(confidence)
        if metadata is not None:
            output["metadata"] = metadata
        return output

    def paper_intent(self, action, reason, quantity=None, metadata=None):
        if self.kind != "bar":
            raise ValueError("paper_intent is only valid in on_bar")
        output = {
            "kind": "paper_intent",
            "asOfMs": self.as_of_ms,
            "instrumentId": self.instrument_id,
            "action": str(action),
            "reason": str(reason),
        }
        if quantity is not None:
            output["quantity"] = float(quantity)
        if metadata is not None:
            output["metadata"] = metadata
        return output

    def factor(self, factor_id, values, metadata=None):
        if self.kind != "rebalance":
            raise ValueError("factor is only valid in on_rebalance")
        output = {"kind": "factor", "asOfMs": self.as_of_ms, "factorId": str(factor_id), "values": values}
        if metadata is not None:
            output["metadata"] = metadata
        return output

    def alpha(self, model_id, horizon_ms, scores, metadata=None):
        if self.kind != "rebalance":
            raise ValueError("alpha is only valid in on_rebalance")
        output = {
            "kind": "alpha", "asOfMs": self.as_of_ms, "modelId": str(model_id),
            "horizonMs": int(horizon_ms), "scores": scores,
        }
        if metadata is not None:
            output["metadata"] = metadata
        return output

    def portfolio_target(self, weights, metadata=None):
        if self.kind != "rebalance":
            raise ValueError("portfolio_target is only valid in on_rebalance")
        output = {"kind": "portfolio_target", "asOfMs": self.as_of_ms, "weights": weights}
        if metadata is not None:
            output["metadata"] = metadata
        return output


def ensure_json_value(value, label="value", depth=0):
    if depth > 12:
        raise ProtocolFailure("invalid_shape", f"{label} exceeds the maximum JSON nesting depth")
    if value is None or isinstance(value, (bool, str)):
        return
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        finite_number(value, label)
        return
    if isinstance(value, list):
        if len(value) > 2_000:
            raise ProtocolFailure("invalid_shape", f"{label} exceeds the maximum array length")
        for index, child in enumerate(value):
            ensure_json_value(child, f"{label}[{index}]", depth + 1)
        return
    if isinstance(value, dict):
        if len(value) > 200:
            raise ProtocolFailure("invalid_shape", f"{label} exceeds the maximum object size")
        for key, child in value.items():
            nonempty_string(key, f"{label} key", 128)
            ensure_json_value(child, f"{label}.{key}", depth + 1)
        return
    raise ProtocolFailure("invalid_shape", f"{label} must be JSON-serializable")


def validate_no_action(output):
    reject_unknown_fields(output, {"kind", "asOfMs", "reason"}, "output")
    if "reason" in output:
        nonempty_string(output["reason"], "output.reason", 1_000)


def validate_protection(protection):
    value = plain_dict(protection, "output.protection")
    reject_unknown_fields(value, {"stopLossPrice", "takeProfitPrice"}, "output.protection")
    if "stopLossPrice" not in value and "takeProfitPrice" not in value:
        raise ProtocolFailure("invalid_output", "output.protection must request a stop-loss and/or take-profit price")
    for field in ("stopLossPrice", "takeProfitPrice"):
        if field in value:
            positive_number(value[field], f"output.protection.{field}")


def validate_protection_update(protection):
    value = plain_dict(protection, "output.protection")
    reject_unknown_fields(value, {"stopLossPrice", "takeProfitPrice"}, "output.protection")
    if "stopLossPrice" not in value and "takeProfitPrice" not in value:
        raise ProtocolFailure("invalid_output", "output.protection must update or clear a stop-loss and/or take-profit price")
    for field in ("stopLossPrice", "takeProfitPrice"):
        if field in value and value[field] is not None:
            positive_number(value[field], f"output.protection.{field}")


def validate_execution(execution):
    value = plain_dict(execution, "output.execution")
    reject_unknown_fields(value, {"orderType", "limitPrice"}, "output.execution")
    order_type = value.get("orderType", "market")
    if order_type not in ORDER_TYPES:
        raise ProtocolFailure("invalid_output", "output.execution.orderType must be market or limit")
    if order_type == "market":
        if "limitPrice" in value:
            raise ProtocolFailure("invalid_output", "market execution must not include limitPrice")
        return
    positive_number(value.get("limitPrice"), "output.execution.limitPrice")


def validate_strategy_action(output, event):
    reject_unknown_fields(output, {"kind", "asOfMs", "instrumentId", "action", "quantity", "reason", "protection", "execution", "orderId", "metadata"}, "output")
    nonempty_string(output.get("instrumentId"), "output.instrumentId", 64, INSTRUMENT_ID_PATTERN)
    if output["instrumentId"] != event["instrumentId"]:
        raise ProtocolFailure("out_of_scope_output", "strategy action output.instrumentId must match event.instrumentId")
    if output.get("action") not in STRATEGY_ACTIONS:
        raise ProtocolFailure("invalid_output", "output.action is not supported")
    nonempty_string(output.get("reason"), "output.reason", 1_000)
    if output["action"] in {"open_long", "open_short", "close_long", "close_short"}:
        if "quantity" in output:
            raise ProtocolFailure("invalid_output", "strategy actions must not include quantity; Desic calculates contracts from the configured position budget")
        validate_execution(output.get("execution", {"orderType": "market"}))
    else:
        if "quantity" in output:
            raise ProtocolFailure("invalid_output", f"output.{output['action']} must not include quantity")
        if "execution" in output:
            raise ProtocolFailure("invalid_output", f"output.{output['action']} must not include execution")
    if output["action"].startswith("close_") and "portfolio" in event:
        side = "long" if output["action"] == "close_long" else "short"
        position = next(
            (item for item in event["portfolio"]["positions"] if item["instrumentId"] == output["instrumentId"] and item["side"] == side),
            None,
        )
        if position is None:
            raise ProtocolFailure("invalid_output", f"output.{output['action']} requires a simulated {side} position")
    if output["action"] != "cancel_order" and "orderId" in output:
        raise ProtocolFailure("invalid_output", f"output.{output['action']} must not include orderId")
    if output["action"] == "set_protection":
        if "protection" not in output:
            raise ProtocolFailure("invalid_output", "output.set_protection requires protection")
        validate_protection_update(output["protection"])
        if not event.get("portfolio", {}).get("positions"):
            raise ProtocolFailure("invalid_output", "output.set_protection requires a simulated position")
    elif output["action"] == "cancel_protection":
        if "protection" in output:
            raise ProtocolFailure("invalid_output", "output.cancel_protection must not include protection")
        if not event.get("portfolio", {}).get("positions"):
            raise ProtocolFailure("invalid_output", "output.cancel_protection requires a simulated position")
    elif output["action"] == "cancel_order":
        if "protection" in output:
            raise ProtocolFailure("invalid_output", "output.cancel_order must not include protection")
        order_id = nonempty_string(output.get("orderId"), "output.orderId", 128, REQUEST_ID_PATTERN)
        open_order_ids = {row["id"] for row in event.get("portfolio", {}).get("openOrders", [])}
        if order_id not in open_order_ids:
            raise ProtocolFailure("invalid_output", "output.cancel_order must reference a current open order")
    elif "protection" in output:
        if not output["action"].startswith("open_"):
            raise ProtocolFailure("invalid_output", "output.protection is only valid for open_long or open_short actions")
        validate_protection(output["protection"])
    if "metadata" in output:
        ensure_json_value(output["metadata"], "output.metadata")


def validate_signal(output, event):
    reject_unknown_fields(output, {"kind", "asOfMs", "instrumentId", "direction", "reason", "confidence", "metadata"}, "output")
    nonempty_string(output.get("instrumentId"), "output.instrumentId", 64, INSTRUMENT_ID_PATTERN)
    if output["instrumentId"] != event["instrumentId"]:
        raise ProtocolFailure("out_of_scope_output", "bar signal output.instrumentId must match event.instrumentId")
    if output.get("direction") not in {"long", "short", "exit"}:
        raise ProtocolFailure("invalid_output", "signal.direction must be long, short, or exit")
    nonempty_string(output.get("reason"), "output.reason", 1_000)
    if "confidence" in output:
        confidence = finite_number(output["confidence"], "output.confidence")
        if confidence < 0 or confidence > 1:
            raise ProtocolFailure("invalid_output", "signal.confidence must be between 0 and 1")
    if "metadata" in output:
        ensure_json_value(output["metadata"], "output.metadata")


def validate_paper_intent(output, event):
    reject_unknown_fields(output, {"kind", "asOfMs", "instrumentId", "action", "reason", "quantity", "metadata"}, "output")
    nonempty_string(output.get("instrumentId"), "output.instrumentId", 64, INSTRUMENT_ID_PATTERN)
    if output["instrumentId"] != event["instrumentId"]:
        raise ProtocolFailure("out_of_scope_output", "bar paper_intent output.instrumentId must match event.instrumentId")
    if output.get("action") not in STRATEGY_ACTIONS:
        raise ProtocolFailure("invalid_output", "paper_intent.action is invalid")
    nonempty_string(output.get("reason"), "output.reason", 1_000)
    if "quantity" in output:
        positive_number(output["quantity"], "output.quantity")
    if "metadata" in output:
        ensure_json_value(output["metadata"], "output.metadata")


def validate_ranked_values(rows, allowed_ids, field):
    if not isinstance(rows, list) or not rows or len(rows) > len(allowed_ids):
        raise ProtocolFailure("invalid_output", f"output.{field} must contain 1 to {len(allowed_ids)} rows")
    ids = set()
    for index, row in enumerate(rows):
        row = plain_dict(row, f"output.{field}[{index}]")
        reject_unknown_fields(row, {"instrumentId", "value", "diagnostics"}, f"output.{field}[{index}]")
        nonempty_string(row.get("instrumentId"), f"output.{field}[{index}].instrumentId", 64, INSTRUMENT_ID_PATTERN)
        if row["instrumentId"] not in allowed_ids:
            raise ProtocolFailure("out_of_scope_output", f"output.{field}[{index}].instrumentId is not an eligible universe instrument")
        if row["instrumentId"] in ids:
            raise ProtocolFailure("invalid_output", f"output.{field} contains duplicate instrumentId values")
        ids.add(row["instrumentId"])
        finite_number(row.get("value"), f"output.{field}[{index}].value")
        if "diagnostics" in row:
            ensure_json_value(row["diagnostics"], f"output.{field}[{index}].diagnostics")


def validate_output(output, event):
    value = plain_dict(output, "output")
    if value.get("asOfMs") != event["asOfMs"] or not isinstance(value.get("asOfMs"), int) or isinstance(value.get("asOfMs"), bool):
        raise ProtocolFailure("cutoff_mismatch", "output.asOfMs must exactly match event.asOfMs")
    ensure_no_future_timestamps(value, event["asOfMs"], "output")
    if event["kind"] in {"start", "bar"}:
        if value.get("kind") == "no_action":
            validate_no_action(value)
        elif value.get("kind") == "action":
            validate_strategy_action(value, event)
        elif value.get("kind") == "signal" and event["kind"] == "bar":
            validate_signal(value, event)
        elif value.get("kind") == "paper_intent" and event["kind"] == "bar":
            validate_paper_intent(value, event)
        else:
            raise ProtocolFailure("invalid_output_kind", "strategy handlers may return no_action or action")
        return value
    allowed_ids = {row["instrumentId"] for row in event["universe"] if row.get("eligible") is not False}
    if not allowed_ids:
        raise ProtocolFailure("invalid_universe", "rebalance event has no eligible instruments")
    if value.get("kind") == "factor":
        reject_unknown_fields(value, {"kind", "asOfMs", "factorId", "values", "metadata"}, "output")
        nonempty_string(value.get("factorId"), "output.factorId", 128, REQUEST_ID_PATTERN)
        validate_ranked_values(value.get("values"), allowed_ids, "values")
    elif value.get("kind") == "alpha":
        reject_unknown_fields(value, {"kind", "asOfMs", "modelId", "horizonMs", "scores", "metadata"}, "output")
        nonempty_string(value.get("modelId"), "output.modelId", 128, REQUEST_ID_PATTERN)
        positive_int(value.get("horizonMs"), "output.horizonMs")
        validate_ranked_values(value.get("scores"), allowed_ids, "scores")
    elif value.get("kind") == "portfolio_target":
        reject_unknown_fields(value, {"kind", "asOfMs", "weights", "metadata"}, "output")
        rows = value.get("weights")
        if not isinstance(rows, list) or not rows or len(rows) > len(allowed_ids):
            raise ProtocolFailure("invalid_output", f"output.weights must contain 1 to {len(allowed_ids)} rows")
        ids = set()
        for index, row in enumerate(rows):
            row = plain_dict(row, f"output.weights[{index}]")
            reject_unknown_fields(row, {"instrumentId", "targetWeight"}, f"output.weights[{index}]")
            nonempty_string(row.get("instrumentId"), f"output.weights[{index}].instrumentId", 64, INSTRUMENT_ID_PATTERN)
            if row["instrumentId"] not in allowed_ids or row["instrumentId"] in ids:
                raise ProtocolFailure("out_of_scope_output", "output.weights must use unique eligible universe instrument IDs")
            ids.add(row["instrumentId"])
            target_weight = finite_number(row.get("targetWeight"), f"output.weights[{index}].targetWeight")
            if abs(target_weight) > 1:
                raise ProtocolFailure("invalid_output", "individual targetWeight must be between -1 and 1")
    else:
        raise ProtocolFailure("invalid_output_kind", "on_rebalance may return factor, alpha, or portfolio_target")
    if "metadata" in value:
        ensure_json_value(value["metadata"], "output.metadata")
    return value


def restricted_import(name, globals_=None, locals_=None, fromlist=(), level=0):
    current_module = (globals_ or {}).get("__name__")
    if current_module == "__desic_strategy__":
        root = name.split(".", 1)[0]
        if level != 0 or root in FORBIDDEN_IMPORTS or root not in ALLOWED_IMPORTS:
            raise ImportError(f"strategy import is not permitted: {name}")
    return builtins.__import__(name, globals_, locals_, fromlist, level)


SAFE_BUILTINS = {
    "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict, "enumerate": enumerate,
    "AttributeError": AttributeError, "Exception": Exception, "filter": filter, "float": float, "int": int, "isinstance": isinstance,
    "KeyError": KeyError, "len": len, "list": list, "map": map, "max": max, "min": min, "pow": pow,
    "range": range, "reversed": reversed, "round": round, "RuntimeError": RuntimeError, "set": set,
    "sorted": sorted, "str": str, "sum": sum, "tuple": tuple, "TypeError": TypeError, "ValueError": ValueError,
    "zip": zip, "__import__": restricted_import,
}


class SourcePolicyVisitor(ast.NodeVisitor):
    def __init__(self):
        self.action_sites = []
        self.market_intervals = set()
        self.dynamic_market_interval = False

    def _forbidden(self, code, message, node=None):
        if node is not None and node.lineno > 0:
            message = f"line {node.lineno}: {message}"
        raise ProtocolFailure(code, message)

    def _validate_import(self, module, level, node):
        root = module.split(".", 1)[0] if module else ""
        if level != 0 or root in FORBIDDEN_IMPORTS or root not in ALLOWED_IMPORTS:
            self._forbidden("forbidden_import", f"strategy import is not permitted: {module or '.'}", node)

    def visit_Import(self, node):
        for alias in node.names:
            self._validate_import(alias.name, 0, node)

    def visit_ImportFrom(self, node):
        self._validate_import(node.module or "", node.level, node)

    def visit_Name(self, node):
        if node.id in FORBIDDEN_NAMES or node.id.startswith("__"):
            if node.id == "getattr":
                self._forbidden(
                    "forbidden_api",
                    "getattr is not permitted; use documented fixed fields directly, for example position.averageEntryPrice",
                    node,
                )
            self._forbidden(
                "forbidden_api",
                f"{node.id} is not permitted in strategy source; use only the documented fixed strategy API",
                node,
            )

    def visit_Attribute(self, node):
        if node.attr.startswith("_"):
            self._forbidden("forbidden_syntax", "strategy source must not access private attributes", node)
        if node.attr == "contracts":
            self._forbidden(
                "invalid_strategy_api",
                "Position has no contracts field; use position.quantity. The host owns contract sizing.",
                node,
            )
        self.generic_visit(node)

    def _record_market_interval(self, node):
        interval = node.args[1] if len(node.args) >= 2 else next(
            (keyword.value for keyword in node.keywords if keyword.arg == "interval"),
            None,
        )
        if isinstance(interval, ast.Constant) and isinstance(interval.value, str) and interval.value in MARKET_INTERVALS:
            self.market_intervals.add(interval.value)
        else:
            # A dynamic expression may resolve to any protocol-supported
            # interval at runtime, so the host must retain the full series set.
            self.dynamic_market_interval = True

    def selected_market_intervals(self):
        if self.dynamic_market_interval:
            return list(MARKET_INTERVALS)
        # The active bar contract always requires 1m, even for a strategy that
        # only reads a higher timeframe or does not call market.bars at all.
        return [interval for interval in MARKET_INTERVALS if interval == "1m" or interval in self.market_intervals]

    def visit_Call(self, node):
        function = node.func
        if isinstance(function, ast.Attribute) and function.attr == "bars":
            if (
                isinstance(function.value, ast.Attribute)
                and function.value.attr == "market"
                and isinstance(function.value.value, ast.Name)
                and function.value.value.id == "ctx"
            ):
                self._record_market_interval(node)
            else:
                # A market view can be assigned to a local or passed through a
                # helper. Its interval cannot be safely proven here, so retain
                # every host-supported series rather than risk an unavailable
                # live or backtest lookup.
                self.dynamic_market_interval = True
        if isinstance(function, ast.Attribute) and isinstance(function.value, ast.Name) and function.value.id == "ctx":
            if function.attr in {
                "open_long", "open_short", "close_long", "close_short",
                "set_protection", "cancel_protection", "cancel_order",
            }:
                action_site = {
                    "method": function.attr,
                    "line": node.lineno,
                    "column": node.col_offset + 1,
                }
                if function.attr in {"open_long", "open_short"}:
                    # Keep the source audit useful to the host without trying
                    # to evaluate strategy branches or user-defined helpers.
                    action_site["protectionKeys"] = []
                    action_site["protectionDynamic"] = False
                    protection_keyword = next(
                        (keyword for keyword in node.keywords if keyword.arg == "protection"),
                        None,
                    )
                    if protection_keyword is not None:
                        protection = protection_keyword.value
                        protection_keys = None
                        if isinstance(protection, ast.Constant) and protection.value is None:
                            protection_keys = []
                        elif isinstance(protection, ast.Dict):
                            protection_keys = []
                            for key in protection.keys:
                                if not isinstance(key, ast.Constant) or not isinstance(key.value, str):
                                    self._forbidden(
                                        "invalid_strategy_api",
                                        "opening protection keys must be the quoted strings stopLossPrice or takeProfitPrice",
                                        key or protection,
                                    )
                                protection_keys.append(key.value)
                        elif (
                            isinstance(protection, ast.Call)
                            and isinstance(protection.func, ast.Name)
                            and protection.func.id == "dict"
                        ):
                            protection_keys = [keyword.arg for keyword in protection.keywords]
                        if protection_keys is None:
                            action_site["protectionDynamic"] = True
                        else:
                            action_site["protectionKeys"] = protection_keys
                        if protection_keys is not None:
                            allowed_protection_keys = {"stopLossPrice", "takeProfitPrice"}
                            invalid_key = next(
                                (key for key in protection_keys if key not in allowed_protection_keys),
                                None,
                            )
                            if invalid_key is not None:
                                self._forbidden(
                                    "invalid_strategy_api",
                                    f"output.protection.{invalid_key} is not part of the protocol; use stopLossPrice and/or takeProfitPrice",
                                    protection_keyword,
                                )
                self.action_sites.append(action_site)
            specification = STRATEGY_CONTEXT_CALLS.get(function.attr)
            if specification is None:
                self._forbidden(
                    "invalid_strategy_api",
                    f"ctx.{function.attr} is not part of the documented strategy API",
                    node,
                )
            max_positional, allowed_keywords = specification
            if any(isinstance(argument, ast.Starred) for argument in node.args):
                self._forbidden(
                    "invalid_strategy_api",
                    f"ctx.{function.attr} must not use expanded positional arguments",
                    node,
                )
            if len(node.args) > max_positional:
                self._forbidden(
                    "invalid_strategy_api",
                    f"ctx.{function.attr} accepts at most {max_positional} positional arguments; pass optional arguments by name",
                    node,
                )
            if function.attr in {"open_long", "open_short"}:
                protection_keyword = next(
                    (keyword for keyword in node.keywords if keyword.arg == "protection"),
                    None,
                )
                if protection_keyword is not None:
                    protection = protection_keyword.value
                    protection_keys = None
                    if isinstance(protection, ast.Dict):
                        protection_keys = []
                        for key in protection.keys:
                            if not isinstance(key, ast.Constant) or not isinstance(key.value, str):
                                self._forbidden(
                                    "invalid_strategy_api",
                                    "opening protection keys must be the quoted strings stopLossPrice or takeProfitPrice",
                                    key or protection,
                                )
                            protection_keys.append(key.value)
                    elif (
                        isinstance(protection, ast.Call)
                        and isinstance(protection.func, ast.Name)
                        and protection.func.id == "dict"
                    ):
                        protection_keys = [keyword.arg for keyword in protection.keywords]
                    if protection_keys is not None:
                        allowed_protection_keys = {"stopLossPrice", "takeProfitPrice"}
                        invalid_key = next(
                            (key for key in protection_keys if key not in allowed_protection_keys),
                            None,
                        )
                        if invalid_key is not None:
                            self._forbidden(
                                "invalid_strategy_api",
                                f"output.protection.{invalid_key} is not part of the protocol; use stopLossPrice and/or takeProfitPrice",
                                protection_keyword,
                            )
            positional_parameters = set(
                STRATEGY_CONTEXT_POSITIONAL_PARAMETERS[function.attr][:len(node.args)]
            )
            for keyword in node.keywords:
                if keyword.arg is None:
                    self._forbidden(
                        "invalid_strategy_api",
                        f"ctx.{function.attr} must not use expanded keyword arguments",
                        node,
                    )
                if keyword.arg not in allowed_keywords:
                    self._forbidden(
                        "invalid_strategy_api",
                        f"ctx.{function.attr} does not accept keyword '{keyword.arg}'",
                        node,
                    )
                if keyword.arg in positional_parameters:
                    if keyword.arg == "reason" and function.attr in {
                        "open_long", "open_short", "close_long", "close_short"
                    }:
                        self._forbidden(
                            "invalid_strategy_api",
                            f"ctx.{function.attr} receives reason as its first positional argument; do not also pass reason=... . Desic chooses contract size from the configured position budget. For a limit order use ctx.{function.attr}(reason, execution=ctx.limit_order(price))",
                            node,
                        )
                    self._forbidden(
                        "invalid_strategy_api",
                        f"ctx.{function.attr} receives '{keyword.arg}' both positionally and by keyword",
                        node,
                    )
        self.generic_visit(node)

    def visit_ClassDef(self, node):
        self._forbidden("forbidden_syntax", "strategy source must not define classes", node)

    def visit_FunctionDef(self, node):
        expected = HANDLER_ARGUMENTS.get(node.name)
        if expected is not None:
            arguments = tuple(argument.arg for argument in node.args.args)
            if arguments != expected or node.args.vararg is not None or node.args.kwarg is not None or node.args.kwonlyargs or node.args.defaults or node.args.kw_defaults:
                self._forbidden("invalid_handler", f"{node.name} must accept exactly ({', '.join(expected)})", node)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node):
        self._forbidden("forbidden_syntax", "strategy handlers must be synchronous", node)

    def visit_Await(self, node):
        self._forbidden("forbidden_syntax", "strategy source must not use await", node)

    def visit_Yield(self, node):
        self._forbidden("forbidden_syntax", "strategy source must not use yield", node)

    def visit_YieldFrom(self, node):
        self._forbidden("forbidden_syntax", "strategy source must not use yield", node)


def source_is_safe(source):
    # The Node host is the primary static gate. Runtime validation is a second line of defense
    # for callers that accidentally launch this private bootstrap directly.
    if not isinstance(source, str) or len(source.encode("utf-8")) > MAX_SOURCE_BYTES or "\x00" in source:
        raise ProtocolFailure("invalid_source", "strategy source is invalid or too large")
    try:
        tree = ast.parse(source, filename="<desic-strategy>", mode="exec")
    except SyntaxError as error:
        raise ProtocolFailure("invalid_source", f"strategy source has invalid syntax at line {error.lineno or 0}") from error
    visitor = SourcePolicyVisitor()
    visitor.visit(tree)
    return source, visitor.action_sites, visitor.selected_market_intervals()


def load_strategy(source):
    source, action_sites, market_intervals = source_is_safe(source)
    namespace = {"__name__": "__desic_strategy__", "__builtins__": SAFE_BUILTINS}
    try:
        compiled = builtins.compile(source, "<desic-strategy>", "exec")
        builtins.exec(compiled, namespace, namespace)
    except ProtocolFailure:
        raise
    except Exception as error:
        raise ProtocolFailure("source_load_failed", f"strategy source could not load: {type(error).__name__}: {str(error)[:500]}") from error
    handlers = sorted(name for name in ("on_start", "on_bar", "on_fill", "on_rebalance") if callable(namespace.get(name)))
    if not handlers:
        raise ProtocolFailure("missing_handler", "strategy source must define on_start(ctx), on_bar(ctx), and/or on_rebalance(ctx)")
    return namespace, handlers, action_sites, market_intervals


def emit(message):
    message["protocol"] = PROTOCOL
    sys.stdout.write(json.dumps(message, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def error_message(request_id, error):
    if isinstance(error, ProtocolFailure):
        return {"type": "error", "requestId": request_id, "code": error.code, "message": str(error)[:1_000]}
    return {"type": "error", "requestId": request_id, "code": "runtime_error", "message": f"strategy execution failed: {type(error).__name__}: {str(error)[:500]}"}


def merge_market_snapshot(cache, market):
    """Merge host data and return immutable point-in-time series views.

    The first event carries the visible history. Later events carry only the
    newest closed bar. Keeping bars frozen in chunks avoids rebuilding and
    freezing the entire visible window for every minute of a long backtest.
    """
    for series in market["series"]:
        key = (series["instrumentId"], series["interval"])
        incoming = series["bars"]
        existing = cache.get(key)
        if existing is None or len(incoming) > 1:
            cache[key] = MarketSeriesCache(incoming)
            continue
        current = incoming[0]
        previous_close = existing.latest_close_time_ms()
        if previous_close is None:
            existing.append(current)
            continue
        current_close = current["closeTimeMs"]
        if current_close > previous_close:
            existing.append(current)
        elif current_close == previous_close:
            existing.replace_latest(current)
        elif current_close != previous_close:
            raise ProtocolFailure("out_of_order_event", "incremental market data moved backward in time")
    return MappingProxyType({key: series.snapshot() for key, series in cache.items()})


def main():
    namespace = None
    handlers = []
    strategy_started = False
    last_event_as_of_ms = None
    market_cache = {}
    portfolio_cache = PortfolioLedgerCache()
    indicator_cache = RollingIndicatorCache()
    strategy_params = {}
    emit({"type": "ready", "apiVersion": 2})
    for raw_line in sys.stdin:
        if len(raw_line.encode("utf-8")) > MAX_LINE_BYTES:
            emit({"type": "error", "requestId": None, "code": "message_too_large", "message": "JSONL request exceeds runtime limit"})
            continue
        try:
            message = None
            message = json.loads(raw_line)
            if message.get("protocol") != PROTOCOL:
                raise ProtocolFailure("protocol_mismatch", "unsupported strategy protocol")
            request_id = message.get("requestId")
            if not isinstance(request_id, str) or not request_id:
                raise ProtocolFailure("invalid_request", "requestId is required")
            message_type = message.get("type")
            if message_type == "load":
                reject_unknown_fields(message, {"protocol", "type", "requestId", "source", "params"}, "load")
                strategy_params = plain_dict(message.get("params", {}), "load.params")
                ensure_json_value(strategy_params, "load.params")
                namespace, handlers, action_sites, market_intervals = load_strategy(message.get("source"))
                strategy_started = False
                last_event_as_of_ms = None
                market_cache = {}
                portfolio_cache = PortfolioLedgerCache()
                indicator_cache = RollingIndicatorCache()
                emit({
                    "type": "loaded",
                    "requestId": request_id,
                    "handlers": handlers,
                    "actionSites": action_sites,
                    "marketIntervals": market_intervals,
                })
            elif message_type == "invoke":
                if namespace is None:
                    raise ProtocolFailure("strategy_not_loaded", "load strategy source before invoking it")
                event = validate_event(message.get("event"))
                if last_event_as_of_ms is not None and event["asOfMs"] < last_event_as_of_ms:
                    raise ProtocolFailure("out_of_order_event", "strategy events must not move backward in time")
                handler_name = {
                    "start": "on_start",
                    "bar": "on_bar",
                    "rebalance": "on_rebalance",
                }[event["kind"]]
                if event["kind"] == "start" and strategy_started:
                    raise ProtocolFailure("invalid_lifecycle", "on_start may be invoked only once after each strategy load")
                if event["kind"] != "start" and "on_start" in handlers and not strategy_started:
                    raise ProtocolFailure("invalid_lifecycle", "invoke on_start before dispatching bar or rebalance events")
                handler = namespace.get(handler_name)
                if not callable(handler):
                    if event["kind"] != "start":
                        raise ProtocolFailure("missing_handler", f"strategy does not implement {handler_name}(ctx)")
                    if event["kind"] == "start":
                        strategy_started = True
                    last_event_as_of_ms = event["asOfMs"]
                    emit({"type": "result", "requestId": request_id, "output": {"kind": "no_action", "asOfMs": event["asOfMs"], "reason": f"{handler_name} is not defined"}})
                    continue
                market = merge_market_snapshot(market_cache, event["market"])
                portfolio = portfolio_cache.snapshot(event.get("portfolio"))
                context = StrategyContext(event, market, portfolio, strategy_params, indicator_cache)
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    output = handler(context)
                output = validate_output(output, event)
                if event["kind"] == "start":
                    strategy_started = True
                last_event_as_of_ms = event["asOfMs"]
                emit({"type": "result", "requestId": request_id, "output": output})
            elif message_type == "invoke_batch":
                if namespace is None:
                    raise ProtocolFailure("strategy_not_loaded", "load strategy source before invoking it")
                reject_unknown_fields(message, {"protocol", "type", "requestId", "events"}, "invoke_batch")
                events = message.get("events")
                if not isinstance(events, list) or not events or len(events) > 64:
                    raise ProtocolFailure("invalid_batch", "invoke_batch.events must contain 1 to 64 events")
                outputs = []
                for event in events:
                    event = validate_event(event)
                    if last_event_as_of_ms is not None and event["asOfMs"] < last_event_as_of_ms:
                        raise ProtocolFailure("out_of_order_event", "strategy events must not move backward in time")
                    handler_name = {
                        "start": "on_start",
                        "bar": "on_bar",
                        "rebalance": "on_rebalance",
                    }[event["kind"]]
                    if event["kind"] == "start" and strategy_started:
                        raise ProtocolFailure("invalid_lifecycle", "on_start may be invoked only once after each strategy load")
                    if event["kind"] != "start" and "on_start" in handlers and not strategy_started:
                        raise ProtocolFailure("invalid_lifecycle", "invoke on_start before dispatching bar or rebalance events")
                    handler = namespace.get(handler_name)
                    if not callable(handler):
                        if event["kind"] != "start":
                            raise ProtocolFailure("missing_handler", f"strategy does not implement {handler_name}(ctx)")
                        if event["kind"] == "start":
                            strategy_started = True
                        last_event_as_of_ms = event["asOfMs"]
                        output = {"kind": "no_action", "asOfMs": event["asOfMs"], "reason": f"{handler_name} is not defined"}
                    else:
                        market = merge_market_snapshot(market_cache, event["market"])
                        portfolio = portfolio_cache.snapshot(event.get("portfolio"))
                        context = StrategyContext(event, market, portfolio, strategy_params, indicator_cache)
                        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                            output = handler(context)
                        output = validate_output(output, event)
                        if event["kind"] == "start":
                            strategy_started = True
                        last_event_as_of_ms = event["asOfMs"]
                    outputs.append(output)
                    if output.get("kind") != "no_action":
                        break
                emit({"type": "result", "requestId": request_id, "outputs": outputs})
            elif message_type == "shutdown":
                emit({"type": "shutdown", "requestId": request_id})
                return
            else:
                raise ProtocolFailure("invalid_message_type", "message.type must be load, invoke, invoke_batch, or shutdown")
        except Exception as error:
            request_id = message.get("requestId") if isinstance(locals().get("message"), dict) else None
            emit(error_message(request_id, error))


if __name__ == "__main__":
    main()
