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
    band_period = int(ctx.params.get("bandPeriod", 20))
    band_width = float(ctx.params.get("bandWidth", 2.0))
    atr_period = int(ctx.params.get("atrPeriod", 14))
    stop_atr = float(ctx.params.get("stopAtr", 2.2))
    if band_period <= 1 or band_width <= 0.0 or atr_period <= 0 or stop_atr <= 0.0:
        return ctx.no_action("invalid Bollinger parameters")

    lookback = max(band_period + 2, atr_period + 2)
    bars = ctx.market.bars(ctx.instrument_id, "30m", lookback=lookback)
    confirmed = [bar for bar in bars if bar.confirmed]
    if len(confirmed) < max(band_period + 1, atr_period + 2):
        return ctx.no_action("waiting for confirmed 30m Bollinger history")

    window = confirmed[-band_period:]
    closes = [bar.close for bar in window]
    middle = sum(closes) / band_period
    variance = sum((close - middle) * (close - middle) for close in closes) / band_period
    deviation = variance ** 0.5
    upper = middle + band_width * deviation
    lower = middle - band_width * deviation
    atr_value = average_true_range(confirmed, atr_period)
    if atr_value is None or atr_value <= 0.0:
        return ctx.no_action("ATR is unavailable")

    current = confirmed[-1]
    long_position = ctx.portfolio.position(ctx.instrument_id, "long")
    short_position = ctx.portfolio.position(ctx.instrument_id, "short")
    if long_position is not None and current.close >= middle:
        return ctx.close_long("30m Bollinger mean reversion reached")
    if short_position is not None and current.close <= middle:
        return ctx.close_short("30m Bollinger mean reversion reached")

    if long_position is None and short_position is None and current.close <= lower:
        stop_price = current.close - stop_atr * atr_value
        if stop_price <= 0.0:
            return ctx.no_action("long ATR stop is invalid")
        return ctx.open_long(
            "30m close below the lower Bollinger band",
            protection={"stopLossPrice": stop_price, "takeProfitPrice": middle},
        )

    if long_position is None and short_position is None and current.close >= upper:
        stop_price = current.close + stop_atr * atr_value
        return ctx.open_short(
            "30m close above the upper Bollinger band",
            protection={"stopLossPrice": stop_price, "takeProfitPrice": middle},
        )

    return ctx.no_action("price remains inside the Bollinger bands")
