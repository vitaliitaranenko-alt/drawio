#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile, access } from 'fs/promises';
import { parseString } from 'xml2js';
import { promisify } from 'util';

const parseXml = promisify(parseString);

const server = new Server(
  {
    name: 'drawio-mcp-server',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_diagram_overview',
        description: 'Get overview of Draw.io file: pages, total elements, file info',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Path to the .drawio or .drawio.xml file',
            },
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
            file_path: {
              type: 'string',
              description: 'Path to the .drawio or .drawio.xml file',
            },
            page_name: {
              type: 'string',
              description: 'Optional: specific page name to parse',
            },
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
            file_path: {
              type: 'string',
              description: 'Path to the .drawio file',
            },
            page_name: {
              type: 'string',
              description: 'Optional: specific page name',
            },
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
            file_path: {
              type: 'string',
              description: 'Path to the .drawio file',
            },
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
            file_path: {
              type: 'string',
              description: 'Path to the .drawio file',
            },
          },
          required: ['file_path'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // Перевірка існування файлу
    try {
      await access(args.file_path);
    } catch {
      return {
        content: [{
          type: 'text',
          text: `❌ Файл не знайдено: ${args.file_path}`,
        }],
        isError: true,
      };
    }

    const content = await readFile(args.file_path, 'utf-8');
    const parsed = await parseXml(content);

    if (name === 'get_diagram_overview') {
      const overview = getDiagramOverview(parsed, args.file_path);
      return {
        content: [{
          type: 'text',
          text: formatOverview(overview),
        }],
      };
    }

    if (name === 'parse_drawio') {
      const cells = extractCells(parsed, args.page_name);
      const components = extractComponents(cells);
      const summary = {
        total_components: components.length,
        by_type: countByType(components),
        components: components.slice(0, 50), // Перші 50 для уникнення переповнення
      };
      
      return {
        content: [{
          type: 'text',
          text: formatComponents(summary),
        }],
      };
    }

    if (name === 'extract_text_content') {
      const cells = extractCells(parsed, args.page_name);
      const textContent = extractTextContent(cells);
      
      return {
        content: [{
          type: 'text',
          text: formatTextContent(textContent),
        }],
      };
    }

    if (name === 'extract_classes') {
      const cells = extractCells(parsed);
      const classes = extractClassInfo(cells);
      
      return {
        content: [{
          type: 'text',
          text: formatClasses(classes),
        }],
      };
    }

    if (name === 'extract_relationships') {
      const cells = extractCells(parsed);
      const relationships = extractRelationships(cells);
      
      return {
        content: [{
          type: 'text',
          text: formatRelationships(relationships),
        }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Помилка: ${error.message}\n\nStack: ${error.stack}`,
      }],
      isError: true,
    };
  }
});

function extractCells(parsed, pageName = null) {
  const cells = [];
  
  function traverse(obj, currentPage = null) {
    if (obj.diagram) {
      obj.diagram.forEach(diagram => {
        const diagramName = diagram.$.name;
        if (!pageName || diagramName === pageName) {
          traverse(diagram, diagramName);
        }
      });
      return;
    }
    
    if (obj.mxCell) {
      cells.push(...obj.mxCell.map(cell => ({ ...cell, page: currentPage })));
    }
    if (obj.mxGraphModel) {
      obj.mxGraphModel.forEach(model => traverse(model, currentPage));
    }
    if (obj.root) {
      obj.root.forEach(root => traverse(root, currentPage));
    }
    if (Array.isArray(obj)) {
      obj.forEach(item => traverse(item, currentPage));
    }
  }
  
  traverse(parsed);
  return cells;
}

function getDiagramOverview(parsed, filePath) {
  const diagrams = [];
  
  if (parsed.mxfile && parsed.mxfile.diagram) {
    parsed.mxfile.diagram.forEach(diagram => {
      const name = diagram.$.name || 'Unnamed';
      diagrams.push(name);
    });
  }
  
  const allCells = extractCells(parsed);
  const components = allCells.filter(cell => cell.$ && cell.$.value);
  const edges = allCells.filter(cell => cell.$ && (cell.$.edge === '1' || cell.$.source));
  
  return {
    file_path: filePath,
    total_pages: diagrams.length,
    pages: diagrams,
    total_elements: allCells.length,
    total_components: components.length,
    total_connections: edges.length,
  };
}

function extractTextContent(cells) {
  const textItems = [];
  
  cells.forEach(cell => {
    if (cell.$ && cell.$.value) {
      const value = decodeHtml(cell.$.value);
      const cleanText = stripHtml(value);
      
      if (cleanText.trim()) {
        textItems.push({
          id: cell.$.id,
          text: cleanText,
          page: cell.page,
        });
      }
    }
  });
  
  return textItems;
}

function decodeHtml(html) {
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#xa;/g, '\n')
    .replace(/&#x9;/g, '\t');
}

function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function countByType(components) {
  const counts = {};
  components.forEach(comp => {
    counts[comp.type] = (counts[comp.type] || 0) + 1;
  });
  return counts;
}

function formatOverview(overview) {
  return `📊 Огляд Draw.io діаграми

📁 Файл: ${overview.file_path}
📄 Сторінок: ${overview.total_pages}
🔷 Елементів: ${overview.total_elements}
📦 Компонентів: ${overview.total_components}
🔗 З'єднань: ${overview.total_connections}

📑 Список сторінок:
${overview.pages.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}`;
}

function formatComponents(summary) {
  let result = `📦 Компоненти діаграми\n\n`;
  result += `Всього: ${summary.total_components}\n\n`;
  result += `За типами:\n`;
  
  Object.entries(summary.by_type).forEach(([type, count]) => {
    result += `  • ${type}: ${count}\n`;
  });
  
  result += `\n📋 Перші ${summary.components.length} компонентів:\n\n`;
  
  summary.components.forEach((comp, i) => {
    const text = stripHtml(decodeHtml(comp.value)).substring(0, 100);
    result += `${i + 1}. [${comp.type}] ${text}${text.length >= 100 ? '...' : ''}\n`;
  });
  
  if (summary.total_components > summary.components.length) {
    result += `\n... та ще ${summary.total_components - summary.components.length} компонентів`;
  }
  
  return result;
}

function formatTextContent(textContent) {
  let result = `📝 Текстовий вміст діаграми\n\n`;
  result += `Всього текстових елементів: ${textContent.length}\n\n`;
  
  const byPage = {};
  textContent.forEach(item => {
    const page = item.page || 'Unknown';
    if (!byPage[page]) byPage[page] = [];
    byPage[page].push(item.text);
  });
  
  Object.entries(byPage).forEach(([page, texts]) => {
    result += `\n📄 ${page}:\n`;
    texts.forEach((text, i) => {
      const preview = text.substring(0, 150);
      result += `  ${i + 1}. ${preview}${text.length > 150 ? '...' : ''}\n`;
    });
  });
  
  return result;
}

function formatClasses(classes) {
  if (classes.length === 0) {
    return '⚠️ Класів не знайдено в діаграмі';
  }
  
  let result = `🏛️ Класи з діаграми\n\n`;
  result += `Всього класів: ${classes.length}\n\n`;
  
  classes.forEach((cls, i) => {
    result += `${i + 1}. ${cls.name}\n`;
    if (cls.fields.length > 0) {
      result += `   Поля:\n`;
      cls.fields.forEach(f => result += `     • ${f}\n`);
    }
    if (cls.methods.length > 0) {
      result += `   Методи:\n`;
      cls.methods.forEach(m => result += `     • ${m}\n`);
    }
    result += '\n';
  });
  
  return result;
}

function formatRelationships(relationships) {
  if (relationships.length === 0) {
    return '⚠️ Зв\'язків не знайдено';
  }
  
  let result = `🔗 Зв'язки між компонентами\n\n`;
  result += `Всього зв'язків: ${relationships.length}\n\n`;
  
  const byType = {};
  relationships.forEach(rel => {
    if (!byType[rel.type]) byType[rel.type] = [];
    byType[rel.type].push(rel);
  });
  
  Object.entries(byType).forEach(([type, rels]) => {
    result += `\n${type.toUpperCase()} (${rels.length}):\n`;
    rels.forEach((rel, i) => {
      const label = rel.label ? ` [${stripHtml(decodeHtml(rel.label))}]` : '';
      result += `  ${i + 1}. ${rel.source} → ${rel.target}${label}\n`;
    });
  });
  
  return result;
}

function extractComponents(cells) {
  return cells
    .filter(cell => cell.$ && cell.$.value)
    .map(cell => ({
      id: cell.$.id,
      value: cell.$.value,
      style: cell.$.style,
      type: detectType(cell.$.style),
      page: cell.page,
    }));
}

function extractClassInfo(cells) {
  return cells
    .filter(cell => cell.$ && cell.$.value && isClassLike(cell.$.style))
    .map(cell => {
      const value = stripHtml(decodeHtml(cell.$.value));
      const lines = value.split('\n').map(l => l.trim()).filter(Boolean);
      
      return {
        id: cell.$.id,
        name: lines[0] || 'Unnamed',
        methods: lines.slice(1).filter(l => l.includes('(') && l.includes(')')),
        fields: lines.slice(1).filter(l => !l.includes('(') || !l.includes(')')),
        page: cell.page,
      };
    });
}

function extractRelationships(cells) {
  return cells
    .filter(cell => cell.$ && (cell.$.edge === '1' || cell.$.source))
    .map(cell => ({
      id: cell.$.id,
      source: cell.$.source || 'unknown',
      target: cell.$.target || 'unknown',
      type: detectRelationType(cell.$.style),
      label: cell.$.value || '',
      page: cell.page,
    }));
}

function detectType(style) {
  if (!style) return 'unknown';
  if (style.includes('swimlane')) return 'swimlane';
  if (style.includes('shape=process')) return 'process';
  if (style.includes('rhombus')) return 'decision';
  if (style.includes('ellipse')) return 'ellipse';
  if (style.includes('cylinder')) return 'database';
  if (style.includes('cloud')) return 'cloud';
  if (style.includes('document')) return 'document';
  if (style.includes('rectangle')) return 'rectangle';
  if (style.includes('rounded')) return 'rounded';
  return 'shape';
}

function isClassLike(style) {
  return style && (style.includes('swimlane') || style.includes('rectangle') || style.includes('shape=process'));
}

function detectRelationType(style) {
  if (!style) return 'association';
  if (style.includes('dashed')) return 'dependency';
  if (style.includes('endArrow=block')) return 'inheritance';
  if (style.includes('endArrow=diamond')) return 'composition';
  if (style.includes('endArrow=open')) return 'aggregation';
  return 'association';
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
