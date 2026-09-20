import { LatestRequest, type RequestSnapshot } from "../src/latest.js";

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;

type SnapshotShape = Assert<
  Equal<
    RequestSnapshot<string>,
    {
      status: "idle" | "loading" | "ready" | "error";
      data: string | undefined;
      error: string | undefined;
    }
  >
>;
const request = new LatestRequest<string>(async (_key: string) => "value");
type RefreshInput = Assert<Equal<Parameters<typeof request.refresh>, [string]>>;
type RefreshOutput = Assert<
  Equal<ReturnType<typeof request.refresh>, Promise<void>>
>;
type ReadOutput = Assert<
  Equal<ReturnType<typeof request.read>, RequestSnapshot<string>>
>;
void request;
