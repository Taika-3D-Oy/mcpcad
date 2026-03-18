import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

declare const acquireVsCodeApi: any;
const vscode = acquireVsCodeApi();

function log(msg: string) { vscode.postMessage({ command: 'log', text: msg }); }

const container = document.getElementById('canvas-container')!;
const loadingDiv = document.getElementById('loading')!;
const infoBar = document.getElementById('info-bar')!;
const errorPanel = document.getElementById('error-panel')!;
const treeContainer = document.getElementById('tree-container')!;

let scene: THREE.Scene, perspCamera: THREE.PerspectiveCamera, orthoCamera: THREE.OrthographicCamera, activeCamera: THREE.Camera, renderer: THREE.WebGLRenderer, controls: OrbitControls;
let loadedModel: THREE.Group | null = null;
let edgeGroup: THREE.Group | null = null;
let assemblyTree: any = null;
let showHiddenLines = false;
let bboxHelper: THREE.BoxHelper | null = null;
let isOrtho = false;
let showBBox = false;
let showEdges = true;
let sectionState = { x: false, y: false, z: false };
let sectionPositions = { x: 0, y: 0, z: 0 };
let sectionFillGroup: THREE.Group | null = null;
let partNodes = new Map<string, THREE.Object3D | null>(); // name -> THREE.Object3D
let partVisibility = new Map<string, boolean>(); // name -> boolean

// ── Camera Presets ─────────────────────────────────────
const PRESETS: Record<string, [number, number]> = {
    front: [0, 0], back: [180, 0],
    top: [0, 90], bottom: [0, -90],
    left: [-90, 0], right: [90, 0],
    iso_ne: [45, 35.264], iso_nw: [135, 35.264],
    iso_sw: [225, 35.264], iso_se: [315, 35.264],
};

// ── Init ───────────────────────────────────────────────
function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1e1e1e);

    // Lighting — stronger contrast between lit and shadowed faces
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const d1 = new THREE.DirectionalLight(0xffffff, 1.0);
    d1.position.set(10, 20, 10);
    scene.add(d1);
    const d2 = new THREE.DirectionalLight(0xffffff, 0.5);
    d2.position.set(-10, -5, -10);
    scene.add(d2);
    const d3 = new THREE.DirectionalLight(0xffffff, 0.3);
    d3.position.set(0, -10, 5);
    scene.add(d3);

    // Grid + axes
    // scene.add(new THREE.GridHelper(20, 20, 0x333333, 0x2a2a2a));
    scene.add(new THREE.AxesHelper(10));

    // Cameras
    const aspect = window.innerWidth / window.innerHeight;
    perspCamera = new THREE.PerspectiveCamera(45, aspect, 0.1, 10000);
    perspCamera.position.set(5, 5, 5);
    orthoCamera = new THREE.OrthographicCamera(-5 * aspect, 5 * aspect, 5, -5, 0.1, 10000);
    orthoCamera.position.set(5, 5, 5);
    activeCamera = perspCamera;

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    (renderer as any).outputEncoding = (THREE as any).sRGBEncoding || 3001; // sRGBEncoding is 3001
    renderer.localClippingEnabled = true;
    container.appendChild(renderer.domElement);

    // Ensure container and renderer element have size
    container.style.width = '100%';
    container.style.height = '100%';

    // Controls
    controls = new OrbitControls(activeCamera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    window.addEventListener('resize', onResize);
    animate();
    vscode.postMessage({ command: 'ready' });
}

function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    perspCamera.aspect = w / h;
    perspCamera.updateProjectionMatrix();
    const aspect = w / h;
    orthoCamera.left = -5 * aspect;
    orthoCamera.right = 5 * aspect;
    orthoCamera.updateProjectionMatrix();
    renderer.setSize(w, h);
}
function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, activeCamera);
}

// ── Camera ─────────────────────────────────────────────
function fitCamera(object: THREE.Object3D, offset?: number) {
    const effectiveOffset = offset || 1.25;
    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = perspCamera.fov * (Math.PI / 180);
    const dist = Math.abs((maxDim / 2) / Math.tan(fov / 2)) * effectiveOffset;

    // Dynamically adjust planes to fit large and small models without clipping
    const far = dist + maxDim * 20;
    const near = Math.max(0.1, maxDim / 2000);
    perspCamera.near = near;
    perspCamera.far = far;
    orthoCamera.near = near;
    orthoCamera.far = far;

    return { center, distance: dist, maxDim };
}

function setCameraAngle(camData: any, azimuth: number, elevation: number, w?: number, h?: number) {
    const theta = azimuth * Math.PI / 180;
    const phi = (90 - elevation) * Math.PI / 180;
    const r = camData.distance * 1.5;
    activeCamera.position.set(
        camData.center.x + r * Math.sin(phi) * Math.cos(theta),
        camData.center.y + r * Math.cos(phi),
        camData.center.z + r * Math.sin(phi) * Math.sin(theta)
    );
    activeCamera.lookAt(camData.center);
    controls.target.copy(camData.center);

    const aspect = (w && h) ? (w / h) : (window.innerWidth / window.innerHeight);

    if (isOrtho) {
        const half = camData.maxDim * 0.75;
        orthoCamera.left = -half * aspect;
        orthoCamera.right = half * aspect;
        orthoCamera.top = half;
        orthoCamera.bottom = -half;
    } else {
        perspCamera.aspect = aspect;
    }
    (activeCamera as any).updateProjectionMatrix();
    controls.update();
}

(window as any).setPreset = function (name: string) {
    if (!loadedModel) return;
    const [az, el] = PRESETS[name] || PRESETS.iso_ne;
    setCameraAngle(fitCamera(loadedModel, 1.2), az, el);
};

(window as any).toggleOrtho = function () {
    isOrtho = !isOrtho;
    const pos = activeCamera.position.clone();
    const target = controls.target.clone();
    activeCamera = isOrtho ? orthoCamera : perspCamera;
    activeCamera.position.copy(pos);
    controls.object = activeCamera;
    controls.target.copy(target);
    if (loadedModel && isOrtho) {
        const cd = fitCamera(loadedModel, 1.2);
        const half = cd.maxDim * 0.75;
        const aspect = window.innerWidth / window.innerHeight;
        orthoCamera.left = -half * aspect;
        orthoCamera.right = half * aspect;
        orthoCamera.top = half;
        orthoCamera.bottom = -half;
    }
    (activeCamera as any).updateProjectionMatrix();
    controls.update();
    document.getElementById('btn-ortho')!.textContent = isOrtho ? 'Ortho' : 'Persp';
};

// ── Section Planes ─────────────────────────────────────
function updateClipping() {
    const planes: THREE.Plane[] = [];
    if (sectionState.x) planes.push(new THREE.Plane(new THREE.Vector3(-1, 0, 0), sectionPositions.x));
    if (sectionState.y) planes.push(new THREE.Plane(new THREE.Vector3(0, -1, 0), sectionPositions.y));
    if (sectionState.z) planes.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), sectionPositions.z));
    renderer.clippingPlanes = planes;

    // Section fill planes — show colored fill on the cut face
    if (sectionFillGroup) { scene.remove(sectionFillGroup); sectionFillGroup = null; }
    if (planes.length > 0 && loadedModel) {
        sectionFillGroup = new THREE.Group();
        sectionFillGroup.name = '__sectionFill__';
        const box = new THREE.Box3().setFromObject(loadedModel);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) * 2;
        const center = box.getCenter(new THREE.Vector3());

        for (const [axis, active] of Object.entries(sectionState)) {
            if (!active) continue;
            const pos = (sectionPositions as any)[axis];
            const planeGeo = new THREE.PlaneGeometry(maxDim, maxDim);
            const planeMat = new THREE.MeshBasicMaterial({
                color: 0xcc4444,
                opacity: 0.15,
                transparent: true,
                side: THREE.DoubleSide,
                // Clip this fill plane by all OTHER section planes
                clippingPlanes: planes.filter((_, i) => {
                    const axes = Object.keys(sectionState).filter(k => (sectionState as any)[k]);
                    return axes[i] !== axis;
                }),
            });
            const mesh = new THREE.Mesh(planeGeo, planeMat);
            // Position and orient the fill plane
            if (axis === 'x') {
                mesh.position.set(pos + loadedModel.position.x, center.y, center.z);
                mesh.rotation.y = Math.PI / 2;
            } else if (axis === 'y') {
                mesh.position.set(center.x, pos + loadedModel.position.y, center.z);
                mesh.rotation.x = -Math.PI / 2;
            } else {
                mesh.position.set(center.x, center.y, pos + loadedModel.position.z);
            }
            // Also draw a cross-hatch outline
            const edgeGeo = new THREE.EdgesGeometry(planeGeo);
            const edgeMat = new THREE.LineBasicMaterial({ color: 0xcc4444, opacity: 0.5, transparent: true });
            const edges = new THREE.LineSegments(edgeGeo, edgeMat);
            edges.position.copy(mesh.position);
            edges.rotation.copy(mesh.rotation);
            sectionFillGroup.add(mesh);
            sectionFillGroup.add(edges);
        }
        scene.add(sectionFillGroup);
    }
}

(window as any).toggleSection = function (axis: 'x' | 'y' | 'z') {
    sectionState[axis] = !sectionState[axis];
    if (sectionState[axis] && loadedModel) {
        const box = new THREE.Box3().setFromObject(loadedModel);
        const center = box.getCenter(new THREE.Vector3());
        sectionPositions[axis] = axis === 'x' ? center.x : axis === 'y' ? center.y : center.z;
    }
    updateClipping();
    document.getElementById('btn-section-' + axis)!.classList.toggle('active', sectionState[axis]);
};

// ── Bounding Box ───────────────────────────────────────
(window as any).toggleBBox = function () {
    showBBox = !showBBox;
    if (bboxHelper) { scene.remove(bboxHelper); bboxHelper = null; }
    if (showBBox && loadedModel) {
        bboxHelper = new THREE.BoxHelper(loadedModel, 0x6cf);
        scene.add(bboxHelper);
    }
    document.getElementById('btn-bbox')!.classList.toggle('active', showBBox);
};

// ── Part Tree ──────────────────────────────────────────
(window as any).toggleSidebar = function () {
    document.getElementById('sidebar')!.classList.toggle('visible');
    document.getElementById('btn-tree')!.classList.toggle('active');
};

function buildTreeUI(node: any, depth: number) {
    const div = document.createElement('div');
    div.className = 'tree-node';
    div.style.paddingLeft = (8 + depth * 14) + 'px';

    const colorDiv = document.createElement('div');
    colorDiv.className = 'tree-color';
    colorDiv.style.background = node.color || '#888';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tree-name';
    nameSpan.textContent = node.name;
    if (node.type && node.type !== 'Assembly') {
        const typeSpan = document.createElement('span');
        typeSpan.style.opacity = '0.3'; typeSpan.style.fontSize = '9px'; typeSpan.style.marginLeft = '4px';
        typeSpan.textContent = '[' + node.type + ']';
        nameSpan.appendChild(typeSpan);
    }

    const eyeSpan = document.createElement('span');
    eyeSpan.className = 'tree-eye';
    eyeSpan.textContent = '👁';
    eyeSpan.onclick = (e) => {
        e.stopPropagation();
        const visible = partVisibility.get(node.name) !== false;
        partVisibility.set(node.name, !visible);
        eyeSpan.classList.toggle('hidden', visible);
        applyPartVisibility();
    };

    div.append(colorDiv, nameSpan, eyeSpan);
    treeContainer.appendChild(div);

    for (const child of (node.children || [])) {
        buildTreeUI(child, depth + 1);
    }
}

function applyPartVisibility(visibleNames?: string[]) {
    if (!loadedModel) return;
    if (visibleNames) {
        // Agent-driven: show only named parts
        const nameSet = new Set(visibleNames);
        loadedModel.traverse(obj => {
            if ((obj as any).isMesh) {
                const name = findPartName(obj);
                obj.visible = name ? nameSet.has(name) : false;
            }
        });
    } else {
        // UI-driven: use partVisibility map
        loadedModel.traverse(obj => {
            if ((obj as any).isMesh) {
                const name = findPartName(obj);
                if (name !== null) {
                    obj.visible = partVisibility.get(name) !== false;
                }
            }
        });
    }
}

function findPartName(obj: THREE.Object3D) {
    let current: THREE.Object3D | null = obj;
    while (current) {
        if (current.name && partNodes.has(current.name)) return current.name;
        current = current.parent;
    }
    return null;
}

(window as any).toggleEdges = function () {
    showEdges = !showEdges;
    if (edgeGroup) edgeGroup.visible = showEdges;
    document.getElementById('btn-edges')!.classList.toggle('active', showEdges);

    // Adjust transparency of surfaces when edges are visible for better debugging
    if (loadedModel) {
        loadedModel.traverse(obj => {
            if ((obj as any).isMesh) {
                const mesh = obj as THREE.Mesh;
                if (mesh.material instanceof THREE.Material) {
                    mesh.material.transparent = false;
                    mesh.material.opacity = 1.0;
                }
            }
        });
    }
};

function buildEdgeGeometry(edgeData: any, hiddenLines: boolean = false, darkEdges: boolean = false): THREE.Group | null {
    if (!edgeData || edgeData.length === 0) return null;
    const points: THREE.Vector3[] = [];
    for (const polyline of edgeData) {
        for (let i = 0; i < polyline.length - 1; i++) {
            points.push(new THREE.Vector3(...polyline[i]));
            points.push(new THREE.Vector3(...polyline[i + 1]));
        }
    }
    const group = new THREE.Group();
    group.name = '__edges__';
    const geometry = new THREE.BufferGeometry().setFromPoints(points);

    // Pass 1: Visible edges — standard depth test (rendered where edges are in front)
    const visibleColor = darkEdges ? 0x2255aa : 0x88bbff;
    const visibleMat = new THREE.LineBasicMaterial({
        color: visibleColor, opacity: 0.9, transparent: true,
        depthFunc: THREE.LessEqualDepth,
    });
    group.add(new THREE.LineSegments(geometry, visibleMat));

    // Pass 2: Hidden edges — inverted depth test (rendered where edges are behind surfaces)
    if (hiddenLines) {
        const hiddenColor = darkEdges ? 0x999999 : 0x5577aa;
        const hiddenOpacity = darkEdges ? 0.25 : 0.35;
        const hiddenMat = new THREE.LineDashedMaterial({
            color: hiddenColor, opacity: hiddenOpacity, transparent: true,
            dashSize: 1, gapSize: 1,
            depthFunc: THREE.GreaterDepth,
            depthWrite: false,
        });
        const hiddenSegments = new THREE.LineSegments(geometry, hiddenMat);
        hiddenSegments.computeLineDistances();
        group.add(hiddenSegments);
    }

    return group;
}

function indexPartNodes(obj: THREE.Group, tree: any) {
    partNodes.clear();
    partVisibility.clear();
    if (!tree) return;
    function walk(node: any) {
        partNodes.set(node.name, null);
        partVisibility.set(node.name, true);
        // Try to find matching Three.js node
        obj.traverse(child => {
            if (child.name === node.name || child.name === node.name.replace(/ /g, '_')) {
                partNodes.set(node.name, child);
            }
        });
        for (const c of (node.children || [])) walk(c);
    }
    walk(tree);
}

// ── GLB Loading ────────────────────────────────────────
function base64ToArrayBuffer(b64: string) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}

async function loadGlb(b64: string, tree: any) {
    loadingDiv.style.display = 'block';
    errorPanel.textContent = '';
    errorPanel.classList.remove('visible');

    return new Promise<void>((resolve, reject) => {
        const loader = new GLTFLoader();
        loader.parse(base64ToArrayBuffer(b64), '', (gltf) => {
            if (loadedModel) scene.remove(loadedModel);
            if (edgeGroup) { scene.remove(edgeGroup); edgeGroup = null; }
            if (bboxHelper) { scene.remove(bboxHelper); bboxHelper = null; }

            loadedModel = gltf.scene;

            // Create edges from data
            const edgeData = (window as any)._lastEdges || [];
            edgeGroup = buildEdgeGeometry(edgeData, showHiddenLines);
            if (edgeGroup) {
                scene.add(edgeGroup);
                edgeGroup.visible = showEdges;
            }

            // Auto-center
            const box = new THREE.Box3().setFromObject(loadedModel);
            const center = box.getCenter(new THREE.Vector3());
            loadedModel.position.sub(center);
            if (edgeGroup) edgeGroup.position.sub(center);

            scene.add(loadedModel);

            // Enable polygon offset on meshes to prevent z-fighting with edge lines
            loadedModel.traverse(obj => {
                if ((obj as any).isMesh) {
                    const mesh = obj as THREE.Mesh;
                    if (mesh.material instanceof THREE.Material) {
                        mesh.material.polygonOffset = true;
                        mesh.material.polygonOffsetFactor = 1;
                        mesh.material.polygonOffsetUnits = 1;
                    }
                }
            });

            // Initial opacity set to 1.0 (Opaque)
            loadedModel.traverse(obj => {
                if ((obj as any).isMesh) {
                    const mesh = obj as THREE.Mesh;
                    if (mesh.material instanceof THREE.Material) {
                        mesh.material.transparent = false;
                        mesh.material.opacity = 1.0;
                    }
                }
            });

            indexPartNodes(loadedModel, tree);

            // Build tree UI
            treeContainer.innerHTML = '';
            if (tree) {
                buildTreeUI(tree, 0);
                document.getElementById('sidebar')!.classList.add('visible');
                document.getElementById('btn-tree')!.classList.add('active');
            }

            // Fit camera
            const cd = fitCamera(loadedModel, 1.5);
            setCameraAngle(cd, 45, 35.264);

            if (showBBox) {
                bboxHelper = new THREE.BoxHelper(loadedModel, 0x6cf);
                scene.add(bboxHelper);
            }

            loadingDiv.style.display = 'none';
            resolve();
        }, (e: any) => {
            loadingDiv.style.display = 'none';
            reject(e);
        });
    });
}

// ── Screenshots ────────────────────────────────────────
function captureScreenshot(width: number, height: number, az: number, el: number, zoom: number, bgColor?: string) {
    const oldW = renderer.domElement.width, oldH = renderer.domElement.height;
    const effectiveZoom = zoom || 1.0;
    if (!loadedModel) return '';

    const savedBg = scene.background;
    const useBg = bgColor || 'white';
    scene.background = new THREE.Color(useBg);

    // Determine if background is light for edge color adaptation
    const bgC = new THREE.Color(useBg);
    const isLightBg = (bgC.r + bgC.g + bgC.b) / 3 > 0.5;

    // Rebuild edges with appropriate colors if needed
    if (isLightBg && edgeGroup) {
        const savedPos = edgeGroup.position.clone();
        scene.remove(edgeGroup);
        edgeGroup = buildEdgeGeometry((window as any)._lastEdges || [], showHiddenLines, true);
        if (edgeGroup) { edgeGroup.position.copy(savedPos); scene.add(edgeGroup); edgeGroup.visible = showEdges; }
    }

    const camData = fitCamera(loadedModel, effectiveZoom);

    const effectiveAz = (az !== undefined) ? az : 45;
    const effectiveEl = (el !== undefined) ? el : 35.264;

    renderer.setSize(width, height);
    setCameraAngle(camData, effectiveAz, effectiveEl, width, height);

    renderer.render(scene, activeCamera);
    const dataUrl = renderer.domElement.toDataURL('image/png');

    // Restore
    renderer.setSize(oldW, oldH);
    setCameraAngle(camData, effectiveAz, effectiveEl); // Uses window aspect
    scene.background = savedBg;

    // Restore edge colors back to dark-bg style
    if (isLightBg && edgeGroup) {
        const savedPos = edgeGroup.position.clone();
        scene.remove(edgeGroup);
        edgeGroup = buildEdgeGeometry((window as any)._lastEdges || [], showHiddenLines, false);
        if (edgeGroup) { edgeGroup.position.copy(savedPos); scene.add(edgeGroup); edgeGroup.visible = showEdges; }
    }

    return dataUrl.split(',')[1];
}

function take9Screenshots(bgColor?: string) {
    if (!loadedModel) return null;
    const camData = fitCamera(loadedModel, 1.0);
    const size = 300;

    // Temporarily set background for screenshots (default: white)
    const savedBg = scene.background;
    const useBg = bgColor || 'white';
    scene.background = new THREE.Color(useBg);

    // Adapt edge colors for light background
    const bgC = new THREE.Color(useBg);
    const isLightBg = (bgC.r + bgC.g + bgC.b) / 3 > 0.5;
    if (isLightBg && edgeGroup) {
        const savedPos = edgeGroup.position.clone();
        scene.remove(edgeGroup);
        edgeGroup = buildEdgeGeometry((window as any)._lastEdges || [], showHiddenLines, true);
        if (edgeGroup) { edgeGroup.position.copy(savedPos); scene.add(edgeGroup); edgeGroup.visible = showEdges; }
    }
    const angles = [[0, 90], [0, 0], [90, 0], [45, 35.264], [135, 35.264], [225, 35.264], [315, 35.264], [0, -90], [-90, 0]];
    const names = ["Top", "Front", "Right", "Iso NE", "Iso NW", "Iso SW", "Iso SE", "Bottom", "Left"];
    const canvas = document.createElement('canvas');
    canvas.width = size * 3; canvas.height = size * 3;
    const ctx = canvas.getContext('2d')!;
    const oldPos = activeCamera.position.clone();
    const oldTarget = controls.target.clone();

    renderer.setSize(size, size);

    for (let i = 0; i < 9; i++) {
        setCameraAngle(camData, angles[i][0], angles[i][1], size, size);
        renderer.render(scene, activeCamera);
        const row = Math.floor(i / 3), col = i % 3;
        ctx.drawImage(renderer.domElement, col * size, row * size);
        // Label background adapts to bg color
        ctx.fillStyle = isLightBg ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.5)';
        ctx.fillRect(col * size, row * size, 60, 18);
        ctx.fillStyle = '#fff'; ctx.font = '11px sans-serif';
        ctx.fillText(names[i], col * size + 5, row * size + 13);
    }

    // Restore
    renderer.setSize(window.innerWidth, window.innerHeight);
    activeCamera.position.copy(oldPos);
    controls.target.copy(oldTarget);
    setCameraAngle(camData, 45, 35.264);
    scene.background = savedBg;

    // Restore edge colors back to dark-bg style
    if (isLightBg && edgeGroup) {
        const savedPos2 = edgeGroup.position.clone();
        scene.remove(edgeGroup);
        edgeGroup = buildEdgeGeometry((window as any)._lastEdges || [], showHiddenLines, false);
        if (edgeGroup) { edgeGroup.position.copy(savedPos2); scene.add(edgeGroup); edgeGroup.visible = showEdges; }
    }

    return canvas.toDataURL('image/png').split(',')[1];
}

// ── Message Handler ────────────────────────────────────
window.addEventListener('message', async event => {
    const msg = event.data;
    if (msg.command !== 'request') return;

    try {
        let responseData: any = {};

        if (msg.type === 'renderAssembly') {
            (window as any)._lastEdges = msg.payload.edges || [];
            showHiddenLines = !!msg.payload.show_hidden_lines;
            const savedOrtho = isOrtho;
            if (msg.payload.orthographic && !isOrtho) (window as any).toggleOrtho();
            else if (!msg.payload.orthographic && isOrtho) (window as any).toggleOrtho();

            await loadGlb(msg.payload.glb_base64, msg.payload.assembly_tree);
            await new Promise(r => setTimeout(r, 100));
            const img = take9Screenshots(msg.payload.background_color);
            responseData = { success: true, image_base64: img };

            if (isOrtho !== savedOrtho) (window as any).toggleOrtho();

        } else if (msg.type === 'renderAndCapture') {
            (window as any)._lastEdges = msg.payload.edges || [];
            showHiddenLines = !!msg.payload.show_hidden_lines;
            await loadGlb(msg.payload.glb_base64, null);
            await new Promise(r => setTimeout(r, 100));
            const img = take9Screenshots(msg.payload.background_color);
            responseData = { success: true, image_base64: img };

        } else if (msg.type === 'captureView') {
            const p = msg.payload;
            if (!loadedModel) { throw new Error('No model loaded'); }

            // Update hidden lines if requested
            const savedHiddenLines = showHiddenLines;
            if (p.show_hidden_lines !== undefined && p.show_hidden_lines !== showHiddenLines) {
                showHiddenLines = !!p.show_hidden_lines;
                const savedPos = edgeGroup ? edgeGroup.position.clone() : null;
                if (edgeGroup) scene.remove(edgeGroup);
                edgeGroup = buildEdgeGeometry((window as any)._lastEdges || [], showHiddenLines);
                if (edgeGroup) {
                    if (savedPos) edgeGroup.position.copy(savedPos);
                    scene.add(edgeGroup);
                    edgeGroup.visible = showEdges;
                }
            }

            if (p.visible_parts) { applyPartVisibility(p.visible_parts); }

            const savedSection = { ...sectionState };
            const savedPositions = { ...sectionPositions };
            if (p.section_plane) {
                sectionState = { x: false, y: false, z: false };
                (sectionState as any)[p.section_plane.axis] = true;
                (sectionPositions as any)[p.section_plane.axis] = p.section_plane.position;
                updateClipping();
            }

            const savedBBox = showBBox;
            if (p.show_bounding_box && !bboxHelper) {
                bboxHelper = new THREE.BoxHelper(loadedModel, 0x6cf);
                scene.add(bboxHelper);
            }

            const savedOrtho = isOrtho;
            if (p.orthographic && !isOrtho) (window as any).toggleOrtho();
            else if (!p.orthographic && isOrtho) (window as any).toggleOrtho();

            await new Promise(r => setTimeout(r, 50));
            const res = p.resolution || [800, 800];
            const img = captureScreenshot(res[0], res[1], p.camera.azimuth, p.camera.elevation, p.zoom, p.background_color);

            if (p.visible_parts) applyPartVisibility();
            sectionState = savedSection;
            sectionPositions = savedPositions;
            updateClipping();
            if (p.show_bounding_box && !savedBBox && bboxHelper) {
                scene.remove(bboxHelper); bboxHelper = null;
            }
            if (p.orthographic !== savedOrtho) (window as any).toggleOrtho();

            // Restore hidden lines state
            if (showHiddenLines !== savedHiddenLines) {
                showHiddenLines = savedHiddenLines;
                const savedPos = edgeGroup ? edgeGroup.position.clone() : null;
                if (edgeGroup) scene.remove(edgeGroup);
                edgeGroup = buildEdgeGeometry((window as any)._lastEdges || [], showHiddenLines);
                if (edgeGroup) {
                    if (savedPos) edgeGroup.position.copy(savedPos);
                    scene.add(edgeGroup);
                    edgeGroup.visible = showEdges;
                }
            }

            responseData = { image_base64: img };

        } else if (msg.type === 'renderCheckpoint') {
            (window as any)._lastEdges = msg.payload.edges || [];
            showHiddenLines = !!msg.payload.show_hidden_lines;
            const savedOrtho = isOrtho;
            if (msg.payload.orthographic && !isOrtho) (window as any).toggleOrtho();
            else if (!msg.payload.orthographic && isOrtho) (window as any).toggleOrtho();

            await loadGlb(msg.payload.glb_base64, null);
            await new Promise(r => setTimeout(r, 50));

            let img: string | null;
            if (msg.payload.nine_view) {
                img = take9Screenshots(msg.payload.background_color);
            } else {
                const res = msg.payload.resolution || [800, 800];
                img = captureScreenshot(res[0], res[1], msg.payload.camera.azimuth, msg.payload.camera.elevation, msg.payload.zoom, msg.payload.background_color);
            }
            responseData = { image_base64: img };

            if (isOrtho !== savedOrtho) (window as any).toggleOrtho();
        }

        vscode.postMessage({ command: 'response', requestId: msg.requestId, data: responseData });
    } catch (e: any) {
        vscode.postMessage({ command: 'response', requestId: msg.requestId, error: e.message });
    }
});

init();
