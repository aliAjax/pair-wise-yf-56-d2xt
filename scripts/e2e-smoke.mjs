/* 端到端冒烟：两个标签页（同 context 共享 localStorage）真实点击 UI 验证协同 */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;

const BASE = 'http://localhost:62021';
const results = [];
const ok = (name, cond) => { results.push([name, !!cond]); console.log(`${cond ? '✔' : '�'} ${name}`); };

const browser = await chromium.launch();
const context = await browser.newContext();
const pageA = await context.newPage(); // 值班员 A：响应负责人
const pageB = await context.newPage(); // 值班员 B：分析员

// 收集控制台错误
const errors = [];
pageA.on('pageerror', (e) => errors.push('A: ' + e.message));
pageB.on('pageerror', (e) => errors.push('B: ' + e.message));

await pageA.goto(BASE);
await pageB.goto(BASE);
await pageA.waitForTimeout(500);

// 选择角色
async function setRole(page, label) {
  await page.locator('.controls select').first().selectOption({ label });
}
await setRole(pageA, '响应负责人');
await setRole(pageB, '分析员');

// 初始：act-1 有 1 票（分析员 seed），待确认
ok('初始 act-1 待确认（1/2 票）', (await pageA.locator('.action-row').first().innerText()).includes('待确认'));

// A（响应负责人）审批 act-1 -> 已批准待执行
await pageA.locator('.action-row').first().getByRole('button', { name: '审批' }).click();
await pageA.waitForTimeout(200);
ok('A 补第二票后 act-1 变为已批准待执行', (await pageA.locator('.action-row').first().innerText()).includes('已批准待执行'));

// B 标签页通过 storage 事件看到同一状态
await pageB.waitForTimeout(500);
ok('B 标签页实时看到已批准状态（协同生效，无覆盖）', (await pageB.locator('.action-row').first().innerText()).includes('已批准待执行'));

// 同角色重复确认：A 的审批按钮应变禁用/显示已确认
const approveBtnA = pageA.locator('.action-row').first().getByRole('button', { name: /已确认/ });
ok('A 重复确认入口已关闭（同角色只算一次）', await approveBtnA.count() === 1);

// A 执行 act-1
await pageA.locator('.action-row').first().getByRole('button', { name: '执行' }).click();
await pageA.waitForTimeout(200);
ok('act-1 已执行', (await pageA.locator('.action-row').first().innerText()).includes('已执行'));
await pageB.waitForTimeout(500);
ok('B 看到 act-1 已执行', (await pageB.locator('.action-row').first().innerText()).includes('已执行'));

// B 更新影响范围（事实更新）-> 未执行动作退回待确认；已执行的 act-1 保持
await pageB.locator('.facts-form input').first().fill('api-gateway、billing-svc、customer-portal');
await pageB.locator('.facts-form button[type="submit"]').click();
await pageB.waitForTimeout(300);
const summaryB = await pageB.locator('.metrics').first().innerText();
ok('事实版本推进到 v2', summaryB.includes('v2'));
const rowsB = await pageB.locator('.action-row').allInnerTexts();
ok('已执行的 act-1 保持已执行且停留在 v1', rowsB[0].includes('已执行') && rowsB[0].includes('v1'));
ok('未执行动作退回待确认且版本变为 v2', rowsB.some((t) => t.includes('v2') && t.includes('待确认')));
ok('旧版本审批以"已作废"形式留痕', rowsB.some((t) => t.includes('已作废的旧版本审批')));

// A 同步看到事实更新
await pageA.waitForTimeout(600);
ok('A 同步看到 v2 事实', (await pageA.locator('.metrics').first().innerText()).includes('v2'));

// 断网：A 断网后审批 act-2，乐观显示待同步
await pageA.getByRole('button', { name: /断网中/ }).click();
await pageA.waitForTimeout(200);
ok('A 进入断网状态（待发 0）', (await pageA.locator('.controls').innerText()).includes('断网中'));
// act-2 是第二行（未执行、block）
const act2Row = pageA.locator('.action-row').filter({ hasText: '封禁可疑出口地址' });
await act2Row.getByRole('button', { name: '审批' }).click();
await pageA.waitForTimeout(200);
ok('断网审批乐观显示为已批准', (await act2Row.innerText()).includes('已批准待执行'));
ok('断网审批带待同步标记', (await act2Row.innerText()).includes('待同步'));
ok('待发队列显示 1 条', (await pageA.locator('.controls').innerText()).includes('待发 1'));

// 断网期间 B 又推进了事实到 v3（影响范围再变）
await pageB.locator('.facts-form input').first().fill('api-gateway、billing-svc、new-host');
await pageB.locator('.facts-form button[type="submit"]').click();
await pageB.waitForTimeout(300);
ok('B 把事实推进到 v3', (await pageB.locator('.metrics').first().innerText()).includes('v3'));

// A 回网：v2 的离线审批合不上 v3 -> 单列；act-2 退回待确认
await pageA.getByRole('button', { name: /在线协同|断网中/ }).click();
await pageA.waitForTimeout(400);
ok('A 恢复在线', (await pageA.locator('.controls').innerText()).includes('在线协同'));
const unmergedCard = pageA.locator('.unmerged-list');
ok('合不上的离线审批单独列出', await unmergedCard.isVisible() && (await unmergedCard.innerText()).includes('版本对不上'));
const act2After = pageA.locator('.action-row').filter({ hasText: '封禁可疑出口地址' });
ok('act-2 因事实变更仍为待确认', (await act2After.innerText()).includes('待确认'));

// 知悉后清单消失
await pageA.locator('.unmerged-row button', { hasText: '知悉' }).click();
await pageA.waitForTimeout(200);
ok('知悉后未合并清单清空', await pageA.locator('.unmerged-list').count() === 0);

ok('全程无页面运行时错误', errors.length === 0);
if (errors.length) console.log(errors.join('\n'));

await browser.close();
const failed = results.filter(([, pass]) => !pass);
console.log(`\n${results.length - failed.length}/${results.length} 项端到端检查通过`);
process.exit(failed.length ? 1 : 0);
