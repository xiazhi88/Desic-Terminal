import { useLayoutEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  "audio[controls]",
  "video[controls]",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export type ModalFocusOptions<
  TContainer extends HTMLElement,
  TInitial extends HTMLElement = HTMLElement
> = {
  containerRef: RefObject<TContainer | null>;
  initialFocusRef?: RefObject<TInitial | null>;
  onClose: () => void;
  enabled?: boolean;
};

type ModalEntry = {
  container: HTMLElement;
  onClose: () => void;
  restoreFocus: HTMLElement | null;
  removeTemporaryTabIndex: boolean;
};

const modalStack: ModalEntry[] = [];
let bodyOverflowBeforeLock: string | null = null;
const isolatedBackground = new Map<HTMLElement, {
  inert: boolean;
  hadInertAttribute: boolean;
  ariaHidden: string | null;
}>();

export function useModalFocus<
  TContainer extends HTMLElement,
  TInitial extends HTMLElement = HTMLElement
>({
  containerRef,
  initialFocusRef,
  onClose,
  enabled = true
}: ModalFocusOptions<TContainer, TInitial>): void {
  const onCloseRef = useRef(onClose);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;

    const entry: ModalEntry = {
      container,
      onClose: () => onCloseRef.current(),
      restoreFocus: activeHtmlElement(),
      removeTemporaryTabIndex: false
    };
    registerModal(entry);

    if (topModal() === entry) {
      focusModal(entry, initialFocusRef?.current ?? null);
    }

    return () => unregisterModal(entry);
  }, [containerRef, enabled, initialFocusRef]);
}

export function getModalFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    isTabbable
  );
}

function registerModal(entry: ModalEntry): void {
  const wasEmpty = modalStack.length === 0;
  const firstDescendant = modalStack.findIndex((candidate) =>
    entry.container.contains(candidate.container)
  );
  if (firstDescendant >= 0) modalStack.splice(firstDescendant, 0, entry);
  else modalStack.push(entry);

  refreshBackgroundIsolation();

  if (!wasEmpty) return;
  bodyOverflowBeforeLock = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", handleDocumentKeyDown, true);
}

function unregisterModal(entry: ModalEntry): void {
  const index = modalStack.indexOf(entry);
  if (index < 0) return;

  const wasTop = index === modalStack.length - 1;
  propagateRestoreTarget(entry);
  modalStack.splice(index, 1);
  if (entry.removeTemporaryTabIndex) entry.container.removeAttribute("tabindex");
  refreshBackgroundIsolation();

  if (modalStack.length === 0) {
    document.removeEventListener("keydown", handleDocumentKeyDown, true);
    document.body.style.overflow = bodyOverflowBeforeLock ?? "";
    bodyOverflowBeforeLock = null;
  }

  if (!wasTop) return;
  const expectedTop = topModal();
  window.requestAnimationFrame(() => {
    if (topModal() !== expectedTop) return;
    restoreModalFocus(entry, expectedTop);
  });
}

function handleDocumentKeyDown(event: KeyboardEvent): void {
  const entry = topModal();
  if (!entry || event.isComposing) return;

  if (event.key === "Escape") {
    if (event.repeat) return;
    if (document.querySelector('[data-terminal-select-menu="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    entry.onClose();
    return;
  }

  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
  trapTabKey(event, entry);
}

function trapTabKey(event: KeyboardEvent, entry: ModalEntry): void {
  const focusable = getModalFocusableElements(entry.container);
  if (focusable.length === 0) {
    event.preventDefault();
    focusContainer(entry);
    return;
  }

  const active = activeHtmlElement();
  const activeIndex = active ? focusable.indexOf(active) : -1;
  const shouldWrapBackward = event.shiftKey && activeIndex <= 0;
  const shouldWrapForward = !event.shiftKey && activeIndex === focusable.length - 1;
  const focusIsOutside = !active || !entry.container.contains(active) || activeIndex < 0;
  if (!shouldWrapBackward && !shouldWrapForward && !focusIsOutside) return;

  event.preventDefault();
  event.stopPropagation();
  const target = event.shiftKey ? focusable[focusable.length - 1] : focusable[0];
  focusWithoutScroll(target);
}

function focusModal(entry: ModalEntry, preferred: HTMLElement | null): void {
  if (preferred && entry.container.contains(preferred) && canReceiveFocus(preferred)) {
    focusWithoutScroll(preferred);
    return;
  }

  const firstFocusable = getModalFocusableElements(entry.container)[0];
  if (firstFocusable) {
    focusWithoutScroll(firstFocusable);
    return;
  }
  focusContainer(entry);
}

function focusContainer(entry: ModalEntry): void {
  if (!entry.container.hasAttribute("tabindex")) {
    entry.container.setAttribute("tabindex", "-1");
    entry.removeTemporaryTabIndex = true;
  }
  focusWithoutScroll(entry.container);
}

function restoreModalFocus(entry: ModalEntry, nextTop: ModalEntry | undefined): void {
  const target = entry.restoreFocus;
  if (
    target?.isConnected &&
    canReceiveFocus(target) &&
    (!nextTop || nextTop.container.contains(target))
  ) {
    focusWithoutScroll(target);
    return;
  }
  if (nextTop) focusModal(nextTop, null);
}

function propagateRestoreTarget(entry: ModalEntry): void {
  for (const candidate of modalStack) {
    if (
      candidate !== entry &&
      entry.container.contains(candidate.container) &&
      (!candidate.restoreFocus || entry.container.contains(candidate.restoreFocus))
    ) {
      candidate.restoreFocus = entry.restoreFocus;
    }
  }
}

function topModal(): ModalEntry | undefined {
  return modalStack[modalStack.length - 1];
}

function refreshBackgroundIsolation(): void {
  for (const [element, previous] of isolatedBackground) {
    element.inert = previous.inert;
    if (!previous.hadInertAttribute) element.removeAttribute("inert");
    if (previous.ariaHidden === null) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", previous.ariaHidden);
  }
  isolatedBackground.clear();

  let current = topModal()?.container ?? null;
  while (current?.parentElement && current.parentElement !== document.body) {
    const parent = current.parentElement;
    for (const sibling of parent.children) {
      if (!(sibling instanceof HTMLElement) || sibling === current) continue;
      isolateElement(sibling);
    }
    current = parent;
  }

  if (current?.parentElement === document.body) {
    for (const sibling of document.body.children) {
      if (!(sibling instanceof HTMLElement) || sibling === current) continue;
      isolateElement(sibling);
    }
  }
}

function isolateElement(element: HTMLElement): void {
  if (!isolatedBackground.has(element)) {
    isolatedBackground.set(element, {
      inert: element.inert,
      hadInertAttribute: element.hasAttribute("inert"),
      ariaHidden: element.getAttribute("aria-hidden")
    });
  }
  element.inert = true;
  element.setAttribute("aria-hidden", "true");
}

function activeHtmlElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function isTabbable(element: HTMLElement): boolean {
  return element.tabIndex >= 0 && canReceiveFocus(element);
}

function canReceiveFocus(element: HTMLElement): boolean {
  if (!element.isConnected || element.matches(":disabled, [aria-disabled='true']")) return false;
  if (element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}

function focusWithoutScroll(element: HTMLElement): void {
  element.focus({ preventScroll: true });
}
