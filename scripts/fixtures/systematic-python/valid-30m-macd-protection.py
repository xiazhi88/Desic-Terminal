# 策略说明
# - 事件时钟：on_bar 每根确认 1m K 线收盘后都会调用，但仅在最新 30m K
#   线已确认收线时计算 MACD 信号。
# - 入场：30m MACD 金叉/死叉且成交量高于此前 20 根平均值时，开 1 手。
# - 保护：开仓动作先附带 14 ATR 的初始止盈止损；首次看到真实成交均价后，
#   用 averageEntryPrice 校正保护价，初始保护在此期间持续生效。
# - 离场：确认的反向 30m MACD 交叉会完整平仓。

pending_entry_protection = None


def ema_series(values, period):
    multiplier = 2.0 / (period + 1.0)
    ema = values[0]
    result = [ema]
    for value in values[1:]:
        ema = value * multiplier + ema * (1.0 - multiplier)
        result.append(ema)
    return result


def average_true_range(bars, period):
    true_ranges = []
    for index in range(1, len(bars)):
        current = bars[index]
        previous_close = bars[index - 1].close
        true_ranges.append(
            max(
                current.high - current.low,
                abs(current.high - previous_close),
                abs(current.low - previous_close),
            )
        )
    return sum(true_ranges[-period:]) / period


def on_bar(ctx):
    global pending_entry_protection

    fast_period = int(ctx.params.get("fastPeriod", 10))
    slow_period = int(ctx.params.get("slowPeriod", 30))
    signal_period = 9
    volume_window = 20
    atr_period = 14
    stop_atr_multiple = 2.0
    take_atr_multiple = 3.0

    if fast_period <= 0 or slow_period <= 0 or fast_period >= slow_period:
        return ctx.no_action("快慢 EMA 参数无效")

    long_position = ctx.portfolio.position(ctx.instrument_id, "long")
    short_position = ctx.portfolio.position(ctx.instrument_id, "short")

    # 信号价初始保护覆盖成交后的首分钟；看到持仓后改为真实均价 ATR 保护。
    pending = pending_entry_protection
    pending_entry_protection = None
    if pending is not None:
        entry_atr = pending["atr"]
        if pending["side"] == "long" and long_position is not None:
            entry_price = long_position.averageEntryPrice
            return ctx.set_protection(
                "按多单实际成交均价校正 ATR 保护价",
                stop_loss_price=entry_price - stop_atr_multiple * entry_atr,
                take_profit_price=entry_price + take_atr_multiple * entry_atr,
            )
        if pending["side"] == "short" and short_position is not None:
            entry_price = short_position.averageEntryPrice
            return ctx.set_protection(
                "按空单实际成交均价校正 ATR 保护价",
                stop_loss_price=entry_price + stop_atr_multiple * entry_atr,
                take_profit_price=entry_price - take_atr_multiple * entry_atr,
            )

    lookback = max(slow_period * 3 + signal_period * 3 + 30, 120)
    bars = ctx.market.bars(ctx.instrument_id, "30m", lookback=lookback)
    if len(bars) < lookback:
        return ctx.no_action("等待 30m MACD 预热")

    signal_bar = bars[-1]
    if not signal_bar.confirmed:
        return ctx.no_action("等待确认的 30m 收线")

    closes = [bar.close for bar in bars]
    fast_ema = ema_series(closes, fast_period)
    slow_ema = ema_series(closes, slow_period)
    dif_series = [fast - slow for fast, slow in zip(fast_ema, slow_ema)]
    dea_series = ema_series(dif_series, signal_period)
    golden_cross = dif_series[-2] <= dea_series[-2] and dif_series[-1] > dea_series[-1]
    death_cross = dif_series[-2] >= dea_series[-2] and dif_series[-1] < dea_series[-1]

    atr_value = average_true_range(bars, atr_period)
    if atr_value <= 0.0:
        return ctx.no_action("ATR 为零，无法设置保护价")

    prior_volume_average = sum(
        bar.volume for bar in bars[-volume_window - 1:-1]
    ) / volume_window
    volume_ok = signal_bar.volume > prior_volume_average

    # 信号离场在下一根 1m 开盘成交；完整平仓后宿主会自动撤销保护价。
    if long_position is not None and death_cross:
        return ctx.close_long("确认的 30m MACD 死叉")
    if short_position is not None and golden_cross:
        return ctx.close_short("确认的 30m MACD 金叉")

    if long_position is None and short_position is None and golden_cross and volume_ok:
        initial_stop = signal_bar.close - stop_atr_multiple * atr_value
        initial_target = signal_bar.close + take_atr_multiple * atr_value
        if initial_stop <= 0.0:
            return ctx.no_action("多单 ATR 初始保护价无效")
        pending_entry_protection = {"side": "long", "atr": atr_value}
        return ctx.open_long(
            "确认的 30m MACD 金叉且成交量放大",
            protection={
                "stopLossPrice": initial_stop,
                "takeProfitPrice": initial_target,
            },
        )

    if long_position is None and short_position is None and death_cross and volume_ok:
        initial_stop = signal_bar.close + stop_atr_multiple * atr_value
        initial_target = signal_bar.close - take_atr_multiple * atr_value
        if initial_target <= 0.0:
            return ctx.no_action("空单 ATR 初始保护价无效")
        pending_entry_protection = {"side": "short", "atr": atr_value}
        return ctx.open_short(
            "确认的 30m MACD 死叉且成交量放大",
            protection={
                "stopLossPrice": initial_stop,
                "takeProfitPrice": initial_target,
            },
        )

    return ctx.no_action("没有确认的 30m 信号")
