import type { Candle, FundingRate, OrderBook, PrivateAccountSnapshot, PrivateWsStatus, PublicWsStatus, Ticker, Trade, OkxPendingOrder } from "../types";

export type MarketEvent =
  | { type: "status"; status: string }
  | ({ type: "publicStatus" } & PublicWsStatus)
  | { type: "ticker"; ticker: Ticker }
  | { type: "orderBook"; instId?: string; book: OrderBook }
  | { type: "trade"; instId?: string; trade: Trade }
  | { type: "trades"; instId?: string; trades: Trade[] }
  | { type: "renderBatch"; orderBooks: Record<string, OrderBook>; trades: Record<string, Trade[]> }
  | { type: "candle"; instId?: string; bar?: string; candle: Candle }
  | { type: "fundingRate"; funding: FundingRate }
  | { type: "privateSnapshot"; snapshot: PrivateAccountSnapshot }
  | { type: "privateOrder"; accountId: string; environment: string; order: OkxPendingOrder }
  | ({ type: "privateStatus" } & PrivateWsStatus)
  | { type: "error"; message: string };
