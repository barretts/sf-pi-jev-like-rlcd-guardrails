import { RefreshLoader } from "../src/refresh.js";

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;

const loader = new RefreshLoader<string>(
  async (_signal: AbortSignal) => "value",
);
type LoadInput = Assert<Equal<Parameters<typeof loader.load>, [AbortSignal]>>;
type LoadOutput = Assert<
  Equal<ReturnType<typeof loader.load>, Promise<string>>
>;
const value: Promise<string> = loader.load(new AbortController().signal);
void value;
