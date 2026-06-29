const STORAGE_KEY_BASE = "workboard.tasks.v1";
const config = window.WORKBOARD_SUPABASE_CONFIG || {};

const statusText = {
  todo: "待处理",
  doing: "进行中",
  done: "已完成",
  delayed: "延期",
  canceled: "取消",
};

const quadrantText = {
  "important-urgent": "重要且紧急",
  "important-not-urgent": "重要不紧急",
  "not-important-urgent": "不重要但紧急",
  "not-important-not-urgent": "不重要不紧急",
};

const demoTaskSignatures = new Set([
  "整理本周重点项目进展|项目管理|周报,复盘|doing|1.5|true|true",
  "拆分下周长期能力建设事项|个人成长|计划|todo|2|true|false",
]);

const state = {
  tasks: loadTasks(null),
  view: "today",
  search: "",
  supabase: null,
  user: null,
  syncReady: false,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function getStorageKey(userId) {
  return userId ? `${STORAGE_KEY_BASE}.${userId}` : `${STORAGE_KEY_BASE}.anon`;
}

function taskSignature(task) {
  return `${task.title}|${task.project || ""}|${(task.tags || []).join(",")}|${task.status}|${task.hours}|${task.important}|${task.urgent}`;
}

function isDemoTask(task) {
  return demoTaskSignatures.has(taskSignature(task));
}

function sanitizeTasks(tasks) {
  const sanitized = (tasks || []).filter((task) => !isDemoTask(task));
  if (sanitized.length !== (tasks || []).length) {
    return sanitized;
  }
  return tasks || [];
}

function todayISO() {
  return formatLocalDate(new Date());
}

function getWeekStart(date) {
  const current = new Date(`${date}T00:00:00`);
  const day = current.getDay() || 7;
  current.setDate(current.getDate() - day + 1);
  return current;
}

function getWeekEnd(date) {
  const start = getWeekStart(date);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return end;
}

function toISO(date) {
  return formatLocalDate(date);
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function weekValue(date = todayISO()) {
  const target = new Date(`${date}T00:00:00`);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const weekStart = getWeekStart(toISO(target));
  const yearStart = getWeekStart(toISO(firstThursday));
  const week = Math.floor((weekStart - yearStart) / 604800000) + 1;
  return `${weekStart.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function weekToRange(value) {
  const [year, week] = value.split("-W").map(Number);
  const fourth = new Date(year, 0, 4);
  const start = getWeekStart(toISO(fourth));
  start.setDate(start.getDate() + (week - 1) * 7);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return [toISO(start), toISO(end)];
}

function loadTasks(userId) {
  const key = getStorageKey(userId);
  const saved = localStorage.getItem(key);
  if (saved) {
    try {
      return sanitizeTasks(JSON.parse(saved));
    } catch {
      return userId === null ? seedTasks(key) : [];
    }
  }
  if (userId === null) {
    return seedTasks(key);
  }
  return [];
}

function loadAnonymousTasks() {
  const key = getStorageKey(null);
  if (!localStorage.getItem(key)) return [];
  const tasks = loadTasks(null);
  if (!tasks.length) {
    localStorage.removeItem(key);
  }
  return tasks;
}

function saveTasks() {
  localStorage.setItem(getStorageKey(state.user?.id), JSON.stringify(state.tasks));
}

function taskTimestamp(task) {
  return new Date(task.updatedAt || task.createdAt || 0).getTime();
}

function mergeTasks(localTasks, cloudTasks) {
  const localMap = Object.fromEntries(localTasks.map((task) => [task.id, task]));
  const cloudMap = Object.fromEntries(cloudTasks.map((task) => [task.id, task]));
  const allIds = new Set([...Object.keys(localMap), ...Object.keys(cloudMap)]);
  return [...allIds].map((id) => {
    const local = localMap[id];
    const cloud = cloudMap[id];
    if (!local) return cloud;
    if (!cloud) return local;
    return taskTimestamp(local) >= taskTimestamp(cloud) ? local : cloud;
  });
}

function buildTaskMap(tasks) {
  return Object.fromEntries(tasks.map((task) => [task.id, task]));
}

function isCloudConfigured() {
  return Boolean(
    config.enabled &&
      config.url &&
      config.anonKey &&
      !config.url.includes("你的") &&
      !config.anonKey.includes("你的") &&
      window.supabase,
  );
}

async function initCloud() {
  renderAuth();
  if (!isCloudConfigured()) return;
  state.supabase = window.supabase.createClient(config.url, config.anonKey);
  const { data } = await state.supabase.auth.getSession();
  state.user = data.session?.user || null;
  state.syncReady = Boolean(state.user);
  if (state.user) {
    const anonTasks = loadAnonymousTasks();
    const userTasks = loadTasks(state.user.id);
    state.tasks = mergeTasks(anonTasks, userTasks);
    await loadCloudTasks();
  }
  state.supabase.auth.onAuthStateChange(async (_event, session) => {
    state.user = session?.user || null;
    state.syncReady = Boolean(state.user);
    if (state.user) {
      const anonTasks = loadAnonymousTasks();
      const userTasks = loadTasks(state.user.id);
      state.tasks = mergeTasks(anonTasks, userTasks);
      await loadCloudTasks();
    } else {
      state.tasks = loadTasks(null);
    }
    renderAuth();
    render();
  });
  renderAuth();
}

async function loadCloudTasks() {
  if (!state.supabase || !state.user) return;
  const { data, error } = await state.supabase.from("tasks").select("id,data,updated_at").eq("user_id", state.user.id).order("updated_at", { ascending: false });
  if (error) {
    showToast(`同步失败：${error.message}`);
    return;
  }
  const cloudTasks = sanitizeTasks(data.map((row) => ({ id: row.id, ...row.data })));
  const anonTasks = loadAnonymousTasks();
  const userTasks = sanitizeTasks(loadTasks(state.user.id));
  state.tasks = mergeTasks(mergeTasks(anonTasks, userTasks), cloudTasks);
  saveTasks();
  const cloudMap = buildTaskMap(cloudTasks);
  await Promise.all(
    state.tasks
      .filter((task) => !cloudMap[task.id] || taskTimestamp(task) > taskTimestamp(cloudMap[task.id]))
      .map((task) => upsertCloudTask(task)),
  );
}

async function upsertCloudTask(task) {
  if (!state.supabase || !state.user) return;
  const { error } = await state.supabase
    .from("tasks")
    .upsert(
      {
        id: task.id,
        user_id: state.user.id,
        data: task,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
  if (error) showToast(`云端保存失败：${error.message}`);
}

async function deleteCloudTask(id) {
  if (!state.supabase || !state.user) return;
  const { error } = await state.supabase.from("tasks").delete().eq("id", id).eq("user_id", state.user.id);
  if (error) showToast(`云端删除失败：${error.message}`);
}

function renderAuth() {
  const configured = isCloudConfigured();
  const signedIn = Boolean(state.user);
  $("#syncStatus").textContent = configured ? (signedIn ? "云同步已开启" : "云同步未登录") : "本地模式";
  $("#syncHint").textContent = configured
    ? signedIn
      ? `已登录：${state.user.email}`
      : "登录后，工作记录会同步到 Supabase。"
    : "配置 Supabase 后可登录并多电脑同步。";
  $("#authEmail").style.display = configured && !signedIn ? "block" : "none";
  $("#authPassword").style.display = configured && !signedIn ? "block" : "none";
  $("#signInBtn").style.display = configured && !signedIn ? "inline-flex" : "none";
  $("#signUpBtn").style.display = configured && !signedIn ? "inline-flex" : "none";
  $("#signOutBtn").style.display = configured && signedIn ? "inline-flex" : "none";
}

function seedTasks(storageKey) {
  const tasks = [];
  if (storageKey) {
    localStorage.setItem(storageKey, JSON.stringify(tasks));
  }
  return tasks;
}

function quadrantOf(task) {
  if (task.important && task.urgent) return "important-urgent";
  if (task.important && !task.urgent) return "important-not-urgent";
  if (!task.important && task.urgent) return "not-important-urgent";
  return "not-important-not-urgent";
}

function filteredTasks(tasks = state.tasks) {
  const query = state.search.trim().toLowerCase();
  if (!query) return [...tasks];
  return tasks.filter((task) => {
    return [task.title, task.description, task.project, ...(task.tags || [])]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
}

function byDateDesc(a, b) {
  return b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt);
}

function tasksInRange(range) {
  const tasks = filteredTasks();
  if (range === "all") return tasks;
  if (range === "active") return tasks.filter((task) => task.status !== "done" && task.status !== "canceled");
  if (range === "today") return tasks.filter((task) => task.date === todayISO());
  if (range === "week") {
    const start = toISO(getWeekStart(todayISO()));
    const end = toISO(getWeekEnd(todayISO()));
    return tasks.filter((task) => isDateInRange(task.date, start, end));
  }
  if (range === "month") {
    const start = new Date();
    start.setDate(start.getDate() - 29);
    return tasks.filter((task) => isDateInRange(task.date, toISO(start), "9999-12-31"));
  }
  return tasks;
}

function isDateInRange(date, start, end) {
  return typeof date === "string" && date >= start && date <= end;
}

function render() {
  renderHeader();
  renderToday();
  renderMatrix();
  renderLogs();
  renderWeeklyDefault();
  renderInsights();
}

function renderHeader() {
  const start = toISO(getWeekStart(todayISO()));
  const end = toISO(getWeekEnd(todayISO()));
  $("#currentWeek").textContent = `${start} 至 ${end}`;
}

function taskCard(task, compact = false) {
  const card = document.createElement("article");
  card.className = "task-card";
  card.innerHTML = `
    <header>
      <div>
        <h3>${escapeHTML(task.title)}</h3>
        ${compact ? "" : `<p>${escapeHTML(task.description || "暂无说明")}</p>`}
      </div>
      <div class="card-actions">
        <button data-edit="${task.id}">编辑</button>
      </div>
    </header>
    <div class="card-meta">
      <span class="pill ${statusClass(task.status)}">${statusText[task.status]}</span>
      <span class="pill">${quadrantText[quadrantOf(task)]}</span>
      <span class="pill">${escapeHTML(task.project || "未分项目")}</span>
      <span class="pill">${task.hours || 0}h</span>
      ${task.dueDate ? `<span class="pill">截止 ${task.dueDate}</span>` : ""}
      ${(task.tags || []).map((tag) => `<span class="pill">#${escapeHTML(tag)}</span>`).join("")}
    </div>
  `;
  card.querySelector("[data-edit]").addEventListener("click", () => openModal(task.id));
  return card;
}

function statusClass(status) {
  if (status === "done") return "status-done";
  if (status === "doing") return "status-doing";
  if (status === "delayed") return "status-delayed";
  if (status === "canceled") return "status-canceled";
  return "";
}

function renderToday() {
  const today = todayISO();
  const todayTasks = filteredTasks().filter((task) => task.date && task.date <= today);
  const status = $("#todayStatusFilter").value;
  const incompleteTasks = todayTasks.filter((task) => task.status !== "done" && task.status !== "canceled");
  const visible = status === "all" ? incompleteTasks : todayTasks.filter((task) => task.status === status);
  renderNextTask(incompleteTasks);
  renderPriorityStrip(incompleteTasks);
  $("#metricDone").textContent = todayTasks.filter((task) => task.status === "done").length;
  $("#metricHours").textContent = `${sumHours(todayTasks)}h`;
  $("#metricFocus").textContent = todayTasks.filter((task) => task.important).length;
  $("#metricDelayed").textContent = todayTasks.filter((task) => task.status === "delayed").length;
  renderTaskList($("#todayList"), visible.sort(byDateDesc));
}

function scoreTask(task) {
  let score = 0;
  if (task.important) score += 100;
  if (task.urgent) score += 70;
  if (task.status === "doing") score += 30;
  if (task.status === "todo") score += 18;
  if (task.dueDate && task.dueDate <= todayISO()) score += 24;
  if (task.status === "delayed") score += 12;
  if (task.status === "done" || task.status === "canceled") score -= 500;
  return score;
}

function getNextTask(tasks) {
  return [...tasks].sort((a, b) => scoreTask(b) - scoreTask(a))[0];
}

function renderNextTask(tasks) {
  const task = getNextTask(tasks);
  $("#quickDone").dataset.id = task?.id || "";
  $("#quickDone").disabled = !task;
  if (!task || scoreTask(task) < 0) {
    $("#nextTaskTitle").textContent = "今天暂时没有待推进事项";
    $("#nextTaskMeta").textContent = "新增重要或紧急事项后，这里会自动排出优先级最高的一项。";
    $("#quickDone").textContent = "新增";
    return;
  }
  $("#nextTaskTitle").textContent = task.title;
  $("#nextTaskMeta").textContent = `${quadrantText[quadrantOf(task)]} · ${task.project || "未分项目"} · ${task.hours || 0}h${task.dueDate ? ` · 截止 ${task.dueDate}` : ""}`;
  $("#quickDone").textContent = task.status === "done" ? "已完成" : "完成";
}

function renderPriorityStrip(tasks) {
  const data = [
    ["重要紧急", tasks.filter((task) => task.important && task.urgent && task.status !== "done").length],
    ["正在进行", tasks.filter((task) => task.status === "doing").length],
    ["今日待完成", tasks.filter((task) => task.status === "todo" || task.status === "doing").length],
    ["已延期", tasks.filter((task) => task.status === "delayed").length],
  ];
  $("#priorityStrip").innerHTML = data
    .map(([label, value]) => `<div class="priority-chip"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
}

function renderTaskList(container, tasks, compact = false) {
  container.innerHTML = "";
  if (!tasks.length) {
    container.innerHTML = `<div class="empty">暂无记录，点击右上角新增一条。</div>`;
    return;
  }
  tasks.forEach((task) => container.appendChild(taskCard(task, compact)));
}

function renderMatrix() {
  const tasks = tasksInRange($("#matrixRange").value)
    .filter((task) => task.status !== "done" && task.status !== "canceled")
    .sort(byDateDesc);
  $$(".quadrant").forEach((quadrant) => {
    const list = quadrant.querySelector(".quadrant-list");
    const items = tasks.filter((task) => quadrantOf(task) === quadrant.dataset.quadrant);
    renderTaskList(list, items, true);
  });
}

function renderLogs() {
  const projects = ["all", ...new Set(state.tasks.map((task) => task.project || "未分项目"))];
  let project = $("#projectFilter").value || "all";
  if (!projects.includes(project)) project = "all";
  const status = $("#statusFilter").value;
  let tasks = filteredTasks();
  if (project !== "all") tasks = tasks.filter((task) => (task.project || "未分项目") === project);
  if (status !== "all") tasks = tasks.filter((task) => task.status === status);
  tasks.sort(byDateDesc);

  $("#projectFilter").innerHTML = projects
    .map((item) => `<option value="${escapeHTML(item)}">${item === "all" ? "全部项目" : escapeHTML(item)}</option>`)
    .join("");
  $("#projectFilter").value = project;

  const groups = tasks.reduce((acc, task) => {
    acc[task.date] ||= [];
    acc[task.date].push(task);
    return acc;
  }, {});
  const container = $("#logGroups");
  container.innerHTML = "";
  if (!tasks.length) {
    container.innerHTML = `<div class="empty">没有匹配的工作记录。</div>`;
    return;
  }
  Object.entries(groups).forEach(([date, items]) => {
    const day = document.createElement("section");
    day.className = "log-day";
    day.innerHTML = `<h3><span>${date}</span><span>${items.length} 项 / ${sumHours(items)}h</span></h3>`;
    const list = document.createElement("div");
    list.className = "task-list";
    items.forEach((task) => list.appendChild(taskCard(task)));
    day.appendChild(list);
    container.appendChild(day);
  });
}

function renderWeeklyDefault() {
  if (!$("#weekPicker").value) {
    $("#weekPicker").value = weekValue();
    $("#weeklyReport").value = buildWeeklyReport(...weekToRange($("#weekPicker").value));
  }
}

function renderInsights() {
  const tasks = tasksInRange($("#insightRange").value);
  renderBars(
    $("#quadrantBars"),
    Object.values(quadrantText).map((label) => ({
      label,
      value: tasks.filter((task) => quadrantText[quadrantOf(task)] === label).length,
    })),
    "项",
  );

  const projectMap = tasks.reduce((acc, task) => {
    const key = task.project || "未分项目";
    acc[key] = (acc[key] || 0) + Number(task.hours || 0);
    return acc;
  }, {});
  renderBars(
    $("#projectBars"),
    Object.entries(projectMap).map(([label, value]) => ({ label, value })),
    "h",
  );

  const suggestions = makeSuggestions(tasks);
  $("#suggestions").innerHTML = suggestions.map((item) => `<li>${escapeHTML(item)}</li>`).join("");
}

function renderBars(container, items, unit) {
  const max = Math.max(1, ...items.map((item) => item.value));
  container.innerHTML = items.length
    ? items
        .map(
          (item) => `
          <div class="bar-row">
            <div class="bar-label"><span>${escapeHTML(item.label)}</span><strong>${item.value}${unit}</strong></div>
            <div class="bar-track"><div class="bar-fill" style="width:${(item.value / max) * 100}%"></div></div>
          </div>
        `,
        )
        .join("")
    : `<div class="empty">暂无数据</div>`;
}

function makeSuggestions(tasks) {
  if (!tasks.length) return ["先记录几条工作事项，再进行复盘分析。"];
  const urgent = tasks.filter((task) => task.urgent).length;
  const importantNotUrgent = tasks.filter((task) => task.important && !task.urgent).length;
  const delayed = tasks.filter((task) => task.status === "delayed").length;
  const done = tasks.filter((task) => task.status === "done").length;
  const suggestions = [];
  if (urgent / tasks.length > 0.45) suggestions.push("紧急事项占比较高，建议把可预见工作提前拆分到计划中。");
  if (importantNotUrgent === 0) suggestions.push("重要不紧急事项较少，可以补充长期规划、能力建设或流程优化类工作。");
  if (delayed > 0) suggestions.push("存在延期事项，建议在下周计划中明确负责人、截止时间和下一步动作。");
  if (done / tasks.length >= 0.7) suggestions.push("完成率较高，可以沉淀本周方法和可复用模板。");
  if (!suggestions.length) suggestions.push("本周期记录较均衡，建议继续保持每日补录和周末复盘。");
  return suggestions;
}

function buildWeeklyReport(start, end) {
  const tasks = state.tasks.filter((task) => task.date >= start && task.date <= end).sort(byDateDesc);
  const done = tasks.filter((task) => task.status === "done");
  const focus = tasks.filter((task) => task.important && task.status !== "canceled");
  const risks = tasks.filter((task) => ["delayed", "todo", "doing"].includes(task.status) && task.important);
  const next = tasks.filter((task) => task.status !== "done" && task.status !== "canceled");
  const quadrantLines = Object.entries(quadrantText)
    .map(([key, label]) => `- ${label}：${tasks.filter((task) => quadrantOf(task) === key).length} 项`)
    .join("\n");

  return `周报：${start} 至 ${end}

一、本周完成
${listLines(done, "本周暂无已完成事项。")}

二、重点工作
${listLines(focus, "本周暂无重点事项。")}

三、问题与风险
${listLines(risks, "本周暂无明显问题或风险。")}

四、时间投入
- 总耗时：${sumHours(tasks)}h
- 完成事项：${done.length} 项
- 延期事项：${tasks.filter((task) => task.status === "delayed").length} 项
${quadrantLines}

五、下周计划
${listLines(next, "暂无自动带入事项，可手动补充下周计划。")}

六、复盘建议
${makeSuggestions(tasks).map((item) => `- ${item}`).join("\n")}`;
}

function listLines(tasks, emptyText) {
  if (!tasks.length) return `- ${emptyText}`;
  return tasks.map((task) => `- ${task.title}（${task.project || "未分项目"}，${task.hours || 0}h）`).join("\n");
}

function sumHours(tasks) {
  return Number(tasks.reduce((sum, task) => sum + Number(task.hours || 0), 0).toFixed(1));
}

function openModal(id) {
  const task = state.tasks.find((item) => item.id === id);
  $("#modalTitle").textContent = task ? "编辑工作记录" : "新增工作记录";
  $("#deleteTask").style.visibility = task ? "visible" : "hidden";
  $("#taskId").value = task?.id || "";
  $("#taskTitle").value = task?.title || "";
  $("#taskDescription").value = task?.description || "";
  $("#taskDate").value = task?.date || todayISO();
  $("#taskProject").value = task?.project || "";
  $("#taskTags").value = (task?.tags || []).join(", ");
  $("#taskHours").value = task?.hours ?? 1;
  $("#taskStatus").value = task?.status || "todo";
  $("#taskDueDate").value = task?.dueDate || "";
  $("#taskImportant").checked = Boolean(task?.important);
  $("#taskUrgent").checked = Boolean(task?.urgent);
  $("#taskModal").showModal();
}

function closeModal() {
  $("#taskModal").close();
}

async function saveTask(event) {
  event.preventDefault();
  const id = $("#taskId").value || crypto.randomUUID();
  const now = new Date().toISOString();
  const task = {
    id,
    title: $("#taskTitle").value.trim(),
    description: $("#taskDescription").value.trim(),
    date: $("#taskDate").value,
    dueDate: $("#taskDueDate").value,
    project: $("#taskProject").value.trim(),
    tags: $("#taskTags").value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    hours: Number($("#taskHours").value || 0),
    status: $("#taskStatus").value,
    important: $("#taskImportant").checked,
    urgent: $("#taskUrgent").checked,
    createdAt: now,
    updatedAt: now,
  };
  const index = state.tasks.findIndex((item) => item.id === id);
  const isNewTask = index < 0;
  if (index >= 0) {
    task.createdAt = state.tasks[index].createdAt;
    state.tasks[index] = task;
  } else {
    state.tasks.push(task);
  }
  saveTasks();
  if (isNewTask) resetVisibilityFilters(task);
  closeModal();
  render();
  showToast("已保存工作记录");
  await upsertCloudTask(task);
}

function resetVisibilityFilters(task) {
  $("#todayStatusFilter").value = "all";
  $("#matrixRange").value = task.date === todayISO() ? "today" : "all";
  $("#projectFilter").value = "all";
  $("#statusFilter").value = "all";
}

async function deleteTask() {
  const id = $("#taskId").value;
  if (!id) return;
  state.tasks = state.tasks.filter((task) => task.id !== id);
  saveTasks();
  await deleteCloudTask(id);
  closeModal();
  render();
  showToast("已删除记录");
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 1800);
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function switchView(view) {
  state.view = view;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $$(".view").forEach((item) => item.classList.remove("active"));
  $(`#${view}View`).classList.add("active");
  $("#pageTitle").textContent =
    {
      today: "今日工作台",
      matrix: "四象限任务视图",
      logs: "工作记录",
      weekly: "自动周报",
      insights: "总结分析",
    }[view] || "工作台";
  render();
}

async function signIn() {
  if (!state.supabase) return;
  const email = $("#authEmail").value.trim();
  const password = $("#authPassword").value;
  if (!email || !password) {
    showToast("请输入邮箱和密码");
    return;
  }
  const { error } = await state.supabase.auth.signInWithPassword({ email, password });
  if (error) showToast(`登录失败：${error.message}`);
  else showToast("已登录，正在同步");
}

async function signUp() {
  if (!state.supabase) return;
  const email = $("#authEmail").value.trim();
  const password = $("#authPassword").value;
  if (!email || !password) {
    showToast("请输入邮箱和密码");
    return;
  }
  const { error } = await state.supabase.auth.signUp({ email, password });
  if (error) showToast(`注册失败：${error.message}`);
  else showToast("注册成功，请按 Supabase 邮件设置确认登录");
}

async function signOut() {
  if (!state.supabase) return;
  await state.supabase.auth.signOut();
  state.user = null;
  state.syncReady = false;
  state.tasks = loadTasks(null);
  renderAuth();
  render();
  showToast("已退出登录");
}

function bindEvents() {
  $$(".nav-item").forEach((item) => item.addEventListener("click", () => switchView(item.dataset.view)));
  $("#openTaskModal").addEventListener("click", () => openModal());
  $("#closeTaskModal").addEventListener("click", closeModal);
  $("#cancelTask").addEventListener("click", closeModal);
  $("#taskForm").addEventListener("submit", saveTask);
  $("#deleteTask").addEventListener("click", deleteTask);
  $("#quickDone").addEventListener("click", async () => {
    const id = $("#quickDone").dataset.id;
    if (!id) {
      openModal();
      return;
    }
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    task.status = "done";
    saveTasks();
    await upsertCloudTask(task);
    render();
    showToast("已标记完成");
  });
  $("#signInBtn").addEventListener("click", signIn);
  $("#signUpBtn").addEventListener("click", signUp);
  $("#signOutBtn").addEventListener("click", signOut);
  $("#searchInput").addEventListener("input", (event) => {
    state.search = event.target.value;
    render();
  });
  ["todayStatusFilter", "matrixRange", "projectFilter", "statusFilter", "insightRange"].forEach((id) => {
    $(`#${id}`).addEventListener("change", render);
  });
  $("#generateWeekly").addEventListener("click", () => {
    $("#weeklyReport").value = buildWeeklyReport(...weekToRange($("#weekPicker").value));
    showToast("周报已生成");
  });
  $("#copyWeekly").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#weeklyReport").value);
    showToast("周报已复制");
  });
}

bindEvents();
initCloud().finally(render);
