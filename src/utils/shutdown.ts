export type ShutdownHook = () => Promise<void> | void;
type SignalName = "SIGINT" | "SIGTERM";

export interface ShutdownError {
  name: string;
  error: unknown;
}

export interface ShutdownResult {
  reason: string;
  errors: ShutdownError[];
}

export class ShutdownCoordinator {
  private readonly hooks: Array<{ name: string; hook: ShutdownHook }> = [];
  private shutdownPromise: Promise<ShutdownResult> | null = null;
  private signalHandlers: Partial<Record<SignalName, () => void>> = {};

  register(name: string, hook: ShutdownHook): void {
    this.hooks.push({ name, hook });
  }

  installSignalHandlers(onSignal: (signal: SignalName) => void): void {
    this.removeSignalHandlers();

    const sigint = () => onSignal("SIGINT");
    const sigterm = () => onSignal("SIGTERM");
    this.signalHandlers.SIGINT = sigint;
    this.signalHandlers.SIGTERM = sigterm;
    process.once("SIGINT", sigint);
    process.once("SIGTERM", sigterm);
  }

  removeSignalHandlers(): void {
    if (this.signalHandlers.SIGINT) {
      process.off("SIGINT", this.signalHandlers.SIGINT);
    }

    if (this.signalHandlers.SIGTERM) {
      process.off("SIGTERM", this.signalHandlers.SIGTERM);
    }

    this.signalHandlers = {};
  }

  async run(reason = "shutdown"): Promise<ShutdownResult> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.execute(reason);
    }

    return this.shutdownPromise;
  }

  private async execute(reason: string): Promise<ShutdownResult> {
    const errors: ShutdownError[] = [];

    for (const { name, hook } of [...this.hooks].reverse()) {
      try {
        await hook();
      } catch (error) {
        errors.push({ name, error });
      }
    }

    return { reason, errors };
  }
}

export async function closeHttpServer(server: {
  close: (cb: (error?: Error | null) => void) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
