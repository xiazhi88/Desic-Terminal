import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Bot, Check, ChevronRight, ShieldCheck, WalletCards, X } from "lucide-react";

export type FirstLaunchStep = "account" | "ai" | "profile" | "trade";

type FirstLaunchStatus = "active" | "dismissed" | "completed";

type FirstLaunchProgress = {
  version: 1;
  status: FirstLaunchStatus;
  step: FirstLaunchStep;
  completedSteps: FirstLaunchStep[];
  updatedAt: number;
};

type FirstLaunchControllerOptions = {
  autoStart: boolean;
  ready: boolean;
  hasExistingAccount: boolean;
  previewStep?: FirstLaunchStep | null;
  onNavigate: (step: FirstLaunchStep) => void;
  onFinished: () => void;
};

const FIRST_LAUNCH_STORAGE_KEY = "desicterminal.firstLaunchOnboarding.v1";
const FIRST_LAUNCH_STEPS: FirstLaunchStep[] = ["account", "ai", "profile", "trade"];

const STEP_CONTENT: Record<FirstLaunchStep, {
  eyebrow: string;
  title: string;
  description: string;
  action: string;
  completion: string;
  facts: Array<{ label: string; tone?: "safe" | "warning" }>;
}> = {
  account: {
    eyebrow: "第 1 步",
    title: "添加 OKX 账号",
    description: "输入 API Key、Secret 和 Passphrase，系统会自动识别实盘或模拟盘。提现权限必须保持关闭。",
    action: "填写账号",
    completion: "保存并测试连接成功后自动进入下一步",
    facts: [
      { label: "凭据仅保存在本机", tone: "safe" },
      { label: "自动识别交易环境", tone: "safe" },
      { label: "禁止提现", tone: "warning" }
    ]
  },
  ai: {
    eyebrow: "第 2 步",
    title: "连接一个 AI 模型",
    description: "填写 Provider、Model ID、Base URL 和 API Key。保存模型配置后执行连接测试。",
    action: "填写模型连接",
    completion: "模型连接测试成功后自动进入下一步",
    facts: [
      { label: "API Key 仅保存在本机", tone: "safe" },
      { label: "支持 OpenAI 兼容接口" }
    ]
  },
  profile: {
    eyebrow: "第 3 步",
    title: "创建第一个 AI Profile",
    description: "账号和模型已自动带入。确认名称、模式与关注品种即可，高级参数以后再设置。",
    action: "配置 Profile",
    completion: "保存 Profile 后自动进入交易步骤",
    facts: [
      { label: "默认顾问模式", tone: "safe" },
      { label: "环境跟随账号", tone: "safe" }
    ]
  },
  trade: {
    eyebrow: "最后一步",
    title: "准备第一笔交易",
    description: "进入交易面板熟悉委托类型、数量与预检。是否提交订单由你决定，不影响首次配置完成。",
    action: "去交易一笔",
    completion: "进入交易面板后指引即完成，不要求提交订单",
    facts: [
      { label: "环境跟随当前账号", tone: "safe" },
      { label: "建议使用小额数量" },
      { label: "下单前检查价格与杠杆", tone: "warning" }
    ]
  }
};

function createProgress(step: FirstLaunchStep, status: FirstLaunchStatus = "active"): FirstLaunchProgress {
  return { version: 1, status, step, completedSteps: [], updatedAt: Date.now() };
}

function isFirstLaunchStep(value: unknown): value is FirstLaunchStep {
  return typeof value === "string" && FIRST_LAUNCH_STEPS.includes(value as FirstLaunchStep);
}

function loadProgress(): FirstLaunchProgress | null {
  try {
    const raw = window.localStorage.getItem(FIRST_LAUNCH_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<FirstLaunchProgress>;
    if (value.version !== 1 || !isFirstLaunchStep(value.step) || !["active", "dismissed", "completed"].includes(value.status ?? "")) return null;
    return {
      version: 1,
      status: value.status as FirstLaunchStatus,
      step: value.step,
      completedSteps: Array.isArray(value.completedSteps) ? value.completedSteps.filter(isFirstLaunchStep) : [],
      updatedAt: Number(value.updatedAt) || Date.now()
    };
  } catch {
    return null;
  }
}

function persistProgress(progress: FirstLaunchProgress) {
  try {
    window.localStorage.setItem(FIRST_LAUNCH_STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // The guide can continue in memory when browser storage is unavailable.
  }
  return progress;
}

export function parseFirstLaunchPreviewStep(value: string | null): FirstLaunchStep | null {
  return isFirstLaunchStep(value) ? value : null;
}

export function useFirstLaunchOnboarding({
  autoStart,
  ready,
  hasExistingAccount,
  previewStep,
  onNavigate,
  onFinished
}: FirstLaunchControllerOptions) {
  const [progress, setProgress] = useState<FirstLaunchProgress | null>(() => previewStep ? createProgress(previewStep) : loadProgress());
  const [open, setOpen] = useState(Boolean(previewStep));
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!ready || initializedRef.current) return;
    initializedRef.current = true;
    if (previewStep) {
      const next = createProgress(previewStep);
      setProgress(next);
      setOpen(true);
      return;
    }
    if (!autoStart) return;
    const stored = loadProgress();
    if (stored) {
      setProgress(stored);
      setOpen(stored.status === "active");
      return;
    }
    if (hasExistingAccount) {
      setProgress(persistProgress({
        ...createProgress("trade", "completed"),
        completedSteps: [...FIRST_LAUNCH_STEPS]
      }));
      return;
    }
    const next = persistProgress(createProgress("account"));
    setProgress(next);
    setOpen(true);
  }, [autoStart, hasExistingAccount, previewStep, ready]);

  useEffect(() => {
    if (!open || !progress || progress.status === "completed") return;
    onNavigate(progress.step);
  }, [onNavigate, open, progress]);

  const dismiss = useCallback(() => {
    if (!progress || progress.status === "completed") return;
    const next = persistProgress({ ...progress, status: "dismissed", updatedAt: Date.now() });
    setProgress(next);
    setOpen(false);
  }, [progress]);

  const reopen = useCallback(() => {
    if (!progress || progress.status === "completed") return;
    const next = persistProgress({ ...progress, status: "active", updatedAt: Date.now() });
    setProgress(next);
    setOpen(true);
  }, [progress]);

  const completeStep = useCallback((step: FirstLaunchStep) => {
    if (!progress || progress.status === "completed" || progress.step !== step) return;
    const completedSteps = Array.from(new Set([...progress.completedSteps, step]));
    const stepIndex = FIRST_LAUNCH_STEPS.indexOf(step);
    const nextStep = FIRST_LAUNCH_STEPS[stepIndex + 1];
    if (!nextStep) {
      const next = persistProgress({ ...progress, status: "completed", completedSteps, updatedAt: Date.now() });
      setProgress(next);
      setOpen(false);
      onFinished();
      return;
    }
    const next = persistProgress({
      ...progress,
      status: open ? "active" : "dismissed",
      step: nextStep,
      completedSteps,
      updatedAt: Date.now()
    });
    setProgress(next);
  }, [onFinished, open, progress]);

  const returnToStep = useCallback(() => {
    if (!progress || progress.status === "completed") return;
    onNavigate(progress.step);
  }, [onNavigate, progress]);

  return {
    step: progress?.step ?? null,
    status: progress?.status ?? null,
    open,
    canReopen: Boolean(progress && progress.status === "dismissed"),
    dismiss,
    reopen,
    completeStep,
    returnToStep
  };
}

type TargetRect = Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width" | "height">;

function measureTarget(step: FirstLaunchStep): TargetRect | null {
  const target = document.querySelector<HTMLElement>(`[data-onboarding-target="${step}"]`);
  if (!target) return null;
  const rect = target.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return null;
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function FirstLaunchOnboarding({
  step,
  accountEnvironment = "demo",
  onExit,
  onReturnToStep,
  onComplete
}: {
  step: FirstLaunchStep;
  accountEnvironment?: "demo" | "live";
  onExit: () => void;
  onReturnToStep: () => void;
  onComplete: () => void;
}) {
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const content = useMemo(() => {
    if (step !== "trade") return STEP_CONTENT[step];
    if (accountEnvironment === "live") {
      return {
        ...STEP_CONTENT.trade,
        title: "准备第一笔实盘交易",
        description: "当前 API Key 已识别为实盘。进入交易面板后请先核对价格、杠杆和保证金模式，是否下单由你决定。",
        completion: "点击“去交易一笔”后完成指引，是否下单由你决定",
        facts: [
          { label: "实盘账户", tone: "warning" as const },
          { label: "每笔订单二次确认", tone: "safe" as const },
          { label: "建议使用可控数量" }
        ]
      };
    }
    return {
      ...STEP_CONTENT.trade,
      title: "准备第一笔模拟交易",
      description: "当前 API Key 已识别为模拟盘。进入交易面板后可以熟悉委托类型、数量与预检，是否提交由你决定。",
      completion: "点击“去交易一笔”后完成指引，是否下单由你决定",
      facts: [
        { label: "模拟盘账户", tone: "safe" as const },
        { label: "建议使用小额数量" },
        { label: "下单前检查价格与杠杆", tone: "warning" as const }
      ]
    };
  }, [accountEnvironment, step]);
  const stepIndex = FIRST_LAUNCH_STEPS.indexOf(step);

  const updateTarget = useCallback(() => {
    const next = measureTarget(step);
    setTargetRect((current) => {
      if (!current || !next) return current === next ? current : next;
      const unchanged = Math.abs(current.top - next.top) < 0.5
        && Math.abs(current.left - next.left) < 0.5
        && Math.abs(current.width - next.width) < 0.5
        && Math.abs(current.height - next.height) < 0.5;
      return unchanged ? current : next;
    });
  }, [step]);

  useEffect(() => {
    let frame = window.requestAnimationFrame(updateTarget);
    const mutationObserver = new MutationObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateTarget);
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", updateTarget);
    const interval = window.setInterval(updateTarget, 600);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(interval);
      mutationObserver.disconnect();
      window.removeEventListener("resize", updateTarget);
    };
  }, [updateTarget]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onExit();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onExit]);

  const ringStyle = useMemo<CSSProperties | undefined>(() => targetRect ? ({
    top: Math.max(66, targetRect.top - 4),
    left: targetRect.left - 4,
    width: targetRect.width + 8,
    height: targetRect.height + 8
  }) : undefined, [targetRect]);

  const cardStyle = useMemo<CSSProperties>(() => {
    const width = Math.min(380, window.innerWidth - 32);
    const estimatedHeight = 246;
    if (!targetRect) {
      return { top: 136, left: clamp((window.innerWidth - width) / 2, 16, window.innerWidth - width - 16), width };
    }
    if (step === "trade") {
      return {
        top: clamp(targetRect.top + 86, 136, window.innerHeight - estimatedHeight - 18),
        left: clamp(targetRect.left - width - 18, 16, window.innerWidth - width - 16),
        width
      };
    }
    if (step === "profile") {
      return {
        top: clamp(targetRect.bottom - estimatedHeight - 18, 136, window.innerHeight - estimatedHeight - 18),
        left: clamp(targetRect.right - width - 18, 16, window.innerWidth - width - 16),
        width
      };
    }
    return {
      top: clamp(targetRect.top - estimatedHeight - 16, 136, window.innerHeight - estimatedHeight - 18),
      left: clamp(targetRect.right - width - 18, 16, window.innerWidth - width - 16),
      width
    };
  }, [step, targetRect]);

  const focusTarget = useCallback(() => {
    onReturnToStep();
    window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>(`[data-onboarding-target="${step}"]`);
      const focusTarget = target?.querySelector<HTMLElement>("[data-onboarding-focus]") ?? target;
      focusTarget?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      focusTarget?.focus({ preventScroll: true });
      updateTarget();
    }, 80);
  }, [onReturnToStep, step, updateTarget]);

  const handleAction = useCallback(() => {
    if (step !== "trade" || !targetRect) {
      focusTarget();
      return;
    }
    onReturnToStep();
    onComplete();
  }, [focusTarget, onComplete, onReturnToStep, step, targetRect]);

  const StepIcon = step === "account" ? WalletCards : step === "ai" || step === "profile" ? Bot : ShieldCheck;

  return (
    <aside className="first-launch-onboarding" aria-label="首次配置指引" aria-live="polite">
      {ringStyle ? <div className="first-launch-spotlight" style={ringStyle} aria-hidden="true" /> : null}
      <div className="first-launch-guide-bar">
        <div className="first-launch-guide-title">
          <StepIcon size={15} />
          <span><strong>首次配置 · {stepIndex + 1} / {FIRST_LAUNCH_STEPS.length}</strong><small>{content.title}</small></span>
        </div>
        <div className="first-launch-progress" aria-label={`第 ${stepIndex + 1} 步，共 ${FIRST_LAUNCH_STEPS.length} 步`}>
          {FIRST_LAUNCH_STEPS.map((item, index) => (
            <i className={index < stepIndex ? "done" : index === stepIndex ? "active" : ""} key={item} />
          ))}
        </div>
        <button type="button" className="first-launch-exit" onClick={onExit}><X size={13} />退出指引</button>
      </div>
      <section className="first-launch-card" style={cardStyle}>
        <span className="first-launch-eyebrow">{content.eyebrow}</span>
        <h2>{content.title}</h2>
        <p>{content.description}</p>
        <div className="first-launch-facts">
          {content.facts.map((fact) => <span className={fact.tone} key={fact.label}>{fact.tone === "safe" ? <Check size={11} /> : null}{fact.label}</span>)}
        </div>
        <div className="first-launch-card-foot">
          <small>{targetRect ? content.completion : "当前步骤已离开，返回后继续配置"}</small>
          <button type="button" onClick={handleAction}>{targetRect ? content.action : "返回当前步骤"}<ChevronRight size={13} /></button>
        </div>
      </section>
    </aside>
  );
}
