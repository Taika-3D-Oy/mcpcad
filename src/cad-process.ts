import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';

/**
 * Manages a long-running Python CadQuery subprocess.
 * Communicates via JSON-RPC over stdin/stdout.
 */
export class CadProcess {
    private process: ChildProcess | null = null;
    private pendingRequests = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void }>();
    private requestCounter = 0;
    private readyResolve!: () => void;
    private readyReject!: (err: Error) => void;
    private readyPromise: Promise<void>;

    constructor(private pythonExec: string, private serverScript: string) {
        this.readyPromise = new Promise((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
    }

    async start(): Promise<void> {
        this.process = spawn(this.pythonExec, [this.serverScript], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Read JSON lines from stdout
        const rl = readline.createInterface({ input: this.process.stdout! });
        rl.on('line', (line) => {
            let msg: any;
            try {
                msg = JSON.parse(line);
            } catch {
                console.error('[CadProcess] Failed to parse:', line);
                return;
            }

            // Handle the initial ready signal
            if (msg.id === '__ready__') {
                if (msg.error) {
                    this.readyReject(new Error(msg.error.message));
                } else {
                    this.readyResolve();
                }
                return;
            }

            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
                if (msg.error) {
                    pending.reject(msg.error);
                } else {
                    pending.resolve(msg.result);
                }
                this.pendingRequests.delete(msg.id);
            }
        });

        // Forward stderr as log lines
        const stderrRl = readline.createInterface({ input: this.process.stderr! });
        stderrRl.on('line', (line) => {
            console.log('[Python]', line);
        });

        this.process.on('exit', (code) => {
            console.error(`[CadProcess] Python exited with code ${code}`);
            for (const [, req] of this.pendingRequests) {
                req.reject({ message: 'Python process exited unexpectedly' });
            }
            this.pendingRequests.clear();
            this.process = null;
        });

        await this.readyPromise;
    }

    /** Send a JSON-RPC command to the Python process and await the response. */
    async send(method: string, params: any = {}): Promise<any> {
        if (!this.process || this.process.exitCode !== null) {
            throw new Error('Python CAD process is not running');
        }

        const id = `req_${++this.requestCounter}`;

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });

            const msg = JSON.stringify({ id, method, params }) + '\n';
            this.process!.stdin!.write(msg);

            // Timeout after 120s (CadQuery boolean ops can be slow)
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.get(id)!.reject(new Error('Python request timed out (120s)'));
                    this.pendingRequests.delete(id);
                }
            }, 120_000);
        });
    }

    get isRunning(): boolean {
        return this.process !== null && this.process.exitCode === null;
    }

    stop() {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
    }
}
