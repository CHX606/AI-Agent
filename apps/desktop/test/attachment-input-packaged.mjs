import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { selectComposerFiles } from "./packaged-file-selection.mjs";

function primaryUsers(requests, start) {
  const relevant=requests.slice(start).filter(item=>item.tools?.length && Array.isArray(item.input));
  assert(relevant.length,'附件未产生实际 SDK 请求');
  return relevant.at(-1).input.filter(item=>item.role==='user');
}

function checkDocuments(message, names, markers) {
  const blocks=message.content.filter(item=>item.type==='input_text');
  const text=blocks.map(item=>item.text).join('\n');
  for(const name of names) assert(text.includes(name),`SDK 缺附件文件名 ${name}`);
  for(const marker of markers) assert(text.includes(marker),`SDK 缺附件正文 ${marker}`);
  assert(!JSON.stringify(message).includes(';base64,'),'文档原始 Base64 进入了模型正文');
}

export async function verifyFileAttachments({command,evaluate,check,requests,directory,screenshot,captureLayouts}) {
  await evaluate("document.querySelector('#nav-tasks').click();document.querySelector('.workspace-group-action[data-action=new]:not(:disabled)').click()");
  await check(()=>evaluate("document.body.dataset.busy!=='true' && Boolean(document.querySelector('.image-upload'))"),'附件入口未初始化');
  assert.equal(await evaluate("document.querySelector('.image-upload').getAttribute('aria-label')"),'上传附件');
  const paths=[], names=['说明-包含较长文件名以检查窄窗口布局.txt','sample.pdf','sample.docx','sample.xlsx'];
  const textFile=join(directory,names[0]);
  writeFileSync(textFile,'ATTACH-TEXT-42 中文文本'); paths.push(textFile);
  for(const name of names.slice(1)){
    const path=join(directory,name);
    writeFileSync(path,readFileSync(fileURLToPath(new URL(`./fixtures/attachments/${name}`,import.meta.url)))); paths.push(path);
  }
  const imagePath=join(directory,'mixed-image.png');
  writeFileSync(imagePath,Buffer.from((await screenshot()).data,'base64'));
  const draftCount=()=>evaluate("document.querySelectorAll('.composer-images .attachment-card').length");
  await selectComposerFiles(command,[...paths,imagePath]);
  await check(async()=>await draftCount()===4 && await evaluate("document.querySelectorAll('.composer-image img').length===1"),'图片和文档混合上传未显示');
  await captureLayouts('attachment-composer');
  await evaluate("document.querySelector('.composer-image button').click()");
  assert.equal(await evaluate("document.querySelectorAll('.composer-image img').length"),0,'图片未移除');
  await evaluate("document.querySelector('.composer-images .attachment-card button').click()");
  assert.equal(await draftCount(),3,'普通附件未移除');
  await selectComposerFiles(command,[textFile]);
  await check(async()=>await draftCount()===4,'普通附件重新添加失败');
  let start=requests.length;
  await evaluate("document.querySelector('#objective').value='';document.querySelector('#objective').dispatchEvent(new Event('input'));document.querySelector('#run').click()");
  await check(()=>evaluate("document.body.dataset.busy==='false' && document.querySelector('#status').dataset.status==='COMPLETED'"),'附件单独发送未完成');
  let users=primaryUsers(requests,start);
  assert.equal(users.length,1,'附件新对话混入旧用户消息');
  checkDocuments(users[0],names,['ATTACH-TEXT-42','ATTACH-PDF-42','ATTACH-WORD-42','ATTACH-SHEET-42']);
  assert.equal(await draftCount(),0,'成功发送后附件草稿未清空');
  assert.equal(await evaluate("document.querySelectorAll('#current-turn .message-attachments .attachment-card').length"),4,'已发送消息缺少附件卡片');
  assert.equal(await evaluate("document.querySelectorAll('#current-turn .message-attachments img').length"),0,'普通附件被渲染成图片');
  assert(await evaluate("Boolean(document.querySelector('#current-turn [aria-label=编辑]'))"),'附件单独发送后缺少编辑入口');
  await captureLayouts('attachment-history');
  const followup=join(directory,'follow-up.csv'); writeFileSync(followup,'item,value\nATTACH-FOLLOWUP-99,99');
  await selectComposerFiles(command,[followup]);
  await check(async()=>await draftCount()===1,'续聊附件未就绪');
  start=requests.length;
  await evaluate("document.querySelector('#objective').value='ATTACH-CONTINUE';document.querySelector('#objective').dispatchEvent(new Event('input'));document.querySelector('#run').click()");
  await check(()=>evaluate("document.body.dataset.busy==='false' && document.querySelector('#status').dataset.status==='COMPLETED' && document.querySelector('#objective-display').textContent==='ATTACH-CONTINUE'"),'带附件续聊未完成');
  users=primaryUsers(requests,start);
  assert.equal(users.length,2,'续聊未保持两轮输入');
  checkDocuments(users[0],names,['ATTACH-TEXT-42','ATTACH-PDF-42','ATTACH-WORD-42','ATTACH-SHEET-42']);
  checkDocuments(users[1],['follow-up.csv'],['ATTACH-FOLLOWUP-99']);
  await evaluate("window.attachmentHistoryTitle=document.querySelector('.history-item[data-active=true]').title;document.querySelector('#new-task').click()");
  await evaluate("[...document.querySelectorAll('.history-item')].find(item=>item.title===window.attachmentHistoryTitle).click()");
  await check(()=>evaluate("document.body.dataset.busy==='false' && document.querySelectorAll('#previous-turns .message-attachments .attachment-card').length===4"),'历史附件未恢复');
  await check(()=>evaluate("Boolean(document.querySelector('#current-turn [aria-label=编辑]'))"),'附件消息缺少编辑入口');
  await evaluate("window.confirm=()=>true;document.querySelector('#current-turn [aria-label=编辑]').click()");
  await check(async()=>await draftCount()===1 && await evaluate("document.querySelector('#objective').value==='ATTACH-CONTINUE'"),'编辑没有恢复原附件');
  start=requests.length;
  await evaluate("document.querySelector('#run').click()");
  await check(()=>evaluate("document.body.dataset.busy==='false' && document.querySelector('#status').dataset.status==='COMPLETED' && document.querySelector('#objective-display').textContent==='ATTACH-CONTINUE'"),'编辑附件重发未完成');
  users=primaryUsers(requests,start);
  assert.equal(users.length,2,'编辑重发混入被撤销的附件消息');
  checkDocuments(users[1],['follow-up.csv'],['ATTACH-FOLLOWUP-99']);
  return { fileSelection:true, mixedUpload:true, remove:true, attachmentOnly:true, textPdfDocxXlsxRead:true,
    noDocumentBase64InSdk:true, continuation:true, history:true, editResend:true };
}
