import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as vscode from 'vscode';
import * as http from 'http';
import { parse } from 'url';
import * as path from 'path';
import * as fs from 'fs';
import { CadProcess } from './cad-process';

export interface WebviewRequester {
    requestFromWebview(type: string, payload?: any): Promise<any>;
}

export class McpCadServer {
    private server!: Server;
    private transport?: SSEServerTransport;
    private httpServer?: http.Server;
    private cadProcess: CadProcess;

    /** The most recently evaluated model_id, used to auto-resolve when not specified. */
    private lastModelId: string | null = null;

    constructor(
        private requester: WebviewRequester,
        private extensionUri: vscode.Uri,
        pythonExec: string,
    ) {
        const serverScript = vscode.Uri.joinPath(extensionUri, 'resources', 'cad_server.py').fsPath;
        this.cadProcess = new CadProcess(pythonExec, serverScript);
        this.initServer();
    }

    private initServer() {
        this.server = new Server(
            { name: "mcpcad-mcp", version: "0.3.0" },
            { capabilities: { resources: {}, tools: {}, prompts: {} } },
        );
        this.setupHandlers();
    }

    // ── Tool Definitions ───────────────────────────────────────

    private setupHandlers() {
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
            resources: [],
        }));

        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: "evaluate_cadquery",
                    description: `Evaluate a CadQuery Python script, visualize it in the 3D viewer, and return structured results.
The script must define a variable named 'result' (a CadQuery Workplane or Assembly).
Use debug_show("name", shape) in the script to register named intermediate checkpoints.
Returns: model_id, assembly_tree, metadata (volume, face count, validity, bounding box), 9-view overview image, and checkpoint names.
Use get_cadquery_docs(page="index") to see available documentation, then read relevant pages (e.g. "examples", "apireference", "selectors") if needed`,
                    inputSchema: {
                        type: "object",
                        properties: {
                            script: {
                                type: "string",
                                description: "CadQuery Python script. Must assign to 'result'. Can call debug_show(name, shape) for checkpoints.",
                            },
                            checkpoints: {
                                type: "boolean",
                                description: "If true, enable debug_show() checkpoints. Default: true.",
                            },
                            include_metadata: {
                                type: "boolean",
                                description: "If true, compute volume, face count, validity, etc. Default: true.",
                            },
                            orthographic: {
                                type: "boolean",
                                description: "If true (default), use orthographic camera for the initial 9-view overview. Set to false for perspective.",
                            },
                            show_hidden_lines: {
                                type: "boolean",
                                description: "If true (default), show hidden edges as dashed lines behind surfaces. Set to false to only show visible edges.",
                            },
                            background_color: {
                                type: "string",
                                description: "Background color for screenshots. Use 'white' or '#ffffff' for documentation. Default: dark gray.",
                            },
                        },
                        required: ["script"],
                    },
                },
                {
                    name: "capture_view",
                    description: `Capture a single high-resolution screenshot of the loaded model from a specific camera angle.
Use this to inspect a specific view more closely, isolate parts, or apply section cuts.
The model must have been loaded via evaluate_cadquery first.`,
                    inputSchema: {
                        type: "object",
                        properties: {
                            model_id: { type: "string", description: "Model ID from evaluate_cadquery. Omit to use the last evaluated model." },
                            preset: { type: "string", enum: ["front", "back", "top", "bottom", "left", "right", "iso_ne", "iso_nw", "iso_sw", "iso_se"], description: "Standard view preset." },
                            view_preset: { type: "string", description: "Alias for preset." },
                            azimuth: { type: "number", description: "Horizontal angle (0=front, 90=right). Ignored if preset is used." },
                            elevation: { type: "number", description: "Vertical angle (-90 to 90). Ignored if preset is used." },
                            zoom_level: { type: "number", description: "Zoom factor. 1.0 is default, 0.5 is closer, 2.0 is farther." },
                            resolution: {
                                type: "array", items: { type: "number" }, minItems: 2, maxItems: 2,
                                description: "Image resolution [width, height]. Default: [800, 800].",
                            },
                            visible_parts: {
                                type: "array", items: { type: "string" },
                                description: "Part names to show (hides others).",
                            },
                            section_plane: {
                                type: "object",
                                properties: {
                                    axis: { type: "string", enum: ["x", "y", "z"] },
                                    position: { type: "number", description: "Cut position." },
                                },
                            },
                            orthographic: { type: "boolean", description: "Use orthographic camera." },
                            show_bounding_box: { type: "boolean", description: "Show bounding box helper." },
                            show_hidden_lines: { type: "boolean", description: "If true (default), show hidden edges as dashed lines behind surfaces." },
                            background_color: { type: "string", description: "Background color for screenshots. Use 'white' or '#ffffff' for documentation. Default: dark gray." },
                        },
                    },
                },
                {
                    name: "inspect_model",
                    description: `Query geometric properties of a loaded model. Returns structured numeric data.
Supports: bounding_box, volume, surface_area, face_count, edge_count, solid_count, shell_count, validity_check, full, list_faces, list_edges, list_solids, topology, mass_properties.
list_faces/list_edges accept an optional geom_type filter (e.g. "Cylinder", "Circle", "Plane").
Each query can optionally target a specific assembly part via part_id (uses the part name from the assembly tree).`,
                    inputSchema: {
                        type: "object",
                        properties: {
                            model_id: { type: "string", description: "Model ID. Omit to use the last evaluated model." },
                            queries: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        type: {
                                            type: "string",
                                            enum: ["bounding_box", "volume", "surface_area", "face_count", "edge_count", "solid_count", "shell_count", "validity_check", "full", "list_faces", "list_edges", "list_solids", "topology", "mass_properties"],
                                            description: "Query type. 'full' returns all metadata. 'list_faces'/'list_edges' return detailed per-entity info. 'topology' returns entity counts by geometry type. 'mass_properties' returns volume, center of mass, surface area, and inertia matrix.",
                                        },
                                        part_id: {
                                            type: "string",
                                            description: "Optional part name from assembly tree. If omitted, queries the whole model.",
                                        },
                                        geom_type: {
                                            type: "string",
                                            description: "Optional geometry type filter for list_faces/list_edges (e.g. 'Plane', 'Cylinder', 'Circle', 'Line').",
                                        },
                                    },
                                    required: ["type"],
                                },
                                description: "List of queries to run. Each can target a specific part.",
                            },
                        },
                        required: ["queries"],
                    },
                },
                {
                    name: "export_model",
                    description: "Export a loaded model to a file (STEP, STL, BREP, or GLB).",
                    inputSchema: {
                        type: "object",
                        properties: {
                            model_id: { type: "string", description: "Model ID. Omit to use the last evaluated model." },
                            format: { type: "string", enum: ["step", "stl", "brep", "glb"], description: "Export format." },
                            output_path: { type: "string", description: "Full output file path. If omitted, saves to a temp directory." },
                        },
                        required: ["format"],
                    },
                },
                {
                    name: "get_cadquery_docs",
                    description: `Browse the bundled CadQuery documentation. Use page="index" (default) to list all available pages with descriptions. Then request a specific page by name (e.g. page="examples", page="primer", page="selectors").
Covers: examples, API reference, selectors, sketches, assemblies, workplanes, 3D concepts, import/export, and more.`,
                    inputSchema: {
                        type: "object",
                        properties: {
                            page: {
                                type: "string",
                                description: "Doc page name. Use 'index' to list available pages. Examples: 'examples', 'apireference', 'primer', 'selectors', 'sketch', 'quickstart', 'assy', 'workplane', 'extending', 'importexport', 'classreference', 'free-func', 'designprinciples', 'cqgi', 'intro'.",
                            },
                        },
                    },
                },
                {
                    name: "get_checkpoint",
                    description: `View a debug checkpoint registered during evaluate_cadquery via debug_show().
Returns a rendered image and metadata of the intermediate shape.`,
                    inputSchema: {
                        type: "object",
                        properties: {
                            model_id: { type: "string", description: "Model ID. Omit to use the last evaluated model." },
                            checkpoint_name: { type: "string", description: "Name of the checkpoint (as passed to debug_show())." },
                            nine_view: { type: "boolean", description: "If true, return the full 9-view grid instead of a single capture. Default: false." },
                            show_hidden_lines: { type: "boolean", description: "If true (default), show hidden edges as dashed lines behind surfaces." },
                            background_color: { type: "string", description: "Background color for screenshots. Use 'white' for documentation." },
                            camera: {
                                type: "object",
                                properties: {
                                    preset: { type: "string", enum: ["front", "back", "top", "bottom", "left", "right", "iso_ne", "iso_nw", "iso_sw", "iso_se"] },
                                    azimuth: { type: "number" },
                                    elevation: { type: "number" },
                                    orthographic: { type: "boolean", description: "Use orthographic camera. Default: true." },
                                },
                            },
                            resolution: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
                        },
                        required: ["checkpoint_name"],
                    },
                },
            ],
        }));

        // ── Tool Dispatch ──────────────────────────────────────

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const name = request.params.name;
            const args = request.params.arguments || {};

            try {
                switch (name) {
                    case "evaluate_cadquery": return await this.handleEvaluate(args);
                    case "capture_view": return await this.handleCaptureView(args);
                    case "inspect_model": return await this.handleInspect(args);
                    case "export_model": return await this.handleExport(args);
                    case "get_checkpoint": return await this.handleGetCheckpoint(args);
                    case "get_cadquery_docs": return await this.handleGetDocs(args);
                    default: throw new Error(`Unknown tool: ${name}`);
                }
            } catch (e: any) {
                return {
                    content: [{ type: "text", text: `Error: ${e.message || e}` }],
                    isError: true,
                };
            }
        });
    }

    // ── Tool Implementations ───────────────────────────────────

    private async handleEvaluate(args: any) {
        const result = await this.cadProcess.send("evaluate", {
            script: String(args.script || ""),
            checkpoints: args.checkpoints !== false,
            include_metadata: args.include_metadata !== false,
        });

        this.lastModelId = result.model_id;

        const content: any[] = [];

        // Build text summary
        if (result.error) {
            let errorText = `❌ Evaluation failed: ${result.error.error}`;
            if (result.error.traceback) {
                errorText += `\n\nTraceback:\n${result.error.traceback}`;
            }
            if (result.error.failing_operation) {
                errorText += `\n\n${result.error.failing_operation}`;
            }
            content.push({ type: "text", text: errorText });
        } else {
            let summary = `✅ Model evaluated successfully.\nModel ID: ${result.model_id}`;
            if (result.assembly_tree) {
                summary += `\n\nAssembly Tree:\n${this.formatTree(result.assembly_tree, 0)}`;
            }
            if (result.metadata) {
                const m = result.metadata;
                summary += `\n\nMetadata:`;
                if (m.volume != null) { summary += `\n  Volume: ${m.volume} mm³`; }
                if (m.surface_area != null) { summary += `\n  Surface Area: ${m.surface_area} mm²`; }
                if (m.bounding_box) { summary += `\n  Bounding Box: [${m.bounding_box.min}] → [${m.bounding_box.max}]`; }
                summary += `\n  Faces: ${m.face_count}, Edges: ${m.edge_count}, Solids: ${m.solid_count}`;
                summary += `\n  Valid: ${m.is_valid ? '✅' : '❌'}`;
            }
            if (result.checkpoint_names.length > 0) {
                summary += `\n\nCheckpoints: ${result.checkpoint_names.join(', ')}`;
            }
            content.push({ type: "text", text: summary });
        }

        // Render in the webview and capture overview
        if (result.glb_base64) {
            try {
                const viewResult = await this.requester.requestFromWebview("renderAssembly", {
                    glb_base64: result.glb_base64,
                    edges: result.edges,
                    assembly_tree: result.assembly_tree,
                    orthographic: args.orthographic !== false,
                    show_hidden_lines: args.show_hidden_lines !== false,
                    background_color: args.background_color || null,
                });

                if (viewResult?.image_base64) {
                    content.push({
                        type: "image",
                        data: viewResult.image_base64,
                        mimeType: "image/png",
                    });
                }
            } catch (e: any) {
                content.push({ type: "text", text: `(Viewer warning: ${e.message})` });
            }
        }

        return { content };
    }

    private async handleCaptureView(args: any) {
        const camera = this.resolveCameraAngles(args);
        const resolution = args.resolution || [800, 800];
        const visibleParts = args.visible_parts || null;
        const sectionPlane = args.section_plane || null;
        const orthographic = args.orthographic !== false; // Default to true
        const showBBox = args.show_bounding_box || false;
        const zoomLevel = args.zoom_level || 1.25;
        const showHiddenLines = args.show_hidden_lines !== false;

        const viewResult = await this.requester.requestFromWebview("captureView", {
            camera,
            resolution,
            visible_parts: visibleParts,
            section_plane: sectionPlane,
            orthographic,
            show_bounding_box: showBBox,
            zoom: zoomLevel,
            show_hidden_lines: showHiddenLines,
            background_color: args.background_color || null,
        });

        const content: any[] = [];

        // Echo effective settings so the agent knows exactly what was captured
        const presetName = args.preset || args.view_preset || args.camera?.preset || null;
        let settingsText = `📷 View captured`;
        settingsText += `\n  Camera: ${presetName ? presetName : `az=${camera.azimuth}° el=${camera.elevation}°`}`;
        settingsText += `\n  Projection: ${orthographic ? 'orthographic' : 'perspective'}`;
        settingsText += `\n  Resolution: ${resolution[0]}×${resolution[1]}`;
        settingsText += `\n  Zoom: ${zoomLevel.toFixed(2)}`;
        if (visibleParts) { settingsText += `\n  Visible parts: ${visibleParts.join(', ')}`; }
        if (sectionPlane) { settingsText += `\n  Section cut: ${sectionPlane.axis.toUpperCase()} at ${sectionPlane.position}`; }
        if (showBBox) { settingsText += `\n  Bounding box: shown`; }
        content.push({ type: "text", text: settingsText });

        if (viewResult?.image_base64) {
            content.push({ type: "image", data: viewResult.image_base64, mimeType: "image/png" });
        } else {
            content.push({ type: "text", text: "No model loaded in viewer. Run evaluate_cadquery first." });
        }
        return { content };
    }

    private async handleInspect(args: any) {
        const modelId = args.model_id || this.lastModelId;
        if (!modelId) {
            throw new Error("No model loaded. Run evaluate_cadquery first.");
        }

        const result = await this.cadProcess.send("inspect", {
            model_id: modelId,
            queries: args.queries,
        });

        let text = `Inspection results for ${modelId}:\n`;
        for (const r of result.results) {
            const partLabel = r.part_id ? ` [${r.part_id}]` : '';
            if (r.error) {
                text += `\n  ${r.type}${partLabel}: ❌ ${r.error}`;
            } else if (r.type === "bounding_box") {
                text += `\n  Bounding Box${partLabel}: min=[${r.min}] max=[${r.max}] extents=[${r.extents}]`;
            } else if (r.type === "validity_check") {
                text += `\n  Valid${partLabel}: ${r.is_valid ? '✅' : '❌'}`;
            } else if (r.type === "full" && r.metadata) {
                const m = r.metadata;
                text += `\n  Full metadata${partLabel}:`;
                if (m.volume != null) { text += `\n    Volume: ${m.volume} mm³`; }
                if (m.surface_area != null) { text += `\n    Surface Area: ${m.surface_area} mm²`; }
                if (m.bounding_box) { text += `\n    BBox: [${m.bounding_box.min}] → [${m.bounding_box.max}]`; }
                text += `\n    Faces: ${m.face_count}, Edges: ${m.edge_count}, Solids: ${m.solid_count}`;
                text += `\n    Valid: ${m.is_valid ? '✅' : '❌'}`;
            } else if (r.type === "list_faces") {
                text += `\n  Faces${partLabel} (${r.count} total):`;
                for (const f of r.faces) {
                    text += `\n    [${f.index}] ${f.geom_type} — area=${f.area} mm²`;
                    if (f.centroid) text += ` centroid=[${f.centroid}]`;
                    if (f.normal) text += ` normal=[${f.normal}]`;
                    if (f.radius != null) text += ` radius=${f.radius}`;
                }
            } else if (r.type === "list_edges") {
                text += `\n  Edges${partLabel} (${r.count} total):`;
                for (const e of r.edges) {
                    text += `\n    [${e.index}] ${e.geom_type} — length=${e.length} mm`;
                    if (e.midpoint) text += ` mid=[${e.midpoint}]`;
                    if (e.radius != null) text += ` radius=${e.radius}`;
                }
            } else if (r.type === "list_solids") {
                text += `\n  Solids${partLabel} (${r.count} total):`;
                for (const s of r.solids) {
                    text += `\n    [${s.index}] volume=${s.volume} mm³`;
                    if (s.centroid) text += ` centroid=[${s.centroid}]`;
                    if (s.bounding_box) text += ` bbox=[${s.bounding_box.min}]→[${s.bounding_box.max}]`;
                }
            } else if (r.type === "topology") {
                text += `\n  Topology${partLabel}:`;
                text += `\n    Faces: ${r.faces.total} — ${Object.entries(r.faces.by_type).map(([k,v]) => `${k}:${v}`).join(', ')}`;
                text += `\n    Edges: ${r.edges.total} — ${Object.entries(r.edges.by_type).map(([k,v]) => `${k}:${v}`).join(', ')}`;
                text += `\n    Solids: ${r.solids}, Shells: ${r.shells}, Wires: ${r.wires}, Vertices: ${r.vertices}`;
            } else if (r.type === "mass_properties") {
                text += `\n  Mass Properties${partLabel}:`;
                text += `\n    Volume: ${r.volume} mm³`;
                if (r.center_of_mass) text += `\n    Center of Mass: [${r.center_of_mass}]`;
                if (r.surface_area != null) text += `\n    Surface Area: ${r.surface_area} mm²`;
                if (r.inertia_matrix) {
                    text += `\n    Inertia Matrix:`;
                    for (const row of r.inertia_matrix) {
                        text += `\n      [${row.map((v: number) => v.toFixed(2)).join(', ')}]`;
                    }
                }
            } else {
                text += `\n  ${r.type}${partLabel}: ${r.value}${r.unit ? ' ' + r.unit : ''}`;
            }
        }

        return { content: [{ type: "text", text }] };
    }

    private async handleExport(args: any) {
        const modelId = args.model_id || this.lastModelId;
        if (!modelId) {
            throw new Error("No model loaded. Run evaluate_cadquery first.");
        }

        const result = await this.cadProcess.send("export", {
            model_id: modelId,
            format: args.format,
            output_path: args.output_path || undefined,
        });

        let exportText = `✅ Exported successfully`;
        exportText += `\n  Path: ${result.file_path}`;
        exportText += `\n  Format: ${result.format?.toUpperCase() || args.format?.toUpperCase()}`;
        exportText += `\n  Size: ${(result.file_size_bytes / 1024).toFixed(1)} KB`;
        exportText += `\n  Unit: ${result.unit || 'mm'}`;
        exportText += `\n  Model: ${result.model_name || 'result'}`;
        if (result.sha256_short) { exportText += `\n  SHA256: ${result.sha256_short}`; }

        return { content: [{ type: "text", text: exportText }] };
    }

    private async handleGetCheckpoint(args: any) {
        const modelId = args.model_id || this.lastModelId;
        if (!modelId) {
            throw new Error("No model loaded. Run evaluate_cadquery first.");
        }

        // Get checkpoint GLB from Python
        const cpResult = await this.cadProcess.send("get_checkpoint_glb", {
            model_id: modelId,
            checkpoint_name: args.checkpoint_name,
        });

        const content: any[] = [];

        // Metadata summary
        if (cpResult.metadata) {
            const m = cpResult.metadata;
            let text = `Checkpoint "${cpResult.checkpoint_name || args.checkpoint_name}":`;
            if (m.volume != null) { text += `\n  Volume: ${m.volume} mm³`; }
            if (m.surface_area != null) { text += `\n  Surface Area: ${m.surface_area} mm²`; }
            if (m.bounding_box) { text += `\n  BBox: [${m.bounding_box.min}] → [${m.bounding_box.max}]`; }
            text += `\n  Faces: ${m.face_count}, Edges: ${m.edge_count}, Solids: ${m.solid_count}`;
            text += `\n  Valid: ${m.is_valid ? '✅' : '❌'}`;
            if (cpResult.available_checkpoints?.length > 0) {
                text += `\n\n  Available checkpoints: ${cpResult.available_checkpoints.join(', ')}`;
            }
            content.push({ type: "text", text });
        }

        // Render in webview and capture
        if (cpResult.glb_base64) {
            try {
                const camera = this.resolveCameraAngles(args.camera);
                const resolution = args.resolution || [800, 800];
                const orthographic = args.camera?.orthographic !== false;
                const nineView = !!args.nine_view;
                const showHiddenLines = args.show_hidden_lines !== false;

                const viewResult = await this.requester.requestFromWebview("renderCheckpoint", {
                    glb_base64: cpResult.glb_base64,
                    edges: cpResult.edges || [],
                    camera,
                    resolution,
                    orthographic,
                    nine_view: nineView,
                    show_hidden_lines: showHiddenLines,
                    background_color: args.background_color || null,
                });

                if (viewResult?.image_base64) {
                    content.push({ type: "image", data: viewResult.image_base64, mimeType: "image/png" });
                }
            } catch (e: any) {
                content.push({ type: "text", text: `(Viewer warning: ${e.message})` });
            }
        }

        return { content };
    }

    private async handleGetDocs(args: any) {
        const docsDir = path.join(this.extensionUri.fsPath, 'resources', 'docs', 'cadquery');
        const pageDescriptions: Record<string, string> = {
            'examples': 'CadQuery examples from simple to complex — boxes, holes, fillets, lofts, assemblies, parametric enclosures, gears',
            'apireference': 'API reference grouped by functional area — 2D ops, 3D ops, selectors, file I/O, assemblies',
            'primer': '3D BREP topology concepts, CadQuery API layers (Fluent/Direct/OCCT), selectors, assemblies',
            'selectors': 'String selector syntax for faces, edges, vertices — directional, parallel, type-based filters',
            'quickstart': 'Getting started with CadQuery — first model walkthrough',
            'sketch': 'Sketch API — 2D face-based and edge/constraint-based sketching',
            'assy': 'Assembly tutorial — constraints, mates, STEP export',
            'workplane': 'Workplane concepts — origins, offsets, rotations, chaining',
            'extending': 'Extending CadQuery — custom plugins, selectors, direct OCCT API usage',
            'importexport': 'Import/export — STEP, STL, DXF, BREP, SVG, AMF, TJS, VRML formats',
            'classreference': 'Class reference — alphabetical listing of all CadQuery classes and methods',
            'free-func': 'Free functions API — top-level shape creation and manipulation functions',
            'designprinciples': 'Design principles behind CadQuery',
            'cqgi': 'CadQuery Gateway Interface — executing scripts programmatically',
            'intro': 'Introduction to CadQuery — what it is and why it exists',
        };

        const pageName = (args.page || 'index').replace(/\.rst$/, '');

        if (pageName === 'index') {
            let text = 'CadQuery Documentation — Available Pages:\n\n';
            for (const [name, desc] of Object.entries(pageDescriptions)) {
                text += `  • ${name} — ${desc}\n`;
            }
            text += '\nUse get_cadquery_docs with page="<name>" to read a specific page.';
            return { content: [{ type: "text", text }] };
        }

        const filePath = path.join(docsDir, `${pageName}.rst`);
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            return { content: [{ type: "text", text: content }] };
        } catch {
            const available = Object.keys(pageDescriptions).join(', ');
            throw new Error(`Unknown doc page: "${pageName}". Available pages: ${available}`);
        }
    }

    // ── Helpers ─────────────────────────────────────────────────

    private resolveCameraAngles(args: any): { azimuth: number, elevation: number } {
        const p = args || {};
        const camera = p.camera || {};

        // Handle flattened structure, nested legacy structure, and aliases
        const preset = p.preset || p.view_preset || camera.preset;
        const azimuth = p.azimuth ?? camera.azimuth;
        const elevation = p.elevation ?? camera.elevation;

        if (preset) {
            const presets: Record<string, [number, number]> = {
                front: [0, 0], back: [180, 0],
                top: [0, 90], bottom: [0, -90],
                left: [-90, 0], right: [90, 0],
                iso_ne: [45, 35.264], iso_nw: [135, 35.264],
                iso_sw: [225, 35.264], iso_se: [315, 35.264],
            };
            const [az, el] = presets[preset as string] || [45, 35.264];
            return { azimuth: az, elevation: el };
        }

        return {
            azimuth: azimuth ?? 45,
            elevation: elevation ?? 35.264,
        };
    }

    private formatTree(node: any, depth: number): string {
        const indent = "  ".repeat(depth);
        const color = node.color ? ` (${node.color})` : '';
        let s = `${indent}• ${node.name}${color}\n`;
        for (const child of (node.children || [])) {
            s += this.formatTree(child, depth + 1);
        }
        return s;
    }

    // ── Server Lifecycle ───────────────────────────────────────

    public async start(): Promise<number> {
        // Start the long-running Python process
        await this.cadProcess.start();
        console.log('[MCP] Python CAD process started');

        return new Promise((resolve) => {
            this.httpServer = http.createServer(async (req, res) => {
                const parsedUrl = parse(req.url || '', true);

                if (parsedUrl.pathname === '/sse') {
                    if (this.transport) {
                        try { await this.server.close(); } catch { }
                        this.initServer();
                    }
                    this.transport = new SSEServerTransport('/messages', res);
                    await this.server.connect(this.transport);
                } else if (parsedUrl.pathname === '/messages' && req.method === 'POST') {
                    if (this.transport) {
                        await this.transport.handlePostMessage(req, res);
                    } else {
                        res.statusCode = 400;
                        res.end('No SSE connection');
                    }
                } else {
                    res.statusCode = 404;
                    res.end('Not found');
                }
            });

            this.httpServer.listen(0, '127.0.0.1', () => {
                const actualPort = (this.httpServer?.address() as any).port;
                console.log(`McpCAD MCP Server at http://localhost:${actualPort}/sse`);
                resolve(actualPort);
            });
        });
    }

    public async stop() {
        this.cadProcess.stop();
        if (this.httpServer) {
            this.httpServer.close();
        }
    }
}
