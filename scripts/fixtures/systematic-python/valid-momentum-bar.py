def on_bar(ctx):
    recent = ctx.market.bars(ctx.instrument_id, ctx.interval, lookback=2)
    previous = recent[0]
    current = recent[-1]
    if current.close > previous.close:
        return ctx.signal(
            "long",
            "closed-bar momentum confirmation",
            confidence=0.65,
            metadata={"previousClose": previous.close, "currentClose": current.close},
        )
    return ctx.no_action("closed-bar momentum is not positive")
