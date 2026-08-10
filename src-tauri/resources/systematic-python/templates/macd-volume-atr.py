def ema_series(values, period):
    multiplier = 2.0 / (period + 1.0)
    current = values[0]
    result = [current]
    for value in values[1:]:
        current = value * multiplier + current * (1.0 - multiplier)
        result.append(current)
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
    if len(true_ranges) < period:
        return None
    return sum(true_ranges[-period:]) / period


def on_bar(ctx):
    fast_period = int(ctx.params.get("fastPeriod", 12))
    slow_period = int(ctx.params.get("slowPeriod", 26))
    signal_period = int(ctx.params.get("signalPeriod", 9))
    volume_window = int(ctx.params.get("volumeWindow", 20))
    atr_period = int(ctx.params.get("atrPeriod", 14))
    stop_atr = float(ctx.params.get("stopAtr", 2.0))
    take_atr = float(ctx.params.get("takeAtr", 3.0))
    if fast_period <= 0 or slow_period <= fast_period or signal_period <= 0:
        return ctx.no_action("invalid MACD parameters")
    if volume_window <= 0 or atr_period <= 0 or stop_atr <= 0.0 or take_atr <= 0.0:
        return ctx.no_action("invalid confirmation parameters")

    lookback = max(slow_period * 3, volume_window + 2, atr_period + 2, 80)
    bars = ctx.market.bars(ctx.instrument_id, "30m", lookback=lookback)
    confirmed = [bar for bar in bars if bar.confirmed]
    if len(confirmed) < lookback:
        return ctx.no_action("waiting for confirmed 30m MACD history")

    closes = [bar.close for bar in confirmed]
    fast_values = ema_series(closes, fast_period)
    slow_values = ema_series(closes, slow_period)
    dif_values = [fast - slow for fast, slow in zip(fast_values, slow_values)]
    dea_values = ema_series(dif_values, signal_period)
    golden_cross = dif_values[-2] <= dea_values[-2] and dif_values[-1] > dea_values[-1]
    death_cross = dif_values[-2] >= dea_values[-2] and dif_values[-1] < dea_values[-1]
    prior_volume = sum(bar.volume for bar in confirmed[-volume_window - 1:-1]) / volume_window
    volume_confirmed = confirmed[-1].volume > prior_volume
    atr_value = average_true_range(confirmed, atr_period)
    if atr_value is None or atr_value <= 0.0:
        return ctx.no_action("ATR is unavailable")

    signal_bar = confirmed[-1]
    long_position = ctx.portfolio.position(ctx.instrument_id, "long")
    short_position = ctx.portfolio.position(ctx.instrument_id, "short")
    if long_position is not None and death_cross:
        return ctx.close_long("confirmed 30m MACD death cross")
    if short_position is not None and golden_cross:
        return ctx.close_short("confirmed 30m MACD golden cross")

    if long_position is None and short_position is None and golden_cross and volume_confirmed:
        stop_price = signal_bar.close - stop_atr * atr_value
        target_price = signal_bar.close + take_atr * atr_value
        if stop_price <= 0.0:
            return ctx.no_action("long ATR stop is invalid")
        return ctx.open_long(
            "30m MACD golden cross with volume confirmation",
            protection={"stopLossPrice": stop_price, "takeProfitPrice": target_price},
        )

    if long_position is None and short_position is None and death_cross and volume_confirmed:
        stop_price = signal_bar.close + stop_atr * atr_value
        target_price = signal_bar.close - take_atr * atr_value
        if target_price <= 0.0:
            return ctx.no_action("short ATR target is invalid")
        return ctx.open_short(
            "30m MACD death cross with volume confirmation",
            protection={"stopLossPrice": stop_price, "takeProfitPrice": target_price},
        )

    return ctx.no_action("MACD or volume confirmation is absent")
