/**
 * src/graph/visualize.ts
 *
 * Exports the indexed code graph as a self-contained, single-file HTML page
 * with an interactive force-directed graph visualization powered by D3.js
 * loaded from CDN. No npm dependencies added — the HTML embeds everything.
 */

import { unwrapValue } from "../hydra/client.js";
import type { HydraClient } from "../hydra/client.js";
import { NODE_LABELS, REL_TYPES } from "./schema.js";
import type { NodeLabel, RelType } from "./schema.js";

/* ------------------------------------------------------------------ */
/* Data types                                                          */
/* ------------------------------------------------------------------ */

export interface VisNode {
	id: string;
	key: string;
	label: NodeLabel;
	name: string;
	file: string;
}

export interface VisEdge {
	source: string;
	target: string;
	type: RelType;
}

export interface VisualizationData {
	nodes: VisNode[];
	edges: VisEdge[];
	meta: { generatedAt: string; totalFiles: number; totalFunctions: number; totalClasses: number; capped: boolean };
}

/* ------------------------------------------------------------------ */
/* Caps                                                                 */
/* ------------------------------------------------------------------ */

const MAX_NODES = 500;
const MAX_EDGES = 1000;

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function cellStr(v: unknown): string {
	const u = unwrapValue(v);
	return typeof u === "string" ? u : String(u ?? "");
}

function cellNum(v: unknown): number {
	const u = unwrapValue(v);
	return typeof u === "number" ? u : Number(u ?? 0);
}

/** Derive the file path from a function/class key (before the first #). */
function fileFromKey(key: string): string {
	const hashIdx = key.indexOf("#");
	if (hashIdx === -1) return "";
	// key is like "function:src/graph/writer.ts#writeExtractedFiles#503"
	// strip the "function:" prefix, then take up to first #
	const withoutPrefix = key.substring(key.indexOf(":") + 1);
	const firstHash = withoutPrefix.indexOf("#");
	return firstHash === -1 ? withoutPrefix : withoutPrefix.substring(0, firstHash);
}

/** Derive a short display name from a node key. */
function nameFromKey(key: string): string {
	const hashIdx = key.indexOf("#");
	if (hashIdx === -1) {
		// File node: "file:src/cli.ts" → "src/cli.ts"
		const colonIdx = key.indexOf(":");
		return colonIdx === -1 ? key : key.substring(colonIdx + 1);
	}
	// "function:src/graph/writer.ts#writeExtractedFiles#503" → "writeExtractedFiles"
	const afterFirstHash = key.substring(hashIdx + 1);
	const secondHash = afterFirstHash.indexOf("#");
	return secondHash === -1 ? afterFirstHash : afterFirstHash.substring(0, secondHash);
}

/* ------------------------------------------------------------------ */
/* Data fetching                                                       */
/* ------------------------------------------------------------------ */

/**
 * Fetch the full code graph from HydraDB and return a flattened
 * VisualizationData structure ready for D3 rendering.
 */
export async function buildVisualizationData(
	client: HydraClient,
): Promise<VisualizationData> {
	// --- Fetch nodes ---
	const funcRes = await client.query(
		`MATCH (f:${NODE_LABELS.FUNCTION}) RETURN f.id AS id, f.key AS key, f.name AS name`,
		undefined,
		{ consistency: "strong" },
	);
	const classRes = await client.query(
		`MATCH (c:${NODE_LABELS.CLASS}) RETURN c.id AS id, c.key AS key, c.name AS name`,
		undefined,
		{ consistency: "strong" },
	);
	const fileRes = await client.query(
		`MATCH (f:${NODE_LABELS.FILE}) RETURN f.id AS id, f.key AS key, f.path AS path`,
		undefined,
		{ consistency: "strong" },
	);

	const nodes: VisNode[] = [];
	const nodeById = new Map<string, VisNode>();

	for (const row of funcRes.rows) {
		const cells = row as unknown[];
		const id = String(cellNum(cells[0]));
		const key = cellStr(cells[1]);
		const name = cellStr(cells[2]);
		const file = fileFromKey(key);
		const node: VisNode = { id, key, label: NODE_LABELS.FUNCTION, name, file };
		nodes.push(node);
		nodeById.set(id, node);
	}

	for (const row of classRes.rows) {
		const cells = row as unknown[];
		const id = String(cellNum(cells[0]));
		const key = cellStr(cells[1]);
		const name = cellStr(cells[2]);
		const file = fileFromKey(key);
		const node: VisNode = { id, key, label: NODE_LABELS.CLASS, name, file };
		nodes.push(node);
		nodeById.set(id, node);
	}

	for (const row of fileRes.rows) {
		const cells = row as unknown[];
		const id = String(cellNum(cells[0]));
		const key = cellStr(cells[1]);
		const path = cellStr(cells[2]);
		const node: VisNode = { id, key, label: NODE_LABELS.FILE, name: path, file: path };
		nodes.push(node);
		nodeById.set(id, node);
	}

	const totalFiles = fileRes.rows.length;
	const totalFunctions = funcRes.rows.length;
	const totalClasses = classRes.rows.length;

	// --- Fetch edges ---
	const callsRes = await client.query(
		`MATCH (a:${NODE_LABELS.FUNCTION})-[r:${REL_TYPES.CALLS}]->(b:${NODE_LABELS.FUNCTION}) RETURN a.id AS source, b.id AS target`,
		undefined,
		{ consistency: "strong" },
	);
	const containsRes = await client.query(
		`MATCH (f:${NODE_LABELS.FILE})-[r:${REL_TYPES.CONTAINS}]->(n) RETURN f.id AS source, n.id AS target`,
		undefined,
		{ consistency: "strong" },
	);
	const methodOfRes = await client.query(
		`MATCH (f:${NODE_LABELS.FUNCTION})-[r:${REL_TYPES.METHOD_OF}]->(c:${NODE_LABELS.CLASS}) RETURN f.id AS source, c.id AS target`,
		undefined,
		{ consistency: "strong" },
	);

	const edges: VisEdge[] = [];
	for (const row of callsRes.rows) {
		const cells = row as unknown[];
		edges.push({ source: String(cellNum(cells[0])), target: String(cellNum(cells[1])), type: REL_TYPES.CALLS });
	}
	for (const row of containsRes.rows) {
		const cells = row as unknown[];
		edges.push({ source: String(cellNum(cells[0])), target: String(cellNum(cells[1])), type: REL_TYPES.CONTAINS });
	}
	for (const row of methodOfRes.rows) {
		const cells = row as unknown[];
		edges.push({ source: String(cellNum(cells[0])), target: String(cellNum(cells[1])), type: REL_TYPES.METHOD_OF });
	}

	// --- Cap nodes and edges ---
	let capped = false;

	if (nodes.length > MAX_NODES) {
		// Count connections per node
		const degree = new Map<string, number>();
		for (const e of edges) {
			degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
			degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
		}
		// Sort by degree descending, take top MAX_NODES
		nodes.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
		const keptIds = new Set(nodes.slice(0, MAX_NODES).map((n) => n.id));
		nodes.length = MAX_NODES;
		// Filter edges to only those where both endpoints are kept
		const filteredEdges = edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target));
		edges.length = 0;
		edges.push(...filteredEdges);
		capped = true;
	}

	if (edges.length > MAX_EDGES) {
		edges.length = MAX_EDGES;
		capped = true;
	}

	return {
		nodes,
		edges,
		meta: {
			generatedAt: new Date().toISOString(),
			totalFiles,
			totalFunctions,
			totalClasses,
			capped,
		},
	};
}

/* ------------------------------------------------------------------ */
/* HTML rendering                                                      */
/* ------------------------------------------------------------------ */

/**
 * Generate a complete, self-contained HTML file with an interactive
 * D3.js force-directed graph visualization.
 */
export function renderVisualizationHtml(data: VisualizationData): string {
	const cappedNotice = data.meta.capped
		? `<div style="position:fixed;top:50px;left:50%;transform:translateX(-50%);background:#b8860b;color:#fff;padding:8px 16px;border-radius:6px;font-size:13px;z-index:100;">⚠ Graph capped to ${MAX_NODES} nodes / ${MAX_EDGES} edges for performance — showing most-connected subset.</div>`
		: "";

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hydracode graph</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117;
    color: #c9d1d9;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    overflow: hidden;
  }
  svg { display: block; }
  .title {
    position: fixed; top: 12px; left: 16px; z-index: 10;
    font-size: 14px; color: #8b949e; pointer-events: none;
  }
  .title strong { color: #e6edf3; font-weight: 600; }
  .legend {
    position: fixed; bottom: 16px; left: 16px; z-index: 10;
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 12px 16px; font-size: 12px; line-height: 1.8;
  }
  .legend-title { font-weight: 600; margin-bottom: 4px; color: #e6edf3; }
  .legend-item { display: flex; align-items: center; gap: 8px; }
  .legend-swatch {
    display: inline-block; width: 12px; height: 12px;
    border-radius: 50%; flex-shrink: 0;
  }
  .legend-line {
    display: inline-block; width: 20px; height: 2px; flex-shrink: 0;
  }
  .tooltip {
    position: fixed; pointer-events: none; z-index: 100;
    background: #1c2128; border: 1px solid #30363d; border-radius: 6px;
    padding: 8px 12px; font-size: 12px; color: #c9d1d9;
    max-width: 400px; word-break: break-all;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    display: none;
  }
  .tooltip .tt-key { color: #58a6ff; font-weight: 600; }
  .tooltip .tt-label { color: #8b949e; }
  .hint {
    position: fixed; bottom: 16px; right: 16px; z-index: 10;
    font-size: 11px; color: #484f58; pointer-events: none;
  }
</style>
</head>
<body>
<div class="title">
  <strong>hydracode graph</strong> — ${data.nodes.length} nodes, ${data.edges.length} edges — generated ${data.meta.generatedAt.split("T")[0]}
</div>
${cappedNotice}
<div class="tooltip" id="tooltip"></div>
<div class="legend">
  <div class="legend-title">Node type</div>
  <div class="legend-item"><span class="legend-swatch" style="background:#58a6ff;"></span> File (${data.meta.totalFiles})</div>
  <div class="legend-item"><span class="legend-swatch" style="background:#f0883e;"></span> Function (${data.meta.totalFunctions})</div>
  <div class="legend-item"><span class="legend-swatch" style="background:#3fb950;"></span> Class (${data.meta.totalClasses})</div>
  <div class="legend-title" style="margin-top:6px;">Edge type</div>
  <div class="legend-item"><span class="legend-line" style="background:#f0883e;"></span> CALLS</div>
  <div class="legend-item"><span class="legend-line" style="background:#30363d;"></span> CONTAINS</div>
  <div class="legend-item"><span class="legend-line" style="background:#3fb950;"></span> METHOD_OF</div>
</div>
<div class="hint">scroll to zoom · drag to pan · click node to highlight</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
<script>
const DATA = ${JSON.stringify(data)};

const labelColor = {
  File: "#58a6ff",
  Function: "#f0883e",
  ClassEntity: "#3fb950",
  Test: "#d2a8ff",
};
const edgeColor = {
  CALLS: "#f0883e",
  CONTAINS: "#30363d",
  METHOD_OF: "#3fb950",
  IMPORTS: "#8b949e",
  TESTS: "#d2a8ff",
};

// Build adjacency map for click-highlight
const adjacency = new Map();
for (const e of DATA.edges) {
  if (!adjacency.has(e.source)) adjacency.set(e.source, new Set());
  if (!adjacency.has(e.target)) adjacency.set(e.target, new Set());
  adjacency.get(e.source).add(e.target);
  adjacency.get(e.target).add(e.source);
}

// Node degree for sizing
const degree = new Map();
for (const n of DATA.nodes) degree.set(n.id, 0);
for (const e of DATA.edges) {
  degree.set(e.source, (degree.get(e.source) || 0) + 1);
  degree.set(e.target, (degree.get(e.target) || 0) + 1);
}
const maxDegree = Math.max(1, ...degree.values());

const width = window.innerWidth;
const height = window.innerHeight;

const svg = d3.select("body").append("svg")
  .attr("width", width)
  .attr("height", height);

const g = svg.append("g");

// Zoom
const zoom = d3.zoom()
  .scaleExtent([0.05, 8])
  .on("zoom", (event) => g.attr("transform", event.transform));
svg.call(zoom);

// Simulation
const simulation = d3.forceSimulation(DATA.nodes)
  .force("link", d3.forceLink(DATA.edges).id(d => d.id).distance(60))
  .force("charge", d3.forceManyBody().strength(-150))
  .force("center", d3.forceCenter(width / 2, height / 2))
  .force("collide", d3.forceCollide().radius(d => nodeRadius(d.id) + 2));

function nodeRadius(id) {
  const deg = degree.get(id) || 0;
  return 4 + (deg / maxDegree) * 14;
}

// Draw edges
const link = g.append("g")
  .selectAll("line")
  .data(DATA.edges)
  .join("line")
  .attr("stroke", d => edgeColor[d.type] || "#30363d")
  .attr("stroke-width", d => d.type === "CONTAINS" ? 0.5 : 1)
  .attr("stroke-opacity", d => d.type === "CONTAINS" ? 0.3 : 0.6);

// Draw nodes
const node = g.append("g")
  .selectAll("circle")
  .data(DATA.nodes)
  .join("circle")
  .attr("r", d => nodeRadius(d.id))
  .attr("fill", d => labelColor[d.label] || "#8b949e")
  .attr("stroke", "#0d1117")
  .attr("stroke-width", 1)
  .style("cursor", "pointer")
  .call(drag(simulation));

// Tooltip
const tooltip = d3.select("#tooltip");
node.on("mouseover", (event, d) => {
  tooltip.style("display", "block")
    .html('<span class="tt-key">' + d.key + '</span><br><span class="tt-label">' + d.label + ' · degree ' + (degree.get(d.id) || 0) + '</span>');
}).on("mousemove", (event) => {
  tooltip.style("left", (event.clientX + 14) + "px").style("top", (event.clientY - 10) + "px");
}).on("mouseout", () => {
  tooltip.style("display", "none");
});

// Click highlight
let selectedNode = null;
node.on("click", (event, d) => {
  event.stopPropagation();
  if (selectedNode === d.id) {
    resetHighlight();
    selectedNode = null;
    return;
  }
  selectedNode = d.id;
  const neighbors = adjacency.get(d.id) || new Set();
  const connected = new Set([d.id, ...neighbors]);

  node.attr("opacity", n => connected.has(n.id) ? 1 : 0.1);
  link.attr("opacity", e => (e.source.id === d.id || e.target.id === d.id) ? 1 : 0.05)
    .attr("stroke-width", e => (e.source.id === d.id || e.target.id === d.id) ? 2 : (e.type === "CONTAINS" ? 0.5 : 1));
});
svg.on("click", () => { resetHighlight(); selectedNode = null; });

function resetHighlight() {
  node.attr("opacity", 1);
  link.attr("stroke-opacity", d => d.type === "CONTAINS" ? 0.3 : 0.6)
    .attr("stroke-width", d => d.type === "CONTAINS" ? 0.5 : 1);
}

// Tick
simulation.on("tick", () => {
  link
    .attr("x1", d => d.source.x)
    .attr("y1", d => d.source.y)
    .attr("x2", d => d.target.x)
    .attr("y2", d => d.target.y);
  node
    .attr("cx", d => d.x)
    .attr("cy", d => d.y);
});

// Drag
function drag(sim) {
  return d3.drag()
    .on("start", (event, d) => { if (!event.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
    .on("end", (event, d) => { if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null; });
}
</script>
</body>
</html>`;
}
