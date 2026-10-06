import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function evaluateMain(url, expression) {
  const connection = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("主进程验收命令超时")), 20_000);
    const finish = (error, value) => {
      clearTimeout(timer); connection.close();
      if (error) reject(error); else resolve(value);
    };
    connection.addEventListener("error", () => finish(new Error("主进程验收连接失败")), { once:true });
    connection.addEventListener("open", () => connection.send(JSON.stringify({ id:1,
      method:"Runtime.evaluate", params:{ expression, awaitPromise:true, returnByValue:true } })));
    connection.addEventListener("message", ({data}) => {
      const value = JSON.parse(data);
      if (value.id !== 1) return;
      const error = value.error ?? value.result?.exceptionDetails;
      finish(error ? new Error(JSON.stringify(error)) : null, value.result?.result?.value);
    });
  });
}

async function clipboardImage(main, dataUrl) {
  return main(`(async () => {
    const {clipboard,ClipboardItem}=process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app/package.json')('electron');
    const saved=[];
    for(const item of await clipboard.read()){
      // 空剪贴板会读出一个没有任何格式的项，ClipboardItem 不接受，跳过即可。
      if(!item.types.length) continue;
      const entries=await Promise.all(item.types.map(async type=>[type,await item.getType(type)]));
      saved.push(new ClipboardItem(Object.fromEntries(entries)));
    }
    globalThis.imageAcceptanceClipboard=saved;
    const bytes=Buffer.from(${JSON.stringify(dataUrl)}.split(',')[1],'base64');
    await clipboard.write([new ClipboardItem({'image/png':new Blob([bytes],{type:'image/png'})})]);
    return {supported:await clipboard.has('image/png')};
  })()`);
}

async function restoreClipboard(main) {
  await main(`(async () => {
    const {clipboard}=process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app/package.json')('electron');
    const saved=globalThis.imageAcceptanceClipboard;
    if(saved){if(saved.length) await clipboard.write(saved);else clipboard.clear();delete globalThis.imageAcceptanceClipboard;}
  })()`);
}

function sdkUsersSince(requests, start) {
  const primary = requests.slice(start).filter(request => request.tools?.length && Array.isArray(request.input));
  assert(primary.length > 0, "本次发送没有产生真实 SDK 主请求");
  return primary.at(-1).input.filter(item => item.role === "user");
}

function verifySdkMessage(message, expectedImage, expectedText, label) {
  assert(Array.isArray(message?.content), `${label}没有使用多模态内容`);
  const images = message.content.filter(block => block.type === "input_image");
  assert.equal(images.length, 1, `${label}图片丢失或被重复注入`);
  assert(images[0].image_url === expectedImage, `${label}传给 SDK 的图片字节与附件不同`);
  const texts = message.content.filter(block => block.type === "input_text").map(block => block.text);
  assert.deepEqual(texts, expectedText ? [expectedText] : [], `${label}文字内容发生变化`);
}

export async function verifyImageInput({command,evaluate,check,requests,directory,screenshot,main,captureLayouts}) {
  await evaluate("document.querySelector('#nav-tasks').click()");
  await check(() => evaluate("Boolean(document.querySelector('.workspace-group-action[data-action=new]:not(:disabled)')) && document.body.dataset.busy!=='true'"), "图片验收的工作区还未加载");
  await evaluate("document.querySelector('.workspace-group-action[data-action=new]:not(:disabled)').click()");
  await check(() => evaluate("Boolean(document.querySelector('.image-upload')) && document.body.dataset.busy!=='true'"), "图片上传入口没有初始化");
  const sample = await screenshot();
  const file = join(directory, "image-upload.png");
  writeFileSync(file, Buffer.from(sample.data, "base64"));
  const dataUrl = `data:image/png;base64,${sample.data}`;
  const setFiles = async files => {
    const {root} = await command("DOM.getDocument");
    const {nodeId} = await command("DOM.querySelector", {nodeId:root.nodeId,selector:'.composer-images input[type=file]'});
    await command("DOM.setFileInputFiles", {nodeId,files});
  };
  const draftCount = () => evaluate("document.querySelectorAll('.composer-image img').length");
  const draftDecoded = () => evaluate("(() => { const image=document.querySelector('.composer-image img');return image?.complete&&image.naturalWidth>0; })()");
  await setFiles([file]);
  await check(async () => await draftCount() === 1, "原生文件选择没有产生图片附件");
  await check(draftDecoded, "上传图片没有可见缩略图");
  assert(await evaluate("document.querySelector('.composer-image img').getAttribute('src')") === dataUrl,
    "文件选择的缩略图与原始 PNG 字节不同");
  await evaluate("document.querySelector('.composer-image button').click()");
  assert.equal(await draftCount(),0,"删除附件没有生效");
  let clipboard;
  try {
    clipboard = await clipboardImage(main, dataUrl);
    await evaluate("document.querySelector('#objective').focus()");
    if (clipboard.supported) {
      await command("Input.dispatchKeyEvent", {type:"keyDown",modifiers:2,key:"v",code:"KeyV",windowsVirtualKeyCode:86});
      await command("Input.dispatchKeyEvent", {type:"keyUp",modifiers:2,key:"v",code:"KeyV",windowsVirtualKeyCode:86});
      await check(async () => await draftCount() === 1, "真实 Ctrl+V 没有粘贴系统剪贴板图片");
    } else {
      await evaluate(`(() => { const transfer=new DataTransfer();const bytes=Uint8Array.from(atob(${JSON.stringify(sample.data)}),c=>c.charCodeAt(0));transfer.items.add(new File([bytes],'clipboard.png',{type:'image/png'}));document.querySelector('#objective').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true})); })()`);
      await check(async () => await draftCount() === 1, "图片粘贴事件没有产生附件");
    }
  } finally { await restoreClipboard(main); }
  await check(draftDecoded, "粘贴图片没有实际解码");
  const pastedImage = await evaluate("document.querySelector('.composer-image img').getAttribute('src')");
  assert(typeof pastedImage === "string" && pastedImage.startsWith("data:image/png;base64,"), "粘贴图片没有使用 PNG 数据");
  await captureLayouts("image-composer");
  const firstRequestStart = requests.length;
  await evaluate("document.querySelector('#objective').value='';document.querySelector('#objective').dispatchEvent(new Event('input'));document.querySelector('#run').click()");
  await check(() => evaluate("document.body.dataset.busy==='false' && document.querySelector('#status').dataset.status==='COMPLETED'"), "仅图片消息未完成");
  const firstUsers = sdkUsersSince(requests, firstRequestStart);
  assert.equal(firstUsers.length, 1, "新任务请求混入了其他对话");
  verifySdkMessage(firstUsers[0], pastedImage, "", "仅图片消息");
  assert.equal(await draftCount(),0,"发送成功后附件未清空");
  assert.equal(await evaluate("document.querySelectorAll('#current-turn .turn-user .message-image img').length"),1,"已发送消息未显示图片");
  assert(await evaluate("document.querySelector('#current-turn .turn-user .message-image img').getAttribute('src')") === pastedImage,
    "已发送图片来源与粘贴附件不同");
  const continuedImage = await evaluate("(() => { const canvas=document.createElement('canvas');canvas.width=48;canvas.height=32;const context=canvas.getContext('2d');context.fillStyle='#df7440';context.fillRect(0,0,48,32);context.fillStyle='#2376b9';context.fillRect(8,8,24,16);return canvas.toDataURL('image/png'); })()");
  assert(continuedImage !== dataUrl && continuedImage !== pastedImage, "两轮图片样本没有区别");
  const continuedFile = join(directory, "image-continue.png");
  writeFileSync(continuedFile, Buffer.from(continuedImage.split(",")[1], "base64"));
  await setFiles([continuedFile]);
  await check(async () => await draftCount()===1,"续聊选择图片失败");
  await check(draftDecoded, "续聊图片没有实际解码");
  assert(await evaluate("document.querySelector('.composer-image img').getAttribute('src')") === continuedImage,
    "续聊缩略图与文件原始 PNG 字节不同");
  const continuedRequestStart = requests.length;
  await evaluate("document.querySelector('#objective').value='IMAGE-CONTINUE';document.querySelector('#objective').dispatchEvent(new Event('input'));document.querySelector('#run').click()");
  await check(() => evaluate("document.body.dataset.busy==='false' && document.querySelector('#status').dataset.status==='COMPLETED' && document.querySelector('#objective-display').textContent==='IMAGE-CONTINUE'"), "文字加图片续聊未完成");
  const users = sdkUsersSince(requests, continuedRequestStart);
  assert.equal(users.length, 2, "续聊请求没有保留恰好两轮用户消息");
  verifySdkMessage(users[0], pastedImage, "", "上一轮图片消息");
  verifySdkMessage(users[1], continuedImage, "IMAGE-CONTINUE", "本轮文字加图片消息");
  await evaluate("window.imageAcceptanceHistoryTitle=document.querySelector('.history-item[data-active=true]').title;document.querySelector('#new-task').click()");
  await evaluate("[...document.querySelectorAll('.history-item')].find(item=>item.title===window.imageAcceptanceHistoryTitle).click()");
  await check(() => evaluate("document.body.dataset.busy==='false' && document.querySelectorAll('.turn-user .message-image img').length===2"), "历史重开后图片丢失");
  await captureLayouts("image-history");
  await check(() => evaluate("[...document.querySelectorAll('.turn-user .message-image img')].every(image=>image.complete&&image.naturalWidth>0)"), "历史图片没有实际载入");
  const historyImages = await evaluate("[...document.querySelectorAll('.turn-user .message-image img')].map(image=>image.getAttribute('src'))");
  assert(historyImages.length === 2 && historyImages[0] === pastedImage && historyImages[1] === continuedImage,
    "历史图片来源或顺序与两轮发送的附件不同");
  await evaluate("document.querySelector('.turn-user .message-image img').click()");
  await check(() => evaluate("(() => { const image=document.querySelector('.image-preview[open] img');return Boolean(image?.complete&&image.naturalWidth>0); })()"), "点击图片没有打开大图预览");
  const previewGeometry = () => evaluate(`(() => {
    const dialog=document.querySelector('.image-preview');const box=dialog.querySelector('img').getBoundingClientRect();
    const close=dialog.querySelector('.image-preview-close').getBoundingClientRect();
    const titlebar=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-height'))||0;
    const caption=dialog.querySelector('.image-preview-name').getBoundingClientRect();
    return {dx:Math.abs(box.left+box.width/2-innerWidth/2),dy:Math.abs(box.top-(innerHeight-caption.bottom)),closeTop:close.top,titlebar,src:dialog.querySelector('img').getAttribute('src')};
  })()`);
  const geometry = await previewGeometry();
  assert(geometry.src === pastedImage, "大图预览的图片与被点击的图片不同");
  assert(geometry.dx <= 2, `大图预览没有水平居中（偏移 ${geometry.dx}px）`);
  assert(geometry.dy <= 2, `大图预览没有垂直居中（上下留白相差 ${geometry.dy}px）`);
  assert(geometry.closeTop >= geometry.titlebar, "大图预览关闭按钮被标题栏遮挡");
  const zoom = () => evaluate("(() => { const d=document.querySelector('.image-preview');return {scale:Number(d.dataset.scale),transform:d.querySelector('img').style.transform,level:d.querySelector('.image-preview-level').textContent}; })()");
  const center = await evaluate("(() => { const r=document.querySelector('.image-preview img').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()");
  await command("Input.dispatchMouseEvent", {type:"mouseWheel",x:center.x,y:center.y,deltaX:0,deltaY:-300});
  await check(async () => (await zoom()).scale > 1, "滚轮没有放大预览图片");
  const wheelZoom = await zoom();
  assert(/scale\(/.test(wheelZoom.transform) && /^\d+%$/.test(wheelZoom.level), "放大后没有应用缩放或显示比例");
  await command("Input.dispatchMouseEvent", {type:"mousePressed",x:center.x,y:center.y,button:"left",buttons:1,clickCount:1});
  await command("Input.dispatchMouseEvent", {type:"mouseMoved",x:center.x+40,y:center.y+25,button:"left",buttons:1});
  await command("Input.dispatchMouseEvent", {type:"mouseReleased",x:center.x+40,y:center.y+25,button:"left",buttons:0,clickCount:1});
  const dragged = await zoom();
  assert(dragged.transform !== wheelZoom.transform, "放大后拖动没有移动图片");
  assert(await evaluate("Boolean(document.querySelector('.image-preview[open]'))"), "拖动图片后预览被误关闭");
  await evaluate("document.querySelector('.image-preview-toolbar button[aria-label=放大]').click()");
  assert((await zoom()).scale > dragged.scale, "放大按钮没有生效");
  await command("Input.dispatchKeyEvent", {type:"keyDown",key:"0",code:"Digit0",windowsVirtualKeyCode:48});
  await command("Input.dispatchKeyEvent", {type:"keyUp",key:"0",code:"Digit0",windowsVirtualKeyCode:48});
  await check(async () => { const value=await zoom();return value.scale===1&&value.transform===""; }, "按 0 没有恢复适应窗口");
  await command("Input.dispatchKeyEvent", {type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await command("Input.dispatchKeyEvent", {type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await check(() => evaluate("!document.querySelector('.image-preview[open]')"), "Esc 没有关闭大图预览");
  return {clickPreview:true,fileSelection:true,preview:true,remove:true,pasteEvent:true,nativeCtrlV:clipboard.supported,
    imageOnly:true,textAndImage:true,sdkVisionInput:true,exactSdkImageBytes:true,noDuplicateImageBlocks:true,
    continuationPreservesImages:true,historyReplay:true,exactHistoryImageSources:true};
}
