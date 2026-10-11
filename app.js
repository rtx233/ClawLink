let bots = [], sessions = [], routeRules = [], activity = [], peerRoutes = {}, stats = {}, service = {};
let apiOnline = false, targetById = {}, modalVersion = 0, qrTimer, inspectNodes = [], inspectedWindow, bindingSession;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const statusLabels = { online: '在线', pending: '等待登录', connecting: '连接中', stopped: '已停止', expired: '登录过期', error: '需检查', verified: '已校验', unbound: '未绑定' };
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无记录';
const targetLabel = id => id === 'all' ? '全部已绑定会话' : targetById[id]?.name || '未指定';
const platformLabel = platform => platform === 'wechat' ? '微信' : 'Telegram';
const empty = (text, action = '') => `<div class="empty-state"><span>↗</span><h3>${esc(text)}</h3>${action}</div>`;
const options = (items, label = x => x.name) => items.map(x => `<option value="${esc(x.id)}">${esc(label(x))}</option>`).join('');
const statusMarkup = status => `<span class="status-pill ${['online', 'verified'].includes(status) ? '' : 'inactive'}"><i></i>${esc(statusLabels[status] || status || '未知')}</span>`;
async function apiRequest(path, body, method = body === undefined ? 'GET' : 'POST') {
  let response;
  try { response = await fetch(`/api${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new Error('无法连接本地服务，请运行 npm run dev'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
async function syncStateFromApi() {
  try {
    const remote = await apiRequest('/state');
    ({ bots, sessions, activity, peerRoutes, stats, service } = remote); routeRules = remote.routes;
    targetById = Object.fromEntries(sessions.map(session => [session.id, session])); apiOnline = true;
    renderAll();
  } catch { apiOnline = false; renderService(); }
}
function renderService() {
  $('#serviceStatus').textContent = apiOnline ? `本地服务 · ${service.polling || 0} 个接收连接` : '服务未连接';
  $('.connection-status .status-dot').classList.toggle('offline', !apiOnline);
  $('#overviewLive').textContent = apiOnline ? '已连接本地服务' : '等待服务';
}
function renderOverview() {
  const online = bots.filter(bot => bot.status === 'online').length;
  $('#metricBots').textContent = online;
  $('#metricRoutes').textContent = routeRules.filter(rule => rule.on).length;
  $('#metricMessages').textContent = stats.messages || 0;
  $('#metricLatency').textContent = stats.replies ? `${(stats.durationMs / stats.replies / 1000).toFixed(1)}s` : '—';
  $('[data-filter="all"] span').textContent = bots.length;
  $('[data-filter="wechat"] span').textContent = bots.filter(x => x.platform === 'wechat').length;
  $('[data-filter="telegram"] span').textContent = bots.filter(x => x.platform === 'telegram').length;
  const filter = $('.segment.active[data-filter]')?.dataset.filter || 'all';
  const filtered = bots.filter(bot => filter === 'all' || bot.platform === filter);
  $('#routeTableBody').innerHTML = filtered.length ? filtered.map(bot => `<tr data-searchable><td><div class="bot-cell"><div class="bot-avatar avatar-${esc(bot.tone)}">${esc(bot.avatar)}</div><div class="bot-meta"><strong>${esc(bot.name)}</strong><span>${esc(bot.handle || '尚未登录')}</span></div></div></td><td><span class="platform-pill platform-${bot.platform}">${platformLabel(bot.platform)}</span></td><td><div class="route-target"><span class="target-logo ${targetById[bot.target]?.tone || 'target-custom'}">↗</span><span>${esc(targetLabel(bot.target))}</span></div></td><td>${statusMarkup(bot.status)}</td><td><button class="row-menu" data-bot-menu="${bot.id}" aria-label="管理 ${esc(bot.name)}">•••</button></td></tr>`).join('') : '<tr><td colspan="5" class="empty-row">先绑定目标会话，再添加你的第一个机器人。</td></tr>';
  $('#activityList').innerHTML = activity.slice(0, 4).map(activityMarkup).join('') || '<p class="muted-copy">真实连接和消息记录会出现在这里。</p>';
  $('#sessionStack').innerHTML = sessions.slice(0, 3).map(session => `<button class="mini-session" data-bind-session="${session.id}"><div class="session-logo ${session.tone}">${session.logo}</div><div class="session-copy"><strong>${esc(session.name)}</strong><span>${esc(session.provider)} · ${statusLabels[session.status]}</span></div><span class="session-users">${session.users} 个机器人</span></button>`).join('') || '<button class="outline-button full" id="newSessionEmpty">＋ 添加第一个路由会话</button>';
  $('#botsLive').textContent = `${online} / ${bots.length} 在线`;
  $('#sessionsLive').textContent = `${sessions.filter(x => x.binding).length} 个已绑定`;
  $('.nav-item[data-view="bots"] .nav-count').textContent = bots.length;
  $('.nav-item[data-view="activity"] .nav-count').textContent = activity.length;
  applySearch();
}
function activityMarkup(item) { return `<div class="activity-item"><div class="activity-icon ${esc(item.tone)}">${esc(item.icon)}</div><div class="activity-copy"><span>${esc(item.text)}</span></div><time class="activity-time">${esc(time(item.at))}</time></div>`; }
function renderBots() {
  $('#botGrid').innerHTML = bots.map(bot => `<article class="bot-card" data-searchable><div class="bot-card-top"><div class="bot-avatar avatar-${esc(bot.tone)}">${esc(bot.avatar)}</div><button class="card-menu" data-bot-menu="${bot.id}" aria-label="管理机器人">•••</button></div><h3>${esc(bot.name)}</h3><p>${esc(bot.handle || '尚未登录')}</p><div class="card-divider"></div><div class="bot-card-foot"><span class="platform-pill platform-${bot.platform}">${platformLabel(bot.platform)}</span>${statusMarkup(bot.status)}</div>${bot.error ? `<p class="error-copy">${esc(bot.error)}</p>` : ''}<p class="muted-copy">默认：${esc(targetLabel(bot.target))} · ${bot.peers.length} 个授权聊天</p><div class="bot-actions"><button class="secondary-button" data-connect-bot="${bot.id}">${bot.platform === 'wechat' ? '扫码登录' : '配置 Token'}</button><button class="text-button" data-switch-bot="${bot.id}">切换会话 →</button></div></article>`).join('') || empty('还没有机器人', '<button class="primary-button" id="addBotEmpty">＋ 添加机器人</button>');
}
function renderRouting() {
  $('#routeRuleCount').textContent = `${routeRules.length} 条规则`;
  $('#ruleList').innerHTML = routeRules.map((rule, index) => { const bot = bots.find(x => x.id === rule.bot); return `<div class="rule-item" data-searchable><span class="rule-index">${String(index + 1).padStart(2, '0')}</span><div class="rule-bot"><div class="bot-avatar avatar-${bot.tone}">${esc(bot.avatar)}</div><div class="rule-bot-copy"><strong>${esc(bot.name)}</strong><span>${platformLabel(bot.platform)}</span></div></div><span class="rule-command">${esc(rule.command)}</span><span class="rule-arrow">→</span><div class="rule-destination"><span class="target-logo ${targetById[rule.target]?.tone || 'target-custom'}">↗</span><span>${esc(targetLabel(rule.target))}</span></div><button class="rule-enabled ${rule.on ? 'on' : ''}" data-rule-toggle="${rule.id}" aria-label="${rule.on ? '暂停' : '启用'}规则" aria-pressed="${rule.on}"></button><button class="rule-action" data-rule-menu="${rule.id}" aria-label="编辑规则">•••</button></div>`; }).join('') || empty('绑定机器人后即可创建路由');
  const rows = Object.entries(peerRoutes).filter(([key]) => JSON.parse(key)[1] !== '*');
  $('#peerRouteList').innerHTML = rows.length ? `<h3>聊天独立路由</h3>${rows.map(([key, route]) => { const [botId, peer] = JSON.parse(key); return `<div class="peer-row"><span>${esc(bots.find(x => x.id === botId)?.name)} · ${esc(peer)}</span><strong>${esc(targetLabel(route.target))}${route.paused ? ' · 已暂停' : ''}</strong></div>`; }).join('')}` : '<p class="muted-copy">在机器人中发送 /switch，或在前端选择授权聊天，可以覆盖该聊天的默认路由。</p>';
}
function renderSessions() {
  $('#sessionGrid').innerHTML = sessions.map(session => `<article class="session-card" data-searchable><div class="session-card-top"><div class="session-logo ${session.tone}">${session.logo}</div><button class="card-menu" data-session-menu="${session.id}" aria-label="管理会话">•••</button></div><h3>${esc(session.name)}</h3><p>${esc(session.provider)} · ${esc(session.binding?.windowTitle || session.binding?.name || (session.binding?.type === 'pi' ? `PI 会话 ${session.binding.sessionId.slice(0, 8)}` : '') || '等待绑定目标会话')}</p><p class="muted-copy">${esc(session.id)}</p>${session.error ? `<p class="error-copy">${esc(session.error)}</p>` : ''}<div class="session-card-foot"><span>${session.users} 个机器人</span>${statusMarkup(session.status)}<button class="outline-button" data-bind-session="${session.id}">${session.binding ? '检查绑定' : '绑定会话'}</button></div><div class="bot-actions"><button class="secondary-button" data-session-switch="${session.id}" ${session.binding ? '' : 'disabled'}>切换到此会话</button><button class="text-button" data-validate-session="${session.id}" ${session.binding ? '' : 'disabled'}>验证连接 →</button></div></article>`).join('') || empty('把 AI 会话变成可路由的目标', '<button class="primary-button" id="newSessionEmpty">＋ 添加路由会话</button>');
}
function renderActivity() {
  const selected = $('.log-filters .active')?.dataset.logFilter || 'all';
  $('#fullActivityList').innerHTML = activity.filter(x => selected === 'all' || x.kind === selected).map(item => `<div class="full-activity-item"><time class="activity-date">${esc(time(item.at))}</time><div class="activity-icon ${item.tone}">${esc(item.icon)}</div><div class="activity-copy"><span>${esc(item.text)}</span></div><span class="activity-badge">${esc(item.kind)}</span></div>`).join('') || empty('暂无活动记录');
}
function renderAll() { renderService(); renderOverview(); renderBots(); renderRouting(); renderSessions(); renderActivity(); applySearch(); }
function applySearch() { const query = $('#globalSearch').value.toLowerCase(); $$('[data-searchable]').forEach(el => { el.hidden = !el.textContent.toLowerCase().includes(query); }); }
function showView(name) {
  $$('.view').forEach(el => el.classList.toggle('active', el.id === `view-${name}`));
  $$('.nav-item[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === name));
  $('#pageTitle').textContent = { overview: '总览', bots: '机器人', routing: '路由规则', sessions: '会话空间', activity: '活动日志' }[name];
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function toast(message) { $('#toastMessage').textContent = message; $('#toast').classList.add('show'); clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 4000); }
function openModal(content, wide = false) {
  clearTimeout(qrTimer); modalVersion += 1;
  $('.modal').classList.toggle('wide', wide); $('#modalContent').innerHTML = `${content}<div id="modalError" class="error-copy" role="alert"></div>`;
  $('#modalBackdrop').classList.add('open'); $('#modalBackdrop').setAttribute('aria-hidden', 'false');
  $('#modalContent input, #modalContent select, #modalContent button')?.focus();
  return modalVersion;
}
function closeModal() { modalVersion += 1; clearTimeout(qrTimer); $('#modalBackdrop').classList.remove('open'); $('#modalBackdrop').setAttribute('aria-hidden', 'true'); }
const actions = (id, text) => `<div class="form-actions"><button class="secondary-button" id="cancelModal">取消</button><button class="primary-button" id="${id}">${text}</button></div>`;
function openAddBot() {
  openModal(`<h2 id="modalTitle">添加机器人</h2><p>微信通过 OpenClaw 扫码，Telegram 使用 BotFather Token。</p><div class="modal-form"><label class="form-label">平台<select class="form-select" id="botPlatform"><option value="wechat">OpenClaw 微信</option><option value="telegram">Telegram Bot</option></select></label><label class="form-label">名称<input class="form-input" id="botName" placeholder="例如：我的工作微信" maxlength="160" /></label><label class="form-label" id="tokenField" hidden>BotFather Token<input class="form-input" id="botToken" type="password" autocomplete="off" placeholder="123456:ABC…" /></label><label class="form-label">默认会话<select class="form-select" id="botTarget"><option value="">稍后配置</option>${options(sessions, x => `${x.name} · ${x.provider}`)}</select></label>${actions('createBot', '创建并扫码')}</div>`);
}
function showPairing(bot) {
  const command = bot.pairingCode ? `/pair ${bot.pairingCode}` : '';
  return `<div class="pairing-box"><strong>授权你的聊天</strong><p>请把下方指令发送到这个微信 / Telegram 机器人的<strong>私聊窗口</strong>。不要在 Codex、Terminal 或 ClawLink 控制台中执行。</p>${command ? `<div class="pairing-command"><code>${esc(command)}</code><button class="secondary-button small" data-copy-pairing="${esc(command)}">复制指令</button></div>` : '<span>配对码已使用。新增聊天可生成新的配对码。</span>'}<div class="muted-copy">${bot.peers.length} 个已授权聊天</div></div>`;
}
async function openWechatLogin(bot) {
  const version = openModal(`<h2 id="modalTitle">连接 ${esc(bot.name)}</h2><p>打开微信扫一扫，并在手机上确认连接。</p><div class="qr-stage" id="qrStage"><p>正在向微信请求二维码…</p></div><div id="verifyField" hidden><label class="form-label">手机显示的数字<input class="form-input" id="verifyCode" inputmode="numeric" autocomplete="off" /></label><button class="primary-button" id="submitVerify">继续验证</button></div><p id="qrStatus" role="status">请求中</p>${showPairing(bot)}<button class="secondary-button" data-connect-bot="${bot.id}">刷新二维码</button>`);
  let data;
  try { data = await apiRequest(`/bots/${bot.id}/login/start`, {}); }
  catch (error) {
    if (version === modalVersion) { $('#qrStage').textContent = '未能获取二维码，请重试。'; $('#qrStatus').textContent = '请求失败'; $('#modalError').textContent = error.message; }
    await syncStateFromApi(); return;
  }
  if (version !== modalVersion) return;
  $('#qrStage').innerHTML = `<img class="qr-image" src="${esc(data.qrImage)}" alt="微信 OpenClaw 登录二维码" />`;
  let verifyCode = '';
  async function poll() {
    if (version !== modalVersion) return;
    try {
      const result = await apiRequest(`/bots/${bot.id}/login/poll`, { loginId: data.loginId, verifyCode });
      if (version !== modalVersion) return;
      const labels = { wait: '等待扫码', scaned: '已扫码，请在手机确认', scaned_but_redirect: '已扫码，正在连接微信服务', need_verifycode: '请输入手机微信显示的数字', verify_code_blocked: '验证次数过多，请稍后刷新', expired: '二维码已过期，请刷新', binded_redirect: '此账号已经连接，请使用已有机器人', confirmed: '扫码成功，正在接收消息' };
      $('#qrStatus').textContent = labels[result.status] || result.status;
      if (result.status === 'need_verifycode') {
        $('#verifyField').hidden = false;
        $('#submitVerify').onclick = () => { verifyCode = $('#verifyCode').value.trim(); $('#verifyField').hidden = true; qrTimer = setTimeout(poll, 100); };
        return;
      }
      verifyCode = '';
      if (result.status === 'confirmed') { await syncStateFromApi(); showView('bots'); toast(result.welcomeSent ? '微信连接成功，已向设备发送配对提示' : '微信已登录，但欢迎提示发送失败；请从机器人设置复制配对指令'); return; }
      if (['expired', 'verify_code_blocked', 'binded_redirect'].includes(result.status)) { await syncStateFromApi(); return; }
      qrTimer = setTimeout(poll, 800);
    } catch (error) {
      if (version !== modalVersion) return;
      $('#qrStatus').textContent = '连接暂时中断，正在重试';
      $('#modalError').textContent = error.message;
      qrTimer = setTimeout(poll, 1800);
    }
  }
  poll();
}
function openTelegramLogin(bot) {
  openModal(`<h2 id="modalTitle">连接 ${esc(bot.name)}</h2><p>从 Telegram @BotFather 获取 Bot Token。连接后给机器人发送配对指令。</p><label class="form-label">BotFather Token<input class="form-input" type="password" id="replacementToken" autocomplete="off" /></label>${showPairing(bot)}${actions('saveTelegram', '验证并连接')}`);
  $('#saveTelegram').dataset.botId = bot.id;
}
function openNewSession() {
  const version = openModal(`<h2 id="modalTitle">添加路由会话</h2><p>为已有聊天添加路由名称。Codex / Claude 绑定原生窗口；PI 绑定会话文件；Paseo 选择已有会话。</p><div class="modal-form"><label class="form-label">会话名称<input class="form-input" id="sessionName" placeholder="例如：产品研究" maxlength="160" /></label><label class="form-label">目标<select class="form-select" id="sessionProvider"><option value="ChatGPT" data-provider="ChatGPT" data-bundle-id="com.openai.chat">ChatGPT</option><option value="Codex" data-provider="Codex" data-bundle-id="com.openai.codex">Codex（本机应用名称可能显示为 ChatGPT）</option><option value="Claude" data-provider="Claude" data-bundle-id="com.anthropic.claudefordesktop">Claude</option><option value="PI" data-provider="PI" data-target-type="pi">PI · Coding Agent</option><option value="Paseo" data-provider="Paseo" data-target-type="paseo">Paseo · 已有会话</option></select></label><p class="muted-copy" id="sessionDiscoveryStatus">正在发现已打开的应用…</p>${actions('saveSession', '添加并绑定')}</div>`);
  let userSelected = false;
  $('#sessionProvider').addEventListener('change', () => { userSelected = true; });
  apiRequest('/native/discover').then(discovered => {
    if (version !== modalVersion) return;
    const select = $('#sessionProvider');
    const existing = new Set([...select.options].map(option => option.dataset.bundleId));
    for (const app of discovered.apps || []) {
      if (!existing.has(app.bundleId) && app.bundleId !== 'sh.paseo.desktop') {
        const option = document.createElement('option'); option.value = app.bundleId; option.dataset.bundleId = app.bundleId; option.dataset.provider = app.name; option.textContent = app.name; select.append(option);
      }
    }
    if (!userSelected && !discovered.apps?.some(app => app.bundleId === 'com.openai.chat') && discovered.apps?.some(app => app.bundleId === 'com.openai.codex')) select.value = 'Codex';
    $('#sessionDiscoveryStatus').textContent = `辅助功能：${discovered.trusted ? '已允许，可绑定原生窗口' : '绑定原生窗口时需要授权'}。PI / Paseo 使用会话适配器，无需辅助功能。`;
  }).catch(() => { if (version === modalVersion) $('#sessionDiscoveryStatus').textContent = '原生应用发现不可用；PI / Paseo 可继续使用各自的会话适配器。'; });
}
async function openAgentBinding(session, type) {
  const version = openModal(`<h2 id="modalTitle">绑定 ${esc(session.name)}</h2><p>${type === 'pi' ? '绑定 PI 已有会话文件，或为 ClawLink 创建新的 PI 会话。沿用本机 PI 登录和工具配置。' : '选择 Paseo 已有会话。消息按会话 ID 送达，并将本次助手回复回传到微信 / Telegram。'}</p><div id="agentStage">正在读取 ${esc(session.provider)} 会话…</div>`, true);
  let data;
  try { data = await apiRequest(`/targets/${type}`); }
  catch (error) { if (version === modalVersion) { $('#agentStage').textContent = '会话发现失败，请重试。'; $('#modalError').textContent = error.message; } return; }
  if (version !== modalVersion) return;
  const saved = session.binding || {};
  const connection = `<div class="binding-tip">${data.available ? `${esc(session.provider)} 已连接` : esc(data.error || '未找到 PI CLI，请先安装并登录 PI，再重新检查')} · 无需辅助功能权限</div>`;
  if (type === 'pi') {
    const files = data.sessions || [];
    $('#agentStage').innerHTML = `${connection}<div class="modal-form"><label class="form-label">绑定方式<select class="form-select" id="piMode"><option value="existing">绑定已有 PI 会话</option><option value="new">创建新的 PI 会话</option></select></label><div id="piExistingFields"><label class="form-label">已发现的会话<select class="form-select" id="piExistingSession"><option value="">选择会话，或在下方填写文件路径</option>${files.map(item => `<option value="${esc(item.file)}">${esc(`${item.cwd} · ${item.id.slice(0, 8)} · ${time(item.updatedAt)}`)}</option>`).join('')}</select></label><label class="form-label">会话文件路径<input class="form-input" id="piSessionFile" value="${esc(saved.sessionFile || '')}" placeholder="/Users/…/.pi/agent/sessions/…/会话.jsonl" /></label><p class="muted-copy">在 PI 中输入 /session 可查看文件路径。此文件承载原有上下文；请避免同时从 PI 终端和 ClawLink 续聊同一个文件。</p></div><label class="form-label" id="piNewFields" hidden>工作目录<input class="form-input" id="piWorkdir" value="${esc(saved.workdir || data.defaultWorkdir || '')}" placeholder="/Users/…/项目" /></label><label class="form-label">Provider（可选）<input class="form-input" id="piProvider" value="${esc(saved.provider || '')}" placeholder="留空沿用 PI 会话 / 默认配置" /></label><label class="form-label">Model（可选）<input class="form-input" id="piModel" value="${esc(saved.model || '')}" placeholder="留空沿用 PI 会话 / 默认配置" /></label><p class="muted-copy">绑定只检查文件和工作目录；模型登录状态会在首次发送时确认。PI 将使用其现有工具权限执行消息。</p>${actions('saveTargetBinding', '校验并保存绑定')}<button class="text-button" data-bind-session="${session.id}">重新发现</button></div>`;
    if (files.some(item => item.file === saved.sessionFile)) $('#piExistingSession').value = saved.sessionFile;
    $('#piExistingSession').onchange = () => { if ($('#piExistingSession').value) $('#piSessionFile').value = $('#piExistingSession').value; };
    $('#piMode').onchange = () => { const isNew = $('#piMode').value === 'new'; $('#piExistingFields').hidden = isNew; $('#piNewFields').hidden = !isNew; };
  } else {
    const agents = data.agents || [];
    $('#agentStage').innerHTML = `${connection}<div class="modal-form"><label class="form-label">搜索会话<input class="form-input" id="paseoSearch" placeholder="按标题、项目路径或 ID 搜索" /></label><label class="form-label">已有会话<select class="form-select" id="paseoAgent"></select></label><label class="form-label">完整会话 ID<input class="form-input" id="paseoAgentId" value="${esc(saved.agentId || '')}" placeholder="选择上方会话，或粘贴完整 UUID" /></label><p class="muted-copy" id="paseoAgentInfo"></p><p class="muted-copy">沿用该会话的模型、工具和权限。运行中的会话会拒绝新的路由消息；需要授权时请在 Paseo 处理。此处不会新建 Paseo 聊天。</p>${actions('saveTargetBinding', '校验并保存绑定')}<button class="text-button" data-bind-session="${session.id}">重新发现</button></div>`;
    function info() { const selected = agents.find(agent => agent.id === $('#paseoAgentId').value); $('#paseoAgentInfo').textContent = selected ? `${selected.provider}${selected.model ? ` / ${selected.model}` : ''} · ${selected.cwd} · ${selected.status}` : ''; }
    function filter() {
      const query = $('#paseoSearch').value.toLowerCase(); const current = $('#paseoAgentId').value;
      $('#paseoAgent').innerHTML = '<option value="">请选择已有会话</option>' + agents.filter(agent => `${agent.name} ${agent.cwd} ${agent.id}`.toLowerCase().includes(query)).map(agent => `<option value="${esc(agent.id)}">${esc(`${agent.name} · ${agent.status} · ${agent.id.slice(0, 8)} · ${agent.cwd}`)}</option>`).join('');
      if ([...$('#paseoAgent').options].some(option => option.value === current)) $('#paseoAgent').value = current;
      info();
    }
    $('#paseoSearch').oninput = filter;
    $('#paseoAgent').onchange = () => { $('#paseoAgentId').value = $('#paseoAgent').value; info(); };
    $('#paseoAgentId').oninput = info; filter();
  }
  $('#saveTargetBinding').onclick = () => guarded($('#saveTargetBinding'), async () => {
    const binding = type === 'pi' ? { mode: $('#piMode').value, sessionFile: $('#piSessionFile').value, workdir: $('#piWorkdir').value, provider: $('#piProvider').value, model: $('#piModel').value } : { agentId: $('#paseoAgentId').value.trim() };
    await apiRequest('/targets/bind', { sessionId: session.id, binding }); await syncStateFromApi();
    if (version !== modalVersion) return;
    closeModal(); toast(`${session.provider} 会话绑定通过校验`);
  });
}
async function openBinding(sessionId) {
  bindingSession = targetById[sessionId];
  const type = bindingSession.targetType || bindingSession.binding?.type || 'native';
  if (['pi', 'paseo'].includes(type)) return openAgentBinding(bindingSession, type);
  inspectNodes = []; inspectedWindow = null;
  const version = openModal(`<h2 id="modalTitle">绑定 ${esc(bindingSession.name)}</h2><p>保持原生软件登录，并打开目标聊天。选择窗口后检查输入框与回复区域。</p><div id="nativeStage">正在发现原生应用…</div>`, true);
  let discovered;
  try { discovered = await apiRequest('/native/discover'); }
  catch (error) {
    if (version === modalVersion) { $('#nativeStage').textContent = '未能读取原生应用，请检查本地连接器后重试。'; $('#modalError').textContent = error.message; }
    return;
  }
  if (version !== modalVersion) return;
  const target = discovered.permissionTarget || {};
  if (!discovered.trusted) { $('#nativeStage').innerHTML = `<div class="pairing-box"><strong>需要辅助功能权限</strong><p>当前服务由 <strong>${esc(target.name || 'ClawLinkBridge')}</strong> 发起 Accessibility 调用。请在系统设置 → 隐私与安全性 → 辅助功能中允许这个进程：</p><code class="path-copy">${esc(target.path || '项目目录/native/ClawLinkBridge')}</code><p class="muted-copy">源码模式的系统权限列表可能显示启动服务的 Codex / 终端或桥接进程；安装包模式可添加 ClawLink.app。若当前检查已通过，无需重复授权。未通过时可点“+”，用 Cmd+Shift+G 定位上述路径；授权后点击“授权后重新检查”。</p></div><div class="modal-actions"><button class="primary-button" id="nativePermission">请求系统授权</button><button class="secondary-button" data-bind-session="${sessionId}">授权后重新检查</button></div>`; return; }
  const bundleId = bindingSession.bundleId || ({ ChatGPT: 'com.openai.chat', Codex: 'com.openai.codex', Claude: 'com.anthropic.claudefordesktop', Paseo: 'sh.paseo.desktop' }[bindingSession.provider] || '');
  const app = discovered.apps.find(x => x.bundleId === bundleId);
  if (!app?.windows?.length) {
    const hint = `请打开并登录 ${bindingSession.provider}，进入目标聊天后重新发现。当前绑定 Bundle ID：${bundleId || '未记录'}。如需 PI 或 Paseo，请返回「添加路由会话」选择对应的会话适配器。`;
    $('#nativeStage').innerHTML = `<div class="pairing-box">${esc(hint)}</div><button class="primary-button" data-bind-session="${sessionId}">重新发现</button>`;
    return;
  }
  $('#nativeStage').innerHTML = `<div class="modal-form"><label class="form-label">原生窗口<select class="form-select" id="nativeWindow">${app.windows.map((title, i) => `<option value="${i}">${esc(title || '(无标题窗口)')}</option>`).join('')}</select></label><button class="primary-button" id="inspectWindow">读取窗口元素</button></div><div id="bindingForm"></div>`;
  $('#inspectWindow').onclick = () => guarded($('#inspectWindow'), async () => {
    inspectedWindow = { bundleId, windowTitle: app.windows[Number($('#nativeWindow').value)] };
    const result = await apiRequest('/native/inspect', inspectedWindow);
    if (version !== modalVersion) return;
    inspectNodes = result.nodes;
    renderBindingForm(bindingSession);
  });
}
function nodeOptions(filter, allowEmpty = false) {
  const kinds = { AXButton: '按钮', AXTextArea: '输入框', AXTextField: '输入框', AXStaticText: '文本', AXHeading: '标题', AXGroup: '内容区域', AXScrollArea: '滚动区域', AXWebArea: '页面' };
  const candidates = inspectNodes.filter(filter);
  return `${allowEmpty ? '<option value="">不配置</option>' : '<option value="">请选择元素</option>'}${candidates.map((node, i) => `<option value="${esc(node.path)}">${esc(`${node.label || node.text?.slice(0, 100) || kinds[node.role] || '内容区域'} · ${kinds[node.role] || '区域'} ${i + 1}`.slice(0, 190))}</option>`).join('')}`;
}
function renderBindingForm(session) {
  if (!inspectNodes.some(x => x.editable)) {
    $('#bindingForm').innerHTML = `<div class="pairing-box">当前窗口没有可用的消息输入框。请先在 ${esc(session.provider)} 完成登录、进入聊天页面，再点击「读取窗口元素」。</div>`;
    return;
  }
  const fields = [
    ['markerPath', '当前聊天的唯一标题 / 标识', x => ['AXStaticText', 'AXHeading'].includes(x.role) && x.text],
    ['inputPath', '消息输入框', x => x.editable],
    ['replyPath', '回复容器（聊天内容或最新助手回复）', x => !x.editable && x.role !== 'AXWindow'],
    ['sendPath', '发送按钮', x => x.role === 'AXButton'],
    ['navigationPath', '会话入口（可选：侧栏中的聊天按钮）', x => x.actions?.includes('AXPress') && (x.text || x.label), true],
    ['busyPath', '停止生成按钮（可选：生成中可见）', x => x.role === 'AXButton', true]
  ];
  $('#bindingForm').innerHTML = `<div class="binding-tip">会话标识应选择聊天正文的唯一标题；回复容器应只包含目标聊天。若绑定侧栏会话入口，收到消息时会先点击它并重新校验。</div><div class="modal-form binding-fields">${fields.map(([id, label, filter, optional]) => `<label class="form-label">${label}<select class="form-select" id="${id}">${nodeOptions(filter, optional)}</select></label>`).join('')}<label class="form-label">回复读取方式<select class="form-select" id="replyMode"><option value="append">整个聊天容器：只读取新增内容</option><option value="latest">最新助手回复：读取该元素的完整内容</option></select></label><label class="form-label">消息输入方式<select class="form-select" id="writeMode"><option value="auto">自动（Claude 使用粘贴）</option><option value="paste">兼容粘贴（无法正常输入时使用）</option></select></label><label class="form-label">选中标识的实际文本<textarea class="form-input readonly-text" id="markerPreview" readonly></textarea></label><details><summary>查看辅助功能元素树</summary><pre class="ax-tree">${esc(inspectNodes.map(x => `${x.path} ${x.role} ${x.label}`).join('\n'))}</pre></details>${actions('saveBinding', '校验并保存绑定')}</div>`;
  const nodeByPath = path => inspectNodes.find(x => x.path === path);
  $('#markerPath').onchange = () => { $('#markerPreview').value = nodeByPath($('#markerPath').value)?.text || ''; };
  fields.forEach(([id, , filter, optional]) => {
    const expected = session.binding?.selectors?.[id.replace('Path', '')];
    const candidates = inspectNodes.filter(filter);
    const matching = expected && candidates.filter(node => Object.entries(expected).every(([key, value]) => !value || node.selector?.[key] === value));
    if (matching?.length === 1) $(`#${id}`).value = matching[0].path;
    else if (session.binding && [...$(`#${id}`).options].some(x => x.value === session.binding[id])) $(`#${id}`).value = session.binding[id];
    else if (!optional && candidates.length === 1) $(`#${id}`).value = candidates[0].path;
    else if (id === 'markerPath') { const match = candidates.filter(x => x.text === session.name); if (match.length === 1) $(`#${id}`).value = match[0].path; }
    else if (id === 'sendPath') { const match = candidates.filter(x => /^(发送|发送消息|send|send message)$/i.test(x.label || x.text)); if (match.length === 1) $(`#${id}`).value = match[0].path; }
  });
  $('#markerPath').onchange();
  if (session.binding) {
    $('#replyMode').value = session.binding.replyMode || 'append'; $('#markerPath').onchange();
    $('#writeMode').value = session.binding.writeMode || 'auto';
  }
  $('#saveBinding').onclick = () => guarded($('#saveBinding'), async () => {
    const binding = { ...inspectedWindow, replyMode: $('#replyMode').value, writeMode: $('#writeMode').value };
    fields.forEach(([id]) => { binding[id] = $(`#${id}`).value; });
    binding.markerText = nodeByPath(binding.markerPath)?.text || '';
    binding.navigationText = nodeByPath(binding.navigationPath)?.text || nodeByPath(binding.navigationPath)?.label || '';
    binding.busyText = nodeByPath(binding.busyPath)?.text || nodeByPath(binding.busyPath)?.label || '';
    await apiRequest('/native/bind', { sessionId: session.id, binding }); await syncStateFromApi(); closeModal(); toast('原生会话绑定通过校验');
  });
}
function openSwitch({ botId, sessionId, broadcast = false } = {}) {
  if (!bots.length) throw new Error('请先添加机器人');
  openModal(`<h2 id="modalTitle">${broadcast ? '下一条消息广播' : '切换会话'}</h2><p>默认路由影响未单独切换的聊天。选择授权聊天可只切换该聊天。</p><div class="modal-form"><label class="form-label">机器人<select class="form-select" id="switchBot">${options(bots)}</select></label><label class="form-label">作用范围<select class="form-select" id="switchPeer"></select></label>${broadcast ? '' : `<label class="form-label">目标会话<select class="form-select" id="switchTarget">${options(sessions.filter(x => x.binding), x => `${x.name} · ${x.provider}`)}</select></label>`}${actions('performSwitch', broadcast ? '启用下一条广播' : '确认切换')}</div>`);
  if (botId) $('#switchBot').value = botId;
  if (sessionId && !broadcast) $('#switchTarget').value = sessionId;
  const peers = () => { const bot = bots.find(x => x.id === $('#switchBot').value); $('#switchPeer').innerHTML = `<option value="">机器人默认</option>${bot.peers.map(peer => `<option value="${esc(peer)}">聊天 ${esc(peer)}</option>`).join('')}`; };
  peers(); $('#switchBot').onchange = peers;
  $('#performSwitch').dataset.broadcast = String(broadcast);
}
function openBotSettings(bot) {
  openModal(`<h2 id="modalTitle">${esc(bot.name)}</h2><p>${platformLabel(bot.platform)} · ${statusLabels[bot.status]} · 最后消息：${esc(time(bot.lastMessageAt))}</p>${showPairing(bot)}<div class="modal-form"><label class="form-label">允许的聊天 ID（每行一个；Telegram 群需手工填写群 ID）<textarea class="form-input multiline" id="allowedPeers">${esc(bot.peers.join('\n'))}</textarea></label><button class="secondary-button" id="savePeers" data-bot-id="${bot.id}">保存授权聊天</button><button class="secondary-button" id="newPairing" data-bot-id="${bot.id}">生成新的配对码</button><button class="secondary-button" data-switch-bot="${bot.id}">切换默认 / 聊天会话</button><button class="secondary-button" data-worker-bot="${bot.id}" data-worker-action="${bot.enabled ? 'stop' : 'start'}" ${bot.configured ? '' : 'disabled'}>${bot.enabled ? '停止接收消息' : '恢复接收消息'}</button><button class="text-button danger" data-delete-bot="${bot.id}">移除机器人</button></div>`);
}
function openCommands() {
  openModal(`<h2 id="modalTitle">机器人指令</h2><p>以下指令都要在微信 / Telegram 机器人私聊中发送；不要在 Codex、Terminal 或 ClawLink 控制台执行。</p><div class="command-modal-list">${[['/pair 配对码', '首次授权私聊'], ['/sessions', '列出会话名称与 ID'], ['/route', '查看当前路由'], ['/switch 会话名', '切换当前聊天的目标'], ['/broadcast', '下一条普通消息发送到全部已绑定会话'], ['/pause', '暂停当前聊天'], ['/resume', '恢复路由']].map(([cmd, label]) => `<div class="command-modal-row"><code>${esc(cmd)}</code><span>${esc(label)}</span></div>`).join('')}</div>`);
}
function openRule(id) {
  if (!bots.length || !sessions.length) throw new Error('请先添加机器人和会话');
  const rule = routeRules.find(x => x.id === id);
  openModal(`<h2 id="modalTitle">${rule ? '编辑' : '新建'}路由规则</h2><p>自定义指令示例：/research 消息内容。匹配后只转发指令后的文字。</p><div class="modal-form"><label class="form-label">机器人<select class="form-select" id="ruleBot" ${rule ? 'disabled' : ''}>${options(bots)}</select></label><label class="form-label">触发指令<input class="form-input" id="ruleCommand" value="${esc(rule?.command || '/research')}" ${rule ? 'disabled' : ''} /></label><label class="form-label">目标<select class="form-select" id="ruleTarget">${options(sessions)}<option value="all">全部已绑定会话</option></select></label>${actions('saveRule', '保存规则')}${rule ? `<button class="text-button danger" data-delete-rule="${rule.id}">删除规则</button>` : ''}</div>`);
  if (rule) { $('#ruleBot').value = rule.bot; $('#ruleTarget').value = rule.target; $('#saveRule').dataset.ruleId = id; }
}
function exportLog() {
  const blob = new Blob([JSON.stringify(activity, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = 'clawlink-activity.json'; link.click(); URL.revokeObjectURL(url);
}
async function guarded(button, fn) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  const version = modalVersion;
  try { await fn(); }
  catch (error) { if ($('#modalBackdrop').classList.contains('open') && version === modalVersion) $('#modalError').textContent = error.message; else toast(error.message); }
  finally { if (button?.isConnected) button.disabled = false; }
}
document.addEventListener('change', event => {
  if (event.target.id === 'botPlatform') { const telegram = event.target.value === 'telegram'; $('#tokenField').hidden = !telegram; $('#createBot').textContent = telegram ? '验证并连接' : '创建并扫码'; }
});
document.addEventListener('click', async event => {
  const button = event.target.closest('button, [data-view-target]'); if (!button || button.disabled || button.id === 'submitVerify') return;
  if (['inspectWindow', 'saveBinding', 'saveTargetBinding'].includes(button.id)) return;
  await guarded(button, async () => {
    if (button.dataset.view) return showView(button.dataset.view);
    if (button.dataset.viewTarget) return showView(button.dataset.viewTarget);
    if (['modalClose', 'cancelModal'].includes(button.id)) return closeModal();
    if (['addBotTop', 'addBotFromView', 'addBotEmpty'].includes(button.id)) return openAddBot();
    if (['newSessionBtn', 'newSessionEmpty'].includes(button.id)) return openNewSession();
    if (button.id === 'createBot') {
      const version = modalVersion;
      const result = await apiRequest('/bots', { name: $('#botName').value, platform: $('#botPlatform').value, target: $('#botTarget').value, token: $('#botToken').value });
      await syncStateFromApi(); if (version !== modalVersion) return; showView('bots');
      if (result.bot.platform === 'wechat') await openWechatLogin(result.bot); else openBotSettings(result.bot); return;
    }
    if (button.dataset.copyPairing) {
      const command = button.dataset.copyPairing;
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(command);
      else {
        const input = document.createElement('textarea'); input.value = command; input.setAttribute('readonly', ''); input.style.position = 'fixed'; input.style.opacity = '0'; document.body.append(input); input.select(); document.execCommand('copy'); input.remove();
      }
      toast('配对指令已复制，请粘贴到微信或 Telegram 机器人私聊'); return;
    }
    if (button.dataset.connectBot) { const bot = bots.find(x => x.id === button.dataset.connectBot); return bot.platform === 'wechat' ? openWechatLogin(bot) : openTelegramLogin(bot); }
    if (button.id === 'saveTelegram') { await apiRequest(`/bots/${button.dataset.botId}/telegram`, { token: $('#replacementToken').value }); await syncStateFromApi(); openBotSettings(bots.find(x => x.id === button.dataset.botId)); return; }
    if (button.id === 'saveSession') { const version = modalVersion; const option = $('#sessionProvider').selectedOptions[0]; const result = await apiRequest('/sessions', { name: $('#sessionName').value, provider: option?.dataset.provider || option?.textContent?.split(' · ')[0], bundleId: option?.dataset.bundleId || '', targetType: option?.dataset.targetType || 'native' }); await syncStateFromApi(); if (version !== modalVersion) return; showView('sessions'); return openBinding(result.session.id); }
    if (button.dataset.bindSession) return openBinding(button.dataset.bindSession);
    if (button.id === 'nativePermission') { const permission = await apiRequest('/native/permission', {}); const target = permission.permissionTarget || {}; toast(permission.trusted ? '辅助功能权限已允许' : `请在辅助功能中允许 ${target.name || 'ClawLinkBridge'}，然后重新检查`); return; }
    if (button.dataset.validateSession) { await apiRequest('/native/validate', { sessionId: button.dataset.validateSession }); await syncStateFromApi(); toast('目标会话校验通过'); return; }
    if (button.dataset.sessionSwitch) return openSwitch({ sessionId: button.dataset.sessionSwitch });
    if (button.dataset.switchBot) return openSwitch({ botId: button.dataset.switchBot });
    if (button.id === 'performSwitch') { const broadcast = button.dataset.broadcast === 'true'; const result = await apiRequest('/commands', { botId: $('#switchBot').value, peerId: $('#switchPeer').value, text: broadcast ? '/broadcast' : `/switch ${$('#switchTarget').value}` }); if (!result.ok) throw new Error(result.reply); await syncStateFromApi(); closeModal(); toast(result.reply); return; }
    if (button.dataset.botMenu) return openBotSettings(bots.find(x => x.id === button.dataset.botMenu));
    if (button.id === 'savePeers') { await apiRequest(`/bots/${button.dataset.botId}`, { allowedPeers: $('#allowedPeers').value.split('\n').map(x => x.trim()).filter(Boolean) }, 'PATCH'); await syncStateFromApi(); toast('授权聊天已保存'); return; }
    if (button.id === 'newPairing') { await apiRequest(`/bots/${button.dataset.botId}/pairing`, {}); await syncStateFromApi(); openBotSettings(bots.find(x => x.id === button.dataset.botId)); return; }
    if (button.dataset.workerBot) { await apiRequest(`/bots/${button.dataset.workerBot}/${button.dataset.workerAction}`, {}); await syncStateFromApi(); closeModal(); return; }
    if (button.dataset.deleteBot) {
      if (button.dataset.confirm !== 'yes') { button.dataset.confirm = 'yes'; button.textContent = '再次点击确认移除'; return; }
      await apiRequest(`/bots/${button.dataset.deleteBot}`, {}, 'DELETE'); await syncStateFromApi(); closeModal(); return;
    }
    if (button.id === 'newRouteBtn') return openRule();
    if (button.dataset.ruleMenu) return openRule(button.dataset.ruleMenu);
    if (button.dataset.ruleToggle) { const id = button.dataset.ruleToggle; await apiRequest(`/routes/${id}`, { on: !routeRules.find(x => x.id === id).on }, 'PATCH'); await syncStateFromApi(); return; }
    if (button.id === 'saveRule') { const id = button.dataset.ruleId; await apiRequest(id === undefined ? '/routes' : `/routes/${id}`, { bot: $('#ruleBot').value, command: $('#ruleCommand').value, target: $('#ruleTarget').value }, id === undefined ? 'POST' : 'PATCH'); await syncStateFromApi(); closeModal(); return; }
    if (button.dataset.deleteRule) { await apiRequest(`/routes/${button.dataset.deleteRule}`, {}, 'DELETE'); await syncStateFromApi(); closeModal(); return; }
    if (button.id === 'broadcastAll') return openSwitch({ broadcast: true });
    if (button.id === 'refreshRoutes') { await syncStateFromApi(); if (!apiOnline) throw new Error('服务未连接'); toast('已从服务端刷新'); return; }
    if (button.dataset.filter) { $$('[data-filter]').forEach(el => el.classList.toggle('active', el === button)); renderOverview(); return; }
    if (button.dataset.logFilter) { $$('[data-log-filter]').forEach(el => el.classList.toggle('active', el === button)); renderActivity(); return; }
    if (button.id === 'exportLog') return exportLog();
    if (button.id === 'viewCommands' || button.dataset.action === 'docs') return openCommands();
    if (button.id === 'quickGuide') { openModal('<h2 id="modalTitle">开始使用 ClawLink</h2><div class="modal-step"><b>1</b><span>在「会话空间」添加路由会话：Codex / Claude 绑定窗口，PI 绑定会话文件，Paseo 选择已有会话。</span></div><div class="modal-step"><b>2</b><span>添加多个微信扫码账号或 Telegram Bot。</span></div><div class="modal-step"><b>3</b><span>将控制台提供的 /pair 指令复制后，发送到微信或 Telegram 机器人的私聊窗口；不要在 Codex 或 Terminal 执行。</span></div><div class="modal-step"><b>4</b><span>发送 /switch 会话名，随后发消息。也可在前端选择机器人及聊天切换。</span></div>'); return; }
    if (button.dataset.action === 'settings') { const result = await apiRequest('/native/discover'); const target = result.permissionTarget || {}; openModal(`<h2 id="modalTitle">本地连接状态</h2><p>服务绑定本机地址；Token 保存于本地私有数据文件。</p><div class="pairing-box">辅助功能权限：${result.trusted ? '已允许' : '需要允许当前进程'}<br />权限进程：${esc(target.name || 'ClawLinkBridge')}<br /><code class="path-copy">${esc(target.path || '未返回路径')}</code><br />接收连接：${service.polling || 0}<br />发现应用：${esc(result.apps.map(x => `${x.name} (${x.bundleId})`).join('、') || '暂无运行中的应用')}</div>`); return; }
    if (button.dataset.sessionMenu) {
      const session = targetById[button.dataset.sessionMenu];
      openModal(`<h2 id="modalTitle">${esc(session.name)}</h2><p>路由会话 ID：${esc(session.id)}</p><div class="modal-form"><button class="primary-button" data-bind-session="${session.id}">检查 / 重新绑定</button><label class="form-label">向当前绑定发送测试文字<input class="form-input" id="nativeTestText" placeholder="输入测试消息" /></label><button class="secondary-button" data-test-session="${session.id}" ${session.binding ? '' : 'disabled'}>发送到目标会话并读取回复</button><pre id="nativeTestReply" class="test-reply"></pre><button class="text-button danger" data-delete-session="${session.id}">移除会话配置</button></div>`); return;
    }
    if (button.dataset.testSession) { $('#nativeTestReply').textContent = '正在发送并等待目标会话回复…'; const data = await apiRequest('/native/send', { sessionId: button.dataset.testSession, text: $('#nativeTestText').value }); if ($('#nativeTestReply')) $('#nativeTestReply').textContent = data.reply; await syncStateFromApi(); return; }
    if (button.dataset.deleteSession) { if (button.dataset.confirm !== 'yes') { button.dataset.confirm = 'yes'; button.textContent = '再次点击确认移除配置'; return; } await apiRequest(`/sessions/${button.dataset.deleteSession}`, {}, 'DELETE'); await syncStateFromApi(); closeModal(); return; }
    if (button.id === 'notificationBtn') return showView('activity');
  });
});
$('#modalBackdrop').addEventListener('click', event => { if (event.target.id === 'modalBackdrop') closeModal(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeModal();
  if ((event.metaKey || event.ctrlKey) && event.key === 'k') { event.preventDefault(); $('#globalSearch').focus(); }
  if (event.key === 'Tab' && $('#modalBackdrop').classList.contains('open')) {
    const elements = $$('button:not([disabled]), input, select, textarea, summary', $('.modal')).filter(el => el.offsetParent !== null);
    if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); }
  }
});
$('#globalSearch').addEventListener('input', applySearch);
renderAll(); syncStateFromApi(); setInterval(syncStateFromApi, 4000);
