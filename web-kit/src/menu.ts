/**
 * 多層選單的純邏輯(FRONTEND-GUIDE.md §7.5、PRD §8.3.4):不依賴 Vue,可單元測試。
 *
 *   - 選單的名稱、圖示、路徑由各應用前端定義;可見與否只依權限代碼(Gateway 為唯一來源)。
 *   - 權限掛在實際頁面(有 path 的節點);中間的目錄層不設權限,底下有任一頁可見即顯示。層數不限。
 *   - 節點同時有 path 與 children 時:本身無權限仍可作為目錄顯示(移除 path),只要底下有可見頁面。
 */

export interface MenuNode {
  /** 同一應用內唯一 */
  key: string;
  title: string;
  subtitle?: string;
  icon?: string;
  /** 頁面路徑(SPA 內,不含 base);目錄層省略 */
  path?: string;
  /** 頁面的選單權限(kind = menu);省略 = 登入即可見 */
  permission?: string;
  /** 另外需要全部具備的權限(例如該頁讀取 API 的權限) */
  requires?: readonly string[];
  children?: readonly MenuNode[];
}

/** 過濾後的節點:children 一定存在,depth 從 0 起算 */
export interface VisibleMenuNode extends Omit<MenuNode, 'children'> {
  depth: number;
  children: VisibleMenuNode[];
}

/** 依權限過濾選單樹;沒有可見頁面的目錄一併移除 */
export function filterMenu(nodes: readonly MenuNode[], can: (code: string) => boolean, depth = 0): VisibleMenuNode[] {
  const out: VisibleMenuNode[] = [];
  for (const n of nodes) {
    const children = filterMenu(n.children ?? [], can, depth + 1);
    const allowed = (!n.permission || can(n.permission)) && (n.requires ?? []).every(can);
    const isPage = !!n.path && allowed;
    if (!isPage && !children.length) continue;
    const { children: _c, path, ...rest } = n;
    out.push({ ...rest, ...(isPage ? { path } : {}), depth, children });
  }
  return out;
}

/** path 是否落在選單路徑內('/' 只比對自己) */
export function pathMatches(menuPath: string, path: string): boolean {
  if (menuPath === '/') return path === '/';
  return path === menuPath || path.startsWith(`${menuPath}/`);
}

/** 目前路徑所在的節點鏈(根 → 頁面),以最長的路徑前綴為準;找不到回空陣列。可用於麵包屑與自動展開 */
export function findTrail(nodes: readonly VisibleMenuNode[], path: string): VisibleMenuNode[] {
  let best: VisibleMenuNode[] = [];
  let bestLen = -1;
  const walk = (list: readonly VisibleMenuNode[], trail: VisibleMenuNode[]) => {
    for (const n of list) {
      const next = [...trail, n];
      if (n.path && pathMatches(n.path, path) && n.path.length > bestLen) {
        best = next;
        bestLen = n.path.length;
      }
      walk(n.children, next);
    }
  };
  walk(nodes, []);
  return best;
}

/** 依展開狀態攤平成清單列(只含可看到的列),適合以單層 v-for 繪製 */
export function flattenMenu(nodes: readonly VisibleMenuNode[], isOpen: (key: string) => boolean): VisibleMenuNode[] {
  const out: VisibleMenuNode[] = [];
  const walk = (list: readonly VisibleMenuNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.children.length && isOpen(n.key)) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** 所有節點的 key(檢查重複、預設全展開時使用) */
export function menuKeys(nodes: readonly MenuNode[]): string[] {
  return nodes.flatMap((n) => [n.key, ...menuKeys(n.children ?? [])]);
}
