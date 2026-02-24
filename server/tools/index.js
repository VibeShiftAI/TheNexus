const filesystemTools = require('./filesystem');
const commandTools = require('./command');
const systemTools = require('./system');

const { checkpointMemoryTool, execute: executeCheckpoint } = require('./context');

// Context management tools
const contextTools = [
    {
        ...checkpointMemoryTool,
        execute: executeCheckpoint
    }
];

// Combine all tools
const allTools = [
    ...filesystemTools,
    ...commandTools,
    ...systemTools,

    ...contextTools
];

// Helper to get Zod type name - handles multiple Zod versions
function getZodTypeName(zodType) {
    if (!zodType) return null;
    // v3 uses _def, v4 uses def
    const def = zodType._def || zodType.def;
    if (!def) return null;
    return def.typeName || def.type;
}

function isZodObject(zodType) {
    const typeName = getZodTypeName(zodType);
    return typeName === 'ZodObject' || typeName === 'object';
}

function isZodString(zodType) {
    const typeName = getZodTypeName(zodType);
    return typeName === 'ZodString' || typeName === 'string';
}

function isZodNumber(zodType) {
    const typeName = getZodTypeName(zodType);
    return typeName === 'ZodNumber' || typeName === 'number' || typeName === 'integer';
}

function isZodBoolean(zodType) {
    const typeName = getZodTypeName(zodType);
    return typeName === 'ZodBoolean' || typeName === 'boolean';
}

function isZodArray(zodType) {
    const typeName = getZodTypeName(zodType);
    return typeName === 'ZodArray' || typeName === 'array';
}

function isZodEnum(zodType) {
    const typeName = getZodTypeName(zodType);
    return typeName === 'ZodEnum' || typeName === 'enum';
}

function isOptionalType(zodType) {
    const typeName = getZodTypeName(zodType);
    return typeName === 'ZodOptional' || typeName === 'ZodDefault' ||
        (zodType.isOptional && zodType.isOptional());
}

function getShape(zodType) {
    const def = zodType._def || zodType.def;
    if (!def || !def.shape) return {};
    return typeof def.shape === 'function' ? def.shape() : def.shape;
}


// Helper to convert Zod schema to Gemini/OpenAI JSON schema
function zodToGeminiSchema(zodSchema) {
    if (!zodSchema || !zodSchema._def) return undefined;
    if (!isZodObject(zodSchema)) return undefined;

    const properties = {};
    const required = [];
    const shape = getShape(zodSchema);

    for (const [key, value] of Object.entries(shape)) {
        properties[key] = convertZodTypeGemini(value);
        if (!isOptionalType(value)) {
            required.push(key);
        }
    }

    return { type: "OBJECT", properties, required };
}

function convertZodTypeGemini(zodType) {
    if (!zodType || !zodType._def) return { type: 'STRING' };

    const description = zodType.description;
    let result = {};

    if (isZodString(zodType)) {
        result = { type: 'STRING' };
    } else if (isZodNumber(zodType)) {
        result = { type: 'NUMBER' };
    } else if (isZodBoolean(zodType)) {
        result = { type: 'BOOLEAN' };
    } else if (isZodEnum(zodType)) {
        result = { type: 'STRING', enum: zodType._def.values };
    } else if (isZodArray(zodType)) {
        const def = zodType._def || zodType.def;
        const elementType = def.type || def.element;
        result = { type: 'ARRAY', items: convertZodTypeGemini(elementType) };
    } else if (isZodObject(zodType)) {
        const properties = {};
        const required = [];
        const shape = getShape(zodType);
        for (const [key, value] of Object.entries(shape)) {
            properties[key] = convertZodTypeGemini(value);
            if (!isOptionalType(value)) {
                required.push(key);
            }
        }
        result = { type: 'OBJECT', properties, required };
    } else if (getZodTypeName(zodType) === 'ZodDefault' || getZodTypeName(zodType) === 'ZodOptional') {
        result = convertZodTypeGemini(zodType._def.innerType);
    } else {
        result = { type: 'STRING' };
    }

    if (description) result.description = description;
    return result;
}

// Helper to convert Zod schema to Claude JSON schema
function zodToClaudeSchema(zodSchema) {
    if (!zodSchema || !zodSchema._def) {
        return { type: 'object', properties: {} };
    }
    if (!isZodObject(zodSchema)) {
        return { type: 'object', properties: {} };
    }

    const properties = {};
    const required = [];
    const shape = getShape(zodSchema);

    for (const [key, value] of Object.entries(shape)) {
        properties[key] = convertZodTypeClaude(value);
        if (!isOptionalType(value)) {
            required.push(key);
        }
    }

    const result = { type: 'object', properties };
    if (required.length > 0) result.required = required;
    return result;
}

function convertZodTypeClaude(zodType) {
    if (!zodType || !zodType._def) return { type: 'string' };

    const description = zodType.description;
    let result = {};

    if (isZodString(zodType)) {
        result = { type: 'string' };
    } else if (isZodNumber(zodType)) {
        result = { type: 'number' };
    } else if (isZodBoolean(zodType)) {
        result = { type: 'boolean' };
    } else if (isZodEnum(zodType)) {
        result = { type: 'string', enum: zodType._def.values };
    } else if (isZodArray(zodType)) {
        const def = zodType._def || zodType.def;
        const elementType = def.element;
        result = { type: 'array', items: convertZodTypeClaude(elementType) };
    } else if (isZodObject(zodType)) {
        const properties = {};
        const required = [];
        const shape = getShape(zodType);
        for (const [key, value] of Object.entries(shape)) {
            properties[key] = convertZodTypeClaude(value);
            if (!isOptionalType(value)) {
                required.push(key);
            }
        }
        result = { type: 'object', properties };
        if (required.length > 0) result.required = required;
    } else if (getZodTypeName(zodType) === 'ZodDefault' || getZodTypeName(zodType) === 'ZodOptional') {
        result = convertZodTypeClaude(zodType._def.innerType);
    } else {
        result = { type: 'string' };
    }

    if (description) result.description = description;
    return result;
}

module.exports = {
    tools: allTools,

    getTool: (name) => allTools.find(t => t.name === name),

    getGeminiTools: () => {
        return allTools.map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.schema ? zodToGeminiSchema(tool.schema) : undefined
        }));
    },

    getClaudeTools: () => {
        return allTools.map(tool => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.schema ? zodToClaudeSchema(tool.schema) : { type: 'object', properties: {} }
        }));
    }
};
