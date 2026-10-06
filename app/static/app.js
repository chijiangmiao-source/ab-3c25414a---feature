"use strict";

const EXAMPLES = {
  "误预测回滚（正确轨迹）": {
    program: [
      "ADD R1,R0,R0",
      "ADD R2,R1,R0",
      "BEQ R1,R2 predict=taken",
      "ADD R3,R1,R2",
      "ADD R4,R3,R1",
      "ADD R1,R4,R2",
      "SUB R5,R1,R0"
    ].join("\n"),
    events: [
      "dispatch I0",
      "dispatch I1",
      "dispatch I2",
      "dispatch I3",
      "dispatch I4",
      "writeback I0",
      "writeback I1",
      "commit I0",
      "writeback I2",
      "resolve I2 not-taken",
      "dispatch I5",
      "dispatch I6",
      "writeback I5",
      "writeback I6",
      "commit I1",
      "commit I2",
      "commit I5",
      "commit I6"
    ].join("\n")
  },
  "违规：被清除写回到达": {
    program: [
      "ADD R1,R0,R0",
      "BEQ R1,R0 predict=taken",
      "ADD R2,R1,R0",
      "ADD R3,R2,R1",
      "ADD R1,R3,R0"
    ].join("\n"),
    events: [
      "dispatch I0",
      "dispatch I1",
      "dispatch I2",
      "dispatch I3",
      "writeback I0",
      "writeback I1",
      "commit I0",
      "resolve I1 not-taken",
      "dispatch I4",
      "writeback I3"
    ].join("\n")
  },
  "异常精确回滚（正确轨迹）": {
    program: [
      "ADD R1,R0,R0",
      "ADD R2,R1,R0",
      "MUL R3,R1,R2",
      "ADD R4,R3,R1",
      "SUB R5,R4,R3"
    ].join("\n"),
    events: [
      "dispatch I0",
      "dispatch I1",
      "dispatch I2",
      "dispatch I3",
      "dispatch I4",
      "writeback I0",
      "commit I0",
      "writeback I1",
      "writeback I2",
      "exception I2",
      "writeback I3",
      "commit I1"
    ].join("\n")
  },
  "违规：异常回滚后写回迟到": {
    program: [
      "ADD R1,R0,R0",
      "MUL R2,R1,R0",
      "ADD R3,R2,R1"
    ].join("\n"),
    events: [
      "dispatch I0",
      "dispatch I1",
      "dispatch I2",
      "writeback I0",
      "commit I0",
      "writeback I1",
      "exception I1",
      "writeback I2"
    ].join("\n")
  },
  "违规：未完成队首提交": {
    program: [
      "ADD R1,R0,R0",
      "ADD R2,R1,R0",
      "ADD R3,R2,R1"
    ].join("\n"),
    events: [
      "dispatch I0",
      "dispatch I1",
      "writeback I1",
      "commit I0"
    ].join("\n")
  },
  "正确预测分支 + 提交序": {
    program: [
      "ADD R1,R0,R0",
      "BNE R1,R0 predict=not-taken",
      "ADD R2,R1,R0"
    ].join("\n"),
    events: [
      "dispatch I0",
      "dispatch I1",
      "dispatch I2",
      "writeback I0",
      "writeback I1",
      "resolve I1 not-taken",
      "commit I0",
      "commit I1",
      "writeback I2",
      "commit I2"
    ].join("\n")
  }
};

const els = {
  program: document.getElementById("program-input"),
  events: document.getElementById("events-input"),
  numphys: document.getElementById("numphys-input"),
  example: document.getElementById("example-select"),
  parseStatus: document.getElementById("parse-status"),
  verdict: document.getElementById("verdict"),
  cursorInfo: document.getElementById("cursor-info"),
  banner: document.getElementById("violation-banner"),
  timeline: document.getElementById("timeline"),
  detail: document.getElementById("detail"),
  regSelect: document.getElementById("reg-select"),
  lineageView: document.getElementById("lineage-view"),
  lineageStatus: document.getElementById("lineage-status"),
  btnValidate: document.getElementById("btn-validate"),
  btnSimulate: document.getElementById("btn-simulate"),
  btnSession: document.getElementById("btn-session"),
  btnStep: document.getElementById("btn-step"),
  btnReset: document.getElementById("btn-reset")
};

let state = {
  steps: [],
  violationStep: null,
  selected: -1,
  sessionId: null,
  mode: null, // "session" | "oneshot"
  instructions: [],
  lineageReg: 0
};

function initExamples() {
  for (const name of Object.keys(EXAMPLES)) {
    const opt = document.createElement("option");
    opt.textContent = name;
    opt.value = name;
    els.example.appendChild(opt);
  }
  els.example.addEventListener("change", () => {
    const ex = EXAMPLES[els.example.value];
    if (ex) {
      els.program.value = ex.program;
      els.events.value = ex.events;
    }
  });
  els.example.value = Object.keys(EXAMPLES)[0];
  els.example.dispatchEvent(new Event("change"));
}

function setStatus(msg, kind) {
  els.parseStatus.textContent = msg || "";
  els.parseStatus.className = "status-line" + (kind ? " " + kind : "");
}

function setVerdict(text, kind) {
  els.verdict.textContent = text;
  els.verdict.className = "verdict" + (kind ? " " + kind : "");
}

function payload() {
  return {
    program: els.program.value,
    events: els.events.value,
    num_phys: Number(els.numphys.value) || 16
  };
}

async function api(path, method, body) {
  const res = await fetch(path, {
    method: method || "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* leave null */ }
  if (!res.ok) {
    let msg = data && (data.error || (data.violation && data.violation.message)) || `HTTP ${res.status}`;
    if (typeof msg === "object") msg = msg.message || JSON.stringify(msg);
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

// ---------------------------------------------------------------- rendering

function clearResult() {
  state.steps = [];
  state.violationStep = null;
  state.selected = -1;
  els.timeline.innerHTML = "";
  els.detail.innerHTML = '<p class="placeholder">执行后在此展开证据。</p>';
  els.banner.classList.add("hidden");
}

function initRegSelect() {
  for (let r = 0; r < 8; r++) {
    const opt = document.createElement("option");
    opt.value = String(r);
    opt.textContent = `R${r}`;
    els.regSelect.appendChild(opt);
  }
  els.regSelect.addEventListener("change", () => {
    state.lineageReg = Number(els.regSelect.value);
    refreshLineage();
  });
}

function renderReport(report) {
  state.mode = "oneshot";
  state.steps = report.steps || [];
  state.instructions = report.instructions || [];
  state.violationStep = report.violation_step;
  renderTimeline(report.num_events);
  if (report.violation) {
    setVerdict("发现违规（已定位首个）", "bad");
    renderViolationBanner(report.violation);
    selectStep(report.violation_step);
  } else {
    setVerdict(`全部 ${report.num_events} 个事件合法`, "ok");
    els.banner.classList.add("hidden");
    if (state.steps.length) selectStep(state.steps.length - 1);
  }
}

function renderTimeline(totalEvents) {
  els.timeline.innerHTML = "";
  for (let i = 0; i < totalEvents; i++) {
    const li = document.createElement("li");
    const step = state.steps[i];
    let cls = "pending";
    let label = "待执行";
    if (step) {
      if (step.violation) { cls = "bad"; label = step.description; }
      else { cls = "ok"; label = step.description; }
    } else {
      label = `事件 #${i} 未执行`;
    }
    li.className = cls;
    li.innerHTML = `<span class="idx">#${i}</span><span>${escapeHtml(label)}</span>`;
    li.addEventListener("click", () => selectStep(i));
    els.timeline.appendChild(li);
  }
}

function renderViolationBanner(v) {
  els.banner.classList.remove("hidden");
  els.banner.innerHTML =
    `<div><span class="code">${escapeHtml(v.code)}</span></div>
     <div class="msg">${escapeHtml(v.message)}</div>`;
}

function selectStep(i) {
  const step = state.steps[i];
  if (!step) return;
  state.selected = i;
  [...els.timeline.children].forEach((li, idx) =>
    li.classList.toggle("selected", idx === i));
  els.detail.innerHTML = "";
  els.detail.appendChild(renderStepDetail(step));
  refreshLineage();
}

function mapTable(snap, changedCols) {
  const tbl = document.createElement("table");
  tbl.className = "state";
  const head = ["", ...snap.map_table.map((_, r) => `R${r}`)];
  const thead = "<tr>" + head.map((h, j) =>
    `<th>${j === 0 ? "" : h}</th>`).join("") + "</tr>";
  const rowLabel = "<tr><td class='label'>映射到</td>";
  const cells = snap.map_table.map((p, r) =>
    `<td class="${changedCols && changedCols.has(r) ? "cell-changed" : ""}"><span class="tag">P${p}</span></td>`
  ).join("");
  tbl.innerHTML = thead + rowLabel + cells + "</tr>";
  return tbl;
}

function changedArchSet(before, after) {
  const s = new Set();
  if (!before || !after) return s;
  for (let r = 0; r < before.map_table.length; r++) {
    if (before.map_table[r] !== after.map_table[r]) s.add(r);
  }
  return s;
}

function freeChips(snap, reclaimed, allocated) {
  const wrap = document.createElement("div");
  wrap.className = "chips";
  if (!snap.free_list.length) {
    wrap.innerHTML = '<span class="chip">（空）</span>';
    return wrap;
  }
  for (const t of snap.free_list) {
    const c = document.createElement("span");
    c.className = "chip" + (reclaimed && reclaimed.includes(t) ? " reclaimed" : "");
    c.textContent = `P${t}`;
    wrap.appendChild(c);
  }
  return wrap;
}

function robCards(snap) {
  const wrap = document.createElement("div");
  wrap.className = "rob-list";
  if (!snap.rob.length) {
    wrap.innerHTML = '<span class="chip">ROB 为空</span>';
    return wrap;
  }
  snap.rob.forEach((e, idx) => {
    const card = document.createElement("div");
    card.className = "rob-card" + (idx === 0 ? " head" : "") + (e.has_exception ? " exc" : "");
    const flags = [];
    flags.push(`<span class="flag ${e.done ? "on" : "off"}">WB</span>`);
    if (e.is_branch) {
      flags.push(`<span class="flag ${e.resolved ? "resolved" : "off"}">RS${e.resolved ? (e.taken ? "=T" : "=NT") : ""}</span>`);
    }
    if (e.has_exception) flags.push('<span class="flag on" style="color:var(--bad)">EXC</span>');
    card.innerHTML =
      `<div class="t">${idx === 0 ? "▶ " : ""}I${e.seq} ${escapeHtml(e.name)}</div>
       <div class="meta">tag=P${e.tag}${e.old_tag !== null ? ` old=P${e.old_tag}` : ""}</div>
       <div class="flags">${flags.join("")}</div>`;
    wrap.appendChild(card);
  });
  return wrap;
}

function checkpointBox(snap) {
  const keys = Object.keys(snap.checkpoints || {});
  const wrap = document.createElement("div");
  wrap.className = "chips";
  if (!keys.length) {
    wrap.innerHTML = '<span class="chip">无活动检查点</span>';
    return wrap;
  }
  for (const seq of keys) {
    const cp = snap.checkpoints[seq];
    const c = document.createElement("span");
    c.className = "chip";
    c.innerHTML = `分支 I${escapeHtml(seq)} → {map: [${cp.map_table.map(p => "P" + p).join(",")}], free: [${cp.free_list.map(p => "P" + p).join(",")} ]}`;
    wrap.appendChild(c);
  }
  return wrap;
}

function h3(text) {
  const h = document.createElement("h3");
  h.textContent = text;
  return h;
}

function renderStepDetail(step) {
  const frag = document.createDocumentFragment();
  const before = step.before;
  const after = step.after;
  const action = step.action;
  const violation = step.violation;
  const changed = changedArchSet(before, after);

  const head = document.createElement("div");
  head.style.marginBottom = "8px";
  head.innerHTML =
    `<strong>事件 #${step.index}：${escapeHtml(step.description)}</strong>` +
    (violation ? ' <span style="color:var(--bad)">→ 违规，复核在此终止</span>' : "");
  frag.appendChild(head);

  if (action && action.action === "dispatch") {
    const ev = document.createElement("div");
    ev.className = "evidence";
    ev.innerHTML =
      `<h4>分派证据</h4>
       <ul>
         <li>目的物理标签：新分配 <span class="tag">P${action.tag}</span>${action.old_tag !== null ? `，旧标签 <span class="tag-old">P${action.old_tag}</span>（记入 ROB，提交时回收）` : "（分支，不分配标签）"}</li>
         <li>源操作数按当时映射读取：${action.src_tags.map((t, i) => `Rs${i}=<span class="tag">P${t}</span>`).join("，")}</li>
         ${action.checkpoint ? `<li>建立分支检查点：map=[${action.checkpoint.map_table.map(p => "P" + p).join(",")}]，free=[${action.checkpoint.free_list.map(p => "P" + p).join(",")}]</li>` : ""}
       </ul>`;
    frag.appendChild(ev);
  }

  if (action && action.action === "resolve" && action.mispredicted) {
    frag.appendChild(renderRollbackEvidence(action));
  }
  if (action && action.exception_rollback) {
    frag.appendChild(renderExceptionEvidence(action.exception_rollback));
  }
  if (action && action.rollback) {
    frag.appendChild(renderExceptionEvidence(action.rollback));
  }
  if (action && action.action === "commit") {
    const ev = document.createElement("div");
    ev.className = "evidence";
    ev.innerHTML = `<h4>提交证据</h4><ul>
      <li>ROB 队首 I${action.seq} 已完成${action.reclaimed_old_tag !== null ? `，回收旧物理标签 <span class="tag-old">P${action.reclaimed_old_tag}</span>` : ""}</li>
    </ul>`;
    frag.appendChild(ev);
  }

  if (violation) {
    const ev = document.createElement("div");
    ev.className = "evidence";
    ev.style.borderColor = "#933";
    ev.innerHTML = `<h4 style="color:#ff8b8b">违规定位</h4>
      <ul><li><strong>${escapeHtml(violation.code)}</strong>：${escapeHtml(violation.message)}</li></ul>`;
    frag.appendChild(ev);
    if (violation.evidence && Object.keys(violation.evidence).length) {
      const pre = document.createElement("pre");
      pre.style.cssText = "font-family:var(--mono);font-size:11.5px;overflow:auto;margin:6px 0;";
      pre.textContent = JSON.stringify(violation.evidence, null, 2);
      ev.appendChild(pre);
    }
  }

  const ba = document.createElement("div");
  ba.className = "before-after";
  const left = document.createElement("div");
  left.className = "ba-box";
  left.innerHTML = "<h4>事件前映射表</h4>";
  left.appendChild(mapTable(before, changed));
  const right = document.createElement("div");
  right.className = "ba-box";
  right.innerHTML = "<h4>事件后映射表</h4>";
  right.appendChild(mapTable(after, changed));
  ba.appendChild(left);
  ba.appendChild(right);
  frag.appendChild(ba);

  frag.appendChild(h3("ROB（事件后）"));
  frag.appendChild(robCards(after));

  const freeRow = document.createElement("div");
  freeRow.className = "before-after";
  const fl = document.createElement("div");
  fl.className = "ba-box";
  fl.innerHTML = "<h4>空闲物理寄存器（事件前）</h4>";
  let reclaimed = action && (action.reclaimed_tags || (action.exception_rollback && action.exception_rollback.reclaimed_tags));
  fl.appendChild(freeChips(before));
  const fr = document.createElement("div");
  fr.className = "ba-box";
  fr.innerHTML = "<h4>空闲物理寄存器（事件后）</h4>";
  fr.appendChild(freeChips(after, reclaimed));
  freeRow.appendChild(fl);
  freeRow.appendChild(fr);
  frag.appendChild(h3("空闲物理寄存器"));
  frag.appendChild(freeRow);

  frag.appendChild(h3("分支检查点（事件后）"));
  frag.appendChild(checkpointBox(after));

  frag.appendChild(h3("状态计数"));
  const counters = document.createElement("div");
  counters.className = "chips";
  counters.innerHTML = Object.entries(after.counters).map(([k, v]) =>
    `<span class="chip">${escapeHtml(k)}: ${v}</span>`).join("");
  frag.appendChild(counters);

  return frag;
}

function renderRollbackEvidence(a) {
  const ev = document.createElement("div");
  ev.className = "evidence";
  const squashed = a.squashed.map(s =>
    `I${s.seq}(tag P${s.tag}${s.was_done ? "，已写回" : ""})`).join("、") || "无";
  ev.innerHTML =
    `<h4>误预测回滚证据 — 分支 I${a.seq}（预测 ${a.predicted_taken ? "taken" : "not-taken"}，实际 ${a.taken ? "taken" : "not-taken"}）</h4>
     <ul>
       <li>清除全部更年轻指令：${escapeHtml(squashed)}</li>
       <li>回收物理标签：${a.reclaimed_tags.map(t => `P${t}`).join("、")}</li>
       <li>恢复映射：${a.restored_mappings.length ? a.restored_mappings.map(m =>
         `R${m.arch}: <span class="diff-from">P${m.from}</span> → <span class="diff-to">P${m.to}</span>`).join("；") : "映射表无差异"}</li>
     </ul>`;
  return ev;
}

function renderExceptionEvidence(r) {
  const ev = document.createElement("div");
  ev.className = "evidence";
  ev.style.borderColor = "#933";
  const discarded = r.discarded.map(d =>
    `I${d.seq}${d.is_faulting ? "（异常自身）" : ""}(P${d.tag}${d.was_done ? "，已写回" : ""})`).join("、");
  ev.innerHTML =
    `<h4 style="color:#ff8b8b">精确异常证据 — 故障指令 I${r.fault_seq} 到达 ROB 队首</h4>
     <ul>
       <li>故障指令自身目标与全部更年轻结果均不提交：${escapeHtml(discarded)}</li>
       <li>回收标签：${r.reclaimed_tags.map(t => `P${t}`).join("、")}</li>
       <li>按 young→old 逆序恢复精确映射：${r.restored_mappings.length ? r.restored_mappings.map(m =>
         `R${m.arch}: <span class="diff-from">P${m.from}</span> → <span class="diff-to">P${m.to}</span>`).join("；") : "无被重命名的寄存器"}</li>
       <li>异常前精确映射：[${r.precise_map.map(p => "P" + p).join(",")}]</li>
     </ul>`;
  return ev;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ---------------------------------------------------------------- lineage

function setLineageStatus(msg, kind) {
  els.lineageStatus.textContent = msg || "";
  els.lineageStatus.className = "status-line" + (kind ? " " + kind : "");
}

function lineagePlaceholder(text, cls) {
  els.lineageView.innerHTML =
    `<p class="placeholder ${cls || ""}">${escapeHtml(text)}</p>`;
}

async function refreshLineage() {
  const step = state.selected;
  if (step < 0 || !state.mode) {
    lineagePlaceholder("请先在时间线选择一个已执行步骤。");
    setLineageStatus("");
    return;
  }
  if (state.violationStep !== null && step >= state.violationStep) {
    lineagePlaceholder(
      `步骤 #${step} 是首个违规事件或在其后：复核已在 #${state.violationStep} 终止，拒绝谱系查询。`,
      "lineage-denied");
    setLineageStatus("已拒绝：首个违规事件之后", "err");
    return;
  }
  const reg = state.lineageReg;
  setLineageStatus("查询谱系…");
  try {
    let dag;
    if (state.mode === "session" && state.sessionId) {
      const r = await api(
        `/api/sessions/${state.sessionId}/lineage?step=${step}&reg=R${reg}`);
      dag = r.lineage;
    } else {
      const r = await api("/api/lineage", "POST", {
        ...payload(), step, reg: `R${reg}`
      });
      dag = r.lineage;
    }
    renderLineage(dag);
    setLineageStatus(`事件 #${step} · R${reg} → P${dag.target_tag}` +
      `（第 ${dag.target_generation} 代分配）`, "ok");
  } catch (e) {
    lineagePlaceholder(`查询被拒绝：${e.message}`, "lineage-denied");
    setLineageStatus(e.message, "err");
  }
}

function renderLineage(dag) {
  els.lineageView.innerHTML = "";
  const head = document.createElement("div");
  head.className = "lineage-head";
  head.innerHTML =
    `事件 #${dag.step} 后 <strong>${dag.register}</strong> 的物理结果 ` +
    `<span class="tag">P${dag.target_tag}</span>（分配代次 ${dag.target_generation}）`;
  els.lineageView.appendChild(head);

  const byId = {};
  for (const n of dag.nodes) byId[n.id] = n;
  // provenance edges point source -> consumer; expanding a node reveals the
  // sources captured at that node's dispatch
  const sources = {};
  for (const n of dag.nodes) sources[n.id] = [];
  for (const e of dag.edges) {
    sources[e.to].push(e);
  }

  const tree = document.createElement("div");
  tree.className = "lin-tree";

  function makeNode(nodeId, incomingEdge) {
    const n = byId[nodeId];
    const li = document.createElement("div");
    li.className = "lin-node-wrap";
    const card = document.createElement("div");
    card.className = "lin-card kind-" + n.kind +
      (n.id === dag.root ? " root" : "") +
      (n.squashed ? " squashed" : "") +
      (n.eventually_squashed ? " doomed" : "") +
      (n.committed ? " committed" : "");

    let title;
    if (n.kind === "initial") {
      title = `<span class="lin-kind">初始</span> ${n.name}`;
    } else {
      title = `<span class="lin-kind">动态实例</span> I${n.seq} ` +
        `<span class="lin-op">${escapeHtml(n.name)}</span>`;
    }
    card.innerHTML =
      `<div class="lin-title">${title}</div>
       <div class="lin-meta">
         分派事件：${n.dispatch_event_index === null ? "—" : "#" + n.dispatch_event_index}
         · 目标物理寄存器：<span class="tag">P${n.tag}</span>
         · 分配代次：${n.generation}
         ${n.old_tag !== null ? `· 旧标签 <span class="tag-old">P${n.old_tag}</span>` : ""}
       </div>`;

    if (incomingEdge) {
      const tag = document.createElement("div");
      tag.className = "lin-edge-tag";
      tag.innerHTML = `源操作数 Rs${incomingEdge.operand} ` +
        `R${incomingEdge.arch} → 分派时映射 <span class="tag">P${incomingEdge.tag}</span>` +
        `（代次 ${incomingEdge.generation}，捕获于事件 #${incomingEdge.captured_at_dispatch_event}）`;
      li.appendChild(tag);
    }

    const srcEdges = (sources[nodeId] || [])
      .slice()
      .sort((a, b) => a.operand - b.operand);
    const expandable = srcEdges.length > 0;
    const headerWrap = document.createElement("div");
    headerWrap.className = "lin-head-row";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "lin-toggle";
    toggle.textContent = expandable ? "▾" : "•";
    toggle.disabled = !expandable;
    headerWrap.appendChild(toggle);
    headerWrap.appendChild(card);
    li.appendChild(headerWrap);

    if ((n.squashed || n.eventually_squashed) && n.squash) {
      const note = document.createElement("div");
      note.className = "lin-squash";
      const prefix = n.squashed ? "清除说明："
        : `后续事件 #${n.squash_event_index} 将清除该实例（本步映射仍有效）：`;
      note.textContent = prefix + n.squash.description;
      li.appendChild(note);
    }
    if (n.committed) {
      const note = document.createElement("div");
      note.className = "lin-commit-note";
      note.textContent = `该实例已在事件 #${n.commit_event_index} 提交。`;
      li.appendChild(note);
    }

    if (expandable) {
      const sub = document.createElement("div");
      sub.className = "lin-children";
      for (const e of srcEdges) {
        sub.appendChild(makeNode(e.from, e));
      }
      li.appendChild(sub);
      toggle.addEventListener("click", () => {
        const collapsed = sub.classList.toggle("collapsed");
        toggle.textContent = collapsed ? "▸" : "▾";
      });
    }
    return li;
  }

  tree.appendChild(makeNode(dag.root, null));
  els.lineageView.appendChild(tree);
}

// ---------------------------------------------------------------- sessions

function setSessionButtons(active) {
  els.btnStep.disabled = !active;
  els.btnReset.disabled = !active;
  els.btnSession.textContent = active ? "重建逐步会话" : "建立逐步会话";
}

async function loadSessionState(s) {
  state.mode = "session";
  state.steps = s.steps;
  state.instructions = s.instructions;
  state.violationStep = s.violation ? s.cursor - 1 : null;
  renderTimeline(s.num_events);
  els.cursorInfo.textContent = `逐步会话 ${s.id}：${s.cursor}/${s.num_events} 事件`;
  if (s.violation) {
    setVerdict("发现违规（已定位首个）", "bad");
    renderViolationBanner(s.violation);
    selectStep(s.cursor - 1);
    els.btnStep.disabled = true;
  } else if (s.done) {
    setVerdict("轨迹合法：全部事件已复核", "ok");
    selectStep(s.steps.length - 1);
    els.btnStep.disabled = true;
  } else {
    setVerdict("逐步复核进行中", "");
    els.banner.classList.add("hidden");
    selectStep(Math.max(0, s.steps.length - 1));
  }
}

async function createSession() {
  setStatus("建立会话…");
  try {
    const s = await api("/api/sessions", "POST", payload());
    clearResult();
    state.sessionId = s.id;
    setSessionButtons(true);
    setStatus(`会话 ${s.id} 已建立`, "ok");
    await loadSessionState(s);
  } catch (e) {
    setStatus(e.message, "err");
  }
}

async function stepSession() {
  if (!state.sessionId) return;
  try {
    const r = await api(`/api/sessions/${state.sessionId}/step`, "POST");
    setStatus("");
    await loadSessionState(r.state);
  } catch (e) {
    setStatus(e.message, "err");
  }
}

async function resetSession() {
  if (!state.sessionId) return;
  try {
    const r = await api(`/api/sessions/${state.sessionId}/reset`, "POST");
    setStatus("会话已复位", "ok");
    await loadSessionState(r.state);
    els.btnStep.disabled = false;
  } catch (e) {
    setStatus(e.message, "err");
  }
}

// ---------------------------------------------------------------- buttons

els.btnValidate.addEventListener("click", async () => {
  setStatus("解析中…");
  try {
    const r = await api("/api/validate", "POST", payload());
    setStatus(`解析通过：${r.num_instructions} 条指令，${r.num_events} 个事件，${r.num_phys} 个物理寄存器`, "ok");
  } catch (e) {
    setStatus(e.message, "err");
  }
});

els.btnSimulate.addEventListener("click", async () => {
  setStatus("复核中…");
  els.cursorInfo.textContent = "";
  try {
    const r = await api("/api/simulate", "POST", payload());
    setStatus("");
    state.sessionId = null;
    setSessionButtons(false);
    renderReport(r);
  } catch (e) {
    setStatus(e.message, "err");
    setVerdict("输入错误", "bad");
  }
});

els.btnSession.addEventListener("click", createSession);
els.btnStep.addEventListener("click", stepSession);
els.btnReset.addEventListener("click", resetSession);

initExamples();
initRegSelect();
