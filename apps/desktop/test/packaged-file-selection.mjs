export async function selectComposerFiles(command, files) {
  const { root } = await command("DOM.getDocument");
  const { nodeId } = await command("DOM.querySelector", { nodeId:root.nodeId, selector:'.composer-images input[type=file]' });
  await command("DOM.setFileInputFiles", { nodeId, files });
}
