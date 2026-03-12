import type { Ctx } from "@milkdown/kit/ctx";
import { editorViewCtx } from "@milkdown/kit/core";
import { blockConfig } from "@milkdown/kit/plugin/block";
import { paragraphSchema } from "@milkdown/kit/preset/commonmark";
import type { Node as ProseNode, ResolvedPos } from "@milkdown/prose/model";
import { NodeSelection, TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";

type ActiveBlockNode = Readonly<{
  $pos: ResolvedPos;
  node: ProseNode;
  el: HTMLElement;
}>;

type FilterNodes = (pos: ResolvedPos, node: ProseNode) => boolean;

const REMOVE_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      d="M7.31 20.5a1.74 1.74 0 0 1-1.28-.53 1.74 1.74 0 0 1-.53-1.28V6H5.25a.72.72 0 0 1-.53-.22.72.72 0 0 1-.22-.53c0-.2.07-.38.22-.53a.72.72 0 0 1 .53-.22H9c0-.24.09-.45.26-.63.17-.17.38-.26.63-.26h4.23c.25 0 .46.09.63.26.17.18.26.39.26.63h3.75c.2 0 .38.07.53.22.14.15.22.33.22.53 0 .21-.08.39-.22.54a.72.72 0 0 1-.53.21h-.25v12.69c0 .5-.18.92-.53 1.28-.35.35-.77.53-1.28.53Zm9.69-14.5H7v12.69c0 .09.03.16.09.22.06.05.13.08.22.08h9.38c.09 0 .16-.03.22-.08.06-.06.09-.13.09-.22Zm-6.85 11a.72.72 0 0 0 .53-.22.72.72 0 0 0 .22-.53V8.75a.72.72 0 0 0-.22-.53.72.72 0 0 0-.53-.22.72.72 0 0 0-.54.22.72.72 0 0 0-.21.53v7.5c0 .2.07.38.22.53.14.15.32.22.53.22Zm3.69 0a.72.72 0 0 0 .53-.22.72.72 0 0 0 .22-.53V8.75a.72.72 0 0 0-.22-.53.72.72 0 0 0-.54-.22.72.72 0 0 0-.53.22.72.72 0 0 0-.22.53v7.5c0 .2.07.38.22.53.15.15.33.22.54.22Z"
    />
  </svg>
`;

const DEFAULT_FILTER_NODES: FilterNodes = (_pos, node) => {
  return !["table", "blockquote", "math_inline"].includes(node.type.name);
};

const isHeadingNode = (node: ProseNode) => node.type.name === "heading";

const getHeadingLevel = (node: ProseNode | null) => {
  if (!node || !isHeadingNode(node)) {
    return null;
  }

  const level = Number(node.attrs.level ?? 0);
  return level >= 1 && level <= 6 ? level : null;
};

const getFilterNodes = (ctx: Ctx) => {
  try {
    return ctx.get(blockConfig.key).filterNodes ?? DEFAULT_FILTER_NODES;
  } catch {
    return DEFAULT_FILTER_NODES;
  }
};

const selectRootNodeByCoords = (
  ctx: Ctx,
  coords: { x: number; y: number },
): ActiveBlockNode | null => {
  const view = ctx.get(editorViewCtx);
  const filterNodes = getFilterNodes(ctx);

  try {
    const pos = view.posAtCoords({
      left: coords.x,
      top: coords.y,
    })?.inside;

    if (pos == null || pos < 0) {
      return null;
    }

    let $pos = view.state.doc.resolve(pos);
    let node = view.state.doc.nodeAt(pos);
    let element = view.nodeDOM(pos) as HTMLElement | null;

    const lookupParent = (force: boolean) => {
      const checkDepth = $pos.depth >= 1 && $pos.index($pos.depth) === 0;
      const shouldLookUp = force || checkDepth;

      if (!shouldLookUp) {
        return;
      }

      const ancestorPos = $pos.before($pos.depth);
      node = view.state.doc.nodeAt(ancestorPos);
      element = view.nodeDOM(ancestorPos) as HTMLElement | null;
      $pos = view.state.doc.resolve(ancestorPos);

      if (node && !filterNodes($pos, node)) {
        lookupParent(true);
      }
    };

    if (!node) {
      return null;
    }

    lookupParent(!filterNodes($pos, node));

    if (!node || !element) {
      return null;
    }

    return { $pos, node, el: element };
  } catch {
    return null;
  }
};

export class CustomBlockHandle {
  readonly #ctx: Ctx;
  readonly #view: EditorView;
  readonly #root: HTMLElement;
  readonly #levelIndicator: HTMLSpanElement;
  readonly #menu: HTMLDivElement;
  readonly #deleteButton: HTMLButtonElement;
  #active: ActiveBlockNode | null = null;
  #handle: HTMLDivElement | null = null;
  #trigger: HTMLDivElement | null = null;
  #observer: MutationObserver | null = null;
  #rootObserver: MutationObserver | null = null;
  #menuOpen = false;
  #destroyed = false;
  #syncFrame: number | null = null;

  constructor(ctx: Ctx) {
    this.#ctx = ctx;
    this.#view = ctx.get(editorViewCtx);
    this.#root = this.#view.dom.parentElement ?? this.#view.dom;
    this.#levelIndicator = document.createElement("span");
    this.#levelIndicator.className = "custom-block-handle__level";
    this.#levelIndicator.hidden = true;

    this.#menu = document.createElement("div");
    this.#menu.className = "custom-block-handle__menu";
    this.#menu.hidden = true;

    this.#deleteButton = document.createElement("button");
    this.#deleteButton.type = "button";
    this.#deleteButton.className = "custom-block-handle__menu-item";
    this.#deleteButton.innerHTML = `
      <span class="custom-block-handle__menu-icon" aria-hidden="true">${REMOVE_ICON}</span>
      <span>删除</span>
    `;

    this.#menu.append(this.#deleteButton);
    this.#menu.addEventListener("mousedown", this.#stopMenuPointer);
    this.#menu.addEventListener("pointerdown", this.#stopMenuPointer);
    this.#deleteButton.addEventListener("click", this.#handleDeleteClick);

    document.addEventListener("pointerdown", this.#handleDocumentPointerDown, true);
    document.addEventListener("keydown", this.#handleDocumentKeyDown, true);
    document.addEventListener("selectionchange", this.#handleSelectionChange);
    document.addEventListener("scroll", this.#handleDocumentScroll, true);
    window.addEventListener("resize", this.#handleWindowResize);
    this.#view.dom.addEventListener("focus", this.#queueSyncFromEvent, true);
    this.#view.dom.addEventListener("pointerup", this.#queueSyncFromEvent, true);
    this.#view.dom.addEventListener("keyup", this.#queueSyncFromEvent, true);

    this.#rootObserver = new MutationObserver(() => {
      this.#bindHandle();
      this.#queueSync();
    });
    this.#rootObserver.observe(this.#root, {
      childList: true,
      subtree: true,
    });

    this.update();
  }

  update = () => {
    if (this.#destroyed) {
      return;
    }

    this.#bindHandle();
    this.#queueSync();
  };

  destroy = () => {
    this.#destroyed = true;

    if (this.#syncFrame !== null) {
      window.cancelAnimationFrame(this.#syncFrame);
      this.#syncFrame = null;
    }

    this.#view.dom.removeEventListener("focus", this.#queueSyncFromEvent, true);
    this.#view.dom.removeEventListener("pointerup", this.#queueSyncFromEvent, true);
    this.#view.dom.removeEventListener("keyup", this.#queueSyncFromEvent, true);
    document.removeEventListener(
      "pointerdown",
      this.#handleDocumentPointerDown,
      true,
    );
    document.removeEventListener("keydown", this.#handleDocumentKeyDown, true);
    document.removeEventListener("selectionchange", this.#handleSelectionChange);
    document.removeEventListener("scroll", this.#handleDocumentScroll, true);
    window.removeEventListener("resize", this.#handleWindowResize);

    this.#menu.removeEventListener("mousedown", this.#stopMenuPointer);
    this.#menu.removeEventListener("pointerdown", this.#stopMenuPointer);
    this.#deleteButton.removeEventListener("click", this.#handleDeleteClick);
    this.#rootObserver?.disconnect();
    this.#rootObserver = null;

    this.#closeMenu();
    this.#unbindHandle();
  };

  readonly #stopMenuPointer = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  readonly #handleDeleteClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    this.#deleteActiveBlock();
  };

  readonly #handleTriggerContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    if (!this.#active) {
      this.#syncActive();
    }

    if (!this.#active) {
      return;
    }

    if (!this.#view.hasFocus()) {
      this.#view.focus();
    }

    if (this.#menuOpen) {
      this.#closeMenu();
      return;
    }

    this.#openMenu();
  };

  readonly #handleDragStart = (event: DragEvent) => {
    this.#closeMenu();

    if (!this.#active) {
      this.#syncActive();
    }

    const active = this.#active;
    if (!active || !event.dataTransfer) {
      return;
    }

    try {
      const selection = NodeSelection.create(this.#view.state.doc, active.$pos.pos);
      this.#view.dispatch(this.#view.state.tr.setSelection(selection));

      const slice = selection.content();
      const { dom, text } = this.#view.serializeForClipboard(slice);
      event.dataTransfer.effectAllowed = "copyMove";
      event.dataTransfer.clearData();
      event.dataTransfer.setData("text/html", dom.innerHTML);
      event.dataTransfer.setData("text/plain", text);
      event.dataTransfer.setDragImage(active.el, 0, 0);
      this.#view.dragging = {
        slice,
        move: true,
      };
    } catch {
      // Let Milkdown's own drag handler continue if node selection cannot be created.
    }
  };

  readonly #handleDocumentPointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (
      target instanceof Node &&
      ((this.#handle && this.#handle.contains(target)) || this.#menu.contains(target))
    ) {
      return;
    }

    this.#closeMenu();
  };

  readonly #handleDocumentKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      this.#closeMenu();
    }
  };

  readonly #handleSelectionChange = () => {
    const selection = document.getSelection();
    if (!selection) {
      return;
    }

    const anchorNode = selection.anchorNode;
    if (
      anchorNode instanceof Node &&
      !this.#view.dom.contains(anchorNode) &&
      !this.#root.contains(anchorNode)
    ) {
      return;
    }

    this.#queueSync();
  };

  readonly #handleDocumentScroll = () => {
    this.#closeMenu();
    this.#queueSync();
  };

  readonly #handleWindowResize = () => {
    this.#closeMenu();
    this.#queueSync();
  };

  readonly #queueSyncFromEvent = () => {
    this.#queueSync();
  };

  #bindHandle = () => {
    const nextHandle =
      this.#root.querySelector<HTMLDivElement>(".milkdown-block-handle") ?? null;

    if (!nextHandle) {
      this.#unbindHandle();
      return;
    }

    if (this.#handle === nextHandle) {
      return;
    }

    this.#unbindHandle();
    this.#handle = nextHandle;
    this.#handle.classList.add("custom-block-handle");

    const operationItems = Array.from(
      this.#handle.querySelectorAll<HTMLDivElement>(".operation-item"),
    );

    const addButton = operationItems[0] ?? null;
    const trigger = operationItems[1] ?? null;

    if (addButton) {
      addButton.classList.add("custom-block-handle__add");
    }

    if (!trigger) {
      return;
    }

    this.#trigger = trigger;
    this.#trigger.classList.add("custom-block-handle__trigger");
    this.#trigger.prepend(this.#levelIndicator);

    if (!this.#menu.isConnected) {
      this.#handle.append(this.#menu);
    }

    this.#handle.addEventListener("dragstart", this.#handleDragStart);
    this.#trigger.addEventListener("contextmenu", this.#handleTriggerContextMenu);

    this.#observer = new MutationObserver(() => {
      this.#queueSync();
    });
    this.#observer.observe(this.#handle, {
      attributes: true,
      attributeFilter: ["style", "data-show"],
      childList: true,
      subtree: true,
    });
  };

  #unbindHandle = () => {
    this.#observer?.disconnect();
    this.#observer = null;

    if (this.#trigger) {
      this.#trigger.removeEventListener(
        "contextmenu",
        this.#handleTriggerContextMenu,
      );
      this.#trigger.classList.remove("custom-block-handle__trigger");
    }

    if (this.#handle) {
      this.#handle.removeEventListener("dragstart", this.#handleDragStart);
      this.#handle.classList.remove("custom-block-handle");
      this.#handle.dataset.menuOpen = "false";
    }

    const addButton = this.#handle?.querySelector<HTMLDivElement>(
      ".custom-block-handle__add",
    );
    addButton?.classList.remove("custom-block-handle__add");

    this.#levelIndicator.remove();
    this.#menu.remove();

    this.#handle = null;
    this.#trigger = null;
  };

  #queueSync = () => {
    if (this.#destroyed || this.#syncFrame !== null) {
      return;
    }

    this.#syncFrame = window.requestAnimationFrame(() => {
      this.#syncFrame = null;
      this.#syncActive();
    });
  };

  #syncActive = () => {
    const handle = this.#handle;
    if (!handle || handle.dataset.show !== "true") {
      this.#active = null;
      this.#syncIndicator(null);
      this.#closeMenu();
      return;
    }

    const nextActive = selectRootNodeByCoords(this.#ctx, {
      x: handle.getBoundingClientRect().right + 32,
      y:
        handle.getBoundingClientRect().top +
        handle.getBoundingClientRect().height / 2,
    });

    if (!nextActive) {
      this.#active = null;
      this.#syncIndicator(null);
      this.#closeMenu();
      return;
    }

    if (this.#active?.$pos.pos !== nextActive.$pos.pos) {
      this.#closeMenu();
    }

    this.#active = nextActive;
    this.#syncIndicator(nextActive.node);
  };

  #openMenu = () => {
    if (!this.#handle) {
      return;
    }

    this.#menuOpen = true;
    this.#handle.dataset.menuOpen = "true";
    this.#menu.hidden = false;
  };

  #closeMenu = () => {
    if (this.#handle) {
      this.#handle.dataset.menuOpen = "false";
    }

    this.#menuOpen = false;
    this.#menu.hidden = true;
  };

  #syncIndicator = (node: ProseNode | null) => {
    const level = getHeadingLevel(node);

    if (level === null) {
      this.#levelIndicator.hidden = true;
      this.#levelIndicator.textContent = "";
      return;
    }

    this.#levelIndicator.hidden = false;
    this.#levelIndicator.textContent = `H${level}`;
  };

  #deleteActiveBlock = () => {
    const active = this.#active;
    if (!active) {
      return;
    }

    if (!this.#view.hasFocus()) {
      this.#view.focus();
    }

    const from = active.$pos.pos;
    const to = from + active.node.nodeSize;

    try {
      let tr = this.#view.state.tr.deleteRange(from, to);
      const nextPos = Math.min(Math.max(from, 0), tr.doc.content.size);
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(nextPos)));
      this.#view.dispatch(tr.scrollIntoView());
    } catch {
      const paragraph = paragraphSchema.type(this.#ctx).create();
      let tr = this.#view.state.tr.replaceWith(from, to, paragraph);
      const nextPos = Math.min(Math.max(from + 1, 1), tr.doc.content.size);
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(nextPos)));
      this.#view.dispatch(tr.scrollIntoView());
    }

    this.#closeMenu();
  };
}
