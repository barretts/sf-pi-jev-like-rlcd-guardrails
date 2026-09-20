export interface RequestSnapshot<T> {
  status: "idle" | "loading" | "ready" | "error";
  data: T | undefined;
  error: string | undefined;
}

export class LatestRequest<T> {
  private state: RequestSnapshot<T> = {
    status: "idle",
    data: undefined,
    error: undefined,
  };

  constructor(private readonly fetchValue: (key: string) => Promise<T>) {}

  read(): RequestSnapshot<T> {
    return { ...this.state };
  }

  async refresh(key: string): Promise<void> {
    this.state = { status: "loading", data: this.state.data, error: undefined };
    try {
      const data = await this.fetchValue(key);
      this.state = { status: "ready", data, error: undefined };
    } catch (reason) {
      this.state = {
        status: "error",
        data: this.state.data,
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
  }
}
