#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile, access } from 'fs/promises';
import { parseString } from 'xml2js';
import { promisify } from 'util';

const parseXml = promisify(parseString);

const server = new Server(
  { name: 'drawio-mcp-server', version: '3.0.0' },
  { capabilities: { tools: {} } }
);

// ── Helpers ──

function decodeHtml(html) {
  if (!html) return '';
  return html
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#xa;/g, '\n').replace(/&#x9;/g, '\t')
    .replace(/&nbsp;/g, ' ');
}

function stripHtml(html) {
  if (!html) return '';
  return decodeHtml(html).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function detectType(style) {
  if (!style) return 'shape';
  if (style.includes('swimlane')) return 'swimlane';
  if (style.includes('rhombus')) return 'decision';
  if (style.includes('ellipse')) return 'ellipse';
  if (style.includes('cylinder')) return 'database';
  if (style.includes('cloud')) return 'cloud';
  if (style.includes('shape=process')) return 'process';
  if (style.includes('shape=mxgraph.bpmn')) return 'bpmn';
  if (style.includes('shape=image')) return 'icon';
  if (style.includes('edgeStyle') || style.includes('endArrow')) return 'edge';
  if (style.includes('text;')) return 'text';
  if (style.includes('group')) return 'group';
  if (style.includes('rounded')) return 'rounded-rect';
  return 'shape';
}

function detectRelationType(style) {
  if (!style) return 'association';
  if (style.includes('dashed')) return 'dependency';
  if (style.includes('endArrow=block')) return 'inheritance';
  if (style.includes('endArrow=diamondThin') || style.includes('endArrow=diamond')) return 'composition';
  if (style.includes('endArrow=open')) return 'aggregation';
  return 'association';
}

// ── Core: extract all cells from parsed XML ──

function extractAllCells(parsed, pageName = null) {
  const cells = [];

  function processMxCell(cell, page) {
    const attrs = cell.$ || {};
    cells.push({ ...attrs, _children: cell, page });
  }

  function processUserObject(uo, page) {
    const attrs = uo.$ || {};
    // UserObject uses "label" instead of "value"
    const value = attrs.label || attrs.value || '';
    const id = attrs.id || '';

    // Inner mxCell carries style, vertex/edge, parent, geometry
    let innerAttrs = {};
    if (uo.mxCell && uo.mxCell[0] && uo.mxCell[0].$) {
      innerAttrs = uo.mxCell[0].$;
    }

    cells.push({
      id,
      value,
      ...innerAttrs,
      // keep all UserObject custom attributes
      _userObjectAttrs: attrs,
      _children: uo,
      page,
    });
  }

  function traverseRoot(rootArr, page) {
    if (!rootArr) return;
    rootArr.forEach(root => {
      (root.mxCell || []).forEach(c => processMxCell(c, page));
      (root.UserObject || []).forEach(u => processUserObject(u, page));
      // Some diagrams nest objects differently
      (root.object || []).forEach(u => processUserObject(u, page));
    });
  }

  if (!parsed.mxfile || !parsed.mxfile.diagram) return cells;

  parsed.mxfile.diagram.forEach(diagram => {
    const dName = diagram.$ && diagram.$.name;
    if (pageName && dName !== pageName) return;

    (diagram.mxGraphModel || []).forEach(model => {
      traverseRoot(model.root, dName);
    });
  });

  return cells;
}

// ── Tool implementations ──

function getDiagramOverview(parsed, filePath) {
  const pages = (parsed.mxfile && parsed.mxfile.diagram || []).map(d => d.$ && d.$.name || 'Unnamed');
  const allCells = extractAllCells(parsed);
  const withValue = allCells.filter(c => c.value && stripHtml(c.value).length > 0);
  const edges = allCells.filter(c => c.edge === '1' || c.source);

  let result = `📊 Огляд Draw.io діаграми\n\n`;
  result += `📁 Файл: ${filePath}\n`;
  result += `📄 Сторінок: ${pages.length}\n`;
  result += `🔷 Всього елементів: ${allCells.length}\n`;
  result += `📦 З текстом: ${withValue.length}\n`;
  result += `🔗 З'єднань: ${edges.length}\n\n`;
  result += `📑 Сторінки:\n`;
  pages.forEach((p, i) => { result += `  ${i + 1}. ${p}\n`; });
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
    }));

  const MAX = 100;
  let result = `📦 Компоненти${pageName ? ` (сторінка: ${pageName})` : ''}\n\n`;
  result += `Всього: ${components.length}\n\n`;

  // Group by page
  const byPage = {};
  components.forEach(c => {
    const p = c.page || 'Unknown';
    if (!byPage[p]) byPage[p] = [];
    byPage[p].push(c);
  });

  let shown = 0;
  for (const [page, comps] of Object.entries(byPage)) {
    result += `\n📄 ${page} (${comps.length} компонентів):\n`;
    for (const c of comps) {
      if (shown >= MAX) break;
      const preview = c.text.substring(0, 120);
      result += `  • [${c.type}] ${preview}${c.text.length > 120 ? '...' : ''}\n`;
      shown++;
    }
    if (shown >= MAX) {
      result += `\n  ... обрізано, всього ${components.length} компонентів\n`;
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
      id: c.id,
      text: stripHtml(c.value),
      page: c.page,
      isEdge: c.edge === '1' || !!c.source,
    }));

  let result = `📝 Текстовий вміст${pageName ? ` (сторінка: ${pageName})` : ''}\n\n`;
  result += `Всього текстових елементів: ${texts.length}\n`;

  const byPage = {};
  texts.forEach(t => {
    const p = t.page || 'Unknown';
    if (!byPage[p]) byPage[p] = [];
    byPage[p].push(t);
  });

  for (const [page, items] of Object.entries(byPage)) {
    result += `\n📄 ${page} (${items.length}):\n`;
    items.forEach((t, i) => {
      const prefix = t.isEdge ? '→' : '•';
      const preview = t.text.substring(0, 200);
      result += `  ${prefix} ${preview}${t.text.length > 200 ? '...' : ''}\n`;
    });
  }

  return result;
}

function parseRelationships(parsed, pageName) {
  const cells = extractAllCells(parsed, pageName);

  // Build id→text map for resolving source/target names
  const idMap = {};
  cells.forEach(c => {
    if (c.id && c.value) {
      const text = stripHtml(c.value);
      if (text) idMap[c.id] = text.substring(0, 60);
    }
  });

  const edges = cells
    .filter(c => c.edge === '1' || c.source)
    .map(c => ({
      id: c.id,
      source: c.source || '?',
      target: c.target || '?',
      sourceName: idMap[c.source] || c.source || '?',
      targetName: idMap[c.target] || c.target || '?',
      label: c.value ? stripHtml(c.value) : '',
      type: detectRelationType(c.style),
      page: c.page,
    }));

  let result = `🔗 Зв'язки${pageName ? ` (сторінка: ${pageName})` : ''}\n\n`;
  result += `Всього: ${edges.length}\n`;

  const byPage = {};
  edges.forEach(e => {
    const p = e.page || 'Unknown';
    if (!byPage[p]) byPage[p] = [];
    byPage[p].push(e);
  });

  const MAX = 100;
  let shown = 0;
  for (const [page, rels] of Object.entries(byPage)) {
    result += `\n📄 ${page} (${rels.length}):\n`;
    for (const r of rels) {
      if (shown >= MAX) break;
      const label = r.label ? ` [${r.label}]` : '';
      result += `  ${r.sourceName} → ${r.targetName}${label} (${r.type})\n`;
      shown++;
    }
    if (shown >= MAX) {
      result += `\n  ... обрізано\n`;
      break;
    }
  }

  return result;
}

function parseClasses(parsed) {
  const cells = extractAllCells(parsed);
  const classes = cells
    .filter(c => c.value && c.style && (c.style.includes('swimlane') || c.style.includes('shape=process')))
    .map(c => {
      const text = stripHtml(c.value);
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      return {
        name: lines[0] || 'Unnamed',
        members: lines.slice(1),
        page: c.page,
      };
    });

  if (classes.length === 0) return '⚠️ Класів/swimlane не знайдено';

  let result = `🏛️ Класи/Swimlane\n\nВсього: ${classes.length}\n\n`;
  classes.forEach((cls, i) => {
    result += `${i + 1}. ${cls.name} (${cls.page})\n`;
    cls.members.forEach(m => { result += `   • ${m}\n`; });
  });
  return result;
}

// ── Tool registration ──

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_diagram_overview',
      description: 'Get overview of Draw.io file: pages, total elements, file info',
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
      description: 'Parse Draw.io file and extract all components with detailed info',
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
      description: 'Extract class names and their methods from Draw.io diagram',
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
      description: 'Extract relationships between components in Draw.io diagram',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the .drawio file' },
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
    const parsed = await parseXml(content, { explicitArray: true, mergeAttrs: false });

    let result;
    switch (name) {
      case 'get_diagram_overview':
        result = getDiagramOverview(parsed, args.file_path);
        break;
      case 'parse_drawio':
        result = parseComponents(parsed, args.page_name);
        break;
      case 'extract_text_content':
        result = parseTextContent(parsed, args.page_name);
        break;
      case 'extract_classes':
        result = parseClasses(parsed);
        break;
      case 'extract_relationships':
        result = parseRelationships(parsed, args.page_name);
        break;
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
