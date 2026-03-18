// 简单的本地数据存储封装（localStorage）
const STORAGE_KEY = "reading_landing_app_v1";

// 通义千问（DashScope）配置
// 注意：前端直接写 API Key 在正式产品中并不安全，这里仅用于本地个人使用的原型。
const QWEN_API_KEY = "sk-1a6a2fff0c904afe8f77d7a988c7099a";
const QWEN_API_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        books: [],
        cards: [],
        todos: [],
        checkins: [],
        settings: {
          modes: {
            cards: true,
            todos: true,
            notification: false,
          },
          reminderTime: "08:30",
        },
      };
    }
    const parsed = JSON.parse(raw);
    // 简单的向后兼容保护
    return {
      books: parsed.books || [],
      cards: parsed.cards || [],
      todos: parsed.todos || [],
      checkins: parsed.checkins || [],
      settings: parsed.settings || {
        modes: { cards: true, todos: true, notification: false },
        reminderTime: "08:30",
      },
    };
  } catch (e) {
    console.error("Failed to load state", e);
    return {
      books: [],
      cards: [],
      todos: [],
      checkins: [],
      settings: {
        modes: {
          cards: true,
          todos: true,
          notification: false,
        },
        reminderTime: "08:30",
      },
    };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// 简单 ID 生成
function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// 全局状态
let state = loadState();

// 多选状态（仅存在于前端内存）
let selectedCardIds = new Set();
let selectedTodoIds = new Set();

// ---- 视图初始化 ----

document.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  setupImport();
  setupSettings();
  renderAll();
  setupDailyReminderCheck();
});

function setupTabs() {
  const buttons = document.querySelectorAll(".nav-button");
  const tabs = document.querySelectorAll(".tab");

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.getAttribute("data-tab");
      // 激活按钮
      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      // 激活面板
      tabs.forEach((tab) => {
        tab.classList.toggle("active", tab.id === `tab-${tabId}`);
      });
    });
  });
}

// ---- 导入逻辑 ----

function setupImport() {
  const fileInput = document.getElementById("file-input");
  const rawTextInput = document.getElementById("raw-text-input");
  const importButton = document.getElementById("import-button");
  const importStatus = document.getElementById("import-status");

  importButton.addEventListener("click", async () => {
    importStatus.textContent = "";
    importStatus.className = "status-message";

    const platform = document.getElementById("platform-select").value;
    const bookTitleInput = document.getElementById("book-title-input");
    const useAiFilter = document.getElementById("use-ai-filter-checkbox").checked;
    const createTodo = document.getElementById("create-todo-checkbox").checked;

    let textContent = rawTextInput.value.trim();

    // 如果没粘贴文本但选择了文件，则读取文件
    const file = fileInput.files && fileInput.files[0];
    if (!textContent && file) {
      try {
        textContent = await file.text();
      } catch (e) {
        importStatus.textContent = "读取文件失败，请重试或改用粘贴方式。";
        importStatus.classList.add("error");
        return;
      }
    }

    if (!textContent) {
      importStatus.textContent = "请至少上传一个导出文件，或在下方粘贴标注文本。";
      importStatus.classList.add("error");
      return;
    }

    // 生成书籍
    const bookId = uid();
    const title =
      bookTitleInput.value.trim() ||
      guessBookTitleFromContent(textContent) ||
      "未命名图书";

    const book = {
      id: bookId,
      title,
      platform,
      createdAt: new Date().toISOString(),
    };

    // 解析为观念条目
    let entries = [];

    // 如果勾选了 AI 筛选，并且有可用的 API Key，则先调用通义千问做一次提炼
    if (useAiFilter && QWEN_API_KEY) {
      importStatus.textContent = "正在调用通义千问筛选真正有复习价值的内容，请稍等…";
      importButton.disabled = true;
      try {
        const aiLines = await aiFilterAndGenerateLines(title, textContent);
        // AI 返回的一般已经是「每条一行」，这里简单包一层结构
        entries = aiLines.map((line) => ({
          text: line,
          note: "",
          tags: [],
        }));
      } catch (e) {
        console.error("AI 筛选失败，改用本地规则解析：", e);
      } finally {
        importButton.disabled = false;
      }
    }

    // 如果没有使用 AI，或者 AI 没返回东西，就回退到本地按行解析
    if (!entries.length) {
      entries = parseHighlights(platform, textContent);
    }

    if (entries.length === 0) {
      importStatus.textContent = "没有解析出有效的观念条目，请检查导出的内容格式。";
      importStatus.classList.add("error");
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const newCards = [];
    const newTodos = [];

    for (const entry of entries) {
      const cardId = uid();
      const card = {
        id: cardId,
        bookId,
        type: "idea",
        content: entry.text,
        note: entry.note || "",
        tags: entry.tags || [],
        createdAt: new Date().toISOString(),
        lastReviewed: null,
        reviewCount: 0,
        active: true,
      };
      newCards.push(card);

      if (createTodo) {
        newTodos.push({
          id: uid(),
          cardId,
          bookId,
          title: shortenText(entry.text, 40),
          createdAt: new Date().toISOString(),
          streak: 0,
          lastCheckinDate: null,
          active: true,
        });
      }
    }

    state.books.push(book);
    state.cards.push(...newCards);
    state.todos.push(...newTodos);

    saveState();
    renderAll();

    importStatus.textContent = `已导入「${title}」，生成 ${newCards.length} 条观念卡片${
      createTodo ? `，以及 ${newTodos.length} 条待办打卡项` : ""
    }。`;
    importStatus.classList.add("success");

    // 清理输入
    rawTextInput.value = "";
    fileInput.value = "";
    if (!bookTitleInput.dataset.locked) {
      bookTitleInput.value = "";
    }
  });
}

function guessBookTitleFromContent(text) {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!firstLine) return null;
  // 很粗糙：如果第一行太长，就不当标题
  if (firstLine.trim().length > 40) return null;
  return firstLine.trim();
}

// 针对不同平台做非常简单的解析：先按行切分，过滤掉太短的 / 明显是元数据的行
function parseHighlights(platform, text) {
  const lines = text.split(/\r?\n/);
  const entries = [];

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // 简单过滤 Kindle / 微信读书 中常见的元数据模式
    const lower = line.toLowerCase();
    if (
      lower.startsWith("位置 ") ||
      lower.startsWith("loc ") ||
      lower.startsWith("page ") ||
      lower.startsWith("highlight(") ||
      lower.startsWith("标注于") ||
      lower.startsWith("添加于") ||
      lower.startsWith("笔记于") ||
      lower.startsWith("—— 来自") ||
      lower.startsWith("来自：") ||
      lower.startsWith("《") // 很多导出会包含书名行，后面我们单独猜标题
    ) {
      continue;
    }

    // 过滤掉几乎没有信息的短句
    if (line.length < 6) continue;

    entries.push({
      text: line,
      note: "",
      tags: [],
    });
  }

  return entries;
}

// 使用通义千问，对整段读书笔记做一次「只保留有复习价值内容」的筛选与提炼
async function aiFilterAndGenerateLines(bookName, noteText) {
  const prompt = `你是「蒹葭」读书笔记智能筛选助手。
目标：从读书笔记中，只保留真正值得重复复习、用于长期内化的内容，包括：
- 明确的观点或判断
- 方法论、步骤、原则
- 需要记忆或长期坚持的习惯/行动建议

请过滤掉：
- 纯粹过渡句、感叹句
- 作者举的具体例子或故事细节（除非本身就是一个原则）
- 目录、页码、位置、时间、格式信息

书名：《${bookName}》
读书笔记原文：
${noteText}

输出要求：
- 只返回筛选后的内容列表，每条一行
- 不要任何序号、解释或额外前缀
- 使用简洁的口语化中文，方便放到卡片里反复阅读。`;

  const response = await fetch(QWEN_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${QWEN_API_KEY}`,
    },
    body: JSON.stringify({
      model: "qwen-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 2000,
    }),
  });

  if (!response.ok) {
    throw new Error(`通义千问接口返回错误状态码：${response.status}`);
  }

  const data = await response.json();
  if (!data.choices || !data.choices.length) {
    throw new Error("通义千问未返回有效内容");
  }

  const aiResult = (data.choices[0].message.content || "").trim();
  const lines = aiResult
    .split("\n")
    .map((line) => line.replace(/^[\s\-·\d\.、]+/, "").trim()) // 去掉可能的序号/符号
    .filter((line) => line.length > 0);

  return lines;
}

function shortenText(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

// ---- 渲染函数 ----

function renderAll() {
  renderBooks();
  renderCards();
  renderTodos();
  renderTimeline();
  renderSettings();
}

function renderBooks() {
  const list = document.getElementById("book-list");
  list.innerHTML = "";
  if (!state.books.length) {
    const li = document.createElement("li");
    li.className = "hint";
    li.textContent = "还没有导入任何图书。导入一批标注试试吧。";
    list.appendChild(li);
    return;
  }

  const cardsByBook = groupBy(state.cards, (c) => c.bookId);

  const platformMap = {
    kindle: "Kindle",
    wechat: "微信读书",
    duokan: "多看",
    apple: "Apple Books",
    plain: "其他",
  };

  for (const book of state.books) {
    const li = document.createElement("li");
    li.className = "book-item";

    const meta = document.createElement("div");
    meta.className = "book-meta";

    const title = document.createElement("div");
    title.className = "book-title";
    title.textContent = book.title;

    const sub = document.createElement("div");
    sub.className = "book-subline";
    const d = new Date(book.createdAt);
    sub.textContent = `${platformMap[book.platform] || "未知来源"} · 导入于 ${
      d.toISOString().slice(0, 10)
    }`;

    const stats = document.createElement("div");
    stats.className = "book-stats";
    const cardCount = (cardsByBook[book.id] || []).length;
    stats.textContent = `${cardCount} 条观念卡片`;

    meta.appendChild(title);
    meta.appendChild(sub);
    meta.appendChild(stats);

    const actions = document.createElement("div");

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "已导入";

    actions.appendChild(badge);

    li.appendChild(meta);
    li.appendChild(actions);
    list.appendChild(li);
  }
}

function renderCards() {
  const container = document.getElementById("card-list");
  const hint = document.getElementById("no-cards-hint");
  const toolbar = document.getElementById("card-toolbar");
  container.innerHTML = "";
  hint.textContent = "";
  toolbar.innerHTML = "";

  const today = new Date().toISOString().slice(0, 10);

  // 简化版：所有 active 的卡片每天都可以出现一次
  const activeCards = state.cards.filter((c) => c.active);
  if (!activeCards.length) {
    hint.textContent = "还没有任何观念卡片。先从「导入图书」开始吧。";
    selectedCardIds = new Set();
    return;
  }

  const booksById = mapById(state.books);

  // 工具栏（全选 / 删除选中）
  const left = document.createElement("div");
  left.className = "list-toolbar-left";
  const selectAllLabel = document.createElement("label");
  const selectAllCheckbox = document.createElement("input");
  selectAllCheckbox.type = "checkbox";
  selectAllCheckbox.addEventListener("change", () => {
    selectedCardIds = new Set();
    if (selectAllCheckbox.checked) {
      activeCards.forEach((c) => selectedCardIds.add(c.id));
    }
    renderCards();
  });
  selectAllLabel.appendChild(selectAllCheckbox);
  const textNode = document.createTextNode("全选当前卡片");
  selectAllLabel.appendChild(textNode);
  left.appendChild(selectAllLabel);

  const countSpan = document.createElement("span");
  countSpan.textContent = selectedCardIds.size ? `已选中 ${selectedCardIds.size} 张卡片` : "点击左侧小方框可多选删除";

  const right = document.createElement("div");
  right.className = "list-toolbar-right";
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "toolbar-button danger";
  deleteBtn.textContent = "删除选中卡片";
  deleteBtn.disabled = !selectedCardIds.size;
  deleteBtn.addEventListener("click", () => {
    if (!selectedCardIds.size) return;
    if (!confirm(`确定要删除这 ${selectedCardIds.size} 张卡片吗？相关的打卡记录也会一并清理。`)) return;
    deleteCards(Array.from(selectedCardIds));
    selectedCardIds = new Set();
    renderAll();
  });

  right.appendChild(deleteBtn);

  const toolbarLeftWrap = document.createElement("div");
  toolbarLeftWrap.className = "list-toolbar-left";
  toolbarLeftWrap.appendChild(selectAllLabel);
  toolbarLeftWrap.appendChild(countSpan);

  toolbar.appendChild(toolbarLeftWrap);
  toolbar.appendChild(right);

  // 如果当前所有 active 卡片都在选中集合里，则勾选全选框
  if (activeCards.length && activeCards.every((c) => selectedCardIds.has(c.id))) {
    selectAllCheckbox.checked = true;
  }

  activeCards.forEach((card) => {
    const item = document.createElement("div");
    item.className = "card-item";

    // 右键删除单个卡片
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (confirm("确定要删除这张卡片吗？相关的打卡记录也会一并清理。")) {
        deleteCards([card.id]);
        selectedCardIds.delete(card.id);
        renderAll();
      }
    });

    const topRow = document.createElement("div");
    topRow.style.display = "flex";
    topRow.style.alignItems = "flex-start";
    topRow.style.gap = "6px";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "row-select";
    checkbox.checked = selectedCardIds.has(card.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedCardIds.add(card.id);
      } else {
        selectedCardIds.delete(card.id);
      }
      renderCards();
    });

    const header = document.createElement("div");
    header.className = "card-item-header";

    const left = document.createElement("div");
    const bookTitle = booksById[card.bookId]?.title || "未知图书";
    const bookEl = document.createElement("div");
    bookEl.className = "card-book";
    bookEl.textContent = `来自《${bookTitle}》`;
    left.appendChild(bookEl);

    const right = document.createElement("div");
    right.className = "tag-list";
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `已复习 ${card.reviewCount || 0} 次`;
    right.appendChild(tag);

    header.appendChild(left);
    header.appendChild(right);

    const content = document.createElement("div");
    content.className = "card-content";
    content.textContent = card.content;

    const note = document.createElement("div");
    note.className = "card-note";
    if (card.note) {
      note.textContent = card.note;
    }

    const actions = document.createElement("div");
    actions.className = "card-actions";

    const textarea = document.createElement("textarea");
    textarea.placeholder = "写一句今天的应用或感受，顺便完成一次打卡。";

    const doneButton = document.createElement("button");
    doneButton.className = "secondary-button";
    doneButton.textContent = "只标记已阅读";
    doneButton.addEventListener("click", () => {
      markCardReviewed(card.id, today, "");
    });

    const checkinButton = document.createElement("button");
    checkinButton.className = "primary-button";
    checkinButton.textContent = "打卡 + 记录";
    checkinButton.addEventListener("click", () => {
      const text = textarea.value.trim();
      markCardReviewed(card.id, today, text);
      textarea.value = "";
    });

    actions.appendChild(textarea);
    actions.appendChild(checkinButton);
    actions.appendChild(doneButton);

    topRow.appendChild(checkbox);
    topRow.appendChild(header);

    item.appendChild(topRow);
    item.appendChild(content);
    if (card.note) item.appendChild(note);
    item.appendChild(actions);

    container.appendChild(item);
  });
}

function renderTodos() {
  const container = document.getElementById("todo-list");
  const hint = document.getElementById("no-todos-hint");
  const toolbar = document.getElementById("todo-toolbar");
  container.innerHTML = "";
  hint.textContent = "";
  toolbar.innerHTML = "";

  const activeTodos = state.todos.filter((t) => t.active);
  if (!activeTodos.length) {
    hint.textContent = "还没有待办打卡项。导入时勾选「创建待办打卡」，或之后手动为某些观念增加行动。";
    selectedTodoIds = new Set();
    return;
  }

  const cardsById = mapById(state.cards);
  const booksById = mapById(state.books);
  const today = new Date().toISOString().slice(0, 10);

  // 工具栏（全选 / 删除选中）
  const left = document.createElement("div");
  left.className = "list-toolbar-left";
  const selectAllLabel = document.createElement("label");
  const selectAllCheckbox = document.createElement("input");
  selectAllCheckbox.type = "checkbox";
  selectAllCheckbox.addEventListener("change", () => {
    selectedTodoIds = new Set();
    if (selectAllCheckbox.checked) {
      activeTodos.forEach((t) => selectedTodoIds.add(t.id));
    }
    renderTodos();
  });
  selectAllLabel.appendChild(selectAllCheckbox);
  const textNode = document.createTextNode("全选当前待办");
  selectAllLabel.appendChild(textNode);
  left.appendChild(selectAllLabel);

  const countSpan = document.createElement("span");
  countSpan.textContent = selectedTodoIds.size ? `已选中 ${selectedTodoIds.size} 条待办` : "可以多选后一起删除不再需要的待办";

  const right = document.createElement("div");
  right.className = "list-toolbar-right";
  const hideBtn = document.createElement("button");
  hideBtn.className = "toolbar-button";
  hideBtn.textContent = "仅隐藏选中待办";
  hideBtn.disabled = !selectedTodoIds.size;
  hideBtn.addEventListener("click", () => {
    if (!selectedTodoIds.size) return;
    if (!confirm(`确定要仅隐藏这 ${selectedTodoIds.size} 条待办吗？历史打卡记录会保留在时间轴中。`)) return;
    hideTodos(Array.from(selectedTodoIds));
    selectedTodoIds = new Set();
    renderAll();
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "toolbar-button danger";
  deleteBtn.textContent = "彻底删除选中待办";
  deleteBtn.disabled = !selectedTodoIds.size;
  deleteBtn.addEventListener("click", () => {
    if (!selectedTodoIds.size) return;
    if (!confirm(`确定要彻底删除这 ${selectedTodoIds.size} 条待办吗？相关的打卡记录也会一并清理。`)) return;
    deleteTodos(Array.from(selectedTodoIds));
    selectedTodoIds = new Set();
    renderAll();
  });

  right.appendChild(hideBtn);
  right.appendChild(deleteBtn);

  const toolbarLeftWrap = document.createElement("div");
  toolbarLeftWrap.className = "list-toolbar-left";
  toolbarLeftWrap.appendChild(selectAllLabel);
  toolbarLeftWrap.appendChild(countSpan);

  toolbar.appendChild(toolbarLeftWrap);
  toolbar.appendChild(right);

  if (activeTodos.length && activeTodos.every((t) => selectedTodoIds.has(t.id))) {
    selectAllCheckbox.checked = true;
  }

  activeTodos.forEach((todo) => {
    const card = cardsById[todo.cardId];
    const book = card ? booksById[card.bookId] : null;

    const item = document.createElement("div");
    item.className = "todo-item";

    // 右键删除单个待办
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const action = window.prompt("输入 1 仅隐藏此待办（保留历史），输入 2 彻底删除此待办：", "1");
      if (action === "2") {
        if (confirm("确定要彻底删除这条待办吗？相关的打卡记录也会一并清理。")) {
          deleteTodos([todo.id]);
          selectedTodoIds.delete(todo.id);
          renderAll();
        }
      } else if (action === "1") {
        hideTodos([todo.id]);
        selectedTodoIds.delete(todo.id);
        renderAll();
      }
    });

    const topRow = document.createElement("div");
    topRow.style.display = "flex";
    topRow.style.alignItems = "flex-start";
    topRow.style.gap = "6px";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "row-select";
    checkbox.checked = selectedTodoIds.has(todo.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedTodoIds.add(todo.id);
      } else {
        selectedTodoIds.delete(todo.id);
      }
      renderTodos();
    });

    const header = document.createElement("div");
    header.className = "todo-header";

    const left = document.createElement("div");
    const titleEl = document.createElement("div");
    titleEl.className = "todo-title";
    titleEl.textContent = todo.title;
    const sub = document.createElement("div");
    sub.className = "todo-subline";
    sub.textContent = book ? `来自《${book.title}》` : "来自导入观念";

    left.appendChild(titleEl);
    left.appendChild(sub);

    const right = document.createElement("div");
    right.className = "todo-streak";
    right.textContent = `连续打卡 ${todo.streak || 0} 天`;

    header.appendChild(left);
    header.appendChild(right);

    const actions = document.createElement("div");
    actions.className = "todo-actions";

    const checkinBtn = document.createElement("button");
    checkinBtn.className = "primary-button";
    checkinBtn.textContent = todo.lastCheckinDate === today ? "今天已打卡" : "今天打卡";
    checkinBtn.disabled = todo.lastCheckinDate === today;

    checkinBtn.addEventListener("click", () => {
      performTodoCheckin(todo.id, card?.id || null);
    });

    const deactivateBtn = document.createElement("button");
    deactivateBtn.className = "secondary-button";
    deactivateBtn.textContent = "暂停此待办";
    deactivateBtn.addEventListener("click", () => {
      if (confirm("确定要暂停这个待办吗？之后可以在导入数据中重新启用。")) {
        todo.active = false;
        saveState();
        renderTodos();
      }
    });

    actions.appendChild(checkinBtn);
    actions.appendChild(deactivateBtn);

    topRow.appendChild(checkbox);
    topRow.appendChild(header);

    item.appendChild(topRow);
    item.appendChild(actions);
    container.appendChild(item);
  });
}

function renderTimeline() {
  const summaryContainer = document.getElementById("timeline-summary");
  const listContainer = document.getElementById("timeline-list");
  summaryContainer.innerHTML = "";
  listContainer.innerHTML = "";

  if (!state.checkins.length) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "还没有任何打卡或复盘记录。可以从卡片或待办里开始打卡。";
    listContainer.appendChild(hint);
    return;
  }

  const byDate = groupBy(state.checkins, (c) => c.date);
  const dates = Object.keys(byDate).sort().reverse(); // 倒序

  // 计算 14 天内的热度
  const today = new Date();
  const heatMap = {};

  dates.forEach((date) => {
    const checkins = byDate[date];
    const count = checkins.length;
    const words = checkins.reduce((sum, c) => sum + (c.noteLength || 0), 0);
    const score = count * 1 + words / 80; // 简单权重：字数越多，说明复盘越深
    let level = 0;
    if (score > 3) level = 3;
    else if (score > 1.5) level = 2;
    else if (score > 0.5) level = 1;
    heatMap[date] = { level, count, words };
  });

  // 概览条（最近 14 天）
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const label = d.getDate();
    const heat = heatMap[dateStr] || { level: 0, count: 0, words: 0 };

    const dot = document.createElement("div");
    dot.className = "timeline-day-dot";

    const bar = document.createElement("div");
    bar.className = `timeline-bar level-${heat.level}`;

    const text = document.createElement("div");
    text.textContent = label;

    dot.appendChild(bar);
    dot.appendChild(text);
    summaryContainer.appendChild(dot);
  }

  // 详细列表（按日展开）
  const cardsById = mapById(state.cards);
  const booksById = mapById(state.books);

  dates.forEach((date) => {
    const group = document.createElement("div");
    group.className = "timeline-group";

    const header = document.createElement("div");
    header.className = "timeline-group-header";

    const left = document.createElement("div");
    const right = document.createElement("div");
    const meta = heatMap[date];

    left.textContent = date;
    right.textContent = `${meta.count} 次打卡 · 约 ${Math.round(meta.words)} 字复盘`;

    header.appendChild(left);
    header.appendChild(right);

    group.appendChild(header);

    const daily = byDate[date];
    daily.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "timeline-entry";

      const title = document.createElement("div");
      title.className = "timeline-entry-title";
      const card = cardsById[entry.cardId];
      const book = card ? booksById[card.bookId] : null;
      const label = card
        ? shortenText(card.content.replace(/\s+/g, " "), 36)
        : "未找到对应观念";
      title.textContent = book ? `《${book.title}》 · ${label}` : label;

      row.appendChild(title);

      if (entry.note) {
        const note = document.createElement("div");
        note.className = "timeline-entry-note";
        note.textContent = entry.note;
        row.appendChild(note);
      }

      group.appendChild(row);
    });

    listContainer.appendChild(group);
  });
}

function renderSettings() {
  const { modes, reminderTime } = state.settings;
  document.getElementById("mode-cards").checked = !!modes.cards;
  document.getElementById("mode-todos").checked = !!modes.todos;
  document.getElementById("mode-notification").checked = !!modes.notification;
  document.getElementById("reminder-time").value = reminderTime || "08:30";
}

// ---- 业务动作 ----

function markCardReviewed(cardId, date, noteText) {
  const card = state.cards.find((c) => c.id === cardId);
  if (!card) return;
  card.reviewCount = (card.reviewCount || 0) + 1;
  card.lastReviewed = date;

  const trimmed = noteText.trim();
  if (trimmed) {
    const checkin = {
      id: uid(),
      type: "card",
      cardId,
      date,
      note: trimmed,
      noteLength: trimmed.length,
      createdAt: new Date().toISOString(),
    };
    state.checkins.push(checkin);
  }

  saveState();
  renderCards();
  renderTimeline();
}

function performTodoCheckin(todoId, cardId) {
  const todo = state.todos.find((t) => t.id === todoId);
  if (!todo) return;

  const today = new Date().toISOString().slice(0, 10);
  if (todo.lastCheckinDate === today) return;

  // 简单连续天数逻辑
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  const yestStr = yest.toISOString().slice(0, 10);
  if (todo.lastCheckinDate === yestStr) {
    todo.streak = (todo.streak || 0) + 1;
  } else {
    todo.streak = 1;
  }
  todo.lastCheckinDate = today;

  const checkin = {
    id: uid(),
    type: "todo",
    cardId: cardId || null,
    date: today,
    note: "",
    noteLength: 0,
    createdAt: new Date().toISOString(),
  };
  state.checkins.push(checkin);

  saveState();
  renderTodos();
  renderTimeline();
}

// ---- 删除工具函数 ----

function deleteCards(cardIds) {
  const idSet = new Set(cardIds);
  // 删除卡片本身
  state.cards = state.cards.filter((c) => !idSet.has(c.id));
  // 删除关联的待办
  state.todos = state.todos.filter((t) => !idSet.has(t.cardId));
  // 删除关联的打卡记录
  state.checkins = state.checkins.filter((c) => !c.cardId || !idSet.has(c.cardId));
  saveState();
}

function deleteTodos(todoIds) {
  const idSet = new Set(todoIds);
  // 删除待办
  state.todos = state.todos.filter((t) => !idSet.has(t.id));
  // 删除和这些待办相关的打卡记录（类型为 todo 且没有 cardId 的那部分）
  state.checkins = state.checkins.filter((c) => !(c.type === "todo" && !c.cardId));
  saveState();
}

function hideTodos(todoIds) {
  const idSet = new Set(todoIds);
  state.todos = state.todos.map((t) =>
    idSet.has(t.id)
      ? {
          ...t,
          active: false,
        }
      : t
  );
  // 不动 checkins，时间轴仍然保留历史
  saveState();
}

// ---- 设置 & 本地通知 ----

function setupSettings() {
  const saveBtn = document.getElementById("save-settings-button");
  const status = document.getElementById("settings-status");

  saveBtn.addEventListener("click", async () => {
    const modes = {
      cards: document.getElementById("mode-cards").checked,
      todos: document.getElementById("mode-todos").checked,
      notification: document.getElementById("mode-notification").checked,
    };
    const time = document.getElementById("reminder-time").value || "08:30";

    if (modes.notification) {
      const granted = await ensureNotificationPermission();
      if (!granted) {
        modes.notification = false;
      }
    }

    state.settings.modes = modes;
    state.settings.reminderTime = time;
    saveState();

    status.textContent = "已保存提醒设置（浏览器需保持打开才能触发本地提醒）。";
    status.className = "status-message success";
  });
}

async function ensureNotificationPermission() {
  if (!("Notification" in window)) {
    alert("当前浏览器不支持通知API。");
    return false;
  }
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;

  try {
    const result = await Notification.requestPermission();
    return result === "granted";
  } catch (e) {
    console.error("Notification permission error", e);
    return false;
  }
}

function setupDailyReminderCheck() {
  // 简单轮询：每 60 秒检查一次是否接近设定时间
  setInterval(() => {
    const { modes, reminderTime } = state.settings;
    if (!modes.notification) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;

    const now = new Date();
    const [hStr, mStr] = (reminderTime || "08:30").split(":");
    const targetMinutes = parseInt(hStr, 10) * 60 + parseInt(mStr, 10);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    // 在目标时间 +/- 1 分钟内，每天只提醒一次
    const diff = Math.abs(nowMinutes - targetMinutes);
    const today = now.toISOString().slice(0, 10);
    const lastNotifiedDay = localStorage.getItem(`${STORAGE_KEY}_last_notify_day`);
    if (diff <= 1 && lastNotifiedDay !== today) {
      localStorage.setItem(`${STORAGE_KEY}_last_notify_day`, today);
      const parts = [];
      if (modes.cards) parts.push("复习观念卡片");
      if (modes.todos) parts.push("完成行动打卡");
      const body = parts.length ? parts.join(" / ") : "回顾一下今天想坚持的观念";

      new Notification("读书落地助手 · 每日提醒", {
        body,
        tag: "reading-landing-daily",
      });
    }
  }, 60000);
}

// ---- 小工具 ----

function groupBy(list, keyFn) {
  return list.reduce((acc, item) => {
    const key = keyFn(item);
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

function mapById(list) {
  return list.reduce((acc, item) => {
    acc[item.id] = item;
    return acc;
  }, {});
}

