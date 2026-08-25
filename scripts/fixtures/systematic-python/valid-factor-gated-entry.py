# Cross-sectional factor used as an entry gate.
#
# The factor answers "which instruments are worth trading" and the strategy
# answers "should this one be entered now". Keeping those separate is what makes
# the pairing useful: the factor supplies relative standing, which a
# single-instrument view cannot see, while timing stays with the bar logic.
#
# Reading a score produces no action. Only the action methods below trade.
def on_bar(ctx):
    scores = ctx.factor_scores("builtin-kline-blend-v1")
    mine = scores.get(ctx.instrument_id)

    # An empty or missing entry means the host had no cross-section for this
    # cutoff, not that the instrument scored zero. Standing down is the honest
    # response to unknown standing.
    if not mine:
        return ctx.no_action("no cross-sectional score at this cutoff")

    universe_size = mine["universeSize"]
    # A ranking over a handful of instruments carries little information, so the
    # gate is only applied where the cross-section is wide enough to mean
    # something.
    if universe_size < 10:
        return ctx.no_action("cross-section too narrow to rank against")

    bars = ctx.market.bars(ctx.instrument_id, "1m", lookback=60)
    if len(bars) < 60:
        return ctx.no_action("insufficient confirmed history")

    trend_up = bars[-1].close > bars[0].close
    leading = mine["rank"] <= max(3, universe_size // 5)
    long_position = ctx.portfolio.position(ctx.instrument_id, "long")

    if long_position is None and trend_up and leading:
        return ctx.open_long(
            "rank {} of {} and trending up".format(mine["rank"], universe_size)
        )

    # Leaving once relative standing decays, rather than waiting for the trend to
    # break, is the point of gating on a cross-section.
    if long_position is not None and not leading:
        return ctx.close_long(
            "rank {} of {} fell out of the leading group".format(
                mine["rank"], universe_size
            )
        )

    return ctx.no_action("holding")
