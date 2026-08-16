import fs from 'fs';
import path from 'path';

// ============================================
// WANAR AI - TASK MANAGEMENT SYSTEM
// by Wisnu Alfian Nur Ashar
// ============================================
// Task planning, tracking, and management

const TASKS_FILE = path.join(process.cwd(), 'data', 'tasks.json');

// Ensure data directory exists
function ensureDataDir() {
  const dataDir = path.dirname(TASKS_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

// Read tasks from file
function readTasks() {
  ensureDataDir();
  if (!fs.existsSync(TASKS_FILE)) {
    return [];
  }
  try {
    const data = fs.readFileSync(TASKS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading tasks:', error);
    return [];
  }
}

// Write tasks to file
function writeTasks(tasks) {
  ensureDataDir();
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error writing tasks:', error);
    return false;
  }
}

export const taskManagementTools = [
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: 'Create and maintain a structured task list for the current coding session.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'Array of todo items with content, status, and priority',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'Brief description of the task' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'], description: 'Current status' },
                priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Priority level' },
                id: { type: 'string', description: 'Optional ID for updating existing task' }
              },
              required: ['content', 'status', 'priority']
            }
          }
        },
        required: ['todos']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo_read',
      description: 'Read the current task list.',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', enum: ['all', 'pending', 'in_progress', 'completed', 'cancelled'], description: 'Filter tasks by status' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo_complete',
      description: 'Mark specific task(s) as completed.',
      parameters: {
        type: 'object',
        properties: {
          task_ids: { type: 'array', items: { type: 'string' }, description: 'Array of task IDs to mark as completed' },
          task_content: { type: 'string', description: 'Or match by content (partial match supported)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo_clear',
      description: 'Clear all tasks or clear completed tasks only',
      parameters: {
        type: 'object',
        properties: {
          clear_type: { type: 'string', enum: ['all', 'completed'], description: 'Clear all tasks or only completed ones' }
        }
      }
    }
  }
];

export async function executeTaskManagementTool(toolName, args) {
  switch (toolName) {
    case 'todo_write':
      return await todoWrite(args);
    case 'todo_read':
      return await todoRead(args);
    case 'todo_complete':
      return await todoComplete(args);
    case 'todo_clear':
      return await todoClear(args);
    default:
      return { error: `Unknown task management tool: ${toolName}` };
  }
}

// ── TodoWrite ──
async function todoWrite(args) {
  const { todos } = args;
  
  if (!todos || !Array.isArray(todos)) {
    return { error: 'todos must be an array' };
  }

  const currentTasks = readTasks();
  const timestamp = new Date().toISOString();

  // Process each todo
  const processedTodos = todos.map((todo, index) => {
    // If has ID, update existing task
    if (todo.id) {
      const existingIndex = currentTasks.findIndex(t => t.id === todo.id);
      if (existingIndex !== -1) {
        currentTasks[existingIndex] = {
          ...currentTasks[existingIndex],
          ...todo,
          updatedAt: timestamp
        };
        return currentTasks[existingIndex];
      }
    }

    // Create new task
    const newTask = {
      id: `task_${Date.now()}_${index}`,
      content: todo.content,
      status: todo.status || 'pending',
      priority: todo.priority || 'medium',
      createdAt: timestamp,
      updatedAt: timestamp
    };

    currentTasks.push(newTask);
    return newTask;
  });

  // Ensure only ONE task is in_progress at a time
  const inProgressTasks = currentTasks.filter(t => t.status === 'in_progress');
  if (inProgressTasks.length > 1) {
    // Keep the most recently updated one
    inProgressTasks.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    for (let i = 1; i < inProgressTasks.length; i++) {
      inProgressTasks[i].status = 'pending';
    }
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
      cancelled: currentTasks.filter(t => t.status === 'cancelled').length
    }
  };
}

// ── TodoRead ──
async function todoRead(args) {
  const { filter = 'all' } = args || {};
  
  const tasks = readTasks();
  
  let filteredTasks = tasks;
  if (filter !== 'all') {
    filteredTasks = tasks.filter(t => t.status === filter);
  }

  return {
    tasks: filteredTasks,
    summary: {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      in_progress: tasks.filter(t => t.status === 'in_progress').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      cancelled: tasks.filter(t => t.status === 'cancelled').length
    }
  };
}

// ── TodoComplete ──
async function todoComplete(args) {
  const { task_ids, task_content } = args;
  
  const tasks = readTasks();
  const timestamp = new Date().toISOString();
  let completedCount = 0;

  // Complete by IDs
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

  // Complete by content match
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
      cancelled: tasks.filter(t => t.status === 'cancelled').length
    }
  };
}

// ── TodoClear ──
async function todoClear(args) {
  const { clear_type = 'completed' } = args || {};
  
  const tasks = readTasks();
  let remainingTasks;

  if (clear_type === 'all') {
    remainingTasks = [];
  } else {
    remainingTasks = tasks.filter(t => t.status !== 'completed');
  }

  writeTasks(remainingTasks);

  return {
    success: true,
    cleared: tasks.length - remainingTasks.length,
    remaining: remainingTasks.length
  };
}

export default {
  taskManagementTools,
  executeTaskManagementTool
};
