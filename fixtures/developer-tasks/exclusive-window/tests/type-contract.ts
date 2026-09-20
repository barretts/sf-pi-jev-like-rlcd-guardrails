import { pageWindow, type PageWindow } from "../src/window.js";

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;

type WindowShape = Assert<
  Equal<
    PageWindow<string>,
    {
      items: string[];
      start: number;
      endExclusive: number;
      hasMore: boolean;
    }
  >
>;
const rows: readonly string[] = Object.freeze(["one", "two"]);
const window = pageWindow(rows, 0, 1);
type WindowOutput = Assert<Equal<typeof window, PageWindow<string>>>;
void window;
