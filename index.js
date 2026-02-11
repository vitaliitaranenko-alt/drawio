#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'fs/promises';
import { parseString } from 'xml2js';
import { promisify } from 'util';

const parseXml = promisify(parseString);

const server = new Server(
  {
    name: 'drawio-mcp-server',
    version: '1.0.0',
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
        name: 'parse_drawio',
        description: 'Parse Draw.io file and extract components, classes, and relationships',
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
    if (name === 'parse_drawio') {
      const content = await readFile(args.file_path, 'utf-8');
      const parsed = await parseXml(content);
      
      const cells = extractCells(parsed);
      const components = extractComponents(cells);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(components, null, 2),
          },
        ],
      };
    }

    if (name === 'extract_classes') {
      const content = await readFile(args.file_path, 'utf-8');
      const parsed = await parseXml(content);
      
      const cells = extractCells(parsed);
      const classes = extractClassInfo(cells);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(classes, null, 2),
          },
        ],
      };
    }

    if (name === 'extract_relationships') {
      const content = await readFile(args.file_path, 'utf-8');
      const parsed = await parseXml(content);
      
      const cells = extractCells(parsed);
      const relationships = extractRelationships(cells);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(relationships, null, 2),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

function extractCells(parsed) {
  const cells = [];
  
  function traverse(obj) {
    if (obj.mxCell) {
      cells.push(...obj.mxCell);
    }
    if (obj.mxGraphModel) {
      traverse(obj.mxGraphModel);
    }
    if (obj.root) {
      traverse(obj.root);
    }
    if (Array.isArray(obj)) {
      obj.forEach(traverse);
    }
  }
  
  traverse(parsed);
  return cells;
}

function extractComponents(cells) {
  return cells
    .filter(cell => cell.$ && cell.$.value)
    .map(cell => ({
      id: cell.$.id,
      value: cell.$.value,
      style: cell.$.style,
      type: detectType(cell.$.style),
    }));
}

function extractClassInfo(cells) {
  return cells
    .filter(cell => cell.$ && cell.$.value && isClassLike(cell.$.style))
    .map(cell => {
      const value = cell.$.value;
      const lines = value.split('\n').map(l => l.trim()).filter(Boolean);
      
      return {
        id: cell.$.id,
        name: lines[0],
        methods: lines.slice(1).filter(l => l.includes('(')),
        fields: lines.slice(1).filter(l => !l.includes('(')),
      };
    });
}

function extractRelationships(cells) {
  return cells
    .filter(cell => cell.$ && (cell.$.edge === '1' || cell.$.source))
    .map(cell => ({
      id: cell.$.id,
      source: cell.$.source,
      target: cell.$.target,
      type: detectRelationType(cell.$.style),
      label: cell.$.value || '',
    }));
}

function detectType(style) {
  if (!style) return 'unknown';
  if (style.includes('swimlane')) return 'class';
  if (style.includes('rectangle')) return 'component';
  if (style.includes('ellipse')) return 'entity';
  return 'shape';
}

function isClassLike(style) {
  return style && (style.includes('swimlane') || style.includes('rectangle'));
}

function detectRelationType(style) {
  if (!style) return 'association';
  if (style.includes('dashed')) return 'dependency';
  if (style.includes('endArrow=block')) return 'inheritance';
  if (style.includes('endArrow=diamond')) return 'composition';
  return 'association';
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
