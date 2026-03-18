import * as vscode from 'vscode';
import { McpCadServer, WebviewRequester } from './mcp-server';
import { PythonManager } from './python-manager';

class CadViewerRequester implements WebviewRequester, vscode.WebviewViewProvider {
    private currentWebview: vscode.Webview | undefined;
    private pendingRequests = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void }>();
    private requestCounter = 0;

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'resources'),
                vscode.Uri.joinPath(this.extensionUri, 'out')
            ]
        };
        webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);
        this.setWebview(webviewView.webview);
        webviewView.onDidDispose(() => {
            if (this.currentWebview === webviewView.webview) {
                this.currentWebview = undefined;
            }
        });
    }

    constructor(private extensionUri: vscode.Uri) { }

    setWebview(webview: vscode.Webview) {
        this.currentWebview = webview;
        webview.onDidReceiveMessage(message => {
            if (message.command === 'response') {
                const req = this.pendingRequests.get(message.requestId);
                if (req) {
                    if (message.error) { req.reject(new Error(message.error)); }
                    else { req.resolve(message.data); }
                    this.pendingRequests.delete(message.requestId);
                }
            }
        });
    }

    setPanel(panel: vscode.WebviewPanel) {
        this.setWebview(panel.webview);
        panel.onDidDispose(() => {
            if (this.currentWebview === panel.webview) { this.currentWebview = undefined; }
        });
    }

    async requestFromWebview(type: string, payload: any = {}): Promise<any> {
        if (!this.currentWebview) {
            await vscode.commands.executeCommand('mcpCadView.focus');
            await new Promise(r => setTimeout(r, 1000));
            if (!this.currentWebview) {
                throw new Error("Webview not active. Open the CAD Viewer panel.");
            }
        }
        const id = `req_${++this.requestCounter}_${Date.now()}`;
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            this.currentWebview!.postMessage({ command: 'request', requestId: id, type, payload });
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.get(id)?.reject(new Error("Webview request timed out"));
                    this.pendingRequests.delete(id);
                }
            }, 30000);
        });
    }
}

export async function activate(context: vscode.ExtensionContext) {
    const requester = new CadViewerRequester(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('mcpCadView', requester)
    );

    let disposable = vscode.commands.registerCommand('mcpcad.customViewer', () => {
        const panel = vscode.window.createWebviewPanel(
            'mcpcadViewport', 'McpCAD Viewport', vscode.ViewColumn.Two,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'resources'),
                    vscode.Uri.joinPath(context.extensionUri, 'out')
                ]
            },
        );
        panel.webview.html = getWebviewContent(panel.webview, context.extensionUri);
        requester.setPanel(panel);
    });
    context.subscriptions.push(disposable);

    // Setup Python
    const pyManager = new PythonManager(context);
    try {
        if (!(await pyManager.isReady())) { await pyManager.setupEnvironment(); }
    } catch (e: any) {
        vscode.window.showErrorMessage(`Python CAD setup failed: ${e.message}`);
        return;
    }

    // Start MCP Server (which also starts the Python CAD process)
    const mcpServer = new McpCadServer(requester, context.extensionUri, pyManager.getPythonExecutable());
    const mcpServerPortPromise = mcpServer.start();

    mcpServerPortPromise.then((port: number) => {
        vscode.window.showInformationMessage(`McpCAD Server running on http://localhost:${port}/sse`);
    });

    if ('lm' in vscode && (vscode.lm as any).registerMcpServerDefinitionProvider) {
        context.subscriptions.push(
            (vscode.lm as any).registerMcpServerDefinitionProvider('mcpcad-mcp', {
                async provideMcpServerDefinitions() {
                    const port = await mcpServerPortPromise;
                    return [
                        new (vscode as any).McpHttpServerDefinition(
                            "McpCAD Server",
                            vscode.Uri.parse(`http://localhost:${port}/sse`),
                            undefined,  // headers
                            "0.4.0"     // version
                        )
                    ];
                }
            })
        );
    }

    context.subscriptions.push({ dispose: () => { mcpServer.stop(); } });
}

export function deactivate() { }

// ── Webview HTML ────────────────────────────────────────────────

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'viewer.js'));

    return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; script-src ${webview.cspSource} 'unsafe-eval'; style-src ${webview.cspSource} 'unsafe-inline';">
    <title>McpCAD Viewer</title>
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body, html { width: 100%; height: 100%; overflow: hidden; background: #1e1e1e; color: #ccc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 12px; }
        #canvas-container { width: 100%; height: 100%; min-height: 100vh; display: block; }

        /* Toolbar */
        #toolbar {
            position: absolute; top: 8px; left: 50%; transform: translateX(-50%);
            display: flex; gap: 2px; background: rgba(30,30,30,0.85); border-radius: 6px;
            padding: 3px; backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,0.08); z-index: 10;
        }
        #toolbar button {
            background: transparent; color: #aaa; border: none; padding: 4px 8px; border-radius: 4px;
            cursor: pointer; font-size: 11px; white-space: nowrap;
        }
        #toolbar button:hover { background: rgba(255,255,255,0.1); color: #fff; }
        #toolbar button.active { background: rgba(80,160,255,0.3); color: #6cf; }
        .tb-sep { width: 1px; background: rgba(255,255,255,0.1); margin: 2px 2px; }

        /* Part tree sidebar */
        #sidebar {
            position: absolute; top: 40px; left: 8px; width: 200px; max-height: calc(100vh - 56px);
            background: rgba(30,30,30,0.9); border-radius: 6px; border: 1px solid rgba(255,255,255,0.08);
            backdrop-filter: blur(8px); overflow-y: auto; z-index: 10; display: none;
        }
        #sidebar.visible { display: block; }
        #sidebar-header { padding: 6px 8px; font-weight: 600; color: #aaa; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
        .tree-node { padding: 3px 8px; display: flex; align-items: center; gap: 6px; cursor: pointer; }
        .tree-node:hover { background: rgba(255,255,255,0.05); }
        .tree-color { width: 10px; height: 10px; border-radius: 2px; border: 1px solid rgba(255,255,255,0.2); flex-shrink: 0; }
        .tree-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tree-eye { cursor: pointer; opacity: 0.5; font-size: 10px; }
        .tree-eye:hover { opacity: 1; }
        .tree-eye.hidden { opacity: 0.2; }

        /* Info bar */
        #info-bar {
            position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%);
            background: rgba(30,30,30,0.85); border-radius: 6px; padding: 4px 10px;
            backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,0.08);
            z-index: 10; font-size: 11px; color: #888; display: none; max-width: 90%;
        }
        #info-bar.visible { display: block; }

        /* Error panel */
        #error-panel {
            position: absolute; bottom: 40px; left: 8px; right: 8px;
            background: rgba(80,20,20,0.9); border-radius: 6px; padding: 8px 12px;
            border: 1px solid rgba(255,80,80,0.3); z-index: 10; display: none;
            font-family: monospace; font-size: 11px; color: #faa; max-height: 200px; overflow-y: auto;
        }
        #error-panel.visible { display: block; }

        #loading { position: absolute; top: 10px; right: 10px; display: none; background: rgba(0,0,0,0.6); padding: 4px 10px; border-radius: 4px; font-size: 11px; z-index: 10; }
    </style>
</head>
<body>
    <div id="toolbar">
        <button onclick="setPreset('front')">Front</button>
        <button onclick="setPreset('top')">Top</button>
        <button onclick="setPreset('right')">Right</button>
        <button onclick="setPreset('iso_ne')">Iso</button>
        <div class="tb-sep"></div>
        <button id="btn-ortho" onclick="toggleOrtho()">Persp</button>
        <div class="tb-sep"></div>
        <button id="btn-section-x" onclick="toggleSection('x')">✂X</button>
        <button id="btn-section-y" onclick="toggleSection('y')">✂Y</button>
        <button id="btn-section-z" onclick="toggleSection('z')">✂Z</button>
        <div class="tb-sep"></div>
        <button id="btn-tree" onclick="toggleSidebar()">🌳</button>
        <button id="btn-bbox" onclick="toggleBBox()">⬜</button>
        <button id="btn-edges" onclick="toggleEdges()" class="active">📐</button>
    </div>

    <div id="sidebar">
        <div id="sidebar-header">Parts</div>
        <div id="tree-container"></div>
    </div>

    <div id="info-bar"></div>
    <div id="error-panel"></div>
    <div id="loading">Loading...</div>
    <div id="canvas-container"></div>

    <script src="${scriptUri}"></script>
</body>
</html>`;
}
