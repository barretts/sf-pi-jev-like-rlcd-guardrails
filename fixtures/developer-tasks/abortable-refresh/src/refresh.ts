export class RefreshLoader<T> {
  private inFlight: Promise<T> | undefined;

  constructor(
    private readonly fetchValue: (signal: AbortSignal) => Promise<T>,
  ) {}

  load(signal: AbortSignal): Promise<T> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchValue(signal).then((value) => {
      this.inFlight = undefined;
      return value;
    });
    return this.inFlight;
  }
}
