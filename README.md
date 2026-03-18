# McpCAD: AI-Powered CAD for VS Code

**McpCAD** is an AI-native 3D modeling system for VS Code. It provides an **MCP server** and a high-performance **Open CASCADE (OCCT)** viewport, enabling AI agents like Antigravity or Claude to see, measure, debug, and build 3D geometry directly in your workspace.

<img src="resources/extension-icon.png" width="128" alt="McpCAD Logo">

## 🚀 Why McpCAD?

Most AI agents are "blind" to 3D geometry. McpCAD bridges this gap by providing tools specifically designed for LLMs to:
- **Visualize**: Render complex B-Rep assemblies using a bundled Three.js viewport.
- **Inspect**: Query volumes, distances, bounding boxes, and face counts.
- **Debug**: Capture high-resolution multi-angle orthographic screenshots for visual feedback.
- **Generate**: Compile Python-based CadQuery scripts into concrete 3D entities.

## ✨ Key Features

- **⚡ Agent-Optimized**: Tools are designed for LLMs, with flat schemas and descriptive metadata.
- **📐 B-Rep Edges**: Explicitly renders arcs and wires, making it easy to debug geometry that lacks faces.
- **📸 Multi-Angle Capture**: Generate 9-angle overview montages or specific zoomed views.
- **🌳 Assembly Tree**: Interactive sidebar with visibility toggles and entity type identification.
- **✂️ Section Cuts**: Dynamic X, Y, Z clipping planes for internal inspection.

## 🛠️ Getting Started

1. **Install**: Install the `mcpcad` extension from the VS Code Marketplace (or load the VSIX).
2. **Setup Python**: The extension will automatically help you set up a Python environment with `cadquery` and `casadi`.
3. **Open Viewport**: Run the command `McpCAD Viewer`.
4. **Agent Integration**: Ask your AI assistant (like Antigravity or Claude) to "Please design a ball bearing using McpCAD" or "Export a STEP of the model".

## 📦 Dependencies

McpCAD is built on the shoulders of giants:
- **[Open CASCADE](https://www.opencascade.com/)**: The world-class B-Rep kernel.
- **[CadQuery](https://github.com/CadQuery/cadquery)**: A powerful nested-function Python library for parametric CAD.
- **[Three.js](https://threejs.org/)**: For high-performance web-based 3D rendering.
- **[Model Context Protocol](https://modelcontextprotocol.io/)**: For seamless AI instrument connectivity.

## ❓ F.A.Q.

**Q: It's not installing, or it's taking forever to start.**  
**A:** The extension automatically prepares a Python environment and installs CadQuery on the first run. This process can take several minutes. Occasionally, a second restart is required for all components to sync. If the MCP server doesn't appear, please restart VS Code, re-open the McpCAD Viewport, and refresh your MCP tools.

**Q: My AI agent says it can't "see" or render the model.**  
**A:** Ensure the McpCAD Viewport is open in VS Code (Run the `McpCAD Viewer` command). The agent interacts with the live viewport to capture screenshots and metadata.

**Q: Why does my agent plan a complex assembly but then only generate a simple part?**  
**A:** AI agents often need a bit of "muscle memory" with new CAD APIs. We recommend letting your agent design a few simple standalone components first and saving those `.py` scripts in your workspace. Once the agent has these local examples to reference, it will be much more successful at "one-shotting" complex assemblies by building on its previous work.

## ⚖️ License

McpCAD is licensed under the **Apache License 2.0**. See the `LICENSE` file for details.

---
*Created (prompted into existence) by Roope Kuisma*
*© 2026 Taika3D Oy*
