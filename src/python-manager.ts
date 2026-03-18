import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import * as os from 'os';

export class PythonManager {
    private envPath: string;
    private pythonExec: string;

    constructor(private context: vscode.ExtensionContext) {
        this.envPath = path.join(this.context.globalStorageUri.fsPath, 'mcpcad_venv');
        this.pythonExec = os.platform() === 'win32'
            ? path.join(this.envPath, 'Scripts', 'python.exe')
            : path.join(this.envPath, 'bin', 'python');
    }

    public getPythonExecutable(): string {
        return this.pythonExec;
    }

    public async isReady(): Promise<boolean> {
        try {
            await fs.access(this.pythonExec);
            // Verify CadQuery is installed
            const isInstalled = await this.execCommand(`"${this.pythonExec}" -c "import cadquery"`);
            return isInstalled.exitCode === 0;
        } catch {
            return false;
        }
    }

    public async setupEnvironment(): Promise<void> {
        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "McpCAD Viewer",
            cancellable: false
        }, async (progress) => {
            progress.report({ message: "Checking for Python..." });

            // Ensure storage directory exists
            await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true });

            const systemPython = await this.findSystemPython();
            if (!systemPython) {
                vscode.window.showErrorMessage("Python 3.8+ is required but was not found on your system. Please install Python to use this extension.");
                throw new Error("Python not found");
            }

            // Create venv if not exists
            try {
                await fs.access(this.pythonExec);
            } catch {
                progress.report({ message: `Creating virtual environment in ${this.envPath}...` });
                await this.execCommand(`"${systemPython}" -m venv "${this.envPath}"`);
            }

            progress.report({ message: "Installing CadQuery (this may take a minute)..." });
            const pipExec = os.platform() === 'win32'
                ? path.join(this.envPath, 'Scripts', 'pip.exe')
                : path.join(this.envPath, 'bin', 'pip');

            // Upgrade pip
            await this.execCommand(`"${this.pythonExec}" -m pip install --upgrade pip`);

            // Install CadQuery
            const res = await this.execCommand(`"${pipExec}" install cadquery`);
            if (res.exitCode !== 0) {
                vscode.window.showErrorMessage(`Failed to install CadQuery: ${res.stderr}`);
                throw new Error("CadQuery installation failed.");
            }

            progress.report({ message: "Setup complete!" });
        });
    }

    private async findSystemPython(): Promise<string | null> {
        const candidates = os.platform() === 'win32' ? ['python', 'py'] : ['python3', 'python'];
        for (const cmd of candidates) {
            try {
                const res = await this.execCommand(`${cmd} --version`);
                if (res.exitCode === 0 && res.stdout.toLowerCase().includes('python 3.')) {
                    // Check version is >= 3.8 just to be safe (CadQuery requirement)
                    const match = res.stdout.match(/Python 3\.(\d+)/i);
                    if (match && parseInt(match[1]) >= 8) {
                        return cmd;
                    }
                }
            } catch {
                continue;
            }
        }
        return null;
    }

    private execCommand(command: string): Promise<{ stdout: string, stderr: string, exitCode: number }> {
        return new Promise((resolve) => {
            exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
                resolve({
                    stdout,
                    stderr,
                    exitCode: error ? error.code || 1 : 0
                });
            });
        });
    }
}
