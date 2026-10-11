const test = require('node:test');
const assert = require('node:assert/strict');
const { createNative, extractReply } = require('../server/native');
const { trustedWechatBase, chunks } = require('../server/adapters');

test('回复只返回新增内容，拒绝回显旧历史和输入消息', () => {
  assert.equal(extractReply('历史', '历史\n提问\n回答', '提问', 'append'), '回答');
  assert.equal(extractReply('历史', '别人的历史', '提问', 'append'), '');
  assert.equal(extractReply('历史', '历史\n提问', '提问', 'append'), '');
  assert.equal(extractReply('旧回复', '新回复', '提问', 'latest'), '新回复');
  assert.equal(extractReply('', '提问', '提问', 'latest'), '');
});

test('原生应用操作串行，等待生成完成和文本稳定后再回复', async () => {
  let active = null, captures = 0; const order = [];
  const native = createNative({ interval: 2, minWait: 4, stableWait: 4, timeout: 500, call: async request => {
    if (request.action === 'send') { assert.equal(active, null); active = request.text; captures = 0; order.push(`send:${active}`); return { sent: true, before: '历史' }; }
    captures += 1;
    if (captures === 1) return { text: `历史\n${active}\n部分`, busy: true };
    return { text: `历史\n${active}\n完整回复`, busy: false };
  } });
  const first = native.send({ replyMode: 'append' }, '问题一').then(result => { order.push(`done:${active}`); active = null; return result; });
  const second = native.send({ replyMode: 'append' }, '问题二').then(result => { order.push(`done:${active}`); active = null; return result; });
  assert.deepEqual(await Promise.all([first, second]), ['完整回复', '完整回复']);
  assert.deepEqual(order, ['send:问题一', 'done:问题一', 'send:问题二', 'done:问题二']);
});

test('生成期间会话校验失败时中止读取，发送超时不自动重发', async () => {
  let sends = 0;
  const native = createNative({ interval: 1, timeout: 20, call: async request => {
    if (request.action === 'send') { sends += 1; return { sent: true, before: '' }; }
    throw new Error('会话标识不符');
  } });
  await assert.rejects(native.send({}, 'test'), /会话标识不符/); assert.equal(sends, 1);
  const timeout = createNative({ interval: 2, timeout: 10, call: async request => request.action === 'send' ? { sent: true, before: '旧历史' } : { text: '另一会话', busy: false } });
  await assert.rejects(timeout.send({}, 'test'), /勿自动重发/);
});

test('关闭服务取消待发送消息，正在处理的消息不继续读取或自动重发', async () => {
  let release, sends = 0, captures = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const native = createNative({ interval: 1, call: async request => {
    if (request.action === 'send') { sends += 1; await pending; return { sent: true, before: '' }; }
    captures += 1; return { text: '不应读取', busy: false };
  } });
  const first = native.send({}, '已开始'); const second = native.send({}, '仍在队列');
  await new Promise(resolve => setImmediate(resolve)); native.close(); release();
  const settled = await Promise.allSettled([first, second]);
  assert.ok(settled.every(result => result.status === 'rejected' && /已停止/.test(result.reason.message)));
  assert.equal(sends, 1); assert.equal(captures, 0);
});

test('微信重定向限制到微信域名，长回复按 Unicode 字符分块', () => {
  assert.equal(trustedWechatBase('https://ilinkai.weixin.qq.com/something'), 'https://ilinkai.weixin.qq.com');
  for (const host of ['https://weixin.qq.com.evil.test', 'http://ilinkai.weixin.qq.com', 'https://evil.test', 'https://user:pass@ilinkai.weixin.qq.com']) assert.throws(() => trustedWechatBase(host));
  const pieces = chunks('😀'.repeat(4000), 1800); assert.equal(pieces.join(''), '😀'.repeat(4000)); assert.equal(pieces.length, 3);
});
