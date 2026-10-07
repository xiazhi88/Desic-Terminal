import { useEffect, useState } from "react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { BookOpen, Crosshair, Megaphone } from "lucide-react";
import type { TraderScorecardData } from "../../lib/ai";
import { HandbookEditor } from "./HandbookEditor";
import { InstructionsPanel, type InstructionProfile } from "./InstructionsPanel";
import { TraderScorecard } from "./TraderScorecard";
import { DESKTOP_HANDBOOK_API, DESKTOP_INSTRUCTION_API, type TraderHandbookApi, type TraderInstructionApi } from "./traderApi";
import "./trader-workspace.css";

export type TraderWorkspaceView = "scorecard" | "handbook" | "instructions";
/** 从别处跳进来时要打开的页面（通知、Profile 编辑器的「管理手册」、成绩单的链接）。`nonce` 变化才生效。 */
export type TraderWorkspaceFocus = { view: TraderWorkspaceView; profileId?: string | null; handbookId?: string | null; nonce: number };

const VIEWS: Array<{ id: TraderWorkspaceView; icon: typeof Crosshair; labelKey: string }> = [
  { id: "scorecard", icon: Crosshair, labelKey: "automation:traderViewScorecard" },
  { id: "handbook", icon: BookOpen, labelKey: "automation:traderViewHandbook" },
  { id: "instructions", icon: Megaphone, labelKey: "automation:traderViewInstructions" }
];

/**
 * 「交易员」工作区：成绩单、交易手册、临时指令放在一起。用户在这里看每个形态的成绩、暂停范围、编辑和回退手册、
 * 给交易员下临时指令。预览页传入 `previewScorecard` 与内存实现的 `handbookApi` / `instructionApi`。
 */
export function TraderWorkspace({
  profiles,
  focus,
  previewScorecard,
  handbookApi = DESKTOP_HANDBOOK_API,
  instructionApi = DESKTOP_INSTRUCTION_API
}: {
  profiles: InstructionProfile[];
  focus?: TraderWorkspaceFocus | null;
  previewScorecard?: TraderScorecardData;
  handbookApi?: TraderHandbookApi;
  instructionApi?: TraderInstructionApi;
}) {
  const { t } = useTranslation(["automation", "common"]);
  const [view, setView] = useState<TraderWorkspaceView>(focus?.view ?? "scorecard");
  const [handbookTarget, setHandbookTarget] = useState<{ id: string | null; nonce: number }>({ id: focus?.handbookId ?? null, nonce: focus?.nonce ?? 0 });
  // 手册编辑器第一次打开后保持挂载：切到成绩单再切回来，未保存的修改还在。
  const [handbookMounted, setHandbookMounted] = useState(view === "handbook");
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [instructionTarget, setInstructionTarget] = useState<{ profileId: string | null; nonce: number }>({
    profileId: focus?.view === "instructions" ? focus.profileId ?? null : null,
    nonce: focus?.nonce ?? 0
  });

  useEffect(() => {
    if (!focus) return;
    setView(focus.view);
    if (focus.view === "handbook") {
      setHandbookTarget({ id: focus.handbookId ?? null, nonce: focus.nonce });
      setHandbookMounted(true);
    }
    if (focus.view === "instructions") setInstructionTarget({ profileId: focus.profileId ?? null, nonce: focus.nonce });
    // 只在跳转请求变化时响应。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  const open = (next: TraderWorkspaceView) => {
    setView(next);
    if (next === "handbook") setHandbookMounted(true);
  };

  return (
    <section className="trader-workspace" data-trader-workspace data-trader-view={view}>
      <nav className="trw-nav" role="tablist" aria-label={t("automation:traderWorkspaceAria")}>
        {VIEWS.map(({ id, icon: Icon, labelKey }) => (
          <button type="button" role="tab" key={id} aria-selected={view === id} className={clsx(view === id && "is-active")} onClick={() => open(id)} data-trader-tab={id}>
            <Icon size={13} />
            {t(labelKey)}
          </button>
        ))}
      </nav>
      <div className="trw-page" hidden={view !== "scorecard"}>
        <TraderScorecard
          profiles={profiles}
          previewData={previewScorecard}
          handbookApi={handbookApi}
          focusProfileId={focus?.view === "scorecard" ? focus.profileId ?? null : null}
          focusNonce={focus?.nonce}
          refreshKey={libraryVersion}
          onOpenHandbook={(handbookId) => {
            setHandbookTarget((current) => ({ id: handbookId, nonce: current.nonce + 1 }));
            open("handbook");
          }}
        />
      </div>
      {handbookMounted ? (
        <div className="trw-page" hidden={view !== "handbook"}>
          <HandbookEditor
            api={handbookApi}
            initialHandbookId={handbookTarget.id}
            focusNonce={handbookTarget.nonce}
            onLibraryChanged={() => setLibraryVersion((value) => value + 1)}
          />
        </div>
      ) : null}
      {view === "instructions" ? (
        <div className="trw-page">
          <InstructionsPanel
            api={instructionApi}
            profiles={profiles}
            defaultProfileId={instructionTarget.profileId}
            focusNonce={instructionTarget.nonce}
          />
        </div>
      ) : null}
    </section>
  );
}
