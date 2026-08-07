def on_start(ctx):
    position = ctx.portfolio.position(ctx.instrument_id, "long")
    if position is not None:
        return ctx.close_long("start with an existing simulated long")
    return ctx.no_action("simulated account initialized")


def on_bar(ctx):
    bars = ctx.market.bars(ctx.instrument_id, ctx.interval, lookback=2)
    long_position = ctx.portfolio.position(ctx.instrument_id, "long")
    if long_position is not None:
        return ctx.close_long("close the simulated long after confirmation")
    if bars[-1].close > bars[0].close:
        return ctx.open_long(
            "closed-bar momentum confirmation",
            protection={"stopLossPrice": 99.0, "takeProfitPrice": 110.0},
            metadata={"availableMarginUsdt": ctx.portfolio.available_margin_usdt},
        )
    return ctx.no_action("closed-bar momentum is not positive")
