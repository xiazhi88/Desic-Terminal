def on_rebalance(ctx):
    values = []
    for instrument in ctx.universe:
        if not instrument.eligible:
            continue
        bars = ctx.market.bars(instrument.instrumentId, "1m", lookback=2)
        momentum = (bars[-1].close / bars[0].close) - 1.0
        values.append({"instrumentId": instrument.instrumentId, "value": momentum})
    return ctx.factor("closed_bar_momentum", values, metadata={"source": "1m close-to-close"})
