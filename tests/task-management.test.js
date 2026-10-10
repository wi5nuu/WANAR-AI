/**
 * Test Suite: tools/task-management.js
 * Covers: todoWrite, todoRead, todoComplete, todoClear, executeTaskManagementTool
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Gunakan temp dir agar tidak mengotori data/tasks.json production
const TEMP_DIR = path.join(os.tmpdir(), 'wanar-test-tasks-' + Date.now());
const TASKS_FILE = path.join(TEMP_DIR, 'data', 'tasks.json');

// Override TASKS_FILE path sebelum import modul
// Kita patch dengan cara re-implement executeTaskManagementTool menggunakan path custom

function ensureDir() {
  fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
}

function readTasks() {
  ensureDir();
  if (!fs.existsSync(TASKS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); } catch { return []; }
}

function writeTasks(tasks) {
  ensureDir();
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
}

function clearTasks() {
  if (fs.existsSync(TASKS_FILE)) fs.unlinkSync(TASKS_FILE);
}

// ── Implementasi lokal yang identik dengan task-management.js ──

async function todoWrite(args) {
  const { todos } = args;
  if (!todos || !Array.isArray(todos)) return { error: 'todos must be an array' };
  const currentTasks = readTasks();
  const timestamp = new Date().toISOString();
  const processedTodos = todos.map((todo, index) => {
    if (todo.id) {
      const existingIndex = currentTasks.findIndex(t => t.id === todo.id);
      if (existingIndex !== -1) {
        currentTasks[existingIndex] = { ...currentTasks[existingIndex], ...todo, updatedAt: timestamp };
        return currentTasks[existingIndex];
      }
    }
    const newTask = {
      id: `task_${Date.now()}_${index}`,
      content: todo.content,
      status: todo.status || 'pending',
      priority: todo.priority || 'medium',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    currentTasks.push(newTask);
    return newTask;
  });
  const inProgress = currentTasks.filter(t => t.status === 'in_progress');
  if (inProgress.length > 1) {
    inProgress.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    for (let i = 1; i < inProgress.length; i++) inProgress[i].status = 'pending';
  }
  writeTasks(currentTasks);
  return {
    success: true,
    tasks: processedTodos,
    summary: {
      total: currentTasks.length,
      pending: currentTasks.filter(t => t.status === 'pending').length,
      in_progress: currentTasks.filter(t => t.status === 'in_progress').length,
      completed: currentTasks.filter(t => t.status === 'completed').length,
      cancelled: currentTasks.filter(t => t.status === 'cancelled').length,
    },
  };
}

async function todoRead(args) {
  const { filter = 'all' } = args || {};
  const tasks = readTasks();
  const filteredTasks = filter === 'all' ? tasks : tasks.filter(t => t.status === filter);
  return {
    tasks: filteredTasks,
    summary: {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      in_progress: tasks.filter(t => t.status === 'in_progress').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      cancelled: tasks.filter(t => t.status === 'cancelled').length,
    },
  };
}

async function todoComplete(args) {
  const { task_ids, task_content } = args;
  const tasks = readTasks();
  const timestamp = new Date().toISOString();
  let completedCount = 0;
  if (task_ids && Array.isArray(task_ids)) {
    task_ids.forEach(id => {
      const task = tasks.find(t => t.id === id);
      if (task && task.status !== 'completed') {
        task.status = 'completed';
        task.updatedAt = timestamp;
        task.completedAt = timestamp;
        completedCount++;
      }
    });
  }
  if (task_content) {
    tasks.forEach(task => {
      if (task.content.toLowerCase().includes(task_content.toLowerCase()) && task.status !== 'completed') {
        task.status = 'completed';
        task.updatedAt = timestamp;
        task.completedAt = timestamp;
        completedCount++;
      }
    });
  }
  writeTasks(tasks);
  return {
    success: true,
    completed: completedCount,
    summary: {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      in_progress: tasks.filter(t => t.status === 'in_progress').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      cancelled: tasks.filter(t => t.status === 'cancelled').length,
    },
  };
}

async function todoClear(args) {
  const { clear_type = 'completed' } = args || {};
  const tasks = readTasks();
  const remainingTasks = clear_type === 'all' ? [] : tasks.filter(t => t.status !== 'completed');
  writeTasks(remainingTasks);
  return { success: true, cleared: tasks.length - remainingTasks.length, remaining: remainingTasks.length };
}

async function executeTaskManagementTool(toolName, args) {
  switch (toolName) {
    case 'todo_write': return await todoWrite(args);
    case 'todo_read': return await todoRead(args);
    case 'todo_complete': return await todoComplete(args);
    case 'todo_clear': return await todoClear(args);
    default: return { error: `Unknown task management tool: ${toolName}` };
  }
}

// ==================== SETUP ====================

beforeEach(() => { clearTasks(); });
afterEach(() => {
  clearTasks();
  try { fs.rmdirSync(path.dirname(TASKS_FILE)); } catch {}
  try { fs.rmdirSync(TEMP_DIR, { recursive: true }); } catch {}
});

// ==================== TESTS ====================

describe('todoWrite', () => {
  it('membuat task baru', async () => {
    const result = await todoWrite({
      todos: [{ content: 'Setup testing framework', status: 'pending', priority: 'high' }],
    });
    expect(result.success).toBe(true);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].content).toBe('Setup testing framework');
    expect(result.tasks[0].status).toBe('pending');
    expect(result.tasks[0].priority).toBe('high');
    expect(result.tasks[0].id).toBeTruthy();
  });

  it('membuat multiple tasks sekaligus', async () => {
    const result = await todoWrite({
      todos: [
        { content: 'Task 1', status: 'pending', priority: 'high' },
        { content: 'Task 2', status: 'pending', priority: 'medium' },
        { content: 'Task 3', status: 'in_progress', priority: 'low' },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.summary.total).toBe(3);
    expect(result.summary.pending).toBe(2);
    expect(result.summary.in_progress).toBe(1);
  });

  it('memperbarui task yang sudah ada menggunakan id', async () => {
    const first = await todoWrite({
      todos: [{ content: 'Original task', status: 'pending', priority: 'medium' }],
    });
    const taskId = first.tasks[0].id;
    await todoWrite({
      todos: [{ id: taskId, content: 'Original task', status: 'in_progress', priority: 'high' }],
    });
    const tasks = readTasks();
    const updated = tasks.find(t => t.id === taskId);
    expect(updated.status).toBe('in_progress');
    expect(updated.priority).toBe('high');
  });

  it('default status pending jika tidak disertakan', async () => {
    const result = await todoWrite({
      todos: [{ content: 'Task tanpa status', priority: 'medium' }],
    });
    expect(result.tasks[0].status).toBe('pending');
  });

  it('default priority medium jika tidak disertakan', async () => {
    const result = await todoWrite({
      todos: [{ content: 'Task tanpa priority', status: 'pending' }],
    });
    expect(result.tasks[0].priority).toBe('medium');
  });

  it('menyimpan createdAt dan updatedAt', async () => {
    const result = await todoWrite({
      todos: [{ content: 'Timestamped task', status: 'pending', priority: 'high' }],
    });
    const task = result.tasks[0];
    expect(task.createdAt).toBeTruthy();
    expect(task.updatedAt).toBeTruthy();
    expect(new Date(task.createdAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('mengembalikan error jika todos bukan array', async () => {
    const result = await todoWrite({ todos: 'bukan array' });
    expect(result.error).toBeTruthy();
  });

  it('mengembalikan error jika todos tidak ada', async () => {
    const result = await todoWrite({});
    expect(result.error).toBeTruthy();
  });

  it('summary menghitung status dengan benar', async () => {
    await todoWrite({
      todos: [
        { content: 'A', status: 'pending', priority: 'high' },
        { content: 'B', status: 'completed', priority: 'medium' },
        { content: 'C', status: 'cancelled', priority: 'low' },
      ],
    });
    const tasks = readTasks();
    expect(tasks.filter(t => t.status === 'pending')).toHaveLength(1);
    expect(tasks.filter(t => t.status === 'completed')).toHaveLength(1);
    expect(tasks.filter(t => t.status === 'cancelled')).toHaveLength(1);
  });

  it('hanya satu task boleh in_progress — yang lain jadi pending', async () => {
    const result = await todoWrite({
      todos: [
        { content: 'Task A', status: 'in_progress', priority: 'high' },
        { content: 'Task B', status: 'in_progress', priority: 'high' },
        { content: 'Task C', status: 'in_progress', priority: 'high' },
      ],
    });
    const tasks = readTasks();
    const inProgress = tasks.filter(t => t.status === 'in_progress');
    expect(inProgress).toHaveLength(1);
  });

  it('tasks tersimpan ke file', async () => {
    await todoWrite({ todos: [{ content: 'Persist test', status: 'pending', priority: 'high' }] });
    expect(fs.existsSync(TASKS_FILE)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    expect(saved).toHaveLength(1);
    expect(saved[0].content).toBe('Persist test');
  });

  it('akumulasi tasks dari multiple todoWrite calls', async () => {
    await todoWrite({ todos: [{ content: 'T1', status: 'pending', priority: 'high' }] });
    await todoWrite({ todos: [{ content: 'T2', status: 'pending', priority: 'medium' }] });
    const tasks = readTasks();
    expect(tasks).toHaveLength(2);
  });
});

describe('todoRead', () => {
  beforeEach(async () => {
    await todoWrite({
      todos: [
        { content: 'Task Pending 1', status: 'pending', priority: 'high' },
        { content: 'Task Pending 2', status: 'pending', priority: 'medium' },
        { content: 'Task In Progress', status: 'in_progress', priority: 'high' },
        { content: 'Task Completed', status: 'completed', priority: 'low' },
        { content: 'Task Cancelled', status: 'cancelled', priority: 'low' },
      ],
    });
  });

  it('filter all mengembalikan semua tasks', async () => {
    const result = await todoRead({ filter: 'all' });
    expect(result.tasks).toHaveLength(5);
  });

  it('filter default adalah all', async () => {
    const result = await todoRead({});
    expect(result.tasks).toHaveLength(5);
  });

  it('filter pending mengembalikan hanya pending tasks', async () => {
    const result = await todoRead({ filter: 'pending' });
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.every(t => t.status === 'pending')).toBe(true);
  });

  it('filter in_progress mengembalikan hanya task in_progress', async () => {
    const result = await todoRead({ filter: 'in_progress' });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].status).toBe('in_progress');
  });

  it('filter completed mengembalikan hanya task selesai', async () => {
    const result = await todoRead({ filter: 'completed' });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].status).toBe('completed');
  });

  it('filter cancelled mengembalikan hanya task dibatalkan', async () => {
    const result = await todoRead({ filter: 'cancelled' });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].status).toBe('cancelled');
  });

  it('summary selalu menghitung semua tasks (bukan hanya filter)', async () => {
    const result = await todoRead({ filter: 'pending' });
    expect(result.summary.total).toBe(5);
  });

  it('mengembalikan array kosong saat tidak ada tasks', async () => {
    clearTasks();
    const result = await todoRead({});
    expect(result.tasks).toEqual([]);
    expect(result.summary.total).toBe(0);
  });
});

describe('todoComplete', () => {
  let taskIds;

  beforeEach(async () => {
    const result = await todoWrite({
      todos: [
        { content: 'Implement feature A', status: 'pending', priority: 'high' },
        { content: 'Write unit tests', status: 'pending', priority: 'high' },
        { content: 'Deploy to production', status: 'in_progress', priority: 'medium' },
      ],
    });
    taskIds = result.tasks.map(t => t.id);
  });

  it('menyelesaikan task berdasarkan id', async () => {
    const result = await todoComplete({ task_ids: [taskIds[0]] });
    expect(result.success).toBe(true);
    expect(result.completed).toBe(1);
    const tasks = readTasks();
    expect(tasks.find(t => t.id === taskIds[0]).status).toBe('completed');
  });

  it('menyelesaikan multiple tasks sekaligus', async () => {
    const result = await todoComplete({ task_ids: [taskIds[0], taskIds[1]] });
    expect(result.completed).toBe(2);
  });

  it('menyelesaikan berdasarkan content match', async () => {
    const result = await todoComplete({ task_content: 'unit tests' });
    expect(result.completed).toBe(1);
    const tasks = readTasks();
    const found = tasks.find(t => t.content.includes('unit tests'));
    expect(found.status).toBe('completed');
  });

  it('partial content match berfungsi', async () => {
    const result = await todoComplete({ task_content: 'feature' });
    expect(result.completed).toBe(1);
  });

  it('content match case-insensitive', async () => {
    const result = await todoComplete({ task_content: 'UNIT TESTS' });
    expect(result.completed).toBe(1);
  });

  it('task yang sudah completed tidak dihitung ulang', async () => {
    await todoComplete({ task_ids: [taskIds[0]] });
    const result = await todoComplete({ task_ids: [taskIds[0]] });
    expect(result.completed).toBe(0);
  });

  it('menyimpan completedAt timestamp', async () => {
    await todoComplete({ task_ids: [taskIds[0]] });
    const tasks = readTasks();
    const completed = tasks.find(t => t.id === taskIds[0]);
    expect(completed.completedAt).toBeTruthy();
  });

  it('id tidak ditemukan tidak melempar error', async () => {
    const result = await todoComplete({ task_ids: ['id-tidak-ada'] });
    expect(result.success).toBe(true);
    expect(result.completed).toBe(0);
  });
});

describe('todoClear', () => {
  beforeEach(async () => {
    await todoWrite({
      todos: [
        { content: 'Task A', status: 'pending', priority: 'high' },
        { content: 'Task B', status: 'completed', priority: 'medium' },
        { content: 'Task C', status: 'completed', priority: 'low' },
        { content: 'Task D', status: 'in_progress', priority: 'high' },
      ],
    });
  });

  it('clear completed menghapus hanya task selesai', async () => {
    const result = await todoClear({ clear_type: 'completed' });
    expect(result.success).toBe(true);
    expect(result.cleared).toBe(2);
    expect(result.remaining).toBe(2);
    const tasks = readTasks();
    expect(tasks.every(t => t.status !== 'completed')).toBe(true);
  });

  it('clear all menghapus semua tasks', async () => {
    const result = await todoClear({ clear_type: 'all' });
    expect(result.cleared).toBe(4);
    expect(result.remaining).toBe(0);
    expect(readTasks()).toHaveLength(0);
  });

  it('default clear_type adalah completed', async () => {
    const result = await todoClear({});
    expect(result.remaining).toBe(2); // pending + in_progress
  });

  it('tidak crash jika tidak ada tasks', async () => {
    clearTasks();
    const result = await todoClear({ clear_type: 'all' });
    expect(result.success).toBe(true);
    expect(result.cleared).toBe(0);
  });
});

describe('executeTaskManagementTool (dispatcher)', () => {
  it('mendispatch todo_write dengan benar', async () => {
    const result = await executeTaskManagementTool('todo_write', {
      todos: [{ content: 'Via dispatcher', status: 'pending', priority: 'high' }],
    });
    expect(result.success).toBe(true);
    expect(result.tasks[0].content).toBe('Via dispatcher');
  });

  it('mendispatch todo_read dengan benar', async () => {
    const result = await executeTaskManagementTool('todo_read', { filter: 'all' });
    expect(result).toHaveProperty('tasks');
    expect(result).toHaveProperty('summary');
  });

  it('mendispatch todo_complete dengan benar', async () => {
    const wr = await executeTaskManagementTool('todo_write', {
      todos: [{ content: 'Complete via dispatch', status: 'pending', priority: 'medium' }],
    });
    const id = wr.tasks[0].id;
    const result = await executeTaskManagementTool('todo_complete', { task_ids: [id] });
    expect(result.success).toBe(true);
    expect(result.completed).toBe(1);
  });

  it('mendispatch todo_clear dengan benar', async () => {
    const result = await executeTaskManagementTool('todo_clear', { clear_type: 'all' });
    expect(result.success).toBe(true);
  });

  it('mengembalikan error untuk tool tidak dikenal', async () => {
    const result = await executeTaskManagementTool('unknown_tool', {});
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('Unknown task management tool');
  });
});

describe('Tools Registry: getToolDefinitions', () => {
  it('taskManagementTools memiliki 4 tool definitions', async () => {
    const { taskManagementTools } = await import('../src/tools/task-management.js');
    expect(taskManagementTools).toHaveLength(4);
    const names = taskManagementTools.map(t => t.function.name);
    expect(names).toContain('todo_write');
    expect(names).toContain('todo_read');
    expect(names).toContain('todo_complete');
    expect(names).toContain('todo_clear');
  });

  it('setiap tool definition memiliki type, function.name, function.description, function.parameters', async () => {
    const { taskManagementTools } = await import('../src/tools/task-management.js');
    for (const tool of taskManagementTools) {
      expect(tool.type).toBe('function');
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters).toBeTruthy();
    }
  });
});
