import assert from "node:assert/strict";

async function send(evaluate, check, text) {
  await evaluate(`(() => { const input=document.querySelector('#objective');input.value=${JSON.stringify(text)};
    input.dispatchEvent(new Event('input'));document.querySelector('#run').click(); })()`);
  await check(() => evaluate(`document.body.dataset.busy==='false' && document.querySelector('#status').dataset.status==='COMPLETED'
    && document.querySelector('#objective-display').textContent===${JSON.stringify(text)}`), `${text} 没有完成`);
}

const actionsVisible = "(() => { const edit=document.querySelector('#current-turn .turn-user-actions [aria-label=编辑]');return Boolean(edit && !edit.hidden && edit.getClientRects().length); })()";

/**
 * 两轮对话里“编辑”最后一轮、改完重发，再“重新生成”新的最后一轮。
 * 只有最后一轮有开始前的快照：收回后，前一轮不能接着收回。模型请求里不能再出现被收回的那一轮。
 */
export async function verifyRewind({ evaluate, check, requests }) {
  await evaluate("document.querySelector('#nav-tasks').click()");
  await check(() => evaluate("Boolean(document.querySelector('.workspace-group-action[data-action=new]:not(:disabled)')) && document.body.dataset.busy!=='true'"), "编辑验收的工作区还未加载");
  await evaluate("document.querySelector('.workspace-group-action[data-action=new]:not(:disabled)').click()");
  await send(evaluate, check, "PACKAGE-REWIND-ONE");
  await send(evaluate, check, "PACKAGE-REWIND-TWO");
  await check(() => evaluate(actionsVisible), "最后一条消息下面没有“编辑 / 重新生成”");
  const sessions = () => evaluate("document.querySelectorAll('.history-item').length");
  const before = await sessions();
  await evaluate("window.confirm=()=>true");
  await evaluate("document.querySelector('#current-turn [aria-label=编辑]').click()");
  await check(() => evaluate("document.querySelector('#objective').value==='PACKAGE-REWIND-TWO' && document.body.dataset.busy==='false' && document.querySelector('#objective-display').textContent==='PACKAGE-REWIND-ONE'"), "编辑后没有回到上一轮并把原文放回输入框");
  assert.equal(await evaluate("document.querySelectorAll('#previous-turns .saved-turn').length"), 0, "被收回的一轮仍然显示");
  assert.equal(await evaluate(actionsVisible), false, "没有快照的前一轮不应显示“编辑”");
  let start = requests.length;
  await send(evaluate, check, "PACKAGE-REWIND-FIXED");
  let sent = JSON.stringify(requests.slice(start));
  assert(sent.includes("PACKAGE-REWIND-ONE") && !sent.includes("PACKAGE-REWIND-TWO"), "改完重发的请求里仍有被收回的一轮");
  await check(() => evaluate(actionsVisible), "新的最后一轮没有“编辑 / 重新生成”");
  start = requests.length;
  await evaluate("document.querySelector('#current-turn [aria-label=重新生成]').click()");
  await check(() => evaluate("document.body.dataset.busy==='false' && document.querySelector('#status').dataset.status==='COMPLETED' && document.querySelector('#objective-display').textContent==='PACKAGE-REWIND-FIXED' && document.querySelectorAll('#previous-turns .saved-turn').length===1"), "重新生成没有完成");
  sent = JSON.stringify(requests.slice(start));
  assert(!sent.includes("PACKAGE-REWIND-TWO"), "重新生成的请求里仍有被收回的一轮");
  // 旧的这一轮（要求和回答）如果还在历史里，最后一次请求会出现不止一次。
  const latest = JSON.stringify(requests.at(-1).input);
  assert.equal((latest.match(/PACKAGE-REWIND-FIXED/gu) ?? []).length, 1, "重新生成的请求里仍保留着被收回的旧回答");
  assert.equal(await sessions(), before, "编辑或重新生成多出了对话");
  // 只有一轮的对话：编辑后整个对话删除，侧栏不留空对话，原文回到新对话的输入框。
  await evaluate("document.querySelector('.workspace-group-action[data-action=new]:not(:disabled)').click()");
  await send(evaluate, check, "PACKAGE-REWIND-SOLO");
  assert.equal(await sessions(), before + 1, "单轮对话没有出现在侧栏");
  await check(() => evaluate(actionsVisible), "单轮对话没有“编辑”");
  await evaluate("document.querySelector('#current-turn [aria-label=编辑]').click()");
  await check(() => evaluate("document.querySelector('#objective').value==='PACKAGE-REWIND-SOLO' && document.body.dataset.busy==='false' && document.querySelector('#current-turn').hidden"), "编辑唯一的一轮后没有回到空白新对话");
  assert.equal(await sessions(), before, "编辑唯一的一轮后侧栏留下了空对话");
  await evaluate("document.querySelector('#objective').value='';document.querySelector('#objective').dispatchEvent(new Event('input'))");
  return { editRestoresComposer:true, editedResendExcludesOldTurn:true, regenerateLatestTurn:true, onlyTurnRemovesConversation:true };
}
