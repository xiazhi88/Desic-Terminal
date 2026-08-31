import { Command, Sparkles } from "lucide-react";
import type { AiSlashEntry } from "./aiResearchCommands";

const COMMAND_COPY: Record<string, [string, string]> = {
  market: ["读取市场快照", "Read market snapshot"],
  structure: ["分析 K 线结构", "Analyze candle structure"],
  flow: ["审查资金费率与流动", "Review funding and flow"],
  radar: ["扫描 Market Radar", "Scan Market Radar"],
  intelligence: ["检索市场情报", "Review market intelligence"],
  risk: ["审查账户风险", "Review account risk"],
  compare: ["对比永续合约", "Compare perpetuals"],
  review: ["形成交易前研究", "Create pre-trade research"]
};

export function AiCommandPalette({ entries, activeIndex, onSelect, uiText }: { entries: AiSlashEntry[]; activeIndex: number; onSelect: (entry: AiSlashEntry) => void; uiText: (zh: string, en: string) => string }) {
  return (
    <div className="ai-command-palette" role="listbox" aria-label={uiText("选择研究命令或 Skill", "Choose a research command or Skill")}>
      <div className="ai-command-palette-head"><strong>{uiText("研究命令 / Skills", "Research commands / Skills")}</strong><span>↑↓ · Enter · Esc</span></div>
      {entries.length === 0 ? <p className="ai-command-palette-empty">{uiText("没有匹配项", "No matching commands")}</p> : entries.map((entry, index) => {
        const isCommand = entry.kind === "command";
        const id = entry.value.id;
        const commandCopy = isCommand ? COMMAND_COPY[id] : undefined;
        const commandParams = isCommand && entry.value.params?.length ? entry.value.params : undefined;
        return (
          <button type="button" role="option" aria-selected={index === activeIndex} className={index === activeIndex ? "active" : ""} key={`${entry.kind}:${id}`} onMouseDown={(event) => { event.preventDefault(); onSelect(entry); }}>
            <span className="ai-command-palette-icon">{isCommand ? <Command size={14} /> : <Sparkles size={14} />}</span>
            <span className="ai-command-palette-copy">
              <strong>/{id}</strong><small>{isCommand ? (commandCopy ? uiText(commandCopy[0], commandCopy[1]) : entry.value.label) : entry.value.name}</small><em>{entry.value.description}</em>
              {commandParams ? (
                <span className="ai-command-palette-params" title={commandParams.map((param) => `${param.name} — ${param.description}`).join(" · ")}>
                  {uiText("参数：", "Params: ")}{commandParams.map((param) => param.name).join(" · ")}
                </span>
              ) : null}
            </span>
            <span className="ai-command-palette-kind">{isCommand ? uiText("命令", "Command") : "Skill"}</span>
          </button>
        );
      })}
    </div>
  );
}
