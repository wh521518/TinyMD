import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import type { Ctx } from "@milkdown/kit/ctx";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import { blockConfig } from "@milkdown/kit/plugin/block";
import {
  blockquoteSchema,
  bulletListSchema,
  codeBlockSchema,
  headingSchema,
  listItemSchema,
  orderedListSchema,
  paragraphSchema,
  setBlockTypeCommand,
  wrapInBlockTypeCommand,
} from "@milkdown/kit/preset/commonmark";
import { lift } from "@milkdown/kit/prose/commands";
import type { Node as ProseNode, NodeType, ResolvedPos } from "@milkdown/prose/model";
import { NodeSelection, TextSelection } from "@milkdown/prose/state";
import { dropPoint } from "@milkdown/prose/transform";
import type { EditorView } from "@milkdown/prose/view";

type ActiveBlockNode = Readonly<{
  $pos: ResolvedPos;
  node: ProseNode;
  el: HTMLElement;
}>;

type FilterNodes = (pos: ResolvedPos, node: ProseNode) => boolean;

type BlockDropPlacement = Readonly<{
  insertPos: number;
  lineLeft: number;
  lineTop: number;
  lineWidth: number;
}>;

type PointerDragState = {
  lastX: number;
  lastY: number;
  placement: BlockDropPlacement | null;
  pointerId: number;
  source: ActiveBlockNode;
  started: boolean;
  startX: number;
  startY: number;
};

type FormatMenuAction = Readonly<{
  destructive?: boolean;
  icon: string;
  key: string;
  label: string;
  run?: (ctx: Ctx) => void;
}>;

type FormatMenuGroup = Readonly<{
  actions: readonly FormatMenuAction[];
  key: string;
  label: string;
}>;

const REMOVE_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      d="M7.31 20.5a1.74 1.74 0 0 1-1.28-.53 1.74 1.74 0 0 1-.53-1.28V6H5.25a.72.72 0 0 1-.53-.22.72.72 0 0 1-.22-.53c0-.2.07-.38.22-.53a.72.72 0 0 1 .53-.22H9c0-.24.09-.45.26-.63.17-.17.38-.26.63-.26h4.23c.25 0 .46.09.63.26.17.18.26.39.26.63h3.75c.2 0 .38.07.53.22.14.15.22.33.22.53 0 .21-.08.39-.22.54a.72.72 0 0 1-.53.21h-.25v12.69c0 .5-.18.92-.53 1.28-.35.35-.77.53-1.28.53Zm9.69-14.5H7v12.69c0 .09.03.16.09.22.06.05.13.08.22.08h9.38c.09 0 .16-.03.22-.08.06-.06.09-.13.09-.22Zm-6.85 11a.72.72 0 0 0 .53-.22.72.72 0 0 0 .22-.53V8.75a.72.72 0 0 0-.22-.53.72.72 0 0 0-.53-.22.72.72 0 0 0-.54.22.72.72 0 0 0-.21.53v7.5c0 .2.07.38.22.53.14.15.32.22.53.22Zm3.69 0a.72.72 0 0 0 .53-.22.72.72 0 0 0 .22-.53V8.75a.72.72 0 0 0-.22-.53.72.72 0 0 0-.54-.22.72.72 0 0 0-.53.22.72.72 0 0 0-.22.53v7.5c0 .2.07.38.22.53.15.15.33.22.54.22Z"
    />
  </svg>
`;

const TEXT_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <g clip-path="url(#tinymd_menu_text)">
      <path d="M5 5.5C5 6.33 5.67 7 6.5 7H10.5V17.5C10.5 18.33 11.17 19 12 19C12.83 19 13.5 18.33 13.5 17.5V7H17.5C18.33 7 19 6.33 19 5.5C19 4.67 18.33 4 17.5 4H6.5C5.67 4 5 4.67 5 5.5Z" />
    </g>
    <defs>
      <clipPath id="tinymd_menu_text">
        <rect width="24" height="24" />
      </clipPath>
    </defs>
  </svg>
`;

const H1_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <g clip-path="url(#tinymd_menu_h1)">
      <path d="M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM19 19H5V5H19V19ZM12 17H14V7H10V9H12V17Z" />
    </g>
    <defs>
      <clipPath id="tinymd_menu_h1">
        <rect width="24" height="24" />
      </clipPath>
    </defs>
  </svg>
`;

const H2_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <g clip-path="url(#tinymd_menu_h2)">
      <path d="M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM19 19H5V5H19V19ZM15 15H11V13H13C14.1 13 15 12.11 15 11V9C15 7.89 14.1 7 13 7H9V9H13V11H11C9.9 11 9 11.89 9 13V17H15V15Z" />
    </g>
    <defs>
      <clipPath id="tinymd_menu_h2">
        <rect width="24" height="24" />
      </clipPath>
    </defs>
  </svg>
`;

const H3_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <g clip-path="url(#tinymd_menu_h3)">
      <path d="M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM19 19H5V5H19V19ZM15 15V13.5C15 12.67 14.33 12 13.5 12C14.33 12 15 11.33 15 10.5V9C15 7.89 14.1 7 13 7H9V9H13V11H11V13H13V15H9V17H13C14.1 17 15 16.11 15 15Z" />
    </g>
    <defs>
      <clipPath id="tinymd_menu_h3">
        <rect width="24" height="24" />
      </clipPath>
    </defs>
  </svg>
`;

const H4_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <g clip-path="url(#tinymd_menu_h4)">
      <path d="M19.04 3H5.04004C3.94004 3 3.04004 3.9 3.04004 5V19C3.04004 20.1 3.94004 21 5.04004 21H19.04C20.14 21 21.04 20.1 21.04 19V5C21.04 3.9 20.14 3 19.04 3ZM19.04 19H5.04004V5H19.04V19ZM13.04 17H15.04V7H13.04V11H11.04V7H9.04004V13H13.04V17Z" />
    </g>
    <defs>
      <clipPath id="tinymd_menu_h4">
        <rect width="24" height="24" />
      </clipPath>
    </defs>
  </svg>
`;

const H5_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <g clip-path="url(#tinymd_menu_h5)">
      <path d="M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM19 19H5V5H19V19ZM15 15V13C15 11.89 14.1 11 13 11H11V9H15V7H9V13H13V15H9V17H13C14.1 17 15 16.11 15 15Z" />
    </g>
    <defs>
      <clipPath id="tinymd_menu_h5">
        <rect width="24" height="24" />
      </clipPath>
    </defs>
  </svg>
`;

const H6_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <g clip-path="url(#tinymd_menu_h6)">
      <path d="M11 17H13C14.1 17 15 16.11 15 15V13C15 11.89 14.1 11 13 11H11V9H15V7H11C9.9 7 9 7.89 9 9V15C9 16.11 9.9 17 11 17ZM11 13H13V15H11V13ZM19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM19 19H5V5H19V19Z" />
    </g>
    <defs>
      <clipPath id="tinymd_menu_h6">
        <rect width="24" height="24" />
      </clipPath>
    </defs>
  </svg>
`;

const QUOTE_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <g clip-path="url(#tinymd_menu_quote)">
      <path d="M7.17 17C7.68 17 8.15 16.71 8.37 16.26L9.79 13.42C9.93 13.14 10 12.84 10 12.53V8C10 7.45 9.55 7 9 7H5C4.45 7 4 7.45 4 8V12C4 12.55 4.45 13 5 13H7L5.97 15.06C5.52 15.95 6.17 17 7.17 17ZM17.17 17C17.68 17 18.15 16.71 18.37 16.26L19.79 13.42C19.93 13.14 20 12.84 20 12.53V8C20 7.45 19.55 7 19 7H15C14.45 7 14 7.45 14 8V12C14 12.55 14.45 13 15 13H17L15.97 15.06C15.52 15.95 16.17 17 17.17 17Z" />
    </g>
    <defs>
      <clipPath id="tinymd_menu_quote">
        <rect width="24" height="24" />
      </clipPath>
    </defs>
  </svg>
`;

const CODE_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <g clip-path="url(#tinymd_menu_code)">
      <path d="M9.4 16.6L4.8 12L9.4 7.4L8 6L2 12L8 18L9.4 16.6ZM14.6 16.6L19.2 12L14.6 7.4L16 6L22 12L16 18L14.6 16.6Z" />
    </g>
    <defs>
      <clipPath id="tinymd_menu_code">
        <rect width="24" height="24" />
      </clipPath>
    </defs>
  </svg>
`;

const BULLET_LIST_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <g clip-path="url(#tinymd_menu_bullet_list)">
      <path d="M4 10.5C3.17 10.5 2.5 11.17 2.5 12C2.5 12.83 3.17 13.5 4 13.5C4.83 13.5 5.5 12.83 5.5 12C5.5 11.17 4.83 10.5 4 10.5ZM4 4.5C3.17 4.5 2.5 5.17 2.5 6C2.5 6.83 3.17 7.5 4 7.5C4.83 7.5 5.5 6.83 5.5 6C5.5 5.17 4.83 4.5 4 4.5ZM4 16.5C3.17 16.5 2.5 17.18 2.5 18C2.5 18.82 3.18 19.5 4 19.5C4.82 19.5 5.5 18.82 5.5 18C5.5 17.18 4.83 16.5 4 16.5ZM8 19H20C20.55 19 21 18.55 21 18C21 17.45 20.55 17 20 17H8C7.45 17 7 17.45 7 18C7 18.55 7.45 19 8 19ZM8 13H20C20.55 13 21 12.55 21 12C21 11.45 20.55 11 20 11H8C7.45 11 7 11.45 7 12C7 12.55 7.45 13 8 13ZM7 6C7 6.55 7.45 7 8 7H20C20.55 7 21 6.55 21 6C21 5.45 20.55 5 20 5H8C7.45 5 7 5.45 7 6Z" />
    </g>
    <defs>
      <clipPath id="tinymd_menu_bullet_list">
        <rect width="24" height="24" />
      </clipPath>
    </defs>
  </svg>
`;

const ORDERED_LIST_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <g clip-path="url(#tinymd_menu_ordered_list)">
      <path d="M8 7H20C20.55 7 21 6.55 21 6C21 5.45 20.55 5 20 5H8C7.45 5 7 5.45 7 6C7 6.55 7.45 7 8 7ZM20 17H8C7.45 17 7 17.45 7 18C7 18.55 7.45 19 8 19H20C20.55 19 21 18.55 21 18C21 17.45 20.55 17 20 17ZM20 11H8C7.45 11 7 11.45 7 12C7 12.55 7.45 13 8 13H20C20.55 13 21 12.55 21 12C21 11.45 20.55 11 20 11ZM4.5 16H2.5C2.22 16 2 16.22 2 16.5C2 16.78 2.22 17 2.5 17H4V17.5H3.5C3.22 17.5 3 17.72 3 18C3 18.28 3.22 18.5 3.5 18.5H4V19H2.5C2.22 19 2 19.22 2 19.5C2 19.78 2.22 20 2.5 20H4.5C4.78 20 5 19.78 5 19.5V16.5C5 16.22 4.78 16 4.5 16ZM2.5 5H3V7.5C3 7.78 3.22 8 3.5 8C3.78 8 4 7.78 4 7.5V4.5C4 4.22 3.78 4 3.5 4H2.5C2.22 4 2 4.22 2 4.5C2 4.78 2.22 5 2.5 5ZM4.5 10H2.5C2.22 10 2 10.22 2 10.5C2 10.78 2.22 11 2.5 11H3.8L2.12 12.96C2.04 13.05 2 13.17 2 13.28V13.5C2 13.78 2.22 14 2.5 14H4.5C4.78 14 5 13.78 5 13.5C5 13.22 4.78 13 4.5 13H3.2L4.88 11.04C4.96 10.95 5 10.83 5 10.72V10.5C5 10.22 4.78 10 4.5 10Z" />
    </g>
    <defs>
      <clipPath id="tinymd_menu_ordered_list">
        <rect width="24" height="24" />
      </clipPath>
    </defs>
  </svg>
`;

const TODO_LIST_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <path d="M5.66936 16.3389L9.39244 12.6158C9.54115 12.4671 9.71679 12.3937 9.91936 12.3957C10.1219 12.3976 10.2975 12.4761 10.4463 12.6312C10.5847 12.7823 10.654 12.9585 10.654 13.1599C10.654 13.3613 10.5847 13.5363 10.4463 13.6851L6.32704 17.8197C6.14627 18.0004 5.93538 18.0908 5.69436 18.0908C5.45333 18.0908 5.24243 18.0004 5.06166 17.8197L3.01744 15.7754C2.87899 15.637 2.81136 15.4629 2.81456 15.2533C2.81776 15.0437 2.88859 14.8697 3.02706 14.7312C3.16551 14.5928 3.34008 14.5235 3.55076 14.5235C3.76144 14.5235 3.93494 14.5928 4.07126 14.7312L5.66936 16.3389ZM5.66936 8.72359L9.39244 5.00049C9.54115 4.85177 9.71679 4.77838 9.91936 4.78031C10.1219 4.78223 10.2975 4.86075 10.4463 5.01586C10.5847 5.16691 10.654 5.34314 10.654 5.54454C10.654 5.74592 10.5847 5.92097 10.4463 6.06969L6.32704 10.2043C6.14627 10.3851 5.93538 10.4755 5.69436 10.4755C5.45333 10.4755 5.24243 10.3851 5.06166 10.2043L3.01744 8.16009C2.87899 8.02162 2.81136 7.84759 2.81456 7.63799C2.81776 7.42837 2.88859 7.25433 3.02706 7.11586C3.16551 6.97741 3.34008 6.90819 3.55076 6.90819C3.76144 6.90819 3.93494 6.97741 4.07126 7.11586L5.66936 8.72359ZM13.7597 16.5581C13.5472 16.5581 13.3691 16.4862 13.2253 16.3424C13.0816 16.1986 13.0097 16.0204 13.0097 15.8078C13.0097 15.5952 13.0816 15.4171 13.2253 15.2735C13.3691 15.13 13.5472 15.0582 13.7597 15.0582H20.7597C20.9722 15.0582 21.1503 15.1301 21.2941 15.2739C21.4378 15.4177 21.5097 15.5959 21.5097 15.8085C21.5097 16.0211 21.4378 16.1992 21.2941 16.3427C21.1503 16.4863 20.9722 16.5581 20.7597 16.5581H13.7597ZM13.7597 8.94276C13.5472 8.94276 13.3691 8.87085 13.2253 8.72704C13.0816 8.58324 13.0097 8.40504 13.0097 8.19244C13.0097 7.97985 13.0816 7.80177 13.2253 7.65819C13.3691 7.5146 13.5472 7.44281 13.7597 7.44281H20.7597C20.9722 7.44281 21.1503 7.51471 21.2941 7.65851C21.4378 7.80233 21.5097 7.98053 21.5097 8.19311C21.5097 8.40571 21.4378 8.5838 21.2941 8.72739C21.1503 8.87097 20.9722 8.94276 20.7597 8.94276H13.7597Z" />
  </svg>
`;

const DEFAULT_FILTER_NODES: FilterNodes = (_pos, node) => {
  return !["table", "blockquote", "math_inline"].includes(node.type.name);
};

const POINTER_DRAG_THRESHOLD_PX = 4;
const EDGE_AUTO_SCROLL_BUFFER_PX = 40;
const EDGE_AUTO_SCROLL_STEP_PX = 18;
const MENU_OFFSET_PX = 10;

const FORMAT_MENU_GROUPS: readonly FormatMenuGroup[] = [
  {
    key: "text",
    label: "Text",
    actions: [
      {
        key: "paragraph",
        label: "Text",
        icon: TEXT_ICON,
        run: (ctx) => {
          ctx.get(commandsCtx).call(setBlockTypeCommand.key, {
            nodeType: paragraphSchema.type(ctx),
          });
        },
      },
      ...[1, 2, 3, 4, 5, 6].map(
        (level) =>
          ({
            key: `heading-${level}`,
            label: `Heading ${level}`,
            icon: [H1_ICON, H2_ICON, H3_ICON, H4_ICON, H5_ICON, H6_ICON][level - 1]!,
            run: (ctx: Ctx) => {
              ctx.get(commandsCtx).call(setBlockTypeCommand.key, {
                nodeType: headingSchema.type(ctx),
                attrs: { level },
              });
            },
          }) satisfies FormatMenuAction,
      ),
      {
        key: "blockquote",
        label: "Quote",
        icon: QUOTE_ICON,
        run: (ctx) => {
          ctx.get(commandsCtx).call(wrapInBlockTypeCommand.key, {
            nodeType: blockquoteSchema.type(ctx),
          });
        },
      },
      {
        key: "code-block",
        label: "Code",
        icon: CODE_ICON,
        run: (ctx) => {
          ctx.get(commandsCtx).call(setBlockTypeCommand.key, {
            nodeType: codeBlockSchema.type(ctx),
          });
        },
      },
    ],
  },
  {
    key: "list",
    label: "List",
    actions: [
      {
        key: "bullet-list",
        label: "Bullet List",
        icon: BULLET_LIST_ICON,
        run: (ctx) => {
          ctx.get(commandsCtx).call(wrapInBlockTypeCommand.key, {
            nodeType: bulletListSchema.type(ctx),
          });
        },
      },
      {
        key: "ordered-list",
        label: "Ordered List",
        icon: ORDERED_LIST_ICON,
        run: (ctx) => {
          ctx.get(commandsCtx).call(wrapInBlockTypeCommand.key, {
            nodeType: orderedListSchema.type(ctx),
          });
        },
      },
      {
        key: "task-list",
        label: "Task List",
        icon: TODO_LIST_ICON,
        run: (ctx) => {
          ctx.get(commandsCtx).call(wrapInBlockTypeCommand.key, {
            nodeType: listItemSchema.type(ctx),
            attrs: { checked: false },
          });
        },
      },
    ],
  },
] as const;

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

const getAncestorBlockNode = (
  view: EditorView,
  $pos: ResolvedPos,
  typeName: string,
): ActiveBlockNode | null => {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const ancestor = $pos.node(depth);
    if (ancestor.type.name !== typeName) {
      continue;
    }

    const ancestorPos = $pos.before(depth);
    const element = view.nodeDOM(ancestorPos) as HTMLElement | null;
    if (!element) {
      continue;
    }

    return {
      $pos: view.state.doc.resolve(ancestorPos),
      node: ancestor,
      el: element,
    };
  }

  return null;
};

const getTopLevelBlockNodeAtIndex = (
  view: EditorView,
  index: number,
): ActiveBlockNode | null => {
  const { doc } = view.state;
  if (index < 0 || index >= doc.childCount) {
    return null;
  }

  let pos = 0;
  for (let offsetIndex = 0; offsetIndex < index; offsetIndex += 1) {
    pos += doc.child(offsetIndex).nodeSize;
  }

  const node = doc.child(index);
  const element = view.nodeDOM(pos) as HTMLElement | null;
  if (!element) {
    return null;
  }

  return {
    $pos: doc.resolve(pos),
    node,
    el: element,
  };
};

const getEdgeBlockNodeByCoords = (
  view: EditorView,
  coords: { y: number },
): ActiveBlockNode | null => {
  const firstBlock = getTopLevelBlockNodeAtIndex(view, 0);
  const lastBlock = getTopLevelBlockNodeAtIndex(view, view.state.doc.childCount - 1);

  if (firstBlock) {
    const firstRect = firstBlock.el.getBoundingClientRect();
    if (coords.y <= firstRect.top) {
      return firstBlock;
    }
  }

  if (lastBlock) {
    const lastRect = lastBlock.el.getBoundingClientRect();
    if (coords.y >= lastRect.bottom) {
      return lastBlock;
    }
  }

  return null;
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
      return getEdgeBlockNodeByCoords(view, coords);
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

    if (node.type.name === "attachment") {
      const listItemNode = getAncestorBlockNode(view, $pos, "list_item");
      if (listItemNode) {
        return listItemNode;
      }
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
  readonly #dropIndicator: HTMLDivElement;
  #active: ActiveBlockNode | null = null;
  #handle: HTMLDivElement | null = null;
  #trigger: HTMLDivElement | null = null;
  #observer: MutationObserver | null = null;
  #rootObserver: MutationObserver | null = null;
  #menuOpen = false;
  #destroyed = false;
  #syncFrame: number | null = null;
  #pointerDrag: PointerDragState | null = null;
  #suppressTriggerClick = false;

  constructor(ctx: Ctx) {
    this.#ctx = ctx;
    this.#view = ctx.get(editorViewCtx);
    this.#root = this.#view.dom.parentElement ?? this.#view.dom;
    this.#levelIndicator = document.createElement("span");
    this.#levelIndicator.className = "custom-block-handle__level";
    this.#levelIndicator.hidden = true;

    this.#menu = document.createElement("div");
    this.#menu.className = "milkdown-slash-menu custom-block-handle__menu";
    this.#menu.dataset.show = "false";
    this.#menu.hidden = true;
    this.#menu.style.position = "fixed";

    this.#dropIndicator = document.createElement("div");
    this.#dropIndicator.className = "custom-block-handle__drop-indicator";
    this.#dropIndicator.hidden = true;

    this.#menu.addEventListener("mousedown", this.#stopMenuPointer);
    this.#menu.addEventListener("pointerdown", this.#stopMenuPointer);
    this.#renderMenu();

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

    this.#teardownPointerDrag();
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
    this.#rootObserver?.disconnect();
    this.#rootObserver = null;

    this.#closeMenu();
    this.#unbindHandle();
    this.#dropIndicator.remove();
  };

  readonly #stopMenuPointer = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  readonly #handleTriggerContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    if (!this.#active) {
      this.#syncActive();
    }

    if (!this.#active || this.#pointerDrag?.started) {
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

  readonly #handleTriggerPointerDown = (event: PointerEvent) => {
    if (
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }

    if (!this.#active) {
      this.#syncActive();
    }

    const active = this.#active;
    if (!active) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.#closeMenu();

    this.#teardownPointerDrag();
    this.#pointerDrag = {
      pointerId: event.pointerId,
      source: active,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      started: false,
      placement: null,
    };

    this.#trigger?.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", this.#handleWindowPointerMove, true);
    window.addEventListener("pointerup", this.#handleWindowPointerUp, true);
    window.addEventListener("pointercancel", this.#handleWindowPointerCancel, true);
  };

  readonly #handleTriggerClick = (event: MouseEvent) => {
    if (event.button !== 0) {
      return;
    }

    if (this.#suppressTriggerClick) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.#toggleMenu();
  };

  readonly #handleWindowPointerMove = (event: PointerEvent) => {
    const pointerDrag = this.#pointerDrag;
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) {
      return;
    }

    pointerDrag.lastX = event.clientX;
    pointerDrag.lastY = event.clientY;

    if (!pointerDrag.started) {
      const deltaX = event.clientX - pointerDrag.startX;
      const deltaY = event.clientY - pointerDrag.startY;
      if (Math.hypot(deltaX, deltaY) < POINTER_DRAG_THRESHOLD_PX) {
        return;
      }

      this.#startPointerDrag(pointerDrag);
    }

    event.preventDefault();
    event.stopPropagation();
    this.#updatePointerDrag(pointerDrag);
  };

  readonly #handleWindowPointerUp = (event: PointerEvent) => {
    const pointerDrag = this.#pointerDrag;
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) {
      return;
    }

    const shouldCommit = pointerDrag.started;
    if (pointerDrag.started) {
      event.preventDefault();
      event.stopPropagation();
    }

    this.#finishPointerDrag(shouldCommit);
  };

  readonly #handleWindowPointerCancel = (event: PointerEvent) => {
    const pointerDrag = this.#pointerDrag;
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) {
      return;
    }

    this.#finishPointerDrag(false);
  };

  readonly #handleDocumentPointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (
      target instanceof Node &&
      ((this.#handle && this.#handle.contains(target)) ||
        this.#menu.contains(target))
    ) {
      return;
    }

    this.#closeMenu();
  };

  readonly #handleDocumentKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") {
      return;
    }

    if (this.#pointerDrag?.started) {
      event.preventDefault();
      event.stopPropagation();
      this.#finishPointerDrag(false);
      return;
    }

    this.#closeMenu();
  };

  readonly #handleSelectionChange = () => {
    if (this.#pointerDrag?.started) {
      return;
    }

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
    if (this.#pointerDrag?.started) {
      this.#updatePointerDrag(this.#pointerDrag);
      return;
    }

    if (this.#menuOpen) {
      this.#positionMenu();
      return;
    }

    this.#queueSync();
  };

  readonly #handleWindowResize = () => {
    if (this.#pointerDrag?.started) {
      this.#updatePointerDrag(this.#pointerDrag);
      return;
    }

    if (this.#menuOpen) {
      this.#positionMenu();
      return;
    }

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
    this.#handle.dataset.pointerDragging = "false";

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
    this.#trigger.draggable = false;
    this.#trigger.prepend(this.#levelIndicator);

    if (!this.#menu.isConnected) {
      this.#root.append(this.#menu);
    }

    this.#trigger.addEventListener("pointerdown", this.#handleTriggerPointerDown);
    this.#trigger.addEventListener("click", this.#handleTriggerClick);
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
      this.#trigger.removeEventListener("pointerdown", this.#handleTriggerPointerDown);
      this.#trigger.removeEventListener("click", this.#handleTriggerClick);
      this.#trigger.removeEventListener(
        "contextmenu",
        this.#handleTriggerContextMenu,
      );
      this.#trigger.draggable = false;
      this.#trigger.classList.remove("custom-block-handle__trigger");
    }

    if (this.#handle) {
      this.#handle.classList.remove("custom-block-handle");
      this.#handle.dataset.menuOpen = "false";
      this.#handle.dataset.pointerDragging = "false";
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

      if (this.#menuOpen) {
        if (!this.#handle || !this.#trigger) {
          this.#closeMenu();
          return;
        }

        this.#positionMenu();
        return;
      }

      this.#syncActive();
    });
  };

  #syncActive = () => {
    if (this.#pointerDrag?.started) {
      return;
    }

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

    if (this.#menuOpen) {
      this.#positionMenu();
    }
  };

  #openMenu = () => {
    if (!this.#handle || this.#pointerDrag?.started) {
      return;
    }

    this.#menuOpen = true;
    this.#menu.hidden = false;
    this.#menu.dataset.show = "true";
    this.#handle.dataset.menuOpen = "true";
    this.#positionMenu();
  };

  #closeMenu = () => {
    this.#menuOpen = false;
    this.#menu.hidden = true;
    this.#menu.dataset.show = "false";
    if (this.#handle) {
      this.#handle.dataset.menuOpen = "false";
    }
  };

  #toggleMenu = () => {
    if (this.#menuOpen) {
      this.#closeMenu();
      return;
    }

    const active = this.#active;
    if (!active) {
      return;
    }

    const selectionPos = this.#getStyleSelectionPos(active);
    if (selectionPos == null) {
      return;
    }

    if (!this.#view.hasFocus()) {
      this.#view.focus();
    }

    try {
      const resolvedPos = this.#view.state.doc.resolve(selectionPos);
      this.#view.dispatch(
        this.#view.state.tr
          .setSelection(TextSelection.near(resolvedPos))
          .scrollIntoView(),
      );
    } catch {
      return;
    }

    this.#openMenu();
  };

  #positionMenu = () => {
    const trigger = this.#trigger;
    if (!this.#menuOpen || !trigger) {
      return;
    }

    void computePosition(trigger, this.#menu, {
      strategy: "fixed",
      placement: "bottom-start",
      middleware: [flip(), shift({ padding: 12 }), offset(MENU_OFFSET_PX)],
    })
      .then(({ x, y }) => {
        Object.assign(this.#menu.style, {
          left: `${Math.round(x)}px`,
          top: `${Math.round(y)}px`,
        });
      })
      .catch(console.error);
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

  #startPointerDrag = (pointerDrag: PointerDragState) => {
    pointerDrag.started = true;
    this.#active = pointerDrag.source;
    this.#closeMenu();
    this.#handle?.setAttribute("data-pointer-dragging", "true");
    pointerDrag.source.el.classList.add("custom-block-handle__drag-source");
    document.body.classList.add("custom-block-handle--dragging");

    if (!this.#view.hasFocus()) {
      this.#view.focus();
    }

    if (NodeSelection.isSelectable(pointerDrag.source.node)) {
      this.#view.dispatch(
        this.#view.state.tr.setSelection(
          NodeSelection.create(this.#view.state.doc, pointerDrag.source.$pos.pos),
        ),
      );
    }
  };

  #finishPointerDrag = (commit: boolean) => {
    const pointerDrag = this.#pointerDrag;
    if (!pointerDrag) {
      return;
    }

    const shouldSuppressClick = pointerDrag.started;
    if (commit && pointerDrag.started && pointerDrag.placement) {
      this.#moveActiveBlock(pointerDrag.source, pointerDrag.placement.insertPos);
    }

    this.#teardownPointerDrag();

    if (shouldSuppressClick) {
      this.#suppressTriggerClick = true;
      window.setTimeout(() => {
        this.#suppressTriggerClick = false;
      }, 0);
    }

    this.#queueSync();
  };

  #teardownPointerDrag = () => {
    const pointerDrag = this.#pointerDrag;
    if (pointerDrag && this.#trigger?.hasPointerCapture?.(pointerDrag.pointerId)) {
      this.#trigger.releasePointerCapture(pointerDrag.pointerId);
    }

    window.removeEventListener("pointermove", this.#handleWindowPointerMove, true);
    window.removeEventListener("pointerup", this.#handleWindowPointerUp, true);
    window.removeEventListener("pointercancel", this.#handleWindowPointerCancel, true);
    this.#handle?.setAttribute("data-pointer-dragging", "false");
    pointerDrag?.source.el.classList.remove("custom-block-handle__drag-source");
    document.body.classList.remove("custom-block-handle--dragging");
    this.#hideDropIndicator();
    this.#pointerDrag = null;
  };

  #renderMenu = () => {
    const menuGroups: readonly FormatMenuGroup[] = [
      ...FORMAT_MENU_GROUPS,
      {
        key: "actions",
        label: "Actions",
        actions: [
          {
            key: "delete",
            label: "Delete",
            icon: REMOVE_ICON,
            destructive: true,
          },
        ],
      },
    ];

    const tabs = document.createElement("nav");
    tabs.className = "tab-group";

    const tabList = document.createElement("ul");
    tabs.append(tabList);

    const groupsRoot = document.createElement("div");
    groupsRoot.className = "menu-groups";

    const selectGroup = (groupKey: string) => {
      const tabItems = Array.from(tabList.querySelectorAll<HTMLLIElement>("li"));
      for (const tabItem of tabItems) {
        tabItem.classList.toggle("selected", tabItem.dataset.group === groupKey);
      }
    };

    for (const [index, group] of menuGroups.entries()) {
      const tabItem = document.createElement("li");
      tabItem.dataset.group = group.key;
      tabItem.textContent = group.label;
      if (index === 0) {
        tabItem.classList.add("selected");
      }

      const groupElement = document.createElement("div");
      groupElement.className = "menu-group";
      groupElement.dataset.group = group.key;

      const heading = document.createElement("h6");
      heading.textContent = group.label;
      groupElement.append(heading);

      const list = document.createElement("ul");

      for (const action of group.actions) {
        const item = document.createElement("li");
        item.dataset.action = action.key;
        if (action.destructive) {
          item.classList.add("custom-block-handle__menu-item--danger");
        }

        const icon = document.createElement("span");
        icon.className = "custom-block-handle__menu-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = action.icon;

        const label = document.createElement("span");
        label.textContent = action.label;

        item.append(icon, label);
        item.addEventListener("pointerenter", () => {
          item.classList.add("hover");
          selectGroup(group.key);
        });
        item.addEventListener("pointerleave", () => {
          item.classList.remove("hover");
          item.classList.remove("active");
        });
        item.addEventListener("pointerdown", () => {
          item.classList.add("active");
          selectGroup(group.key);
        });
        item.addEventListener("pointerup", (event) => {
          event.preventDefault();
          item.classList.remove("active");
          this.#runMenuAction(action);
        });
        list.append(item);
      }

      tabItem.addEventListener("pointerdown", () => {
        selectGroup(group.key);
        groupsRoot.scrollTop = groupElement.offsetTop - groupsRoot.offsetTop;
      });

      groupElement.append(list);
      tabList.append(tabItem);
      groupsRoot.append(groupElement);
    }

    this.#menu.replaceChildren(tabs, groupsRoot);
  };

  #runMenuAction = (action: FormatMenuAction) => {
    const active = this.#active;
    if (!active) {
      return;
    }

    if (action.key === "delete") {
      this.#deleteActiveBlock();
      return;
    }

    if (!this.#focusStyleSelection(active)) {
      this.#closeMenu();
      return;
    }

    this.#applyFormatAction(action.key);
    this.#closeMenu();
    this.#queueSync();
  };

  #focusStyleSelection = (active: ActiveBlockNode) => {
    const selectionPos = this.#getStyleSelectionPos(active);
    if (selectionPos == null) {
      return false;
    }

    try {
      const resolvedPos = this.#view.state.doc.resolve(selectionPos);
      this.#view.dispatch(
        this.#view.state.tr.setSelection(TextSelection.near(resolvedPos)),
      );
      return true;
    } catch {
      return false;
    }
  };

  #applyFormatAction = (actionKey: string) => {
    const ctx = this.#ctx;

    const normalize = () => {
      this.#liftSelectionOutOfContainers();
      this.#setCurrentBlockType(paragraphSchema.type(ctx));
    };

    switch (actionKey) {
      case "paragraph":
        normalize();
        return;
      case "heading-1":
      case "heading-2":
      case "heading-3":
      case "heading-4":
      case "heading-5":
      case "heading-6": {
        normalize();
        const parts = actionKey.split("-");
        const level = Number(parts[parts.length - 1] ?? 0);
        if (level >= 1 && level <= 6) {
          this.#setCurrentBlockType(headingSchema.type(ctx), { level });
        }
        return;
      }
      case "blockquote":
        normalize();
        this.#wrapCurrentBlock(blockquoteSchema.type(ctx));
        return;
      case "code-block":
        normalize();
        this.#setCurrentBlockType(codeBlockSchema.type(ctx));
        return;
      case "bullet-list":
        normalize();
        this.#wrapCurrentBlock(bulletListSchema.type(ctx));
        return;
      case "ordered-list":
        normalize();
        this.#wrapCurrentBlock(orderedListSchema.type(ctx));
        return;
      case "task-list":
        normalize();
        this.#wrapCurrentBlock(listItemSchema.type(ctx), { checked: false });
        return;
      default:
        return;
    }
  };

  #liftSelectionOutOfContainers = () => {
    for (let attempts = 0; attempts < 8; attempts += 1) {
      const lifted = lift(this.#view.state, (tr) => {
        this.#view.dispatch(tr);
      });

      if (!lifted) {
        return;
      }
    }
  };

  #setCurrentBlockType = (
    nodeType: NodeType,
    attrs?: Record<string, unknown>,
  ) => {
    this.#ctx.get(commandsCtx).call(setBlockTypeCommand.key, {
      nodeType,
      attrs: attrs ?? null,
    });
  };

  #wrapCurrentBlock = (nodeType: NodeType, attrs?: Record<string, unknown>) => {
    this.#ctx.get(commandsCtx).call(wrapInBlockTypeCommand.key, {
      nodeType,
      attrs: attrs ?? null,
    });
  };

  #getStyleSelectionPos = (active: ActiveBlockNode) => {
    if (active.node.isTextblock) {
      return active.$pos.pos + active.node.content.size;
    }

    let textBlockPos: number | null = null;
    active.node.descendants((node, pos) => {
      if (!node.isTextblock) {
        return true;
      }

      textBlockPos = active.$pos.pos + 1 + pos + node.content.size;
      return false;
    });

    return textBlockPos;
  };

  #updatePointerDrag = (pointerDrag: PointerDragState) => {
    this.#maybeAutoScroll(pointerDrag.lastY);

    const placement = this.#resolveDropPlacement(
      pointerDrag.source,
      pointerDrag.lastX,
      pointerDrag.lastY,
    );
    pointerDrag.placement = placement;

    if (!placement) {
      this.#hideDropIndicator();
      return;
    }

    this.#showDropIndicator(placement);
  };

  #resolveDropPlacement = (
    source: ActiveBlockNode,
    clientX: number,
    clientY: number,
  ): BlockDropPlacement | null => {
    if (!NodeSelection.isSelectable(source.node)) {
      return null;
    }

    const editorRect = this.#view.dom.getBoundingClientRect();
    if (editorRect.width <= 0 || editorRect.height <= 0) {
      return null;
    }

    const probeX = Math.min(
      Math.max(clientX, editorRect.left + 24),
      editorRect.right - 24,
    );
    const target = selectRootNodeByCoords(this.#ctx, {
      x: probeX,
      y: clientY,
    });

    if (!target) {
      return null;
    }

    const sourceFrom = source.$pos.pos;
    const sourceTo = sourceFrom + source.node.nodeSize;
    const targetRect = target.el.getBoundingClientRect();
    const beforeTarget = clientY <= targetRect.top + targetRect.height / 2;
    const anchorPos = beforeTarget
      ? target.$pos.pos
      : target.$pos.pos + target.node.nodeSize;

    if (anchorPos === sourceFrom || anchorPos === sourceTo) {
      return null;
    }

    const sourceSelection = NodeSelection.create(this.#view.state.doc, sourceFrom);
    const slice = sourceSelection.content();
    const insertPos = dropPoint(this.#view.state.doc, anchorPos, slice);
    if (insertPos == null || insertPos === sourceFrom || insertPos === sourceTo) {
      return null;
    }

    const lineLeft = Math.max(targetRect.left, editorRect.left);
    const lineRight = Math.max(
      lineLeft + 36,
      Math.min(targetRect.right, editorRect.right),
    );

    return {
      insertPos,
      lineLeft,
      lineTop: beforeTarget ? targetRect.top : targetRect.bottom,
      lineWidth: lineRight - lineLeft,
    };
  };

  #showDropIndicator = (placement: BlockDropPlacement) => {
    if (!this.#dropIndicator.isConnected) {
      document.body.append(this.#dropIndicator);
    }

    this.#dropIndicator.hidden = false;
    this.#dropIndicator.style.left = `${Math.round(placement.lineLeft)}px`;
    this.#dropIndicator.style.top = `${Math.round(placement.lineTop)}px`;
    this.#dropIndicator.style.width = `${Math.round(placement.lineWidth)}px`;
  };

  #hideDropIndicator = () => {
    this.#dropIndicator.hidden = true;
  };

  #moveActiveBlock = (source: ActiveBlockNode, insertPos: number) => {
    if (!NodeSelection.isSelectable(source.node)) {
      return;
    }

    const { state } = this.#view;
    const sourcePos = source.$pos.pos;
    const selection = NodeSelection.create(state.doc, sourcePos);
    const slice = selection.content();
    const nextInsertPos = dropPoint(state.doc, insertPos, slice);
    if (
      nextInsertPos == null ||
      nextInsertPos === sourcePos ||
      nextInsertPos === sourcePos + source.node.nodeSize
    ) {
      return;
    }

    let tr = state.tr.setSelection(selection);
    tr.deleteSelection();

    const mappedInsertPos = tr.mapping.map(nextInsertPos);
    if (slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1) {
      const node = slice.content.firstChild;
      if (!node) {
        return;
      }

      tr.replaceRangeWith(mappedInsertPos, mappedInsertPos, node);
      if (tr.doc.eq(state.doc)) {
        return;
      }

      if (NodeSelection.isSelectable(node)) {
        tr = tr.setSelection(NodeSelection.create(tr.doc, mappedInsertPos));
      } else {
        const nextPos = Math.min(
          Math.max(mappedInsertPos + 1, 0),
          tr.doc.content.size,
        );
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(nextPos)));
      }
    } else {
      tr.replaceRange(mappedInsertPos, mappedInsertPos, slice);
      if (tr.doc.eq(state.doc)) {
        return;
      }

      const nextPos = Math.min(
        Math.max(mappedInsertPos + 1, 0),
        tr.doc.content.size,
      );
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(nextPos)));
    }

    this.#view.dispatch(tr.scrollIntoView());
  };

  #maybeAutoScroll = (clientY: number) => {
    const scrollContainer = this.#getScrollContainer();
    if (!scrollContainer) {
      return;
    }

    const rect = scrollContainer.getBoundingClientRect();
    let delta = 0;

    if (clientY < rect.top + EDGE_AUTO_SCROLL_BUFFER_PX) {
      delta = -EDGE_AUTO_SCROLL_STEP_PX;
    } else if (clientY > rect.bottom - EDGE_AUTO_SCROLL_BUFFER_PX) {
      delta = EDGE_AUTO_SCROLL_STEP_PX;
    }

    if (delta !== 0) {
      scrollContainer.scrollTop += delta;
    }
  };

  #getScrollContainer = () => {
    let element = this.#view.dom.parentElement;
    while (element) {
      const style = window.getComputedStyle(element);
      const canScroll =
        /(auto|scroll)/.test(style.overflowY) &&
        element.scrollHeight > element.clientHeight;
      if (canScroll) {
        return element;
      }
      element = element.parentElement;
    }

    return null;
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
