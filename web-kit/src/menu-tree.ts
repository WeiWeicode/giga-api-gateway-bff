/**
 * 多層側邊選單(FRONTEND-GUIDE.md §7.5、PRD §8.3.4):依 /api/auth/me 的 permissions 過濾,層數不限。
 *
 *   const { menu, trail, crumbs, isOpen, toggle } = useMenuTree(MENU, { storageKey: 'portal.menu.open' })
 *   <GnMenuTree :nodes="menu" :is-open="isOpen" :trail="trail" @toggle="toggle">
 *     <template #item="{ node, open, active, toggle }"> …自訂外觀… </template>
 *   </GnMenuTree>
 *
 * 元件不帶樣式:輸出 <ul class="gn-menu"> / <li class="gn-menu__node is-open is-active is-in-trail has-children">,
 * 縮排用 CSS 變數 --gn-depth;外觀由各應用以 class 或 #item slot 自訂。
 */
import { computed, defineComponent, h, ref, toValue, watch, type MaybeRefOrGetter, type PropType, type VNode } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { useAuth } from './auth';
import { filterMenu, findTrail, flattenMenu, menuKeys, type MenuNode, type VisibleMenuNode } from './menu';

export interface MenuTreeOptions {
  /** 目前路徑;預設為 vue-router 的 route.path */
  path?: () => string;
  /** 以 localStorage 保存展開狀態的鍵(各應用不同);省略則不保存 */
  storageKey?: string;
  /** 初始展開:'trail' = 只展開目前頁面所在路徑(預設)、'all' = 全部展開 */
  defaultOpen?: 'trail' | 'all';
}

function readKeys(key?: string): string[] | null {
  if (!key) return null;
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

type BffMenu = { name: string; sort: number | null; icon: string | null } | undefined;

/** 節點的名稱、圖示、同層順序以 BFF 為準(GigaItApp「選單管理」可改);沒有時用前端定義 */
function withNames(nodes: readonly MenuNode[], menuOf: (code: string | undefined) => BffMenu): MenuNode[] {
  const order = new Map(nodes.map((n, i) => [n.key, i]));
  const sortOf = (n: MenuNode) => menuOf(n.permission ?? n.code)?.sort ?? null;
  return nodes
    .map((n) => {
      const m = menuOf(n.permission ?? n.code);
      return { ...n, title: m?.name ?? n.title, icon: m?.icon ?? n.icon, ...(n.children ? { children: withNames(n.children, menuOf) } : {}) };
    })
    .sort((a, b) => {
      const sa = sortOf(a);
      const sb = sortOf(b);
      // 兩者都有 BFF 排序時依排序,否則維持前端定義的順序
      return sa !== null && sb !== null && sa !== sb ? sa - sb : order.get(a.key)! - order.get(b.key)!;
    });
}

export function useMenuTree(defs: MaybeRefOrGetter<readonly MenuNode[]>, opts: MenuTreeOptions = {}) {
  const { permissions, menuOf } = useAuth();
  const route = opts.path ? null : useRoute();
  const path = opts.path ?? (() => route!.path);

  const menu = computed(() => {
    const have = new Set(permissions.value);
    return filterMenu(withNames(toValue(defs), menuOf), (c) => have.has(c));
  });
  const trail = computed(() => findTrail(menu.value, path()));
  /** 麵包屑:根 → 目前頁面的標題 */
  const crumbs = computed(() => trail.value.map((n) => n.title));
  const active = computed(() => trail.value.at(-1) ?? null);

  const saved = readKeys(opts.storageKey);
  const openKeys = ref<Set<string>>(new Set(saved ?? (opts.defaultOpen === 'all' ? menuKeys(toValue(defs)) : [])));
  const save = () => {
    if (!opts.storageKey) return;
    try {
      localStorage.setItem(opts.storageKey, JSON.stringify([...openKeys.value]));
    } catch {
      /* 無法保存時只影響下次開啟 */
    }
  };
  // 換頁時展開目前頁面所在的目錄(不收合其他已展開的)
  watch(
    trail,
    (t) => {
      const missing = t.filter((n) => n.children.length && !openKeys.value.has(n.key));
      if (!missing.length) return;
      openKeys.value = new Set([...openKeys.value, ...missing.map((n) => n.key)]);
      save();
    },
    { immediate: true },
  );

  const isOpen = (key: string) => openKeys.value.has(key);
  function toggle(key: string, open?: boolean) {
    const s = new Set(openKeys.value);
    if (open ?? !s.has(key)) s.add(key);
    else s.delete(key);
    openKeys.value = s;
    save();
  }
  /** 依展開狀態攤平的列,適合不想用遞迴元件、自行以單層 v-for 繪製時使用 */
  const rows = computed(() => flattenMenu(menu.value, isOpen));

  return { menu, trail, crumbs, active, rows, openKeys, isOpen, toggle };
}

export interface MenuItemSlotProps {
  node: VisibleMenuNode;
  open: boolean;
  /** 目前頁面 */
  active: boolean;
  /** 目前頁面或其上層目錄 */
  inTrail: boolean;
  hasChildren: boolean;
  toggle: () => void;
}

/** 遞迴選單元件(不帶樣式);#item slot 可自訂每一列的內容 */
export const GnMenuTree = defineComponent({
  name: 'GnMenuTree',
  props: {
    nodes: {
      type: Array as PropType<readonly VisibleMenuNode[]>,
      required: true,
    },
    isOpen: {
      type: Function as PropType<(key: string) => boolean>,
      required: true,
    },
    /** useMenuTree 的 trail:標示目前頁面與其上層 */
    trail: {
      type: Array as PropType<readonly VisibleMenuNode[]>,
      default: () => [],
    },
    /** 內部遞迴用:是否為最外層 */
    root: { type: Boolean, default: true },
  },
  emits: { toggle: (key: string) => typeof key === 'string' },
  setup(props, { emit, slots }) {
    const trailKeys = computed(() => new Set(props.trail.map((n) => n.key)));
    const activeKey = computed(() => props.trail.at(-1)?.key ?? null);

    const defaultItem = (p: MenuItemSlotProps): VNode =>
      p.node.path
        ? h(
            RouterLink,
            {
              to: p.node.path,
              class: 'gn-menu__link',
              'aria-current': p.active ? 'page' : undefined,
            },
            () => p.node.title,
          )
        : h(
            'button',
            {
              type: 'button',
              class: 'gn-menu__toggle',
              'aria-expanded': p.open,
              onClick: p.toggle,
            },
            p.node.title,
          );

    return (): VNode =>
      h(
        'ul',
        {
          class: ['gn-menu', props.root ? 'gn-menu--root' : 'gn-menu--sub'],
          role: props.root ? 'tree' : 'group',
        },
        props.nodes.map((node) => {
          const hasChildren = node.children.length > 0;
          const open = hasChildren && props.isOpen(node.key);
          const slotProps: MenuItemSlotProps = {
            node,
            open,
            active: activeKey.value === node.key,
            inTrail: trailKeys.value.has(node.key),
            hasChildren,
            toggle: () => emit('toggle', node.key),
          };
          return h(
            'li',
            {
              key: node.key,
              role: 'treeitem',
              'aria-expanded': hasChildren ? open : undefined,
              class: [
                'gn-menu__node',
                {
                  'is-open': open,
                  'is-active': slotProps.active,
                  'is-in-trail': slotProps.inTrail,
                  'has-children': hasChildren,
                },
              ],
              style: { '--gn-depth': node.depth },
            },
            [
              slots.item ? slots.item(slotProps) : defaultItem(slotProps),
              open
                ? h(
                    GnMenuTree,
                    {
                      nodes: node.children,
                      isOpen: props.isOpen,
                      trail: props.trail,
                      root: false,
                      onToggle: (k: string) => emit('toggle', k),
                    },
                    slots.item ? { item: slots.item } : undefined,
                  )
                : null,
            ],
          );
        }),
      );
  },
});
