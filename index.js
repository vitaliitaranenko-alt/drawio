#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile, access } from 'fs/promises';
import { parseString } from 'xml2js';
import { promisify } from 'util';
import { inflateRaw } from 'zlib';

const parseXml = promisify(parseString);
const inflateRawAsync = promisify(inflateRaw);

const server = new Server(
  { name: 'drawio-mcp-server', version: '4.0.0' },
  { capabilities: { tools: {} } }
);

// ── Helpers ──

function decodeHtml(html) {
  if (!html) return '';
  return html
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#xa;/g, '\n').replace(/&#x9;/g, '\t')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'");
}

function stripHtml(html) {
  if (!html) return '';
  return decodeHtml(html).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function detectType(style) {
  if (!style) return 'shape';
  const s = style.toLowerCase();
  if (s.includes('swimlane')) return 'swimlane';
  if (s.includes('rhombus')) return 'decision';
  if (s.includes('ellipse') && s.includes('double')) return 'start/end';
  if (s.includes('ellipse')) return 'ellipse';
  if (s.includes('cylinder')) return 'database';
  if (s.includes('cloud')) return 'cloud';
  if (s.includes('shape=process')) return 'process';
  if (s.includes('shape=mxgraph.bpmn')) return 'bpmn';
  if (s.includes('shape=image')) return 'icon';
  if (s.includes('shape=hexagon')) return 'hexagon';
  if (s.includes('shape=parallelogram')) return 'parallelogram';
  if (s.includes('shape=document')) return 'document';
  if (s.includes('shape=callout')) return 'callout';
  if (s.includes('shape=note')) return 'note';
  if (s.includes('text;')) return 'text';
  if (s.includes('group')) return 'group';
  if (s.includes('rounded')) return 'rounded-rect';
  return 'shape';
}

function detectRelationType(style) {
  if (!style) return 'flow';
  if (style.includes('dashed')) return 'dependency';
  if (style.includes('endArrow=block') && style.includes('endFill=0')) return 'inheritance';
  if (style.includes('endArrow=block')) return 'flow';
  if (style.includes('endArrow=diamondThin') || style.includes('endArrow=diamond')) return 'composition';
  if (style.includes('endArrow=open') && style.includes('dashed')) return 'async/message';
  if (style.includes('endArrow=open')) return 'aggregation';
  return 'flow';
}

// ── Decode compressed diagrams (base64 + deflate + URL-encoded) ──

async function decompressDiagram(encoded) {
  try {
    const decoded = Buffer.from(encoded, 'base64');
    const inflated = await inflateRawAsync(decoded);
    return decodeURIComponent(inflated.toString('utf-8'));
  } catch {
    return null;
  }
}

// ── Core: extract all cells with hierarchy ──

async function parseDiagramXml(parsed) {
  // Handle compressed diagrams: if diagram has text content instead of mxGraphModel
  if (parsed.mxfile && parsed.mxfile.diagram) {
    for (const diagram of parsed.mxfile.diagram) {
      if (!diagram.mxGraphModel && diagram._ && diagram._.trim()) {
        const xml = await decompressDiagram(diagram._.trim());
        if (xml) {
          const inner = await parseXml(xml, { explicitArray: true, mergeAttrs: false });
          diagram.mxGraphModel = inner.mxGraphModel ? [inner] : [inner.mxGraphModel || inner];
          // Re-wrap if needed
          if (!diagram.mxGraphModel[0].root && inner.mxGraphModel) {
            diagram.mxGraphModel = [inner.mxGraphModel];
          }
        }
      }
    }
  }
  return parsed;
}

function extractAllCells(parsed, pageName = null) {
  const cells = [];

  function addCell(attrs, page, extraAttrs = {}) {
    cells.push({ ...attrs, ...extraAttrs, page });
  }

  if (!parsed.mxfile || !parsed.mxfile.diagram) return cells;

  parsed.mxfile.diagram.forEach(diagram => {
    const dName = diagram.$ && diagram.$.name;
    if (pageName && dName !== pageName) return;

    (diagram.mxGraphModel || []).forEach(model => {
      const modelObj = model.$ ? model : (model.mxGraphModel ? model.mxGraphModel[0] : model);
      (modelObj.root || []).forEach(root => {
        // mxCell elements
        (root.mxCell || []).forEach(c => {
          addCell(c.$ || {}, dName);
        });
        // UserObject / object elements (label → value)
        for (const tag of ['UserObject', 'object']) {
          (root[tag] || []).forEach(uo => {
            const uoAttrs = uo.$ || {};
            let innerAttrs = {};
            if (uo.mxCell && uo.mxCell[0] && uo.mxCell[0].$) {
              innerAttrs = uo.mxCell[0].$;
            }
            addCell(
              { id: uoAttrs.id, value: uoAttrs.label || uoAttrs.value || '', ...innerAttrs },
              dName,
              { _customAttrs: uoAttrs }
            );
          });
        }
      });
    });
  });

  return cells;
}

function buildHierarchy(cells) {
  const idMap = {};
  cells.forEach(c => {
    if (c.id) {
      idMap[c.id] = {
        id: c.id,
        text: stripHtml(c.value),
        type: detectType(c.style),
        parent: c.parent,
        isEdge: c.edge === '1' || !!c.source,
        source: c.source,
        target: c.target,
        style: c.style,
        page: c.page,
        link: c._customAttrs && c._customAttrs.link,
        children: [],
      };
    }
  });

  // Build tree
  Object.values(idMap).forEach(node => {
    if (node.parent && idMap[node.parent]) {
      idMap[node.parent].children.push(node);
    }
  });

  return idMap;
}

// ── Tool: full_diagram ──

function renderFullDiagram(parsed, pageName) {
  const cells = extractAllCells(parsed, pageName);
  const hierarchy = buildHierarchy(cells);

  const pages = {};
  cells.forEach(c => {
    if (!pages[c.page]) pages[c.page] = [];
  });

  // Find top-level containers per page (swimlanes, groups with no meaningful parent)
  const topLevel = Object.values(hierarchy).filter(n =>
    (!n.parent || n.parent === '0' || n.parent === '1') && n.text && !n.isEdge
  );

  // Group by page
  const byPage = {};
  topLevel.forEach(n => {
    if (!byPage[n.page]) byPage[n.page] = [];
    byPage[n.page].push(n);
  });

  let result = '';

  const renderNode = (node, indent = '') => {
    if (!node.text && node.children.length === 0) return '';
    let line = '';
    if (node.text) {
      const typeTag = node.type !== 'shape' && node.type !== 'text' ? `[${node.type}] ` : '';
      const linkTag = node.link ? ` 🔗 ${node.link}` : '';
      line = `${indent}${typeTag}${node.text}${linkTag}\n`;
    }
    // Render children (non-edges first, then edges)
    const childNodes = node.children.filter(c => !c.isEdge && c.text);
    const childEdges = node.children.filter(c => c.isEdge && c.text);
    childNodes.forEach(c => { line += renderNode(c, indent + '  '); });
    childEdges.forEach(c => { line += `${indent}  → ${c.text}\n`; });
    return line;
  };

  for (const [page, nodes] of Object.entries(byPage)) {
    result += `\n${'═'.repeat(80)}\n📄 ${page}\n${'═'.repeat(80)}\n\n`;

    // Render structured nodes
    nodes.forEach(n => { result += renderNode(n); });

    // Render edges (connections) for this page
    const pageEdges = Object.values(hierarchy).filter(n => n.page === page && n.isEdge);
    if (pageEdges.length > 0) {
      result += `\n  Зв'язки:\n`;
      pageEdges.forEach(e => {
        const src = hierarchy[e.source];
        const tgt = hierarchy[e.target];
        const srcName = (src && src.text) || e.source || '?';
        const tgtName = (tgt && tgt.text) || e.target || '?';
        const label = e.text ? ` [${e.text}]` : '';
        result += `    ${srcName.substring(0, 50)} → ${tgtName.substring(0, 50)}${label}\n`;
      });
    }
  }

  // Also collect orphan text nodes (parent exists but parent has no text — floating labels)
  const orphans = Object.values(hierarchy).filter(n =>
    n.text && !n.isEdge &&
    n.parent && n.parent !== '0' && n.parent !== '1' &&
    hierarchy[n.parent] && !hierarchy[n.parent].text &&
    !hierarchy[n.parent].children.some(c => c.id !== n.id && c.text)
  );

  if (orphans.length > 0) {
    const orphanByPage = {};
    orphans.forEach(o => {
      if (!orphanByPage[o.page]) orphanByPage[o.page] = [];
      orphanByPage[o.page].push(o);
    });
    for (const [page, items] of Object.entries(orphanByPage)) {
      // Only add if not already rendered
      result += `\n  📌 Додаткові елементи (${page}):\n`;
      items.forEach(o => {
        result += `    • ${o.text.substring(0, 150)}\n`;
      });
    }
  }

  return result;
}

// ── Tool implementations ──

function getDiagramOverview(parsed, filePath) {
  const pages = (parsed.mxfile && parsed.mxfile.diagram || []).map(d => d.$ && d.$.name || 'Unnamed');
  const allCells = extractAllCells(parsed);
  const withValue = allCells.filter(c => c.value && stripHtml(c.value).length > 0);
  const edges = allCells.filter(c => c.edge === '1' || c.source);
  const hierarchy = buildHierarchy(allCells);
  const swimlanes = Object.values(hierarchy).filter(n => n.type === 'swimlane');
  const decisions = Object.values(hierarchy).filter(n => n.type === 'decision');
  const links = Object.values(hierarchy).filter(n => n.link);

  let result = `📊 Огляд Draw.io діаграми\n\n`;
  result += `📁 Файл: ${filePath}\n`;
  result += `📄 Сторінок: ${pages.length}\n`;
  result += `🔷 Всього елементів: ${allCells.length}\n`;
  result += `📦 З текстом: ${withValue.length}\n`;
  result += `🔗 З'єднань: ${edges.length}\n`;
  result += `🏊 Swimlanes: ${swimlanes.length}\n`;
  result += `❓ Рішення (ромби): ${decisions.length}\n`;
  result += `🔗 Посилання: ${links.length}\n\n`;
  result += `📑 Сторінки:\n`;
  pages.forEach((p, i) => { result += `  ${i + 1}. ${p}\n`; });

  if (links.length > 0) {
    result += `\n🔗 Посилання в діаграмі:\n`;
    links.forEach(l => {
      result += `  • ${l.text.substring(0, 60)} → ${l.link}\n`;
    });
  }

  return result;
}

function parseComponents(parsed, pageName) {
  const cells = extractAllCells(parsed, pageName);
  const components = cells
    .filter(c => c.value && stripHtml(c.value).length > 0 && c.edge !== '1' && !c.source)
    .map(c => ({
      id: c.id,
      text: stripHtml(c.value),
      type: detectType(c.style),
      page: c.page,
      parent: c.parent,
      link: c._customAttrs && c._customAttrs.link,
    }));

  const MAX = 150;
  let result = `📦 Компоненти${pageName ? ` (сторінка: ${pageName})` : ''}\n\n`;
  result += `Всього: ${components.length}\n\n`;

  const byPage = {};
  components.forEach(c => {
    const p = c.page || 'Unknown';
    if (!byPage[p]) byPage[p] = [];
    byPage[p].push(c);
  });

  let shown = 0;
  for (const [page, comps] of Object.entries(byPage)) {
    result += `\n📄 ${page} (${comps.length}):\n`;
    for (const c of comps) {
      if (shown >= MAX) break;
      const preview = c.text.substring(0, 120);
      const linkTag = c.link ? ` 🔗` : '';
      result += `  • [${c.type}] ${preview}${c.text.length > 120 ? '...' : ''}${linkTag}\n`;
      shown++;
    }
    if (shown >= MAX) {
      result += `\n  ... обрізано, всього ${components.length}\n`;
      break;
    }
  }

  return result;
}

function parseTextContent(parsed, pageName) {
  const cells = extractAllCells(parsed, pageName);
  const texts = cells
    .filter(c => c.value && stripHtml(c.value).length > 0)
    .map(c => ({
      text: stripHtml(c.value),
      page: c.page,
      isEdge: c.edge === '1' || !!c.source,
    }));

  let result = `📝 Текстовий вміст${pageName ? ` (сторінка: ${pageName})` : ''}\n\n`;
  result += `Всього: ${texts.length}\n`;

  const byPage = {};
  texts.forEach(t => {
    const p = t.page || 'Unknown';
    if (!byPage[p]) byPage[p] = [];
    byPage[p].push(t);
  });

  for (const [page, items] of Object.entries(byPage)) {
    result += `\n📄 ${page} (${items.length}):\n`;
    items.forEach(t => {
      const prefix = t.isEdge ? '→' : '•';
      const preview = t.text.substring(0, 200);
      result += `  ${prefix} ${preview}${t.text.length > 200 ? '...' : ''}\n`;
    });
  }

  return result;
}

function parseRelationships(parsed, pageName) {
  const cells = extractAllCells(parsed, pageName);
  const hierarchy = buildHierarchy(cells);

  const edges = Object.values(hierarchy).filter(n => n.isEdge);

  let result = `🔗 Зв'язки${pageName ? ` (сторінка: ${pageName})` : ''}\n\nВсього: ${edges.length}\n`;

  const byPage = {};
  edges.forEach(e => {
    const p = e.page || 'Unknown';
    if (!byPage[p]) byPage[p] = [];
    byPage[p].push(e);
  });

  const MAX = 150;
  let shown = 0;
  for (const [page, rels] of Object.entries(byPage)) {
    result += `\n📄 ${page} (${rels.length}):\n`;
    for (const r of rels) {
      if (shown >= MAX) break;
      const src = hierarchy[r.source];
      const tgt = hierarchy[r.target];
      const srcName = (src && src.text) ? src.text.substring(0, 50) : (r.source || '?');
      const tgtName = (tgt && tgt.text) ? tgt.text.substring(0, 50) : (r.target || '?');
      const label = r.text ? ` [${r.text}]` : '';
      result += `  ${srcName} → ${tgtName}${label} (${detectRelationType(r.style)})\n`;
      shown++;
    }
    if (shown >= MAX) { result += `\n  ... обрізано\n`; break; }
  }

  return result;
}

function parseClasses(parsed) {
  const cells = extractAllCells(parsed);
  const classes = cells
    .filter(c => c.value && c.style && (c.style.includes('swimlane') || c.style.includes('shape=process')))
    .map(c => ({ name: stripHtml(c.value), page: c.page }));

  if (classes.length === 0) return '⚠️ Класів/swimlane не знайдено';

  let result = `🏛️ Swimlanes/Класи\n\nВсього: ${classes.length}\n\n`;
  classes.forEach((cls, i) => { result += `${i + 1}. ${cls.name} (${cls.page})\n`; });
  return result;
}

// ── Tool registration ──

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_diagram_overview',
      description: 'Get overview of Draw.io file: pages, total elements, connections, swimlanes, links',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the .drawio or .drawio.xml file' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'parse_drawio',
      description: 'Parse Draw.io file and extract all components grouped by page',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the .drawio or .drawio.xml file' },
          page_name: { type: 'string', description: 'Optional: specific page name to parse' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'extract_text_content',
      description: 'Extract all text content from diagram (labels, descriptions, notes)',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the .drawio file' },
          page_name: { type: 'string', description: 'Optional: specific page name' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'extract_classes',
      description: 'Extract swimlanes and class-like containers from Draw.io diagram',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the .drawio file' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'extract_relationships',
      description: 'Extract relationships/connections between components with resolved names',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the .drawio file' },
          page_name: { type: 'string', description: 'Optional: specific page name' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'full_diagram',
      description: 'Read FULL diagram as structured text with hierarchy, connections, and all details. Best for understanding the complete flow.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the .drawio or .drawio.xml file' },
          page_name: { type: 'string', description: 'Optional: specific page name for focused reading' },
        },
        required: ['file_path'],
      },
    },
  ],
}));

// ── Tool dispatch ──

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    await access(args.file_path);
  } catch {
    return { content: [{ type: 'text', text: `❌ Файл не знайдено: ${args.file_path}` }], isError: true };
  }

  try {
    const content = await readFile(args.file_path, 'utf-8');
    let parsed = await parseXml(content, { explicitArray: true, mergeAttrs: false });
    parsed = await parseDiagramXml(parsed);

    let result;
    switch (name) {
      case 'get_diagram_overview':
        result = getDiagramOverview(parsed, args.file_path); break;
      case 'parse_drawio':
        result = parseComponents(parsed, args.page_name); break;
      case 'extract_text_content':
        result = parseTextContent(parsed, args.page_name); break;
      case 'extract_classes':
        result = parseClasses(parsed); break;
      case 'extract_relationships':
        result = parseRelationships(parsed, args.page_name); break;
      case 'full_diagram':
        result = renderFullDiagram(parsed, args.page_name); break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: 'text', text: result }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `❌ Помилка: ${error.message}\n${error.stack}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
