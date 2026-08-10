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
    slow_period = int(ctx.params.get("slowPeriod", 36))
    atr_period = int(ctx.params.get("atrPeriod", 14))
    stop_atr = float(ctx.params.get("stopAtr", 2.0))
    take_atr = float(ctx.params.get("takeAtr", 3.5))
    if fast_period <= 0 or slow_period <= fast_period or atr_period <= 0:
        return ctx.no_action("invalid trend parameters")
    if stop_atr <= 0.0 or take_atr <= 0.0:
        return ctx.no_action("invalid ATR protection parameters")

    lookback = max(slow_period + 2, atr_period + 2)
    bars = ctx.market.bars(ctx.instrument_id, "30m", lookback=lookback)
    confirmed = [bar for bar in bars if bar.confirmed]
    minimum_bars = max(slow_period + 1, atr_period + 2)
    if len(confirmed) < minimum_bars:
        return ctx.no_action("waiting for confirmed 30m trend history")

    closes = [bar.close for bar in confirmed]
    fast_values = ema_series(closes, fast_period)
    slow_values = ema_series(closes, slow_period)
    fast_now = fast_values[-1]
    fast_previous = fast_values[-2]
    slow_now = slow_values[-1]
    slow_previous = slow_values[-2]
    golden_cross = fast_previous <= slow_previous and fast_now > slow_now
    death_cross = fast_previous >= slow_previous and fast_now < slow_now
    atr_value = average_true_range(confirmed, atr_period)
    if atr_value is None or atr_value <= 0.0:
        return ctx.no_action("ATR is unavailable")

    signal_bar = confirmed[-1]
    long_position = ctx.portfolio.position(ctx.instrument_id, "long")
    short_position = ctx.portfolio.position(ctx.instrument_id, "short")
    if long_position is not None and death_cross:
        return ctx.close_long("confirmed 30m EMA trend reversal")
    if short_position is not None and golden_cross:
        return ctx.close_short("confirmed 30m EMA trend reversal")

    if long_position is None and short_position is None and golden_cross:
        stop_price = signal_bar.close - stop_atr * atr_value
        target_price = signal_bar.close + take_atr * atr_value
        if stop_price <= 0.0:
            return ctx.no_action("long ATR stop is invalid")
        return ctx.open_long(
            "confirmed 30m EMA golden cross",
            protection={"stopLossPrice": stop_price, "takeProfitPrice": target_price},
        )

    if long_position is None and short_position is None and death_cross:
        stop_price = signal_bar.close + stop_atr * atr_value
        target_price = signal_bar.close - take_atr * atr_value
        if target_price <= 0.0:
            return ctx.no_action("short ATR target is invalid")
        return ctx.open_short(
            "confirmed 30m EMA death cross",
            protection={"stopLossPrice": stop_price, "takeProfitPrice": target_price},
        )

    return ctx.no_action("EMA trend has not crossed")
