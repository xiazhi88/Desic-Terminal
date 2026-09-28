// 市场星图的板块归类：交易所不提供加密板块字段，这里是一份本地静态归类表（按币种代码）。
// 只覆盖流动性较好的常见币种；表里没有的加密合约归入「其他」，不猜测。
// 非加密资产直接按交易所的 instCategory 归类（股票 / 大宗商品 / 外汇 / 债券）。

export const RADAR_SECTORS = [
  { id: "major", zh: "主流", en: "Majors" },
  { id: "l1", zh: "公链", en: "L1" },
  { id: "l2", zh: "L2", en: "L2" },
  { id: "defi", zh: "DeFi", en: "DeFi" },
  { id: "ai", zh: "AI", en: "AI" },
  { id: "meme", zh: "Meme", en: "Meme" },
  { id: "game", zh: "游戏", en: "Gaming" },
  { id: "stock", zh: "美股", en: "Stocks" },
  { id: "commodity", zh: "大宗商品", en: "Commodities" },
  { id: "fx", zh: "外汇", en: "FX" },
  { id: "bond", zh: "债券", en: "Bonds" },
  { id: "other", zh: "其他", en: "Other" }
] as const;

export type RadarSectorId = (typeof RADAR_SECTORS)[number]["id"];

const CRYPTO_SECTORS: Record<Exclude<RadarSectorId, "stock" | "commodity" | "fx" | "bond" | "other">, string> = {
  major: "BTC ETH XRP BNB OKB LTC BCH ETC",
  l1: "SOL ADA AVAX TON TRX DOT NEAR APT SUI ATOM ALGO XLM HBAR ICP SEI INJ TIA KAS EGLD FTM S SONIC XTZ EOS FIL KSM FLOW NEO QTUM ZIL ONE KAIA BERA MOVE IOTA XDC VET THETA HYPE ZEC XMR DASH BSV CELO MINA ROSE CORE",
  l2: "ARB OP STRK MATIC POL IMX MNT ZK METIS MANTA BLAST SCR TAIKO LRC BOBA CELR LINEA ZRO BASE",
  defi: "LINK UNI AAVE PENDLE ENA MKR SKY LDO CRV COMP SNX DYDX GMX JUP RAY CAKE SUSHI 1INCH BAL YFI ETHFI EIGEN RUNE JTO PYTH ONDO MORPHO AERO CVX FXS RPL SSV UMA API3 BAND ORCA DRIFT KMNO ZRX BNT LQTY USUAL",
  ai: "TAO FET RENDER VIRTUAL WLD AGIX OCEAN AR AKT ARKM IO GRASS AIXBT AI16Z GOAT ACT NEAR IP KAITO COOKIE GRT PRIME NMR CGPT SAHARA",
  meme: "DOGE SHIB PEPE WIF BONK PENGU TRUMP FLOKI MEME BOME POPCAT MEW NEIRO TURBO BRETT MOODENG PNUT CAT DOGS NOT SATS ORDI MELANIA FARTCOIN SPX GIGA MOG LUNC PEOPLE",
  game: "AXS SAND MANA GALA ENJ ILV YGG PIXEL BEAM MAGIC APE GMT ALICE SUPER PORTAL RON NFT BIGTIME XAI GODS"
};

const SECTOR_BY_BASE = new Map<string, RadarSectorId>();
for (const [sector, list] of Object.entries(CRYPTO_SECTORS) as Array<[RadarSectorId, string]>) {
  for (const base of list.split(/\s+/)) {
    // 同一代码出现在多个板块时以先登记的为准（例如 NEAR 归公链）。
    if (base && !SECTOR_BY_BASE.has(base)) SECTOR_BY_BASE.set(base, sector);
  }
}

/** instCategory：OKX 产品类别（1 加密 / 3 股票 / 4 大宗商品 / 5 外汇 / 6 债券）。 */
export function radarSectorOf(instId: string, instCategory: string | null | undefined): RadarSectorId {
  if (instCategory === "3") return "stock";
  if (instCategory === "4") return "commodity";
  if (instCategory === "5") return "fx";
  if (instCategory === "6") return "bond";
  const base = instId.split("-")[0]?.toUpperCase() ?? "";
  return SECTOR_BY_BASE.get(base) ?? "other";
}

export function radarSectorName(sector: string, chinese: boolean) {
  const found = RADAR_SECTORS.find((item) => item.id === sector);
  return found ? (chinese ? found.zh : found.en) : sector;
}

export function radarSectorOrder(sector: string) {
  const index = RADAR_SECTORS.findIndex((item) => item.id === sector);
  return index < 0 ? RADAR_SECTORS.length : index;
}
