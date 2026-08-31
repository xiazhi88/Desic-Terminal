import { Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { IntelligenceWorkspacePage } from "../App";
import { AiResearchWorkspace } from "./AiResearchWorkspace";
import { previewRadarAssets, previewRadarTickers } from "./fixtures";

export function AiPreview() {
  const { i18n } = useTranslation();
  const [fullIntelligence, setFullIntelligence] = useState(false);
  if (fullIntelligence) {
    return <main className="ai-preview-page"><Suspense fallback={<div className="automation-page-loading"><Loader2 className="spin" size={20} /><span>{i18n.resolvedLanguage?.toLowerCase().startsWith("zh") ? "正在加载市场情报" : "Loading Market Intelligence"}</span></div>}><IntelligenceWorkspacePage accounts={[]} marketAssets={null} selectedSymbol="BTC-USDT-SWAP" onNewsUnreadCountChange={() => undefined} /></Suspense></main>;
  }
  return (
    <main className="ai-preview-page">
      <AiResearchWorkspace preview selectedSymbol="BTC-USDT-SWAP" accountId="preview-account" accountLabel="Research Demo" accountEnvironment="demo" onOpenIntelligence={() => setFullIntelligence(true)} marketAssets={previewRadarAssets} marketTickers={previewRadarTickers} cacheDir={previewRadarAssets.cacheDir} />
    </main>
  );
}
