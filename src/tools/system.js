import config from '../../config/config.js';
import * as db from '../database.js';

export const systemTools = [
  {
    type: 'function',
    function: {
      name: 'token_usage',
      description: 'Cek sisa token hari ini, total pemakaian, limit harian, dan biaya.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'system_info',
      description: 'Lihat konfigurasi sistem: provider, model, batasan token, fitur yang aktif (RAG, cluster).',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'database_stats',
      description: 'Statistik database: jumlah session, total messages, jumlah user, dll.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

export async function executeSystemTool(name, args) {
  switch (name) {
    case 'token_usage': {
      const today = new Date().toISOString().slice(0, 10);
      const usage = db.getDailyUsage(today);
      const limit = config.tokens.dailyLimit;
      const remaining = Math.max(0, limit - usage.total);
      const percent = ((usage.total / limit) * 100).toFixed(1);
      return {
        today: usage.total,
        limit,
        remaining,
        percentUsed: percent + '%',
        cost: usage.cost,
        costLimit: config.tokens.dailyCostLimit,
        providers: usage.providers || [],
        models: usage.models || [],
      };
    }

    case 'system_info': {
      return {
        defaultProvider: config.defaultProvider,
        context: {
          maxTurns: config.context?.maxTurns || 20,
          maxContextTokens: config.context?.maxContextTokens || 131072,
        },
        nvidia: {
          models: config.nvidia.models?.map(m => m.label || m.id) || [],
          defaultModel: config.nvidia.defaultModel,
          keyCount: config.nvidia.apiKeys?.length || 1,
        },
        vector: {
          defaultModel: config.vector.defaultModel,
          models: config.vector.models?.map(m => m.id) || [],
        },
        puter: {
          enabled: config.puter.enabled,
          defaultModel: config.puter.defaultModel,
        },
        rag: {
          enabled: config.rag?.enabled || false,
        },
        tokens: {
          dailyLimit: config.tokens.dailyLimit,
          dailyCostLimit: config.tokens.dailyCostLimit,
        },
      };
    }

    case 'database_stats': {
      const sessions = db.getSessions(1);
      const totalSessions = db.getSessions(10000).length;
      return {
        totalSessions,
        latestSession: sessions[0] || null,
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}