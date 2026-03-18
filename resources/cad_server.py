#!/usr/bin/env python3
"""Long-running CadQuery evaluation server.

Protocol: JSON lines over stdin (requests) / stdout (responses).
Logging goes to stderr to avoid protocol interference.

Each request:  { "id": "...", "method": "...", "params": {...} }
Each response: { "id": "...", "result": {...} }
        or:    { "id": "...", "error": { "message": "...", "traceback": "..." } }
"""

import sys
import json
import traceback
import os
import tempfile
import base64
import time


def log(msg):
    print(f"[cad_server] {msg}", file=sys.stderr, flush=True)


log("Initializing CadQuery...")

try:
    import cadquery as cq
    log("CadQuery loaded successfully")
except ImportError as e:
    print(json.dumps({
        "id": "__ready__",
        "error": {"message": f"Failed to import CadQuery: {e}"}
    }), flush=True)
    sys.exit(1)

# Try importing Open CASCADE modules for advanced features
HAS_ADVANCED_OC = False
try:
    from OCP.GProp import GProp_GProps
    from OCP.BRepGProp import BRepGProp
    from OCP.BRepCheck import BRepCheck_Analyzer
    HAS_ADVANCED_OC = True
except ImportError:
    log("Warning: Advanced Open Cascade imports unavailable, some features limited")


# ── Model Store ─────────────────────────────────────────────────

class InMemoryStore:
    MAX_MODELS = 5

    def __init__(self):
        self.models = {}

    def store(self, model_id, **data):
        self.models[model_id] = data
        while len(self.models) > self.MAX_MODELS:
            oldest = next(iter(self.models))
            del self.models[oldest]
            log(f"Evicted model {oldest}")

    def get(self, model_id):
        return self.models.get(model_id)


store = InMemoryStore()


# ── Helpers ─────────────────────────────────────────────────────

def extract_color_hex(color):
    """Extract hex color string from a CadQuery Color object."""
    if color is None:
        return None
    try:
        if hasattr(color, 'toTuple'):
            t = color.toTuple()
            r, g, b = int(t[0] * 255), int(t[1] * 255), int(t[2] * 255)
            return f"#{r:02x}{g:02x}{b:02x}"
        if hasattr(color, 'wrapped'):
            rgb = color.wrapped.GetRGB()
            r = int(rgb.Red() * 255)
            g = int(rgb.Green() * 255)
            b = int(rgb.Blue() * 255)
            return f"#{r:02x}{g:02x}{b:02x}"
    except Exception:
        pass
    return None


def extract_assembly_tree(obj, idx_counter=None):
    """Walk a CadQuery Assembly or shape and build a JSON-serializable tree."""
    if idx_counter is None:
        idx_counter = [0]

    if isinstance(obj, cq.Assembly):
        # Determine the type of the underlying shape if it exists
        obj_type = "Assembly"
        shape = get_shape(obj)
        if shape:
            if hasattr(shape, 'val'): shape = shape.val()
            if isinstance(shape, cq.Solid): obj_type = "Solid"
            elif isinstance(shape, cq.Shell): obj_type = "Shell"
            elif isinstance(shape, cq.Face): obj_type = "Face"
            elif isinstance(shape, cq.Wire): obj_type = "Wire"
            elif isinstance(shape, cq.Edge): obj_type = "Edge"

        node = {
            "name": obj.name or "root",
            "color": extract_color_hex(obj.color),
            "node_index": idx_counter[0],
            "type": obj_type,
            "children": []
        }
        idx_counter[0] += 1
        for child in obj.children:
            node["children"].append(extract_assembly_tree(child, idx_counter))
        return node

    return {
        "name": "result", "color": None, "node_index": 0, "type": "Unknown", "children": []
    }


def tessellate_edges(shape, tolerance=0.1):
    """Extract all edges from a shape and tessellate them into polylines."""
    if not shape:
        return []

    polylines = []
    try:
        edges = shape.Edges()
        for edge in edges:
            # Tessellate the edge
            # We use a simple sampling approach for robust cross-version compatibility
            # In Open CASCADE/CadQuery, we can use the discretization
            try:
                # Get points along the edge
                # length / tolerance gives us a reasonable sample count
                length = edge.Length()
                num_points = max(2, int(length / tolerance))
                if num_points > 500: num_points = 500 # safety limit
                
                points = []
                for i in range(num_points + 1):
                    p = edge.positionAt(i / num_points)
                    # OCCT is Z-up, GLTF/Three.js is Y-up: swap Y and Z
                    points.append([round(p.x, 6), round(p.z, 6), round(-p.y, 6)])
                
                polylines.append(points)
            except Exception as e:
                log(f"Edge tessellation failed for one edge: {e}")
    except Exception as e:
        log(f"All edge extraction failed: {e}")
    
    return polylines


def get_shape(obj):
    """Extract the underlying cq.Shape from various CadQuery types."""
    if isinstance(obj, cq.Workplane):
        return obj.val()
    if isinstance(obj, cq.Assembly):
        try:
            return obj.toCompound()
        except Exception:
            return None
    if hasattr(obj, 'wrapped'):  # cq.Shape subclass
        return obj
    return None


def resolve_part_shape(model, part_name):
    """Extract the shape of a named part from a stored assembly model."""
    result_obj = model.get("result")
    if result_obj is None:
        return None

    if not isinstance(result_obj, cq.Assembly):
        # Single shape, no parts to resolve
        if part_name in ("result", "root"):
            return model.get("shape")
        return None

    # Walk the assembly tree to find the named part
    def find_in_assembly(asm, target_name):
        if (asm.name or "root") == target_name:
            return get_shape(asm)
        for child in asm.children:
            result = find_in_assembly(child, target_name)
            if result is not None:
                return result
        return None

    return find_in_assembly(result_obj, part_name)


def compute_metadata(shape):
    """Compute geometric metadata from a CadQuery Shape."""
    if shape is None:
        return None

    meta = {
        "volume": None,
        "surface_area": None,
        "bounding_box": None,
        "face_count": 0,
        "edge_count": 0,
        "solid_count": 0,
        "shell_count": 0,
        "is_valid": True,
    }

    try:
        meta["volume"] = round(shape.Volume(), 6)
    except Exception:
        pass

    if HAS_ADVANCED_OC:
        try:
            props = GProp_GProps()
            BRepGProp.SurfaceProperties_s(shape.wrapped, props)
            meta["surface_area"] = round(props.Mass(), 6)
        except Exception:
            pass

        try:
            analyzer = BRepCheck_Analyzer(shape.wrapped)
            meta["is_valid"] = analyzer.IsValid()
        except Exception:
            pass

    try:
        bb = shape.BoundingBox()
        meta["bounding_box"] = {
            "min": [round(bb.xmin, 6), round(bb.ymin, 6), round(bb.zmin, 6)],
            "max": [round(bb.xmax, 6), round(bb.ymax, 6), round(bb.zmax, 6)],
        }
    except Exception:
        pass

    for attr, key in [("Faces", "face_count"), ("Edges", "edge_count"),
                      ("Solids", "solid_count"), ("Shells", "shell_count")]:
        try:
            meta[key] = len(getattr(shape, attr)())
        except Exception:
            pass

    return meta


def obj_to_glb_base64(obj):
    """Convert a CadQuery object to GLB and return as base64 string."""
    tmp_path = os.path.join(tempfile.gettempdir(), f"cad_{time.time_ns()}.glb")
    try:
        if isinstance(obj, cq.Assembly):
            obj.save(tmp_path, "GLTF")
        else:
            a = cq.Assembly()
            if isinstance(obj, cq.Workplane):
                a.add(obj)
            else:
                a.add(cq.Workplane().add(obj))
            a.save(tmp_path, "GLTF")

        with open(tmp_path, "rb") as f:
            return base64.b64encode(f.read()).decode("ascii")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ── Command Handlers ────────────────────────────────────────────

def handle_evaluate(params):
    script = params["script"]
    want_metadata = params.get("include_metadata", True)
    model_id = f"m_{int(time.time() * 1000)}"

    # Checkpoint collector injected into the script namespace
    checkpoints = {}

    def debug_show(name, shape):
        if isinstance(shape, cq.Workplane):
            checkpoints[name] = shape.val()
        else:
            checkpoints[name] = shape
        log(f"Checkpoint registered: {name}")

    namespace = {
        "cq": cq, "cadquery": cq,
        "debug_show": debug_show,
        "log": lambda msg: log(f"[script] {msg}"),
    }

    # Execute the user script
    error_info = None
    try:
        exec(script, namespace)
    except Exception as e:
        error_info = {
            "error": str(e),
            "traceback": traceback.format_exc(),
            "failing_operation": None,
            "last_successful_shape_glb": None,
        }
        if checkpoints:
            last_name = list(checkpoints.keys())[-1]
            try:
                error_info["last_successful_shape_glb"] = obj_to_glb_base64(checkpoints[last_name])
                error_info["failing_operation"] = f"Failed after checkpoint '{last_name}'"
            except Exception:
                pass

        store.store(model_id, result=None, checkpoints=checkpoints, error=error_info)
        return {
            "model_id": model_id,
            "glb_base64": error_info.get("last_successful_shape_glb"),
            "assembly_tree": None,
            "metadata": None,
            "checkpoint_names": list(checkpoints.keys()),
            "error": error_info,
        }

    result_obj = namespace.get("result")
    if result_obj is None:
        return {
            "model_id": model_id,
            "glb_base64": None,
            "assembly_tree": None,
            "metadata": None,
            "checkpoint_names": list(checkpoints.keys()),
            "error": {
                "error": "Script must define a variable named 'result'",
                "traceback": "", "failing_operation": None,
                "last_successful_shape_glb": None,
            },
        }

    tree = extract_assembly_tree(result_obj)
    shape = get_shape(result_obj)
    metadata = compute_metadata(shape) if want_metadata and shape else None
    glb_b64 = obj_to_glb_base64(result_obj)
    edges = tessellate_edges(shape) if shape else []

    store.store(
        model_id, result=result_obj, shape=shape,
        tree=tree, metadata=metadata, checkpoints=checkpoints,
        edges=edges
    )

    return {
        "model_id": model_id,
        "glb_base64": glb_b64,
        "edges": edges,
        "assembly_tree": tree,
        "metadata": metadata,
        "checkpoint_names": list(checkpoints.keys()),
        "error": None,
    }


def handle_inspect(params):
    model_id = params["model_id"]
    model = store.get(model_id)
    if not model:
        raise ValueError(f"Model {model_id} not found (may have been evicted)")

    results = []

    for q in params.get("queries", []):
        qtype = q["type"]
        part_id = q.get("part_id")  # optional per-part targeting

        # Resolve the target shape (whole model or specific part)
        if part_id:
            target = resolve_part_shape(model, part_id)
            if target is None:
                results.append({"type": qtype, "part_id": part_id, "error": f"Part '{part_id}' not found in assembly"})
                continue
        else:
            target = model.get("shape")

        try:
            entry = {"type": qtype}
            if part_id:
                entry["part_id"] = part_id

            if qtype == "bounding_box":
                bb = target.BoundingBox()
                entry.update({
                    "min": [round(bb.xmin, 6), round(bb.ymin, 6), round(bb.zmin, 6)],
                    "max": [round(bb.xmax, 6), round(bb.ymax, 6), round(bb.zmax, 6)],
                    "extents": [round(bb.xmax - bb.xmin, 6),
                                round(bb.ymax - bb.ymin, 6),
                                round(bb.zmax - bb.zmin, 6)],
                })
            elif qtype == "volume":
                entry.update({"value": round(target.Volume(), 6), "unit": "mm³"})
            elif qtype == "surface_area" and HAS_ADVANCED_OC:
                props = GProp_GProps()
                BRepGProp.SurfaceProperties_s(target.wrapped, props)
                entry.update({"value": round(props.Mass(), 6), "unit": "mm²"})
            elif qtype == "validity_check":
                is_valid = True
                if HAS_ADVANCED_OC:
                    analyzer = BRepCheck_Analyzer(target.wrapped)
                    is_valid = analyzer.IsValid()
                entry["is_valid"] = is_valid
            elif qtype in ("face_count", "edge_count", "solid_count", "shell_count"):
                attr = qtype.replace("_count", "").capitalize() + "s"
                entry["value"] = len(getattr(target, attr)())
            elif qtype == "full":
                # Convenience: return all metadata for this target at once
                meta = compute_metadata(target)
                entry["metadata"] = meta

            elif qtype == "list_faces":
                geom_filter = q.get("geom_type")  # optional filter e.g. "Cylinder"
                face_list = []
                for i, face in enumerate(target.Faces()):
                    gt = face.geomType()
                    if geom_filter and gt.lower() != geom_filter.lower():
                        continue
                    info = {
                        "index": i,
                        "geom_type": gt,
                        "area": round(face.Area(), 6),
                    }
                    try:
                        c = face.Center()
                        info["centroid"] = [round(c.x, 6), round(c.y, 6), round(c.z, 6)]
                    except Exception:
                        pass
                    try:
                        # Normal at center of face
                        n = face.normalAt()
                        info["normal"] = [round(n.x, 6), round(n.y, 6), round(n.z, 6)]
                    except Exception:
                        pass
                    if gt in ("Cylinder", "Cone", "Sphere", "Torus"):
                        try:
                            info["radius"] = round(face.radius(), 6)
                        except Exception:
                            pass
                    face_list.append(info)
                entry["faces"] = face_list
                entry["count"] = len(face_list)

            elif qtype == "list_edges":
                geom_filter = q.get("geom_type")  # optional filter e.g. "Circle"
                edge_list = []
                for i, edge in enumerate(target.Edges()):
                    gt = edge.geomType()
                    if geom_filter and gt.lower() != geom_filter.lower():
                        continue
                    info = {
                        "index": i,
                        "geom_type": gt,
                        "length": round(edge.Length(), 6),
                    }
                    try:
                        mid = edge.positionAt(0.5)
                        info["midpoint"] = [round(mid.x, 6), round(mid.y, 6), round(mid.z, 6)]
                    except Exception:
                        pass
                    if gt in ("CIRCLE", "Circle", "ARC", "Arc"):
                        try:
                            info["radius"] = round(edge.radius(), 6)
                        except Exception:
                            pass
                    edge_list.append(info)
                entry["edges"] = edge_list
                entry["count"] = len(edge_list)

            elif qtype == "list_solids":
                solid_list = []
                for i, solid in enumerate(target.Solids()):
                    info = {
                        "index": i,
                        "volume": round(solid.Volume(), 6),
                    }
                    try:
                        bb = solid.BoundingBox()
                        info["bounding_box"] = {
                            "min": [round(bb.xmin, 6), round(bb.ymin, 6), round(bb.zmin, 6)],
                            "max": [round(bb.xmax, 6), round(bb.ymax, 6), round(bb.zmax, 6)],
                        }
                    except Exception:
                        pass
                    try:
                        c = solid.Center()
                        info["centroid"] = [round(c.x, 6), round(c.y, 6), round(c.z, 6)]
                    except Exception:
                        pass
                    solid_list.append(info)
                entry["solids"] = solid_list
                entry["count"] = len(solid_list)

            elif qtype == "topology":
                faces_by_type = {}
                for face in target.Faces():
                    gt = face.geomType()
                    faces_by_type[gt] = faces_by_type.get(gt, 0) + 1
                edges_by_type = {}
                for edge in target.Edges():
                    gt = edge.geomType()
                    edges_by_type[gt] = edges_by_type.get(gt, 0) + 1
                entry.update({
                    "faces": {"total": sum(faces_by_type.values()), "by_type": faces_by_type},
                    "edges": {"total": sum(edges_by_type.values()), "by_type": edges_by_type},
                    "solids": len(target.Solids()),
                    "shells": len(target.Shells()),
                    "wires": len(target.Wires()),
                    "vertices": len(target.Vertices()),
                })

            elif qtype == "mass_properties":
                entry["volume"] = round(target.Volume(), 6)
                try:
                    c = target.Center()
                    entry["center_of_mass"] = [round(c.x, 6), round(c.y, 6), round(c.z, 6)]
                except Exception:
                    pass
                if HAS_ADVANCED_OC:
                    try:
                        props = GProp_GProps()
                        BRepGProp.SurfaceProperties_s(target.wrapped, props)
                        entry["surface_area"] = round(props.Mass(), 6)
                    except Exception:
                        pass
                    try:
                        vprops = GProp_GProps()
                        BRepGProp.VolumeProperties_s(target.wrapped, vprops)
                        mat = vprops.MatrixOfInertia()
                        entry["inertia_matrix"] = [
                            [round(mat.Value(r, c), 6) for c in range(1, 4)]
                            for r in range(1, 4)
                        ]
                    except Exception:
                        pass

            else:
                entry["error"] = f"Unknown query type: {qtype}"

            results.append(entry)
        except Exception as e:
            results.append({"type": qtype, "part_id": part_id, "error": str(e)})

    return {"results": results}


def handle_export(params):
    model_id = params["model_id"]
    fmt = params.get("format", "step")
    output_path = params.get("output_path")

    model = store.get(model_id)
    if not model:
        raise ValueError(f"Model {model_id} not found")

    result_obj = model.get("result")
    shape = model.get("shape")
    if not result_obj and not shape:
        raise ValueError("Model has no result (evaluation may have failed)")

    if not output_path:
        ext_map = {"step": ".step", "stl": ".stl", "brep": ".brep", "glb": ".glb"}
        output_path = os.path.join(tempfile.gettempdir(), f"cad_export_{model_id}{ext_map.get(fmt, '.step')}")

    if fmt == "glb":
        data = base64.b64decode(obj_to_glb_base64(result_obj))
        with open(output_path, "wb") as f:
            f.write(data)
    elif fmt == "step":
        cq.exporters.export(shape, output_path, "STEP")
    elif fmt == "stl":
        cq.exporters.export(shape, output_path, "STL")
    elif fmt == "brep":
        shape.exportBrep(output_path)
    else:
        raise ValueError(f"Unknown format: {fmt}")

    file_size = os.path.getsize(output_path)

    # Compute a simple hash for tracking
    import hashlib
    with open(output_path, "rb") as f:
        file_hash = hashlib.sha256(f.read()).hexdigest()[:16]

    # Extract model name from assembly tree if available
    tree = model.get("tree")
    model_name = tree.get("name", "result") if tree else "result"

    return {
        "file_path": output_path,
        "file_size_bytes": file_size,
        "format": fmt,
        "model_id": model_id,
        "model_name": model_name,
        "unit": "mm",
        "sha256_short": file_hash,
    }


def handle_get_checkpoint_glb(params):
    model_id = params["model_id"]
    name = params["checkpoint_name"]

    model = store.get(model_id)
    if not model:
        raise ValueError(f"Model {model_id} not found")

    checkpoints = model.get("checkpoints", {})
    if name not in checkpoints:
        available = list(checkpoints.keys())
        raise ValueError(f"Checkpoint '{name}' not found. Available: {available}")

    cp_shape = checkpoints[name]
    glb_b64 = obj_to_glb_base64(cp_shape)
    raw = cp_shape if hasattr(cp_shape, 'wrapped') else get_shape(cp_shape)
    meta = compute_metadata(raw)
    edges = tessellate_edges(raw) if raw else []

    return {
        "glb_base64": glb_b64,
        "edges": edges,
        "checkpoint_name": name,
        "metadata": meta,
        "available_checkpoints": list(checkpoints.keys()),
    }


# ── Main Loop ───────────────────────────────────────────────────

HANDLERS = {
    "evaluate": handle_evaluate,
    "inspect": handle_inspect,
    "export": handle_export,
    "get_checkpoint_glb": handle_get_checkpoint_glb,
}

# Signal ready
print(json.dumps({"id": "__ready__", "result": {"status": "ready"}}), flush=True)
log("Server ready, waiting for commands...")

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue

    try:
        request = json.loads(line)
    except json.JSONDecodeError as e:
        print(json.dumps({"id": None, "error": {"message": f"Invalid JSON: {e}"}}), flush=True)
        continue

    req_id = request.get("id")
    method = request.get("method", "")
    params = request.get("params", {})

    handler = HANDLERS.get(method)
    if not handler:
        print(json.dumps({"id": req_id, "error": {"message": f"Unknown method: {method}"}}), flush=True)
        continue

    try:
        result = handler(params)
        print(json.dumps({"id": req_id, "result": result}), flush=True)
    except Exception as e:
        log(f"Error in {method}: {traceback.format_exc()}")
        print(json.dumps({
            "id": req_id,
            "error": {"message": str(e), "traceback": traceback.format_exc()},
        }), flush=True)
