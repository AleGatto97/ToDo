/**
 * TODO UNIFI - TO-DO LIST APPLICATION LOGIC
 * Architecture: 
 * - Progetti (Level 1) -> Reorderable via Drag & Drop
 *   ├── Task Dirette di Progetto (Senza Attività)
 *   └── Attività (Level 2) -> Reorderable via Drag & Drop (dentro lo stesso progetto)
 *        └── Task (Level 3) -> Auto-sorted per priorità decrescente
 */

(function () {
  'use strict';

  // State Store
  const STORAGE_KEY = 'todo_unifi_workspace_v2';
  const CLOUD_CONFIG_KEY = 'todo_unifi_cloud_config_v2';

  let appState = {
    projects: [] 
  };

  let cloudConfig = {
    provider: 'none', // 'none', 'jsonbin', 'firebase'
    binId: '',
    apiKey: '',
    firebaseUrl: ''
  };

  // Mappa dei timer di cancellazione a 5 secondi per ciascuna task completata
  const activeDeletionTimers = new Map();

  // ID del Progetto da eliminare (in attesa di conferma nel modale)
  let pendingDeleteProjectId = null;

  // Drag & Drop State per le Attività e per i Progetti
  let draggedActivityInfo = null; // { projectId, activityIndex }
  let draggedProjectIndex = null;

  // Priority Definitions
  const PRIORITIES = {
    5: { name: 'Estrema', class: 'dot-extreme', priorityClass: 'priority-5' },
    4: { name: 'Alta', class: 'dot-high', priorityClass: 'priority-4' },
    3: { name: 'Media', class: 'dot-medium', priorityClass: 'priority-3' },
    2: { name: 'Bassa', class: 'dot-low', priorityClass: 'priority-2' },
    1: { name: 'In attesa', class: 'dot-waiting', priorityClass: 'priority-1' }
  };

  // ==========================================================================
  // INITIALIZATION & PERSISTENCE
  // ==========================================================================
  function init() {
    loadLocalState();
    loadCloudConfig();
    bindEvents();
    render();

    if (cloudConfig.provider !== 'none') {
      syncWithCloudFetch();
    }
  }

  function loadLocalState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        appState = JSON.parse(saved);
        ensureDataStructure();
        sortAllTasks();
      } else {
        createInitialDemoData();
      }
    } catch (e) {
      console.error('Errore nel caricamento da LocalStorage', e);
    }
  }

  function ensureDataStructure() {
    if (!appState.projects) appState.projects = [];
    appState.projects.forEach(project => {
      if (!project.tasks) project.tasks = [];
      if (!project.activities) project.activities = [];
      project.activities.forEach(activity => {
        if (!activity.tasks) activity.tasks = [];
      });
    });
  }

  function saveState() {
    try {
      sortAllTasks();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
      if (cloudConfig.provider !== 'none') {
        syncWithCloudPush();
      }
    } catch (e) {
      console.error('Errore nel salvataggio dello stato', e);
    }
  }

  function sortAllTasks() {
    appState.projects.forEach(project => {
      if (project.tasks) {
        project.tasks.sort((a, b) => b.priority - a.priority);
      } else {
        project.tasks = [];
      }

      if (project.activities) {
        project.activities.forEach(activity => {
          if (activity.tasks) {
            activity.tasks.sort((a, b) => b.priority - a.priority);
          } else {
            activity.tasks = [];
          }
        });
      }
    });
  }

  function createInitialDemoData() {
    appState = {
      projects: [
        {
          id: generateId(),
          name: 'PROGETTI ACCADEMICI & LAVORO',
          tasks: [
            { id: generateId(), name: 'Inviare mail di conferma docente', priority: 5, completed: false }
          ],
          activities: [
            {
              id: generateId(),
              name: 'Pianificazione Q4',
              tasks: [
                { id: generateId(), name: 'Concludere report di laboratorio', priority: 4, completed: false },
                { id: generateId(), name: 'Revisione presentazioni e slides', priority: 3, completed: false },
                { id: generateId(), name: 'Organizzazione file e documentazione', priority: 1, completed: false }
              ]
            }
          ]
        }
      ]
    };
    ensureDataStructure();
    sortAllTasks();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
  }

  function generateId() {
    return 'id_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
  }

  // ==========================================================================
  // CLOUD SYNC ENGINE
  // ==========================================================================
  function loadCloudConfig() {
    try {
      const saved = localStorage.getItem(CLOUD_CONFIG_KEY);
      if (saved) {
        cloudConfig = JSON.parse(saved);
        updateSyncBadgeUI();
      }
    } catch (e) {
      console.error('Errore nel caricamento configurazione Cloud', e);
    }
  }

  function saveCloudConfig() {
    localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(cloudConfig));
    updateSyncBadgeUI();
  }

  function updateSyncBadgeUI() {
    const badge = document.getElementById('sync-status-badge');
    const badgeText = document.getElementById('sync-status-text');

    if (cloudConfig.provider === 'none') {
      badge.className = 'sync-badge sync-local';
      badgeText.textContent = 'Locale';
    } else {
      badge.className = 'sync-badge sync-connected';
      badgeText.textContent = 'Cloud Sync Attivo (' + cloudConfig.provider.toUpperCase() + ')';
    }
  }

  async function syncWithCloudPush() {
    if (cloudConfig.provider === 'jsonbin' && cloudConfig.binId) {
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (cloudConfig.apiKey) headers['X-Master-Key'] = cloudConfig.apiKey;

        await fetch(`https://api.jsonbin.io/v3/b/${cloudConfig.binId}`, {
          method: 'PUT',
          headers: headers,
          body: JSON.stringify(appState)
        });
      } catch (e) {
        console.warn('Sincronizzazione Cloud Push fallita:', e);
      }
    } else if (cloudConfig.provider === 'firebase' && cloudConfig.firebaseUrl) {
      try {
        const url = cloudConfig.firebaseUrl.endsWith('/') ? cloudConfig.firebaseUrl + 'todo_unifi.json' : cloudConfig.firebaseUrl + '/todo_unifi.json';
        await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(appState)
        });
      } catch (e) {
        console.warn('Sincronizzazione Firebase Push fallita:', e);
      }
    }
  }

  async function syncWithCloudFetch() {
    if (cloudConfig.provider === 'jsonbin' && cloudConfig.binId) {
      try {
        const headers = {};
        if (cloudConfig.apiKey) headers['X-Master-Key'] = cloudConfig.apiKey;

        const res = await fetch(`https://api.jsonbin.io/v3/b/${cloudConfig.binId}/latest`, { headers });
        if (res.ok) {
          const data = await res.json();
          const remoteState = data.record || data;
          if (remoteState && remoteState.projects) {
            appState = remoteState;
            ensureDataStructure();
            sortAllTasks();
            localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
            render();
          }
        }
      } catch (e) {
        console.warn('Sincronizzazione Cloud Fetch fallita:', e);
      }
    } else if (cloudConfig.provider === 'firebase' && cloudConfig.firebaseUrl) {
      try {
        const url = cloudConfig.firebaseUrl.endsWith('/') ? cloudConfig.firebaseUrl + 'todo_unifi.json' : cloudConfig.firebaseUrl + '/todo_unifi.json';
        const res = await fetch(url);
        if (res.ok) {
          const remoteState = await res.json();
          if (remoteState && remoteState.projects) {
            appState = remoteState;
            ensureDataStructure();
            sortAllTasks();
            localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
            render();
          }
        }
      } catch (e) {
        console.warn('Sincronizzazione Firebase Fetch fallita:', e);
      }
    }
  }

  // ==========================================================================
  // RENDER LOGIC
  // ==========================================================================
  function render() {
    const container = document.getElementById('projects-container');
    const emptyState = document.getElementById('empty-state');

    container.innerHTML = '';

    if (!appState.projects || appState.projects.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');

    appState.projects.forEach((project, projectIndex) => {
      const projectCard = createProjectCardElement(project, projectIndex);
      container.appendChild(projectCard);
    });
  }

  function createProjectCardElement(project, projectIndex) {
    const card = document.createElement('div');
    card.className = 'project-card';
    card.draggable = true;
    card.dataset.projectId = project.id;
    card.dataset.projectIndex = projectIndex;

    // Bind Drag & Drop per i Progetti
    bindProjectDragEvents(card, projectIndex);

    // Header del Progetto
    const header = document.createElement('div');
    header.className = 'project-header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'project-title-group';

    const projectDragHandle = document.createElement('div');
    projectDragHandle.className = 'drag-handle project-drag-handle';
    projectDragHandle.title = 'Trascina per riordinare progetti';
    projectDragHandle.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="9" cy="5" r="1"></circle>
        <circle cx="9" cy="12" r="1"></circle>
        <circle cx="9" cy="19" r="1"></circle>
        <circle cx="15" cy="5" r="1"></circle>
        <circle cx="15" cy="12" r="1"></circle>
        <circle cx="15" cy="19" r="1"></circle>
      </svg>
    `;

    const title = document.createElement('h2');
    title.className = 'project-title';
    title.textContent = project.name.toUpperCase();

    titleGroup.appendChild(projectDragHandle);
    titleGroup.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'project-actions';

    // Pulsante "Task" diretta nel progetto
    const addDirectTaskBtn = document.createElement('button');
    addDirectTaskBtn.className = 'btn-add-task';
    addDirectTaskBtn.title = 'Aggiungi Task diretta al Progetto';
    addDirectTaskBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
      <span>Task</span>
    `;
    addDirectTaskBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAddTaskModal(project.id, null);
    });

    // Pulsante Rimuovi Progetto
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-icon btn-icon-danger';
    deleteBtn.title = 'Rimuovi Progetto';
    deleteBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>
    `;
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDeleteProjectModal(project.id, project.name);
    });

    actions.appendChild(addDirectTaskBtn);
    actions.appendChild(deleteBtn);
    header.appendChild(titleGroup);
    header.appendChild(actions);
    card.appendChild(header);

    // SEZIONE TASK DIRETTE DEL PROGETTO (Senza attività)
    if (project.tasks && project.tasks.length > 0) {
      const directTasksBox = document.createElement('div');
      directTasksBox.className = 'project-direct-tasks';

      const directTasksTitle = document.createElement('div');
      directTasksTitle.className = 'section-subheading';
      directTasksTitle.textContent = 'TASK DIRETTE PROGETTO';

      const tasksContainer = document.createElement('div');
      tasksContainer.className = 'tasks-container';

      project.tasks.forEach((task) => {
        const taskElement = createTaskElement(project.id, null, task);
        tasksContainer.appendChild(taskElement);
      });

      directTasksBox.appendChild(directTasksTitle);
      directTasksBox.appendChild(tasksContainer);
      card.appendChild(directTasksBox);
    }

    // Contenitore Attività
    const activitiesContainer = document.createElement('div');
    activitiesContainer.className = 'activities-container';
    activitiesContainer.dataset.projectId = project.id;

    if (project.activities && project.activities.length > 0) {
      project.activities.forEach((activity, activityIndex) => {
        const activityItem = createActivityElement(project.id, activity, activityIndex);
        activitiesContainer.appendChild(activityItem);
      });
    }

    card.appendChild(activitiesContainer);

    // Footer Azioni Progetto
    const footerActions = document.createElement('div');
    footerActions.className = 'project-footer-actions';

    const addActivityBtn = document.createElement('button');
    addActivityBtn.className = 'btn-add-activity';
    addActivityBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
      <span>Attività</span>
    `;
    addActivityBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAddActivityModal(project.id);
    });

    const addDirectTaskFooterBtn = document.createElement('button');
    addDirectTaskFooterBtn.className = 'btn-add-activity btn-add-direct-task';
    addDirectTaskFooterBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
      <span>Task Diretta</span>
    `;
    addDirectTaskFooterBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAddTaskModal(project.id, null);
    });

    footerActions.appendChild(addActivityBtn);
    footerActions.appendChild(addDirectTaskFooterBtn);
    card.appendChild(footerActions);

    return card;
  }

  function createActivityElement(projectId, activity, activityIndex) {
    const item = document.createElement('div');
    item.className = 'activity-item';
    item.draggable = true;
    item.dataset.projectId = projectId;
    item.dataset.activityId = activity.id;
    item.dataset.activityIndex = activityIndex;

    // Gestione Drag & Drop per le Attività
    bindActivityDragEvents(item, projectId, activityIndex);

    // Header Attività
    const header = document.createElement('div');
    header.className = 'activity-header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'activity-title-group';

    const dragHandle = document.createElement('div');
    dragHandle.className = 'drag-handle';
    dragHandle.title = 'Trascina per riordinare attività';
    dragHandle.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="9" cy="5" r="1"></circle>
        <circle cx="9" cy="12" r="1"></circle>
        <circle cx="9" cy="19" r="1"></circle>
        <circle cx="15" cy="5" r="1"></circle>
        <circle cx="15" cy="12" r="1"></circle>
        <circle cx="15" cy="19" r="1"></circle>
      </svg>
    `;

    const title = document.createElement('h3');
    title.className = 'activity-title';
    title.textContent = activity.name;

    titleGroup.appendChild(dragHandle);
    titleGroup.appendChild(title);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.alignItems = 'center';
    actions.style.gap = '6px';

    // Pulsante Aggiungi Task
    const addTaskBtn = document.createElement('button');
    addTaskBtn.className = 'btn-add-task';
    addTaskBtn.title = 'Aggiungi Task nell\'Attività';
    addTaskBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
      <span>Task</span>
    `;
    addTaskBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAddTaskModal(projectId, activity.id);
    });

    // Pulsante Rimuovi Attività
    const deleteActivityBtn = document.createElement('button');
    deleteActivityBtn.className = 'btn-icon btn-icon-danger';
    deleteActivityBtn.style.width = '28px';
    deleteActivityBtn.style.height = '28px';
    deleteActivityBtn.title = 'Elimina Attività';
    deleteActivityBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    `;
    deleteActivityBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteActivity(projectId, activity.id);
    });

    actions.appendChild(addTaskBtn);
    actions.appendChild(deleteActivityBtn);

    header.appendChild(titleGroup);
    header.appendChild(actions);
    item.appendChild(header);

    // Contenitore Task
    const tasksContainer = document.createElement('div');
    tasksContainer.className = 'tasks-container';

    if (activity.tasks && activity.tasks.length > 0) {
      activity.tasks.forEach((task) => {
        const taskElement = createTaskElement(projectId, activity.id, task);
        tasksContainer.appendChild(taskElement);
      });
    }

    item.appendChild(tasksContainer);

    return item;
  }

  function createTaskElement(projectId, activityId, task) {
    const taskItem = document.createElement('div');
    const priorityMeta = PRIORITIES[task.priority] || PRIORITIES[1];
    
    taskItem.className = `task-item ${priorityMeta.priorityClass} ${task.completed ? 'completed' : ''}`;
    taskItem.dataset.taskId = task.id;

    const leftGroup = document.createElement('div');
    leftGroup.className = 'task-left';

    const checkboxWrapper = document.createElement('div');
    checkboxWrapper.className = 'task-checkbox-wrapper';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'task-checkbox';
    checkbox.checked = !!task.completed;
    checkbox.addEventListener('change', (e) => toggleTaskCompletion(projectId, activityId, task.id, e.target.checked));

    checkboxWrapper.appendChild(checkbox);

    const taskTitle = document.createElement('span');
    taskTitle.className = 'task-title';
    taskTitle.textContent = task.name;

    leftGroup.appendChild(checkboxWrapper);
    leftGroup.appendChild(taskTitle);

    const badge = document.createElement('div');
    badge.className = 'task-badge-priority';
    badge.innerHTML = `<span class="priority-dot ${priorityMeta.class}"></span> ${priorityMeta.name}`;

    taskItem.appendChild(leftGroup);
    taskItem.appendChild(badge);

    if (task.completed) {
      const timerBar = document.createElement('div');
      timerBar.className = 'task-deletion-bar';
      taskItem.appendChild(timerBar);

      ensureTaskDeletionTimer(projectId, activityId, task.id);
    }

    return taskItem;
  }

  // ==========================================================================
  // DRAG & DROP PER I PROGETTI
  // ==========================================================================
  function bindProjectDragEvents(card, projectIndex) {
    card.addEventListener('dragstart', (e) => {
      // Se si sta trascinando un'attività dentro la card, ignoriamo il drag del progetto
      if (e.target.closest('.activity-item')) {
        return;
      }
      draggedProjectIndex = projectIndex;
      card.classList.add('dragging-project');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'project:' + projectIndex);
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging-project');
      document.querySelectorAll('.project-card').forEach(el => el.classList.remove('drag-over-project'));
      draggedProjectIndex = null;
    });

    card.addEventListener('dragover', (e) => {
      if (draggedProjectIndex === null || draggedActivityInfo !== null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      card.classList.add('drag-over-project');
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over-project');
    });

    card.addEventListener('drop', (e) => {
      if (draggedProjectIndex === null || draggedActivityInfo !== null) return;
      e.preventDefault();
      card.classList.remove('drag-over-project');

      const targetIndex = projectIndex;
      if (draggedProjectIndex !== targetIndex) {
        reorderProjects(draggedProjectIndex, targetIndex);
      }
    });
  }

  function reorderProjects(fromIndex, toIndex) {
    const [movedProject] = appState.projects.splice(fromIndex, 1);
    appState.projects.splice(toIndex, 0, movedProject);
    saveState();
    render();
  }

  // ==========================================================================
  // DRAG & DROP PER LE ATTIVITÀ (Nello stesso progetto)
  // ==========================================================================
  function bindActivityDragEvents(element, projectId, activityIndex) {
    element.addEventListener('dragstart', (e) => {
      e.stopPropagation(); // Evita che scatti anche il dragstart del progetto padre
      draggedActivityInfo = { projectId, activityIndex };
      element.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'activity:' + activityIndex);
    });

    element.addEventListener('dragend', (e) => {
      e.stopPropagation();
      element.classList.remove('dragging');
      document.querySelectorAll('.activity-item').forEach(el => el.classList.remove('drag-over'));
      draggedActivityInfo = null;
    });

    element.addEventListener('dragover', (e) => {
      if (!draggedActivityInfo) return;
      e.preventDefault();
      e.stopPropagation();
      if (draggedActivityInfo.projectId === projectId) {
        e.dataTransfer.dropEffect = 'move';
        element.classList.add('drag-over');
      }
    });

    element.addEventListener('dragleave', (e) => {
      e.stopPropagation();
      element.classList.remove('drag-over');
    });

    element.addEventListener('drop', (e) => {
      if (!draggedActivityInfo) return;
      e.preventDefault();
      e.stopPropagation();
      element.classList.remove('drag-over');

      if (draggedActivityInfo.projectId !== projectId) {
        alert("Un'attività creata in un progetto NON può cambiare progetto!");
        return;
      }

      const targetActivityIndex = parseInt(element.dataset.activityIndex, 10);
      const sourceActivityIndex = draggedActivityInfo.activityIndex;

      if (sourceActivityIndex !== targetActivityIndex) {
        reorderActivities(projectId, sourceActivityIndex, targetActivityIndex);
      }
    });
  }

  function reorderActivities(projectId, fromIndex, toIndex) {
    const project = appState.projects.find(p => p.id === projectId);
    if (!project || !project.activities) return;

    const [movedActivity] = project.activities.splice(fromIndex, 1);
    project.activities.splice(toIndex, 0, movedActivity);

    saveState();
    render();
  }

  // ==========================================================================
  // GESTIONE TIMER CANCELLAZIONE TASK 5 SECONDI
  // ==========================================================================
  function toggleTaskCompletion(projectId, activityId, taskId, isCompleted) {
    const project = appState.projects.find(p => p.id === projectId);
    if (!project) return;

    let task = null;
    if (activityId) {
      const activity = project.activities.find(a => a.id === activityId);
      if (activity) task = activity.tasks.find(t => t.id === taskId);
    } else {
      task = (project.tasks || []).find(t => t.id === taskId);
    }

    if (!task) return;

    task.completed = isCompleted;

    if (isCompleted) {
      saveState();
      render();
      ensureTaskDeletionTimer(projectId, activityId, taskId);
    } else {
      cancelTaskDeletionTimer(taskId);
      saveState();
      render();
    }
  }

  function ensureTaskDeletionTimer(projectId, activityId, taskId) {
    if (activeDeletionTimers.has(taskId)) return;

    const timeoutId = setTimeout(() => {
      deleteTask(projectId, activityId, taskId);
      activeDeletionTimers.delete(taskId);
    }, 5000);

    activeDeletionTimers.set(taskId, { timeoutId });
  }

  function cancelTaskDeletionTimer(taskId) {
    if (activeDeletionTimers.has(taskId)) {
      const { timeoutId } = activeDeletionTimers.get(taskId);
      clearTimeout(timeoutId);
      activeDeletionTimers.delete(taskId);
    }
  }

  function deleteTask(projectId, activityId, taskId) {
    const project = appState.projects.find(p => p.id === projectId);
    if (!project) return;

    if (activityId) {
      const activity = project.activities.find(a => a.id === activityId);
      if (activity) {
        activity.tasks = activity.tasks.filter(t => t.id !== taskId);
      }
    } else {
      project.tasks = (project.tasks || []).filter(t => t.id !== taskId);
    }

    saveState();
    render();
  }

  // ==========================================================================
  // AZIONI SUI PROGETTI, ATTIVITÀ E TASK
  // ==========================================================================
  function addProject(name) {
    if (!name || !name.trim()) return;

    const newProject = {
      id: generateId(),
      name: name.trim().toUpperCase(),
      tasks: [],
      activities: []
    };

    appState.projects.push(newProject);
    saveState();
    render();
  }

  function deleteProject(projectId) {
    appState.projects = appState.projects.filter(p => p.id !== projectId);
    saveState();
    render();
  }

  function addActivity(projectId, name) {
    if (!name || !name.trim()) return;

    const project = appState.projects.find(p => p.id === projectId);
    if (!project) return;

    const newActivity = {
      id: generateId(),
      name: name.trim(),
      tasks: []
    };

    if (!project.activities) project.activities = [];
    project.activities.push(newActivity);
    saveState();
    render();
  }

  function deleteActivity(projectId, activityId) {
    const project = appState.projects.find(p => p.id === projectId);
    if (!project) return;

    project.activities = project.activities.filter(a => a.id !== activityId);
    saveState();
    render();
  }

  function addTask(projectId, activityId, name, priority) {
    if (!name || !name.trim()) return;

    const project = appState.projects.find(p => p.id === projectId);
    if (!project) return;

    const newTask = {
      id: generateId(),
      name: name.trim(),
      priority: parseInt(priority, 10) || 1,
      completed: false
    };

    if (activityId) {
      const activity = project.activities.find(a => a.id === activityId);
      if (!activity) return;
      if (!activity.tasks) activity.tasks = [];
      activity.tasks.push(newTask);
      activity.tasks.sort((a, b) => b.priority - a.priority);
    } else {
      if (!project.tasks) project.tasks = [];
      project.tasks.push(newTask);
      project.tasks.sort((a, b) => b.priority - a.priority);
    }

    saveState();
    render();
  }

  // ==========================================================================
  // EVENT BINDINGS & MODALS
  // ==========================================================================
  function bindEvents() {
    document.getElementById('btn-add-project').addEventListener('click', openAddProjectModal);
    document.getElementById('btn-empty-add-project').addEventListener('click', openAddProjectModal);

    document.getElementById('form-project').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('project-name');
      addProject(input.value);
      input.value = '';
      closeModal('modal-project');
    });

    document.getElementById('form-activity').addEventListener('submit', (e) => {
      e.preventDefault();
      const projectId = document.getElementById('activity-project-id').value;
      const input = document.getElementById('activity-name');
      addActivity(projectId, input.value);
      input.value = '';
      closeModal('modal-activity');
    });

    document.getElementById('form-task').addEventListener('submit', (e) => {
      e.preventDefault();
      const projectId = document.getElementById('task-project-id').value;
      const activityId = document.getElementById('task-activity-id').value || null;
      const nameInput = document.getElementById('task-name');
      const priorityInput = document.querySelector('input[name="task-priority"]:checked');

      addTask(projectId, activityId, nameInput.value, priorityInput ? priorityInput.value : 1);

      nameInput.value = '';
      closeModal('modal-task');
    });

    document.getElementById('btn-confirm-delete-project').addEventListener('click', () => {
      if (pendingDeleteProjectId) {
        deleteProject(pendingDeleteProjectId);
        pendingDeleteProjectId = null;
      }
      closeModal('modal-delete-confirm');
    });

    document.getElementById('btn-cloud-sync').addEventListener('click', openCloudModal);
    document.getElementById('cloud-provider-select').addEventListener('change', (e) => {
      toggleCloudProviderFields(e.target.value);
    });
    document.getElementById('btn-save-cloud-config').addEventListener('click', () => {
      const provider = document.getElementById('cloud-provider-select').value;
      cloudConfig.provider = provider;
      cloudConfig.binId = document.getElementById('jsonbin-bin-id').value.trim();
      cloudConfig.apiKey = document.getElementById('jsonbin-api-key').value.trim();
      cloudConfig.firebaseUrl = document.getElementById('firebase-db-url').value.trim();

      saveCloudConfig();
      closeModal('modal-cloud');

      if (provider !== 'none') {
        syncWithCloudFetch();
      }
    });

    document.getElementById('btn-export-import').addEventListener('click', () => openModal('modal-data'));
    document.getElementById('btn-download-json').addEventListener('click', downloadBackupJSON);
    document.getElementById('btn-trigger-import-file').addEventListener('click', () => {
      document.getElementById('import-json-file').click();
    });
    document.getElementById('import-json-file').addEventListener('change', handleImportJSONFile);

    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const modalId = btn.getAttribute('data-close');
        closeModal(modalId);
      });
    });

    document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
          closeModal(backdrop.id);
        }
      });
    });
  }

  function openAddProjectModal() {
    document.getElementById('project-name').value = '';
    openModal('modal-project');
  }

  function openAddActivityModal(projectId) {
    document.getElementById('activity-project-id').value = projectId;
    document.getElementById('activity-name').value = '';
    openModal('modal-activity');
  }

  function openAddTaskModal(projectId, activityId) {
    document.getElementById('task-project-id').value = projectId;
    document.getElementById('task-activity-id').value = activityId || '';
    document.getElementById('task-name').value = '';
    
    const radioEstrema = document.querySelector('input[name="task-priority"][value="5"]');
    if (radioEstrema) radioEstrema.checked = true;

    openModal('modal-task');
  }

  function openDeleteProjectModal(projectId, projectName) {
    pendingDeleteProjectId = projectId;
    document.getElementById('delete-project-name-placeholder').textContent = `"${projectName.toUpperCase()}"`;
    openModal('modal-delete-confirm');
  }

  function openCloudModal() {
    document.getElementById('cloud-provider-select').value = cloudConfig.provider || 'none';
    document.getElementById('jsonbin-bin-id').value = cloudConfig.binId || '';
    document.getElementById('jsonbin-api-key').value = cloudConfig.apiKey || '';
    document.getElementById('firebase-db-url').value = cloudConfig.firebaseUrl || '';
    toggleCloudProviderFields(cloudConfig.provider);
    openModal('modal-cloud');
  }

  function toggleCloudProviderFields(provider) {
    const jsonbinFields = document.getElementById('cloud-jsonbin-fields');
    const firebaseFields = document.getElementById('cloud-firebase-fields');

    jsonbinFields.classList.add('hidden');
    firebaseFields.classList.add('hidden');

    if (provider === 'jsonbin') jsonbinFields.classList.remove('hidden');
    if (provider === 'firebase') firebaseFields.classList.remove('hidden');
  }

  function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('hidden');
      const input = modal.querySelector('input[type="text"]');
      if (input) setTimeout(() => input.focus(), 100);
    }
  }

  function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('hidden');
  }

  function downloadBackupJSON() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appState, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `todo_unifi_backup_${new Date().toISOString().slice(0,10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  }

  function handleImportJSONFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (event) {
      try {
        const importedData = JSON.parse(event.target.result);
        if (importedData && Array.isArray(importedData.projects)) {
          appState = importedData;
          ensureDataStructure();
          saveState();
          render();
          closeModal('modal-data');
          alert('Backup ripristinato con successo!');
        } else {
          alert('Formato file JSON non valido.');
        }
      } catch (err) {
        alert('Errore nella lettura del file JSON: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
