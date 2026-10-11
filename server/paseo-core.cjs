function checkAgent(agent, agentId, forSend = false) {
  if (!agent || agent.id !== agentId) throw new Error('Paseo 会话不存在或 ID 不匹配，请重新绑定');
  if (agent.archivedAt) throw new Error('Paseo 会话已归档，请先在 Paseo 恢复');
  if (forSend && (agent.pendingPermissions?.length || agent.requiresAttention && agent.attentionReason === 'permission')) throw new Error('Paseo 正在等待授权，请先在 Paseo 处理');
  if (forSend && (agent.status === 'running' || agent.activeTurn)) throw new Error('Paseo 会话正在运行，请等待当前任务结束');
}
function replyFromTimeline(before, after, messageId) {
  if (before.epoch !== after.epoch || after.staleCursor || after.gap) throw new Error('Paseo 时间线已变化，无法确认本次回复；请到 Paseo 查看，消息不会自动重发');
  const entries = [...after.entries].sort((a, b) => a.seqStart - b.seqStart);
  const baseline = Math.max(-1, ...before.entries.map(entry => entry.seqEnd));
  const start = entries.findIndex(entry => entry.seqEnd > baseline && entry.item.type === 'user_message' && (entry.item.clientMessageId === messageId || entry.item.messageId === messageId));
  if (start < 0) throw new Error('Paseo 未提供本次消息的时间线标识；请到 Paseo 查看，消息不会自动重发');
  const own = entries[start]; const result = [];
  for (const entry of entries.slice(start + 1)) {
    if (entry.seqEnd <= baseline) continue;
    if (entry.item.type === 'user_message') break;
    if (own.turnId && entry.turnId !== own.turnId) continue;
    if (entry.item.type === 'assistant_message' && entry.item.text?.trim()) result.push(entry.item.text.trim());
  }
  if (!result.length) throw new Error('Paseo 本次任务没有可回传的文本回复；请到 Paseo 查看');
  return result.join('\n\n');
}
async function perform(client, input) {
  if (input.action === 'discover') {
    const payload = await client.fetchAgents({});
    return { available: true, agents: payload.entries.map(entry => entry.agent).filter(agent => !agent.archivedAt).map(agent => ({ id: agent.id, name: agent.title || agent.id, provider: agent.provider, model: agent.runtimeInfo?.model || agent.model || '', status: agent.status, cwd: agent.cwd })) };
  }
  const fetched = await client.fetchAgent({ agentId: input.agentId });
  checkAgent(fetched.agent, input.agentId, input.action === 'send');
  if (input.action === 'validate') return { text: fetched.agent.title || input.agentId, name: fetched.agent.title || input.agentId, agentId: input.agentId };
  if (input.action !== 'send') throw new Error('未知 Paseo 操作');
  const before = await client.fetchAgentTimeline(input.agentId, { direction: 'tail', limit: 1, projection: 'projected', timeout: 10000 });
  // Recheck after fetching history so a task started in the meantime is refused.
  checkAgent((await client.fetchAgent({ agentId: input.agentId })).agent, input.agentId, true);
  await client.sendAgentMessage(input.agentId, input.message, { messageId: input.messageId });
  const result = await client.waitForFinish(input.agentId, input.timeout);
  if (result.status === 'permission') throw new Error('消息已提交，Paseo 正在等待授权，请在 Paseo 处理并查看后续回复；不会自动重发');
  if (result.status === 'timeout') throw new Error('消息已提交，Paseo 仍未完成，请到 Paseo 查看；不会自动重发');
  if (result.status === 'error') throw new Error(`Paseo 任务失败：${result.error || '未知错误'}；消息不会自动重发`);
  if (result.status !== 'idle') throw new Error(`Paseo 返回未知任务状态：${result.status}；请到 Paseo 查看`);
  const after = await client.fetchAgentTimeline(input.agentId, { direction: 'tail', limit: 0, projection: 'projected', timeout: 15000 });
  return { reply: replyFromTimeline(before, after, input.messageId) };
}
module.exports = { perform, checkAgent, replyFromTimeline };
